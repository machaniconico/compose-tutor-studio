// ピアノロールの選んだ音の編集(移植 P33 / wave5 US-014):
// クリップボード(コピー・切り取り・貼り付け)、半音・度数の移調、スケールに合わせる。
//
// 決めた規則:
// - どの編集も Undo 1 段。理由つきで断るときは一部だけ反映することはない。
// - 書き込み先は、リンク(エイリアス)クリップなら元のクリップ。元を鳴らすすべての
//   配置(リンクを含む)で、クリップの終わりと曲の終わりを超えないことを確かめる。
// - 音の高さは MIDI 0〜127。1 つでも外れる音があれば全体を断る。
// - D1: 対象クリップ(元とリンクのすべての配置)の開始位置が整数 tick でなければ、
//   音の編集を断る。ループする配置があるとき、貼り付け・切り取りはループの周期
//   (最後の音の終わり)を変えない場合だけ認める。移調・スケール合わせは周期を変えない。
// - D2: 同じ高さの音の重なりは、編集後の buildScheduleEvents(全クリップ・リンク・
//   ループの全回)を MIDI 書き出しと同じ丸め(開始・終わりを別々に tick へ丸め、
//   長さは最低 1 tick)で絶対 tick に直し、同じトラック・同じ高さで区間が交わったら断る。
//   端が接するだけなら認める(MIDI 書き出しと同じ)。
// - D3: 編集後の予定イベントは「編集前 − 消した音の全配置・全回 + 足した音の全配置・
//   全回」と多重集合として完全に一致しなければ取りやめる(許容誤差なし)。
// - 位置と長さは整数 tick(PPQ 480)で扱う。コピーは tick の目盛りに乗った音だけ。
// - 度数移調: スケール内の音はスケールに沿って n 段動く。スケール外の音は、
//   動かす向きでいちばん近いスケール音までを 1 段と数え、残りをスケールに沿って動かす
//   (C メジャーで C#4 を 1 段上げると D4、1 段下げると C4)。
// - スケールに合わせる: 選んだ音のうちスケール外の音だけを、いちばん近いスケール音へ
//   寄せる。上下が同じ距離なら下へ寄せる。スケール外の音は間違いではないので、
//   利用者が選んで押したときだけ行う。

import {
  MAX_EVENTS_PER_CLIP,
  MIN_EVENT_DURATION_BEATS,
  PPQ,
  beatTick,
  clipContentOwnerId,
  midiClipNaturalPatternLength,
  resolveClipContent,
  type Clip,
  type NoteEvent,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  getScalePitchClasses,
  midiToNoteName,
  nearestScalePitch,
  transposeByDegree,
} from '@cts/theory-engine';
import { buildScheduleEvents, type SchedulePayload } from '../audio/events';
import type { ScheduledEvent } from '../audio/scheduler';
import { publishAppEvent } from './appEvents';
import { uid } from './ids';
import { getNoteClipboard, setNoteClipboard, type ClipboardNote, type NoteClipboard } from './noteClipboard';
import { useStore } from './store';

/** 移調できる量。半音は 1 オクターブ、度数は 7 段まで。 */
export const MAX_TRANSPOSE_SEMITONES = 12;
export const MAX_TRANSPOSE_DEGREES = 7;

export const FIT_TO_SCALE_HELP =
  'スケール外の音は間違いではありません(経過音やブルーノートなど、わざと使う音もあります)。'
  + '響きをスケールにそろえたいときだけ、選んだ音のうちスケール外の音を、いちばん近いスケールの音へ寄せます。';

export type NoteEditRefusal = Readonly<{ ok: false; reason: string }>;
export type NoteEditSuccess = Readonly<{
  ok: true;
  changed: boolean;
  project: Project;
  noteIds: readonly string[];
  message: string;
}>;
export type NoteEditOutcome = NoteEditSuccess | NoteEditRefusal;
export type CopyOutcome =
  | Readonly<{ ok: true; clipboard: NoteClipboard; message: string }>
  | NoteEditRefusal;
export type CutOutcome = (NoteEditSuccess & Readonly<{ clipboard: NoteClipboard }>) | NoteEditRefusal;

/** 店(store)を通した編集の結果。成功時は選び直す音の ID と、表示する文。 */
export type NoteEditResult =
  | Readonly<{ ok: true; changed: boolean; noteIds: readonly string[]; message: string }>
  | NoteEditRefusal;

export type TransposeAmount = Readonly<{ semitones: number }> | Readonly<{ degrees: number }>;

export const SOUND_CHANGED =
  'この編集をすると、選んだ音以外の鳴り方まで変わってしまうため、取りやめました。曲はそのままです。';

export function refuse(reason: string): NoteEditRefusal {
  return { ok: false, reason };
}

export function noteName(pitch: number): string {
  try {
    return midiToNoteName(pitch);
  } catch {
    return '(不明な音)';
  }
}

