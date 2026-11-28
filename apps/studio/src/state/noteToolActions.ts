// ピアノロールのノート操作(移植 P34 / wave5 US-015):
// レガート、スタッカート、連結、再生ヘッドでの分割、グリッド単位の移動、ベロシティランプ。
//
// 決めた規則(P33 の規則 D1〜D3 をそのまま使う。noteEditActions.ts の先頭を参照):
// - どの操作も、選んだ音だけが対象で、Undo 1 段。理由つきで断るときは一部だけ反映しない。
// - 結果の位置・長さは整数 tick(PPQ 480)。目盛りに乗らない・長さ 0 以下・クリップや曲の外に
//   出る結果は、丸めたり切り詰めたりせず断る。
// - 同じ高さの音の重なりと「選んだ音以外は鳴り方が変わらない」ことは、P33 と同じ
//   scheduleProblem(buildScheduleEvents の多重集合で完全一致、スウィング込み)で確かめる。
// - ループするクリップでは、ループの周期(最後の音の終わり)が変わる操作は断る。
// - レガート(鳴る時間で定義): 長さ = 次に鳴り始める選んだ音(高さは問わない)の鳴り始め − 自分の鳴り始め
//   (スウィング込み、P20 の resolveGrooveNoteSpan)。いちばん後ろの音は変えない。
// - スタッカート: 長さを半分(STACCATO_RATIO)にする。tick に四捨五入し、最低 1 tick。
//   すでに 1 tick の音は変えない。
// - 連結: 同じ高さで、次の音が前の音の終わりと接するか重なる選んだ音を 1 つにする。
//   いちばん早い音の id と強さを残し、終わりはいちばん遅い終わり。
// - 分割: 再生ヘッドの位置(クリップ内の tick)で、またぐ選んだ音を 2 つにする。
//   ループするクリップは (再生ヘッド − クリップの始まり) mod 周期 の位置で元の音を分ける(全部の繰り返しが分かれる)。
//   どちらも 1 tick 以上。後半は同じ高さ・強さで、新しい id。
// - グリッド移動: 開始位置を「グリッド幅 × 段数」tick だけ動かす(長さ・高さは変えない)。
// - ベロシティランプ: 開始位置が最初の音の強さ from、最後の音の強さ to で、間は拍位置に比例して
//   直線的に変える(四捨五入、1〜127)。同じ位置から始まる音は同じ強さ。

import {
  MAX_EVENTS_PER_CLIP,
  PPQ,
  beatTick,
  midiClipNaturalPatternLength,
  resolveGrooveNoteSpan,
  type Clip,
  type GrooveNoteSpan,
  type NoteEvent,
  type Project,
} from '@cts/project-model';
import { uid } from './ids';
import {
  SOUND_CHANGED,
  clipDomainProblem,
  commit,
  editLockReason,
  exactTicks,
  locateTarget,
  noteName,
  pickNotes,
  refuse,
  scheduleProblem,
  withOwnerNotes,
  type EditTarget,
  type NoteEditOutcome,
  type NoteEditResult,
} from './noteEditActions';
import { useStore } from './store';

/** スタッカートで残す長さの割合。 */
export const STACCATO_RATIO = 0.5;
/** 1 回のグリッド移動で動かせる段数の上限。 */
export const MAX_NUDGE_STEPS = 64;

/** 別の編集(ドラッグなど)の途中は、その Undo 1 段に相乗りしない。P3A と同じ文。 */
const BUSY_REASON = 'ほかの操作が終わってから試してください。';
const OFF_GRID =
  '1/480 拍の目盛りに乗っていない音があるため、この操作はできません。先に「ゆらぎ…」のクオンタイズで位置をそろえてください。';
const LOOP_PERIOD_CHANGED = 'ループしているクリップでは、ループの長さ(最後の音の終わり)が変わる操作はできません。';

/** 元の音 id → 置き換え後の音(空 = 消す、1 つ = 変更、2 つ = 分割)。 */
type Plan = Readonly<{
  replace: ReadonlyMap<string, readonly NoteEvent[]>;
  message: (count: number) => string;
  unchanged: string;
}>;