/** 拍を整数 tick に直す。目盛りから外れていれば null。 */
export function exactTicks(beat: number): number | null {
  if (typeof beat !== 'number' || !Number.isFinite(beat)) return null;
  const ticks = Math.round(beat * PPQ);
  return Number.isSafeInteger(ticks) && ticks / PPQ === beat ? ticks : null;
}

// ---------------------------------------------------------------------------
// 対象のクリップと選んだ音
// ---------------------------------------------------------------------------

export type EditTarget = Readonly<{
  owner: Clip;
  ownerTrack: Track;
  /** 元のクリップを鳴らす配置(元自身とリンク)。位置と長さは配置ごと。 */
  placements: readonly Clip[];
  trackIds: ReadonlySet<string>;
}>;

export function locateTarget(project: Project, clipId: string): EditTarget | string {
  if (typeof clipId !== 'string') return 'MIDI クリップを選んでから編集してください。';
  const ownerId = clipContentOwnerId(project, clipId);
  let owner: Clip | undefined;
  let ownerTrack: Track | undefined;
  const placements: Clip[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (ownerId !== null && clip.id === ownerId) {
        owner = clip;
        ownerTrack = track;
      }
      if (ownerId !== null && clipContentOwnerId(project, clip.id) === ownerId) {
        const resolved = resolveClipContent(project, clip);
        if (resolved) placements.push(resolved);
      }
    }
  }
  if (!owner || !ownerTrack || owner.type !== 'midi' || placements.length === 0) {
    return 'MIDI クリップが見つからないため、編集できません。MIDI クリップを選び直してください。';
  }
  return { owner, ownerTrack, placements, trackIds: new Set(placements.map((clip) => clip.trackId)) };
}

export function pickNotes(target: EditTarget, noteIds: readonly string[]): NoteEvent[] | string {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return '先に音を選んでください。';
  const byId = new Map((target.owner.notes ?? []).map((note) => [note.id, note]));
  const picked: NoteEvent[] = [];
  const seen = new Set<string>();
  for (const id of noteIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const note = typeof id === 'string' ? byId.get(id) : undefined;
    if (!note) return '選んだ音が見つかりません。音を選び直してください。';
    picked.push(note);
  }
  return picked;
}

/** 新しい音や動かした音が、どの配置でもクリップの終わりと曲の終わりに収まるか。 */
function placementProblem(project: Project, target: EditTarget, note: NoteEvent): string | null {
  const end = note.startBeat + note.durationBeats;
  for (const placement of target.placements) {
    if (end > placement.lengthBeats) {
      return 'クリップの終わりを超える音があるため、取りやめました(クリップの長さは変わりません)。';
    }
    if (beatTick(placement.startBeat + end) > beatTick(project.lengthBeats)) {
      return '曲の終わりを超える音があるため、取りやめました。先に曲を長くしてください。';
    }
  }
  return null;
}

export function withOwnerNotes(project: Project, ownerId: string, notes: NoteEvent[]): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.clips.some((clip) => clip.id === ownerId)
        ? { ...track, clips: track.clips.map((clip) => (clip.id === ownerId ? { ...clip, notes } : clip)) }
        : track,
    ),
  };
}

// ---------------------------------------------------------------------------
// buildScheduleEvents による事後確認
// ---------------------------------------------------------------------------

function scheduleOf(project: Project): ScheduledEvent[] | null {
  try {
    return buildScheduleEvents(project);
  } catch {
    return null;
  }
}

function eventKey(event: ScheduledEvent): string {
  const payload = event.payload as SchedulePayload;
  if (payload.kind === 'note') {
    return JSON.stringify([event.beat, 'note', payload.trackId, payload.preset, payload.pitch, payload.durationBeats, payload.velocity]);
  }
  return JSON.stringify([event.beat, payload]);
}

function countKeys(events: readonly ScheduledEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = eventKey(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) if (b.get(key) !== count) return false;
  return true;
}

function sane(events: readonly ScheduledEvent[]): boolean {
  return events.every((event) => {
    const payload = event.payload as SchedulePayload;
    if (!Number.isFinite(event.beat) || event.beat < 0) return false;
    if (payload.kind !== 'note') return true;
    return Number.isInteger(payload.pitch) && payload.pitch >= 0 && payload.pitch <= 127
      && Number.isFinite(payload.durationBeats) && payload.durationBeats > 0;
  });
}

const LOOP_LENGTH_CHANGED = 'ループしているクリップでは、ループの長さが変わる貼り付け・切り取りはできません。';

/** D1: 音を編集できるクリップか(全配置の開始位置が整数 tick)。 */
export function clipDomainProblem(target: EditTarget): string | null {
  if (target.placements.some((placement) => exactTicks(placement.startBeat) === null)) {
    return 'このクリップは開始位置が 1/480 拍の目盛りに乗っていないため、音を編集できません。クリップを目盛りの位置に置き直してください。';
  }
  return null;
}

/** D1: ループする配置があるとき、貼り付け・切り取りでループの周期が変わるなら断る。 */
function loopProblem(target: EditTarget, before: readonly NoteEvent[], after: readonly NoteEvent[]): string | null {
  if (!target.placements.some((placement) => placement.loop)) return null;
  return midiClipNaturalPatternLength(before) === midiClipNaturalPatternLength(after) ? null : LOOP_LENGTH_CHANGED;
}