type Build = (ordered: readonly NoteEvent[], target: EditTarget) => Plan | string;

function ticksOf(note: NoteEvent): { start: number; duration: number } | null {
  const start = exactTicks(note.startBeat);
  const duration = exactTicks(note.durationBeats);
  return start === null || duration === null ? null : { start, duration };
}

function placementOf(target: EditTarget, clipId: string): Clip {
  return target.placements.find((clip) => clip.id === clipId) ?? target.placements[0]!;
}

/** 実際に鳴る区間(スウィング込み、P20 の resolveGrooveNoteSpan)。鳴らない音は null。編集中の配置の 1 回目で数える。 */
function soundingSpan(project: Project, placement: Clip, note: NoteEvent): GrooveNoteSpan | null {
  return resolveGrooveNoteSpan(
    project,
    placement.startBeat + note.startBeat,
    note.durationBeats,
    placement.startBeat + placement.lengthBeats,
  );
}

/** 変えた項目だけ整数 tick を求め、クリップ・曲の終わりに収まるか(tick で数える)確かめる。 */
function resultProblem(project: Project, target: EditTarget, original: NoteEvent | undefined, note: NoteEvent): string | null {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
    || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) {
    return '音の高さや強さが使える範囲を外れるため、取りやめました。どの音も変えていません。';
  }
  const startChanged = original === undefined || note.startBeat !== original.startBeat;
  const durationChanged = original === undefined || note.durationBeats !== original.durationBeats;
  if (!startChanged && !durationChanged) return null;
  const start = exactTicks(note.startBeat);
  const duration = exactTicks(note.durationBeats);
  if (start === null || duration === null) return OFF_GRID;
  if (start < 0) return 'クリップの先頭より前に出る音があるため、取りやめました。どの音も動かしていません。';
  if (duration < 1) return '長さが 1 ティック未満になる音があるため、取りやめました。どの音も変えていません。';
  for (const placement of target.placements) {
    if (start + duration > beatTick(placement.lengthBeats)) {
      return 'クリップの終わりを超える音があるため、取りやめました(クリップの長さは変わりません)。';
    }
    if (beatTick(placement.startBeat) + start + duration > beatTick(project.lengthBeats)) {
      return '曲の終わりを超える音があるため、取りやめました。先に曲を長くしてください。';
    }
  }
  return null;
}

function runTool(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  build: Build,
): NoteEditOutcome {
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return refuse(target);
  const domain = clipDomainProblem(target);
  if (domain !== null) return refuse(domain);
  const picked = pickNotes(target, noteIds);
  if (typeof picked === 'string') return refuse(picked);
  const pickedSet = new Set(picked);
  const ordered = (target.owner.notes ?? []).filter((note) => pickedSet.has(note));
  let plan: Plan | string;
  try {
    plan = build(ordered, target);
  } catch {
    return refuse(SOUND_CHANGED);
  }
  if (typeof plan === 'string') return refuse(plan);
  const selected = picked.map((note) => note.id);
  if (plan.replace.size === 0) return { ok: true, changed: false, project, noteIds: selected, message: plan.unchanged };

  const originals = new Map((target.owner.notes ?? []).map((note) => [note.id, note]));
  const addedIds = new Set<string>();
  for (const [id, notes] of plan.replace) {
    for (const note of notes) {
      const problem = resultProblem(project, target, note.id === id ? originals.get(id) : undefined, note);
      if (problem !== null) return refuse(problem);
      addedIds.add(note.id);
    }
  }
  const notes = (target.owner.notes ?? []).flatMap((note) => plan.replace.get(note.id) ?? [note]);
  if (notes.length > MAX_EVENTS_PER_CLIP) return refuse('このクリップの音の数が上限を超えるため、取りやめました。');
  if (target.placements.some((placement) => placement.loop)
    && beatTick(midiClipNaturalPatternLength(target.owner.notes ?? [])) !== beatTick(midiClipNaturalPatternLength(notes))) {
    return refuse(LOOP_PERIOD_CHANGED);
  }
  const next = withOwnerNotes(project, target.owner.id, notes);
  const problem = scheduleProblem(project, next, target, new Set(plan.replace.keys()), addedIds, (pitch) =>
    `この操作をすると、このトラックで同じ高さの音(${noteName(pitch)})どうしが重なってしまうため、取りやめました。どの音も変えていません。`);
  if (problem !== null) return refuse(problem);
  const noteIdsAfter = selected.flatMap((id) => {
    const replaced = plan.replace.get(id);
    return replaced ? replaced.map((note) => note.id) : [id];
  });
  return { ok: true, changed: true, project: next, noteIds: noteIdsAfter, message: plan.message(plan.replace.size) };
}

// ---------------------------------------------------------------------------
// 純粋関数(Project を受け取って結果を返す)
// ---------------------------------------------------------------------------

/**
 * レガート(鳴る時間で定義): 選んだ音の長さを、「次に鳴り始める選んだ音の鳴り始め − 自分の鳴り始め」に
 * する(スウィング込み。高さは問わず、同じ鳴り始めの音は 1 つと数える)。鳴らない音があれば断る。
 */
export function legatoNotesInProject(project: Project, clipId: string, noteIds: readonly string[]): NoteEditOutcome {
  return runTool(project, clipId, noteIds, (ordered, target) => {
    const placement = placementOf(target, clipId);
    const spans = ordered.map((note) => soundingSpan(project, placement, note));
    if (spans.some((span) => span === null)) return 'スウィングなどで鳴らない音が含まれるため、レガートはできません。';
    const onsets = [...new Set(spans.map((span) => span!.onsetTick))].sort((a, b) => a - b);
    const replace = new Map<string, readonly NoteEvent[]>();
    for (const [index, note] of ordered.entries()) {
      const own = spans[index]!.onsetTick;
      const next = onsets[onsets.indexOf(own) + 1];
      if (next === undefined) continue;
      const ticks = next - own;
      if (!Number.isSafeInteger(ticks) || ticks <= 0) return OFF_GRID;
      const durationBeats = ticks / PPQ;
      if (durationBeats !== note.durationBeats) replace.set(note.id, [{ ...note, durationBeats }]);
    }
    return {
      replace,
      message: (count) => `${count}個の音を、次の音の始まりまでのばしました(レガート)。`,
      unchanged: 'のばせる音はありませんでした。2 つ以上、始まりの違う音を選んでください。',
    };
  });
}

/** スタッカート: 長さを STACCATO_RATIO 倍に(四捨五入、最低 1 tick)。 */
export function staccatoNotesInProject(project: Project, clipId: string, noteIds: readonly string[]): NoteEditOutcome {
  return runTool(project, clipId, noteIds, (ordered) => {
    const replace = new Map<string, readonly NoteEvent[]>();
    for (const note of ordered) {
      const ticks = note.durationBeats * PPQ;
      if (!Number.isFinite(ticks)) return SOUND_CHANGED;
      const shorter = Math.max(1, Math.round(ticks * STACCATO_RATIO));
      if (shorter < ticks) replace.set(note.id, [{ ...note, durationBeats: shorter / PPQ }]);
    }
    return {
      replace,
      message: (count) => `${count}個の音を短くしました(スタッカート)。`,
      unchanged: 'これ以上短くできる音はありませんでした。',
    };
  });
}

/** 連結: 同じ高さで接する・重なる選んだ音を 1 つに。いちばん早い音の id と強さを残す。 */
export function joinNotesInProject(project: Project, clipId: string, noteIds: readonly string[]): NoteEditOutcome {
  return runTool(project, clipId, noteIds, (ordered) => {
    const info = ordered.map((note) => ({ note, ticks: ticksOf(note) }));
    if (info.some((entry) => entry.ticks === null)) return OFF_GRID;
    const byPitch = new Map<number, typeof info>();
    for (const entry of info) byPitch.set(entry.note.pitch, [...(byPitch.get(entry.note.pitch) ?? []), entry]);
    const replace = new Map<string, readonly NoteEvent[]>();
    for (const group of byPitch.values()) {
      group.sort((a, b) => a.ticks!.start - b.ticks!.start || (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0));
      let head = group[0]!;
      let end = head.ticks!.start + head.ticks!.duration;
      let joined: string[] = [];
      const flush = (): void => {
        if (joined.length === 0) return;
        replace.set(head.note.id, [{ ...head.note, durationBeats: (end - head.ticks!.start) / PPQ }]);
        for (const id of joined) replace.set(id, []);
        joined = [];
      };
      for (const entry of group.slice(1)) {
        if (entry.ticks!.start <= end) {
          joined.push(entry.note.id);
          end = Math.max(end, entry.ticks!.start + entry.ticks!.duration);
        } else {
          flush();
          head = entry;
          end = entry.ticks!.start + entry.ticks!.duration;
        }
      }
      flush();
    }
    if (replace.size === 0) {
      return 'つなげられる音がありません。同じ高さで、隣り合う(または重なる)音を 2 つ以上選んでください。';
    }
    const heads = [...replace.values()].filter((notes) => notes.length === 1).length;
    return {
      replace,
      message: () => `${replace.size}個の音を、${heads}個につなげました。`,
      unchanged: '',
    };
  });
}