/**
 * `ownerId` を鳴らす全配置・全回のうち、`ids` の音の予定イベントのキー
 * (buildScheduleEvents と同じ組み立て)。数えきれなければ null。
 */
function occurrenceKeys(project: Project, ownerId: string, ids: ReadonlySet<string>): string[] | null {
  const keys: string[] = [];
  if (ids.size === 0) return keys;
  try {
    // buildScheduleEvents そのもの(スウィング後の onset / 長さ、同じ高さの重なりの切り詰め込み)から、
    // この音の予定だけを拾う。
    const sources = new Map<object, { clipId: string; noteId: string }>();
    const events = buildScheduleEvents(project, (payload, source) => sources.set(payload, source));
    for (const event of events) {
      const payload = event.payload as SchedulePayload;
      const source = sources.get(payload);
      if (!source || payload.kind !== 'note' || !ids.has(source.noteId)) continue;
      if (clipContentOwnerId(project, source.clipId) !== ownerId) continue;
      keys.push(JSON.stringify([
        event.beat,
        'note',
        payload.trackId,
        payload.preset,
        payload.pitch,
        payload.durationBeats,
        payload.velocity,
      ]));
    }
  } catch {
    return null;
  }
  return keys;
}

export function roundedNoteTickSpan(beat: number, durationBeats: number): readonly [number, number] {
  const start = Math.round(beat * PPQ);
  return [start, Math.max(start + 1, Math.round((beat + durationBeats) * PPQ))];
}