/** 分割: クリップ内の tick `atTick` をまたぐ選んだ音を 2 つに。後半の id は `newId` で作る。 */
export function splitNotesInProject(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  atTick: number,
  newId: () => string = () => uid('note'),
): NoteEditOutcome {
  return runTool(project, clipId, noteIds, (ordered) => {
    if (typeof atTick !== 'number' || !Number.isSafeInteger(atTick) || atTick <= 0) {
      return '分ける位置がクリップの外です。再生ヘッドを、分けたい音の途中に置いてください。';
    }
    const info = ordered.map((note) => ({ note, ticks: ticksOf(note) }));
    if (info.some((entry) => entry.ticks === null)) return OFF_GRID;
    const replace = new Map<string, readonly NoteEvent[]>();
    for (const { note, ticks } of info) {
      const { start, duration } = ticks!;
      if (!(start < atTick && atTick < start + duration)) continue;
      replace.set(note.id, [
        { ...note, durationBeats: (atTick - start) / PPQ },
        { ...note, id: newId(), startBeat: atTick / PPQ, durationBeats: (start + duration - atTick) / PPQ },
      ]);
    }
    if (replace.size === 0) {
      return '再生ヘッドの位置にかかる、選んだ音がありません。再生ヘッドを音の途中に置いてください(音の始まりや終わりでは分けられません)。';
    }
    return {
      replace,
      message: (count) => `${count}個の音を、再生ヘッドの位置で 2 つに分けました。`,
      unchanged: '',
    };
  });
}

/** グリッド移動: 開始位置を `deltaTicks` だけ動かす(長さ・高さはそのまま)。 */
export function nudgeNotesInProject(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  deltaTicks: number,
): NoteEditOutcome {
  if (typeof deltaTicks !== 'number' || !Number.isSafeInteger(deltaTicks) || deltaTicks === 0) {
    return refuse('動かす量を指定してください。');
  }
  return runTool(project, clipId, noteIds, (ordered) => {
    const replace = new Map<string, readonly NoteEvent[]>();
    for (const note of ordered) {
      const start = exactTicks(note.startBeat);
      if (start === null) return OFF_GRID;
      replace.set(note.id, [{ ...note, startBeat: (start + deltaTicks) / PPQ }]);
    }
    return {
      replace,
      message: (count) => `${count}個の音を${deltaTicks < 0 ? '左(前)' : '右(後ろ)'}へ動かしました。`,
      unchanged: '',
    };
  });
}