export function tickSpansOverlap(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

/** D2: 同じトラック・同じ高さで、MIDI 書き出しと同じ丸めの tick 区間が交わる音の高さ。 */
function scheduleOverlapPitch(events: readonly ScheduledEvent[], trackIds: ReadonlySet<string>): number | null {
  const spans = new Map<string, Array<readonly [number, number]>>();
  for (const event of events) {
    const payload = event.payload as SchedulePayload;
    if (payload.kind !== 'note' || !trackIds.has(payload.trackId)) continue;
    const span = roundedNoteTickSpan(event.beat, payload.durationBeats);
    const key = `${payload.trackId}\u0000${payload.pitch}`;
    const list = spans.get(key) ?? [];
    list.push(span);
    spans.set(key, list);
  }
  for (const [key, list] of spans) {
    list.sort((a, b) => a[0] - b[0]);
    let maxEnd = -Infinity;
    for (const [start, end] of list) {
      if (maxEnd > start) return Number(key.slice(key.indexOf('\u0000') + 1));
      maxEnd = Math.max(maxEnd, end);
    }
  }
  return null;
}

/**
 * 編集後の事後確認(D2・D3)。問題がなければ null、あれば断る理由。
 * `removedIds` は編集前の、`addedIds` は編集後の、元クリップの音の ID
 * (高さだけを変える編集では、変えた音が両方に入る)。
 */
export function scheduleProblem(
  before: Project,
  after: Project,
  target: EditTarget,
  removedIds: ReadonlySet<string>,
  addedIds: ReadonlySet<string>,
  overlapReason: (pitch: number) => string,
): string | null {
  const a = scheduleOf(before);
  const b = scheduleOf(after);
  if (a === null || b === null || !sane(b)) return SOUND_CHANGED;
  const pitch = scheduleOverlapPitch(b, target.trackIds);
  if (pitch !== null) return overlapReason(pitch);
  const removed = occurrenceKeys(before, target.owner.id, removedIds);
  const added = occurrenceKeys(after, target.owner.id, addedIds);
  if (removed === null || added === null) return SOUND_CHANGED;
  const expected = countKeys(a);
  for (const key of removed) {
    const count = expected.get(key) ?? 0;
    if (count === 0) return SOUND_CHANGED;
    if (count === 1) expected.delete(key);
    else expected.set(key, count - 1);
  }
  for (const key of added) expected.set(key, (expected.get(key) ?? 0) + 1);
  return sameCounts(expected, countKeys(b)) ? null : SOUND_CHANGED;
}

/**
 * 新しい MIDI クリップを足した後の事後確認(P38 伴奏)。D2・D3 と同じ検査で、
 * 「編集前の予定 + 新しい音の全配置」と編集後の予定が多重集合として完全に一致し、
 * 同じトラック・同じ高さの重なりがないことを確かめる。問題がなければ null。
 */
export function newClipScheduleProblem(before: Project, after: Project, clipId: string): string | null {
  const target = locateTarget(after, clipId);
  if (typeof target === 'string') return SOUND_CHANGED;
  const addedIds = new Set((target.owner.notes ?? []).map((note) => note.id));
  return scheduleProblem(before, after, target, new Set(), addedIds, (pitch) =>
    `新しい伴奏の音(${noteName(pitch)})が同じ高さで重なるため、取りやめました。曲はそのままです。`);
}

// ---------------------------------------------------------------------------
// 純粋関数(テストしやすいように Project を受け取って返す)
// ---------------------------------------------------------------------------

/** 選んだ音をクリップボード用の形にする。プロジェクトは変えない。 */
export function copyNotesFromProject(project: Project, clipId: string, noteIds: readonly string[]): CopyOutcome {
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return refuse(target);
  const picked = pickNotes(target, noteIds);
  if (typeof picked === 'string') return refuse(picked);
  const ticks: Array<{ note: NoteEvent; start: number; duration: number }> = [];
  for (const note of picked) {
    const start = exactTicks(note.startBeat);
    const duration = exactTicks(note.durationBeats);
    if (start === null || duration === null || start < 0 || duration < 1) {
      return refuse(
        '位置か長さが細かすぎる(1/480 拍の目盛りに乗っていない)音があるため、コピーできません。先にクオンタイズしてください。',
      );
    }
    ticks.push({ note, start, duration });
  }
  const originTicks = Math.min(...ticks.map((entry) => entry.start));
  const notes: ClipboardNote[] = ticks
    .sort((x, y) => x.start - y.start || x.note.pitch - y.note.pitch)
    .map(({ note, start, duration }) => ({
      pitch: note.pitch,
      offsetTicks: start - originTicks,
      durationTicks: duration,
      velocity: note.velocity,
    }));
  return { ok: true, clipboard: { originTicks, notes }, message: `${notes.length}個の音をコピーしました。` };
}

/** コピーしてから消す(Undo 1 段)。 */
export function cutNotesInProject(project: Project, clipId: string, noteIds: readonly string[]): CutOutcome {
  const copied = copyNotesFromProject(project, clipId, noteIds);
  if (!copied.ok) return copied;
  const target = locateTarget(project, clipId) as EditTarget;
  const domain = clipDomainProblem(target);
  if (domain !== null) return refuse(domain);
  const removedIds = new Set<string>(noteIds);
  const existing = target.owner.notes ?? [];
  const removed = existing.filter((note) => removedIds.has(note.id));
  const kept = existing.filter((note) => !removedIds.has(note.id));
  const loop = loopProblem(target, existing, kept);
  if (loop !== null) return refuse(loop);
  const next = withOwnerNotes(project, target.owner.id, kept);
  const problem = scheduleProblem(project, next, target, removedIds, new Set(), (pitch) =>
    `切り取ると、このトラックで同じ高さの音(${noteName(pitch)})どうしが重なってしまうため、取りやめました。`);
  if (problem !== null) return refuse(problem);
  return {
    ok: true,
    changed: true,
    project: next,
    noteIds: [],
    clipboard: copied.clipboard,
    message: `${removed.length}個の音を切り取りました。貼り付けると、別の場所に置けます。`,
  };
}

/**
 * クリップボードの音を、いちばん早い音がクリップ内の `anchorTicks` に来るように貼る。
 * クリップか曲の終わりを超える音、同じ高さの音と重なる音が 1 つでもあれば全体を断る。
 */
export function pasteNotesIntoProject(
  project: Project,
  clipId: string,
  clipboard: NoteClipboard | null,
  anchorTicks: number,
  makeId: () => string = () => uid('note'),
): NoteEditOutcome {
  if (!clipboard || !Array.isArray(clipboard.notes) || clipboard.notes.length === 0) {
    return refuse('コピーした音がありません。先に音を選んでコピーしてください。');
  }
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return refuse(target);
  const domain = clipDomainProblem(target);
  if (domain !== null) return refuse(domain);
  if (!Number.isSafeInteger(anchorTicks) || anchorTicks < 0) {
    return refuse('貼り付ける位置がクリップの外です。');
  }
  const existing = target.owner.notes ?? [];
  if (existing.length + clipboard.notes.length > MAX_EVENTS_PER_CLIP) {
    return refuse(`1 つのクリップに置ける音は ${MAX_EVENTS_PER_CLIP} 個までのため、貼り付けられません。`);
  }
  const added: NoteEvent[] = [];
  for (const entry of clipboard.notes) {
    const { pitch, offsetTicks, durationTicks, velocity } = entry;
    if (
      !Number.isInteger(pitch) || pitch < 0 || pitch > 127
      || !Number.isInteger(velocity) || velocity < 1 || velocity > 127
      || !Number.isSafeInteger(offsetTicks) || offsetTicks < 0
      || !Number.isSafeInteger(durationTicks) || durationTicks < 1
      || !Number.isSafeInteger(anchorTicks + offsetTicks + durationTicks)
    ) {
      return refuse('クリップボードの中身を読み取れないため、貼り付けられません。もう一度コピーしてください。');
    }
    const note: NoteEvent = {
      id: makeId(),
      pitch,
      startBeat: (anchorTicks + offsetTicks) / PPQ,
      durationBeats: durationTicks / PPQ,
      velocity,
    };
    if (note.durationBeats < MIN_EVENT_DURATION_BEATS) {
      return refuse('短すぎて鳴らない音があるため、貼り付けられません。');
    }
    const problem = placementProblem(project, target, note);
    if (problem !== null) return refuse(problem.replace('取りやめました', '貼り付けられません'));
    added.push(note);
  }
  const notes = [...existing, ...added];
  const loop = loopProblem(target, existing, notes);
  if (loop !== null) return refuse(loop);
  const next = withOwnerNotes(project, target.owner.id, notes);
  const problem = scheduleProblem(project, next, target, new Set(), new Set(added.map((note) => note.id)), (pitch) =>
    `貼り付けると、このトラックで同じ高さの音(${noteName(pitch)})が重なってしまうため、貼り付けられません。再生ヘッドを空いている位置(このクリップの中)へ動かしてから貼り付けるか、重なる音を先に消してください。`);
  if (problem !== null) return refuse(problem);
  return {
    ok: true,
    changed: true,
    project: next,
    noteIds: added.map((note) => note.id),
    message: `${added.length}個の音を貼り付けました。`,
  };
}

/** ステップ入力で置く音の強さ(ピアノロールの新規ノートと同じ)。 */
export const STEP_INPUT_VELOCITY = 100;

const STEP_END_REACHED =
  'クリップの終わりまで来ました。これ以上は入力できません(クリップの長さは変わりません)。クリップを長くするか、別の場所から入力してください。';

/**
 * ステップ入力: 1 音を、クリップ内の `cursorTicks` に `stepTicks` の長さで置く。
 * 貼り付けと同じ事後確認(クリップ・曲の終わり、同じ高さの重なり、予定イベントの完全一致、
 * ループ周期の維持)を通らなければ全体を断り、クリップはそのまま。
 */
export function stepInsertNoteInProject(
  project: Project,
  clipId: string,
  pitch: number,
  cursorTicks: number,
  stepTicks: number,
  makeId: () => string = () => uid('note'),
): NoteEditOutcome {
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return refuse(target);
  const domain = clipDomainProblem(target);
  if (domain !== null) return refuse(domain);
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) return refuse('音の高さが 0〜127 の外のため、入力できません。');
  if (!Number.isSafeInteger(cursorTicks) || cursorTicks < 0 || !Number.isSafeInteger(stepTicks) || stepTicks < 1) {
    return refuse('入力する位置か長さを読み取れないため、入力できません。');
  }
  const existing = target.owner.notes ?? [];
  if (existing.length + 1 > MAX_EVENTS_PER_CLIP) {
    return refuse(`1 つのクリップに置ける音は ${MAX_EVENTS_PER_CLIP} 個までのため、入力できません。`);
  }
  const note: NoteEvent = {
    id: makeId(),
    pitch,
    startBeat: cursorTicks / PPQ,
    durationBeats: stepTicks / PPQ,
    velocity: STEP_INPUT_VELOCITY,
  };
  if (note.durationBeats < MIN_EVENT_DURATION_BEATS) return refuse('短すぎて鳴らない長さのため、入力できません。');
  if (placementProblem(project, target, note) !== null) return refuse(STEP_END_REACHED);
  const notes = [...existing, note];
  const loop = loopProblem(target, existing, notes);
  if (loop !== null) return refuse(loop.replace('貼り付け・切り取り', '入力'));
  const next = withOwnerNotes(project, target.owner.id, notes);
  const problem = scheduleProblem(project, next, target, new Set(), new Set([note.id]), (overlap) =>
    `ここに入力すると、このトラックで同じ高さの音(${noteName(overlap)})が重なってしまうため、入力できません。休符で先へ進むか、重なる音を先に消してください。`);
  if (problem !== null) return refuse(problem);
  return {
    ok: true,
    changed: true,
    project: next,
    noteIds: [note.id],
    message: `${noteName(pitch)}を入力しました。`,
  };
}

/** 高さだけを変える編集の共通部分。 */
function applyPitches(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  pitchOf: (pitch: number) => number,
  describe: (count: number) => string,
  unchangedMessage: string,
): NoteEditOutcome {
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return refuse(target);
  const domain = clipDomainProblem(target);
  if (domain !== null) return refuse(domain);
  const picked = pickNotes(target, noteIds);
  if (typeof picked === 'string') return refuse(picked);
  const nextPitch = new Map<string, number>();
  for (const note of picked) {
    let pitch: number;
    try {
      pitch = pitchOf(note.pitch);
    } catch {
      return refuse('曲のキーとスケールを読み取れないため、スケールに沿って動かせません。');
    }
    if (!Number.isInteger(pitch) || pitch > 127) {
      return refuse(`${noteName(note.pitch)}がいちばん高い音(MIDI 127)を超えてしまうため、取りやめました。どの音も動かしていません。`);
    }
    if (pitch < 0) {
      return refuse(`${noteName(note.pitch)}がいちばん低い音(MIDI 0)を下回ってしまうため、取りやめました。どの音も動かしていません。`);
    }
    if (pitch !== note.pitch) nextPitch.set(note.id, pitch);
  }
  if (nextPitch.size === 0) {
    return { ok: true, changed: false, project, noteIds: picked.map((note) => note.id), message: unchangedMessage };
  }
  const notes = (target.owner.notes ?? []).map((note) => {
    const pitch = nextPitch.get(note.id);
    return pitch === undefined ? note : { ...note, pitch };
  });
  const next = withOwnerNotes(project, target.owner.id, notes);
  const changedIds = new Set(nextPitch.keys());
  const problem = scheduleProblem(project, next, target, changedIds, changedIds, (pitch) =>
    `動かすと、このトラックで同じ高さの音(${noteName(pitch)})どうしが重なってしまうため、取りやめました。どの音も動かしていません。`);
  if (problem !== null) return refuse(problem);
  return {
    ok: true,
    changed: true,
    project: next,
    noteIds: picked.map((note) => note.id),
    message: describe(nextPitch.size),
  };
}