/** ベロシティランプ: 最初の音の強さ `from` から最後の音の強さ `to` まで、拍位置に比例して直線的に。 */
export function rampVelocityInProject(
  project: Project,
  clipId: string,
  noteIds: readonly string[],
  from: number,
  to: number,
): NoteEditOutcome {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 127;
  if (!valid(from) || !valid(to)) return refuse('強さは 1〜127 の整数で指定してください。');
  return runTool(project, clipId, noteIds, (ordered) => {
    const sorted = [...ordered].sort((a, b) =>
      a.startBeat - b.startBeat || a.pitch - b.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const first = sorted[0]!.startBeat;
    const span = sorted[sorted.length - 1]!.startBeat - first;
    const replace = new Map<string, readonly NoteEvent[]>();
    for (const note of sorted) {
      const fraction = span > 0 ? (note.startBeat - first) / span : 0;
      const velocity = Math.min(127, Math.max(1, Math.round(from + (to - from) * fraction)));
      if (velocity !== note.velocity) replace.set(note.id, [{ ...note, velocity }]);
    }
    return {
      replace,
      message: (count) => `${count}個の音の強さを、${from}から${to}へなめらかに変えました。`,
      unchanged: '強さは変わりませんでした。',
    };
  });
}

// ---------------------------------------------------------------------------
// 店(store)への反映。どれも Undo 1 段。録音中は断る。
// ---------------------------------------------------------------------------

function run(verb: string, make: (snapshot: Project) => NoteEditOutcome): NoteEditResult {
  const locked = editLockReason(verb);
  if (locked) return refuse(locked);
  if (useStore.getState().isProjectTransactionOpen()) return refuse(BUSY_REASON);
  const snapshot = useStore.getState().project;
  return commit(make(snapshot), snapshot, verb);
}

export function legatoSelectedNotes(clipId: string, noteIds: readonly string[]): NoteEditResult {
  return run('レガート', (project) => legatoNotesInProject(project, clipId, noteIds));
}

export function staccatoSelectedNotes(clipId: string, noteIds: readonly string[]): NoteEditResult {
  return run('スタッカート', (project) => staccatoNotesInProject(project, clipId, noteIds));
}

export function joinSelectedNotes(clipId: string, noteIds: readonly string[]): NoteEditResult {
  return run('連結', (project) => joinNotesInProject(project, clipId, noteIds));
}

/** 再生ヘッドの、クリップ内の tick。クリップの外なら断る理由の文。 */
export function playheadTickInClip(project: Project, clipId: string, positionBeat: number): number | string {
  const target = locateTarget(project, clipId);
  if (typeof target === 'string') return target;
  const placement = target.placements.find((clip) => clip.id === clipId) ?? target.placements[0]!;
  let local = beatTick(positionBeat) - beatTick(placement.startBeat);
  if (!Number.isFinite(positionBeat) || !Number.isSafeInteger(local) || local <= 0 || local >= beatTick(placement.lengthBeats)) {
    return '再生ヘッドがクリップの外にあります。分けたい音の途中に再生ヘッドを置いてください。';
  }
  // ループするクリップは、再生ヘッドをループ 1 周の中の位置に直す((再生ヘッド − クリップの始まり) mod 周期)。
  const period = beatTick(midiClipNaturalPatternLength(target.owner.notes ?? []));
  if (placement.loop && period > 0) local %= period;
  if (local <= 0) return '再生ヘッドがループの頭にあります。分けたい音の途中に再生ヘッドを置いてください。';
  return local;
}

export function splitSelectedNotesAtPlayhead(clipId: string, noteIds: readonly string[]): NoteEditResult {
  return run('分割', (project) => {
    const at = playheadTickInClip(project, clipId, useStore.getState().transport.positionBeat);
    return typeof at === 'string' ? refuse(at) : splitNotesInProject(project, clipId, noteIds, at);
  });
}

/** `gridSteps` 段(負は前)だけ、`snapBeats`(グリッド幅。整数 tick のものだけ)ずつ動かす。 */
export function nudgeSelectedNotes(
  clipId: string,
  noteIds: readonly string[],
  gridSteps: number,
  snapBeats: number,
): NoteEditResult {
  if (typeof gridSteps !== 'number' || !Number.isInteger(gridSteps) || gridSteps === 0 || Math.abs(gridSteps) > MAX_NUDGE_STEPS) {
    return refuse('動かす量を指定してください。');
  }
  const snapTicks = exactTicks(snapBeats);
  if (snapTicks === null || snapTicks < 1) return refuse('グリッドを正しく選んでください。');
  return run('移動', (project) => nudgeNotesInProject(project, clipId, noteIds, gridSteps * snapTicks));
}

export function rampSelectedVelocity(clipId: string, noteIds: readonly string[], from: number, to: number): NoteEditResult {
  return run('強さの編集', (project) => rampVelocityInProject(project, clipId, noteIds, from, to));
}