/**
 * スケールに沿って `degrees` 段動かす。スケール外の音は、動かす向きでいちばん近い
 * スケール音までを 1 段と数える(上の規則)。
 */
export function moveByScaleDegrees(midi: number, degrees: number, key: string, scale: Project['scale']): number {
  if (degrees === 0) return midi;
  const scalePcs = new Set(getScalePitchClasses(key, scale));
  const pc = (value: number) => ((value % 12) + 12) % 12;
  if (scalePcs.has(pc(midi))) return transposeByDegree(midi, degrees, key, scale);
  const step = degrees > 0 ? 1 : -1;
  let next = midi + step;
  // どのスケールも音の間隔は 6 半音以下なので、6 回以内に見つかる。
  for (let i = 0; i < 6 && !scalePcs.has(pc(next)); i += 1) next += step;
  if (!scalePcs.has(pc(next))) throw new Error('スケール音が見つかりません');
  return transposeByDegree(next, degrees - step, key, scale);
}

/** 選んだ音を半音、またはスケールの度数で動かす(Undo 1 段、部分適用なし)。 */
export function transposeNotesInProject(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  by: TransposeAmount,
): NoteEditOutcome {
  if (by === null || typeof by !== 'object') return refuse('動かす量を指定してください。');
  if (Object.hasOwn(by, 'semitones')) {
    const semitones = (by as { semitones: unknown }).semitones;
    if (typeof semitones !== 'number' || !Number.isInteger(semitones) || semitones === 0 || Math.abs(semitones) > MAX_TRANSPOSE_SEMITONES) {
      return refuse(`半音で動かせるのは -${MAX_TRANSPOSE_SEMITONES}〜+${MAX_TRANSPOSE_SEMITONES} の 0 以外の整数です。`);
    }
    const direction = semitones > 0 ? '上げ' : '下げ';
    return applyPitches(
      project,
      clipId,
      noteIds,
      (pitch) => pitch + semitones,
      (count) => `${count}個の音を${Math.abs(semitones)}半音${direction}ました。`,
      '高さの変わる音はありませんでした。',
    );
  }
  if (Object.hasOwn(by, 'degrees')) {
    const degrees = (by as { degrees: unknown }).degrees;
    if (typeof degrees !== 'number' || !Number.isInteger(degrees) || degrees === 0 || Math.abs(degrees) > MAX_TRANSPOSE_DEGREES) {
      return refuse(`スケールの段で動かせるのは -${MAX_TRANSPOSE_DEGREES}〜+${MAX_TRANSPOSE_DEGREES} の 0 以外の整数です。`);
    }
    const direction = degrees > 0 ? '上へ' : '下へ';
    return applyPitches(
      project,
      clipId,
      noteIds,
      (pitch) => moveByScaleDegrees(pitch, degrees, project.key, project.scale),
      (count) => `${count}個の音を、スケールに沿って${Math.abs(degrees)}段${direction}動かしました。`,
      '高さの変わる音はありませんでした。',
    );
  }
  return refuse('動かす量を指定してください。');
}

/** 選んだ音のうちスケール外の音だけを、いちばん近いスケール音へ寄せる(同じ距離なら下)。 */
export function fitNotesToScaleInProject(project: Project, clipId: string, noteIds: readonly string[]): NoteEditOutcome {
  return applyPitches(
    project,
    clipId,
    noteIds,
    (pitch) => nearestScalePitch(pitch, project.key, project.scale, 'down'),
    (count) => `スケール外の音 ${count}個を、近いスケールの音へ寄せました。`,
    '選んだ音はすべてスケールの音なので、そのままにしました。',
  );
}

export type RetimedNote = Readonly<{ startBeat: number; velocity: number }>;

const RETIME_LOOP_CHANGED = 'ループしているクリップでは、ループの長さが変わる編集はできません。';

/**
 * 選んだ音の開始位置と強さだけを変える(グルーヴ編集用。Undo 1 段、部分適用なし)。
 * `retime` は選んだ音(クリップ内の順)を同じ順の新しい値へ写す。開始位置は整数 tick に
 * 丸め、音の高さと長さは変えない。D1〜D3 は P33 の編集と同じ規則で確かめる。
 */
export function retimeNotesInProject(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  retime: (picked: readonly NoteEvent[]) => readonly RetimedNote[],
  describe: (count: number) => string,
  unchangedMessage: string,
): NoteEditOutcome {
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return refuse(target);
  const domain = clipDomainProblem(target);
  if (domain !== null) return refuse(domain);
  const picked = pickNotes(target, noteIds);
  if (typeof picked === 'string') return refuse(picked);
  const ordered = (target.owner.notes ?? []).filter((note) => picked.includes(note));
  let results: readonly RetimedNote[];
  try {
    results = retime(ordered);
  } catch {
    return refuse('選んだ音が多すぎるため、この編集はできません。');
  }
  if (results.length !== ordered.length) return refuse(SOUND_CHANGED);
  const next = new Map<string, NoteEvent>();
  for (const [index, note] of ordered.entries()) {
    const result = results[index]!;
    // 目標の位置が今の位置と同じ音には触れない(目盛りに乗っていなくてもそのまま)。
    if (result.startBeat === note.startBeat && result.velocity === note.velocity) continue;
    const startBeat = result.startBeat === note.startBeat ? note.startBeat : beatTick(result.startBeat) / PPQ;
    const edited: NoteEvent = { ...note, startBeat, velocity: result.velocity };
    if (!Number.isInteger(edited.velocity) || edited.velocity < 1 || edited.velocity > 127 || !(startBeat >= 0)) {
      return refuse('音の強さや位置が使える範囲を外れるため、取りやめました。どの音も動かしていません。');
    }
    if (startBeat === note.startBeat && edited.velocity === note.velocity) continue;
    const problem = placementProblem(project, target, edited);
    if (problem !== null) return refuse(problem);
    next.set(note.id, edited);
  }
  const ids = picked.map((note) => note.id);
  if (next.size === 0) return { ok: true, changed: false, project, noteIds: ids, message: unchangedMessage };
  const notes = (target.owner.notes ?? []).map((note) => next.get(note.id) ?? note);
  if (target.placements.some((placement) => placement.loop)
    && midiClipNaturalPatternLength(target.owner.notes ?? []) !== midiClipNaturalPatternLength(notes)) {
    return refuse(RETIME_LOOP_CHANGED);
  }
  const changed = withOwnerNotes(project, target.owner.id, notes);
  const changedIds = new Set(next.keys());
  const problem = scheduleProblem(project, changed, target, changedIds, changedIds, (pitch) =>
    `この編集をすると、このトラックで同じ高さの音(${noteName(pitch)})どうしが重なってしまうため、取りやめました。どの音も動かしていません。`);
  if (problem !== null) return refuse(problem);
  return { ok: true, changed: true, project: changed, noteIds: ids, message: describe(next.size) };
}

// ---------------------------------------------------------------------------
// 店(store)への反映。どれも Undo 1 段。
// ---------------------------------------------------------------------------

export function editLockReason(verb: string): string | null {
  const state = useStore.getState();
  if (state.audioRecordingOperationId !== null || state.midiRecordingActive) {
    return `録音中は${verb}できません。録音を止めてからやり直してください。`;
  }
  if (state.projectOperationBusy) return `プロジェクトを開いている途中のため、今は${verb}できません。`;
  return null;
}

export function commit(outcome: NoteEditOutcome, snapshot: Project, verb: string): NoteEditResult {
  if (!outcome.ok) return outcome;
  if (!outcome.changed) return { ok: true, changed: false, noteIds: outcome.noteIds, message: outcome.message };
  const state = useStore.getState();
  const applied = state.applyProjectChange((current) => (current === snapshot ? outcome.project : current));
  if (!applied || useStore.getState().project === snapshot) {
    return refuse(`今は${verb}を反映できませんでした。曲はそのままです。もう一度お試しください。`);
  }
  state.selectNotes([...outcome.noteIds]);
  return { ok: true, changed: true, noteIds: outcome.noteIds, message: outcome.message };
}

function trackOf(project: Project, clipId: string): Track | undefined {
  return project.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
}

/** 選んだ音をアプリ内のクリップボードへコピーする。曲は変えない。 */
export function copySelectedNotes(clipId: string, noteIds: readonly string[]): NoteEditResult {
  const copied = copyNotesFromProject(useStore.getState().project, clipId, noteIds);
  if (!copied.ok) return copied;
  setNoteClipboard(copied.clipboard);
  return { ok: true, changed: false, noteIds, message: copied.message };
}

/** 選んだ音をコピーしてから消す。消せたときだけクリップボードを書き換える。 */
export function cutSelectedNotes(clipId: string, noteIds: readonly string[]): NoteEditResult {
  const locked = editLockReason('切り取り');
  if (locked) return refuse(locked);
  const snapshot = useStore.getState().project;
  const outcome = cutNotesInProject(snapshot, clipId, noteIds);
  const result = commit(outcome, snapshot, '切り取り');
  if (result.ok && outcome.ok) setNoteClipboard(outcome.clipboard);
  return result;
}

/**
 * クリップボードの音を貼る。`at: 'auto'`(Ctrl/Cmd+V)は、再生ヘッドがこのクリップの中なら
 * いちばん早い音を再生ヘッドの位置に、外ならコピーした時と同じクリップ内の位置に置く。
 * `at: 'original'`(Ctrl/Cmd+Shift+V)は、いつもコピーした時と同じ位置に置く。
 */
export function pasteClipboardNotes(clipId: string, at: 'auto' | 'original'): NoteEditResult {
  const locked = editLockReason('貼り付け');
  if (locked) return refuse(locked);
  const state = useStore.getState();
  const snapshot = state.project;
  const clipboard = getNoteClipboard();
  if (!clipboard) return refuse('コピーした音がありません。先に音を選んでコピーしてください。');
  let anchorTicks = clipboard.originTicks;
  if (at === 'auto') {
    const track = trackOf(snapshot, clipId);
    const raw = track?.clips.find((clip) => clip.id === clipId);
    const placement = raw ? resolveClipContent(snapshot, raw) : null;
    if (!placement) return refuse('MIDI クリップが見つからないため、貼り付けられません。');
    // クリップの中かどうかは丸める前の再生ヘッドで決め、中なら tick に丸めて置く。
    const position = state.transport.positionBeat;
    if (position >= placement.startBeat && position < placement.startBeat + placement.lengthBeats) {
      anchorTicks = beatTick(position) - beatTick(placement.startBeat);
    }
  }
  const outcome = pasteNotesIntoProject(snapshot, clipId, clipboard, anchorTicks);
  const result = commit(outcome, snapshot, '貼り付け');
  if (result.ok && result.changed && outcome.ok) {
    const project = useStore.getState().project;
    const track = trackOf(project, clipId);
    let scalePcs: number[] = [];
    try {
      scalePcs = getScalePitchClasses(project.key, project.scale);
    } catch {
      scalePcs = [];
    }
    const pastedIds = new Set(outcome.noteIds);
    const owner = locateTarget(project, clipId);
    const pasted = typeof owner === 'string' ? [] : (owner.owner.notes ?? []).filter((note) => pastedIds.has(note.id));
    for (const note of pasted) {
      publishAppEvent({
        type: 'note.added',
        payload: {
          pitch: note.pitch,
          startBeat: note.startBeat,
          durationBeats: note.durationBeats,
          trackId: track?.id ?? '',
          trackName: track?.name ?? '',
          inScale: scalePcs.includes(((note.pitch % 12) + 12) % 12),
        },
      });
    }
  }
  return result;
}

/** 選んだ音を半音、またはスケールの度数で動かす。 */
export function transposeSelectedNotes(clipId: string, noteIds: readonly string[], by: TransposeAmount): NoteEditResult {
  const locked = editLockReason('移調');
  if (locked) return refuse(locked);
  const snapshot = useStore.getState().project;
  return commit(transposeNotesInProject(snapshot, clipId, noteIds, by), snapshot, '移調');
}

/** 選んだ音のうちスケール外の音だけを、近いスケール音へ寄せる。 */
export function fitSelectedNotesToScale(clipId: string, noteIds: readonly string[]): NoteEditResult {
  const locked = editLockReason('スケール合わせ');
  if (locked) return refuse(locked);
  const snapshot = useStore.getState().project;
  return commit(fitNotesToScaleInProject(snapshot, clipId, noteIds), snapshot, 'スケール合わせ');
}

/** 選んだ音の開始位置・強さを変える(グルーヴ編集)。録音中は断る。 */
export function retimeSelectedNotes(
  clipId: string,
  noteIds: readonly string[],
  retime: (picked: readonly NoteEvent[]) => readonly RetimedNote[],
  describe: (count: number) => string,
  unchangedMessage: string,
): NoteEditResult {
  const locked = editLockReason('編集');
  if (locked) return refuse(locked);
  const snapshot = useStore.getState().project;
  return commit(
    retimeNotesInProject(snapshot, clipId, noteIds, retime, describe, unchangedMessage),
    snapshot,
    '編集',
  );
}

/** ステップ入力で 1 音置く。Undo 1 段。録音中は断る。成功時の noteIds[0] が置いた音の ID。 */
export function stepInsertNote(clipId: string, pitch: number, cursorTicks: number, stepTicks: number): NoteEditResult {
  const locked = editLockReason('入力');
  if (locked) return refuse(locked);
  const snapshot = useStore.getState().project;
  return commit(stepInsertNoteInProject(snapshot, clipId, pitch, cursorTicks, stepTicks), snapshot, '入力');
}

/** ステップ入力で最後に置いた音 1 つを消す(クリップボードは触らない)。Undo 1 段。 */
export function stepRemoveNote(clipId: string, noteId: string): NoteEditResult {
  const locked = editLockReason('入力');
  if (locked) return refuse(locked);
  const snapshot = useStore.getState().project;
  const outcome = cutNotesInProject(snapshot, clipId, [noteId]);
  if (!outcome.ok) return outcome;
  const result = commit({ ...outcome, message: '最後に入力した音を消して、1 つ戻りました。' }, snapshot, '入力');
  return result;
}
