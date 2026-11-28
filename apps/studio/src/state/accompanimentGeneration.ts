// おまかせ伴奏(移植 P3A / wave5 US-031)。
//
// コードトラックと調から、ベース・コード(和音)・ドラムの 3 トラックを一度に作る。
//
// 決めた規則:
// - 生成先は必ず新しいトラック 3 本(「伴奏」「ベース」「ドラム」、使われていれば「… 2」)。
//   既存のトラック・クリップ・音には一切触れない(wave5 のような置き換えや確認は不要)。
//   トラック・クリップ・音の追加が全体で Undo 1 段。トラックが 3 本足せないときは断る。
// - 範囲: コードトラックが覆う小節(最初のコードの小節〜最後のコードの小節)。曲の長さを超えない。
//   クリップは小節の頭から始まるので、ドラムのマス目が小節とそろう。
// - コード: P38 の generateCompingInProject をそのまま使う(保存された構成音、近い音でつなぐ)。
// - ベース・ドラム: theory-engine の generateAccompaniment(P13)。ベースはルート+5度までで
//   E1〜G3(MIDI 28〜55)に収める。ドラムは 16 ステップ(拍子に応じる)で、クリップの
//   drumGroove は付けない(曲のスウィングを引き継ぐ)。ハイハットのチョークは曲の設定のまま。
// - 乱数は seed つき。seed はコードトラックの中身と雰囲気から決める(Math.random は使わない)。
// - 録音中、プロジェクトを開いている途中、操作(トランザクション)が開いている間、
//   コードがない曲、範囲内で拍子が変わる曲は断る。
// - 事後確認: 音を足した 2 クリップは newClipScheduleProblem、ドラムは予定の増分が一致すること。
//   1 つでも失敗したら何も変えない。

import {
  GROOVE_RESOLVER_PPQ,
  MAX_EVENTS_PER_CLIP,
  MAX_PROJECT_TRACKS,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  PPQ,
  addTrack,
  barToBeatAt,
  beatToBarPosition,
  compileMusicalTime,
  chordTones,
  cutSwingOverlaps,
  isGrooveResolvedMode,
  pitchClassNumber,
  resolveGrooveNoteSpan,
  timeSignatureAtBeat,
  type Clip,
  type DrumEvent,
  type DrumLane,
  type NoteEvent,
  type Project,
  type TrackIdFactory,
} from '@cts/project-model';
import { ACCOMPANIMENT_MOODS, generateAccompaniment, type AccompanimentMood } from '@cts/theory-engine';
import { buildScheduleEvents, type DrumScheduleEvent, type NoteScheduleEvent, type SchedulePayload } from '../audio/events';
import { canonicalSynthPresetName } from '../audio/presets';
import { generateCompingInProject, projectBarCount } from './compingGeneration';
import { useStore } from './store';

export { ACCOMPANIMENT_MOODS };
export type { AccompanimentMood };

export const BASS_TRACK_NAME = 'ベース';
export const DRUM_TRACK_NAME = 'ドラム';
const BASS_PRESET = 'warmBass';
const COMPING_REGISTER = 55;
/** ベースの許す音域: E1〜G3。 */
export const BASS_LOW = 28;
export const BASS_HIGH = 55;
const TRACKS_ADDED = 3;
const ROOT_VELOCITY = 92;
const FIFTH_VELOCITY = 80;
const COMPING_FALLBACK_PRESET = 'p22:pianoLike';
const COMPING_TRACK_NAME = '伴奏';
const BUSY_REASON = 'ほかの操作が終わってから試してください。';

export type AccompanimentRequest = Readonly<{ mood: AccompanimentMood }>;

type ExpectedNote = Readonly<{
  trackId: string; preset: string; beat: number; durationBeats: number; pitch: number; velocity: number; clipEndBeat: number;
}>;
type ExpectedDrum = Readonly<{ trackId: string; lane: DrumLane; tick: number; velocity: number }>;
/** 生成した音の、絶対位置での期待値(事後確認の「正解」)。 */
export type ExpectedAccompaniment = Readonly<{ notes: readonly ExpectedNote[]; drums: readonly ExpectedDrum[] }>;

export type AccompanimentOutcome =
  | Readonly<{
    ok: true;
    project: Project;
    trackIds: Readonly<{ chords: string; bass: string; drums: string }>;
    startBar: number;
    endBar: number;
    counts: Readonly<{ chords: number; bass: number; drums: number }>;
    expected: ExpectedAccompaniment;
    message: string;
  }>
  | Readonly<{ ok: false; reason: string }>;

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

const PAST_END_REASON = '曲の長さより後ろにコードがあります。曲の長さを延ばすか、コードを短くしてください。';
const SCHEDULE_REASON = '作った音が予定の位置や長さで鳴らないため、取りやめました。曲はそのままです。';

function hashText(seed: number, text: string): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash;
}

/** コードトラックの中身と雰囲気から決まる整数(同じ曲・同じ雰囲気なら同じ値)。 */
export function accompanimentSeed(project: Project, mood: string): number {
  let hash = hashText(0, mood);
  for (const chord of project.chordTrack) {
    hash = hashText(hash, `|${String(chord.symbol)}@${String(chord.startBeat)}+${String(chord.durationBeats)}`);
  }
  return hash;
}

/** プロジェクト内のすべての id(`id` という名前の文字列)。 */
function existingIds(project: Project): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'id' && typeof inner === 'string') ids.add(inner);
        else walk(inner);
      }
    }
  };
  walk(project);
  return ids;
}

/**
 * 決定的な id。シードと「部品+通し番号」だけで決まる。既存の id とぶつかったら、
 * シードを混ぜ直して(塩を増やして)別の接頭辞に替える。
 */
function createIdSource(project: Project, seed: number) {
  const taken = existingIds(project);
  let salt = 0;
  let prefix = '';
  const refresh = () => { prefix = hashText(seed, `salt${salt}`).toString(36); };
  refresh();
  return (part: string): TrackIdFactory => {
    let index = 0;
    return (kind) => {
      for (;;) {
        index += 1;
        const id = `${kind}-acc${prefix}-${part}${index.toString(36)}`;
        if (!taken.has(id)) {
          taken.add(id);
          return id;
        }
        salt += 1;
        refresh();
      }
    };
  };
}

function uniqueName(project: Project, base: string): string {
  const used = new Set(project.tracks.map((track) => track.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!used.has(name)) return name;
  }
}

const inwardStart = (beat: number) => Math.ceil(beat * PPQ);
const inwardEnd = (beat: number) => Math.floor(beat * PPQ);

/** ベースの 5 度: コードの構成音のうち 7 半音上、なければ 6、なければ 8 半音上。なければ null。 */
function chordFifthInterval(chord: Project['chordTrack'][number], rootPc: number): number | null {
  const intervals = new Set(chordTones(chord).map((tone) => (((Math.trunc(tone) - rootPc) % 12) + 12) % 12));
  for (const interval of [7, 6, 8]) if (intervals.has(interval)) return interval;
  return null;
}

type BassSpan = { start: number; end: number; pitch: number; velocity: number };

/** ベース: 小節ごと・コードごとにルート(頭)と 5 度(後半、2 拍以上あるときだけ)。tick 単位。 */
function bassSpans(
  project: Project,
  index: ReturnType<typeof compileMusicalTime>,
  chords: readonly Project['chordTrack'][number][],
  rangeStartTick: number,
  rangeEndTick: number,
): BassSpan[] {
  const spans: BassSpan[] = [];
  for (const chord of [...chords].sort((a, b) => a.startBeat - b.startBeat)) {
    const tones = chordTones(chord);
    if (tones.length === 0) continue;
    let rootPc = (((Math.trunc(tones[0]!) % 12) + 12) % 12);
    try {
      rootPc = pitchClassNumber(chord.root);
    } catch {
      // 読めないルートは最初の構成音(再生と同じ)。
    }
    const fifth = chordFifthInterval(chord, rootPc);
    const chordStart = Math.max(inwardStart(chord.startBeat), rangeStartTick);
    const chordEnd = Math.min(inwardEnd(chord.startBeat + chord.durationBeats), rangeEndTick);
    if (chordEnd <= chordStart) continue;
    let bar = beatToBarPosition(index, chordStart / PPQ).bar;
    for (;;) {
      const barStart = Math.round(barToBeatAt(index, bar) * PPQ);
      if (barStart >= chordEnd) break;
      const barEnd = Math.round(barToBeatAt(index, bar + 1) * PPQ);
      const start = Math.max(chordStart, barStart);
      const end = Math.min(chordEnd, barEnd);
      bar += 1;
      if (end <= start) continue;
      const root = 36 + rootPc;
      const length = end - start;
      if (fifth === null || length < 2 * PPQ) {
        spans.push({ start, end, pitch: root, velocity: ROOT_VELOCITY });
      } else {
        const half = Math.floor(length / 2);
        spans.push({ start, end: start + half, pitch: root, velocity: ROOT_VELOCITY });
        spans.push({ start: start + half, end, pitch: root + fifth, velocity: FIFTH_VELOCITY });
      }
    }
  }
  return spans;
}

/**
 * 事後確認(予定と予定の比較): 追加した 3 トラック以外の予定が生成前と同じで、
 * 新しいトラックの予定が「生成した音の期待値」と多重集合で完全に一致し(音: 位置・長さ・高さ・強さ、
 * ドラム: レーン・位置・強さ)、同じトラック・同じ高さの音が重ならないこと。問題がなければ null。
 * スウィングは、期待値にも再生と同じ解決(resolveGrooveNoteSpan / authoredBeat)をかけて比べる。
 */
export function accompanimentScheduleProblem(before: Project, after: Project, expected: ExpectedAccompaniment): string | null {
  let a: ReturnType<typeof buildScheduleEvents>;
  let b: ReturnType<typeof buildScheduleEvents>;
  try {
    a = buildScheduleEvents(before);
    b = buildScheduleEvents(after);
  } catch {
    return '伴奏を入れると再生の予定を組めなくなるため、取りやめました。曲はそのままです。';
  }
  if (b.length > MAX_RUNTIME_SCHEDULE_EVENTS) {
    return '伴奏を入れると曲全体の音の数が再生できる上限を超えるため、取りやめました。範囲を短くしてください。';
  }
  const newTracks = new Set([...expected.notes.map((n) => n.trackId), ...expected.drums.map((d) => d.trackId)]);
  const count = (keys: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const same = (x: Map<string, number>, y: Map<string, number>) =>
    x.size === y.size && [...x].every(([key, n]) => y.get(key) === n);
  const trackOf = (event: { payload: unknown }) => (event.payload as SchedulePayload).trackId;

  const keep = (event: { beat: number; payload: unknown }) => JSON.stringify([event.beat, event.payload]);
  if (!same(count(a.map(keep)), count(b.filter((e) => !newTracks.has(trackOf(e))).map(keep)))) return SCHEDULE_REASON;

  const resolved = isGrooveResolvedMode(after);
  const wantNotes: string[] = [];
  // 再生と同じ、スウィングで同じ高さの次の音に食い込む音を、次の鳴り始めで切る規則を期待値にもかける。
  const spans = resolved
    ? expected.notes.map((note) => resolveGrooveNoteSpan(after, note.beat, note.durationBeats, note.clipEndBeat))
    : [];
  if (spans.some((span) => span === null)) return SCHEDULE_REASON;
  const cut = resolved
    ? cutSwingOverlaps(expected.notes.map((note, i) => ({ group: `${note.trackId}:${note.pitch}`, span: spans[i]! })))
    : [];
  expected.notes.forEach((note, i) => {
    let beat = note.beat;
    let durationBeats = note.durationBeats;
    if (resolved) {
      beat = spans[i]!.onsetTick / GROOVE_RESOLVER_PPQ;
      durationBeats = (cut[i]!.endTick - spans[i]!.onsetTick) / GROOVE_RESOLVER_PPQ;
    }
    wantNotes.push(JSON.stringify([beat, note.trackId, note.preset, note.pitch, durationBeats, note.velocity]));
  });
  const gotNotes: string[] = [];
  const wantDrums = expected.drums.map((d) => JSON.stringify([d.trackId, d.lane, d.tick, d.velocity]));
  const gotDrums: string[] = [];
  const byPitch = new Map<string, Array<[number, number]>>();
  for (const event of b) {
    if (!newTracks.has(trackOf(event))) continue;
    const payload = event.payload as SchedulePayload;
    if (payload.kind === 'note') {
      const note = payload as NoteScheduleEvent;
      gotNotes.push(JSON.stringify([event.beat, note.trackId, note.preset, note.pitch, note.durationBeats, note.velocity]));
      const key = `${note.trackId}:${note.pitch}`;
      const list = byPitch.get(key) ?? [];
      list.push([Math.round(event.beat * PPQ), Math.round((event.beat + note.durationBeats) * PPQ)]);
      byPitch.set(key, list);
    } else {
      const drum = payload as DrumScheduleEvent;
      const authored = drum.authoredBeat ?? event.beat;
      gotDrums.push(JSON.stringify([drum.trackId, drum.lane, Math.round(authored * PPQ), drum.velocity]));
    }
  }
  if (!same(count(wantNotes), count(gotNotes)) || !same(count(wantDrums), count(gotDrums))) return SCHEDULE_REASON;
  for (const list of byPitch.values()) {
    list.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i]![0] < list[i - 1]![1]) return '新しい伴奏の音が同じ高さで重なるため、取りやめました。曲はそのままです。';
    }
  }
  return null;
}

/** 純粋関数: 条件を満たせば、3 つのトラックを足した Project を返す。 */
export function generateAccompanimentInProject(project: Project, request: AccompanimentRequest): AccompanimentOutcome {
  if (request === null || typeof request !== 'object') return refuse('伴奏の設定が読み取れませんでした。');
  const chords = Array.isArray(project.chordTrack)
    ? project.chordTrack.filter((chord) => Number.isFinite(chord?.startBeat) && Number.isFinite(chord?.durationBeats)
      && chord.durationBeats > 0)
    : [];
  // 最初に確かめる: 曲の長さより後ろへ伸びるコードがあるときは、何も作らない。
  if (chords.some((chord) => chord.startBeat + chord.durationBeats > project.lengthBeats)) {
    return refuse(PAST_END_REASON);
  }
  const { mood } = request;
  if (typeof mood !== 'string' || !Object.hasOwn(ACCOMPANIMENT_MOODS, mood)) {
    return refuse('伴奏の雰囲気を一覧から選んでください。');
  }
  if (chords.length === 0) {
    return refuse('コードトラックにコードがないため、伴奏を作れません。先にコードを置いてください。');
  }
  if (project.tracks.length + TRACKS_ADDED > MAX_PROJECT_TRACKS) {
    return refuse(`トラックの数が上限(${MAX_PROJECT_TRACKS} 本)に近く、伴奏の 3 トラックを足せません。使わないトラックを消してください。`);
  }

  // 範囲: コードがある小節。終わりは、最後のコードの終わり(整数 tick)を含む小節線まで。
  let index: ReturnType<typeof compileMusicalTime>;
  let startBar: number;
  let endBar: number;
  try {
    index = compileMusicalTime(project);
    const firstTick = Math.max(0, Math.floor(Math.min(...chords.map((chord) => chord.startBeat)) * PPQ));
    const lastEndTick = Math.ceil(Math.max(...chords.map((chord) => chord.startBeat + chord.durationBeats)) * PPQ);
    startBar = beatToBarPosition(index, firstTick / PPQ).bar + 1;
    endBar = Math.min(beatToBarPosition(index, (lastEndTick - 1) / PPQ).bar + 1, projectBarCount(project));
  } catch {
    return refuse('小節の位置を計算できませんでした。コードの位置を確かめてください。');
  }

  // コードの音: P38 の生成をそのまま使う。再生の確認はこちらでやり直すので、
  // P38 側の検査は(スウィングなしの)従来の再生で通す。生成する音はスウィングに依らない。
  const comping = generateCompingInProject({ ...project, swing: 0, hiHatChoke: false }, {
    startBar,
    endBar,
    pattern: mood === 'soft' ? 'whole' : 'stab',
    register: COMPING_REGISTER,
    voiceLeading: true,
  });
  if (!comping.ok) return comping;
  const compingSource = comping.project.tracks.find((track) => track.id === comping.trackId)!;
  const compingClipSource = compingSource.clips[0]!;
  const rangeStart = barToBeatAt(index, startBar - 1);
  const rangeEnd = Math.min(barToBeatAt(index, endBar), project.lengthBeats);
  const rangeStartTick = Math.round(rangeStart * PPQ);
  const rangeEndTick = Math.round(rangeEnd * PPQ);

  // ドラムのマス目は 1 つの拍子を前提にするので、範囲内で拍子が変わる曲は断る。
  const [numerator, denominator] = timeSignatureAtBeat(index, rangeStart);
  for (const event of project.timeSignatureMap) {
    if (event.beat > rangeStart && event.beat < rangeEnd) {
      const [n, d] = timeSignatureAtBeat(index, event.beat);
      if (n !== numerator || d !== denominator) {
        return refuse('範囲の途中で拍子が変わるため、ドラムをそろえて作れません。拍子が同じ範囲でお試しください。');
      }
    }
  }
  const beatsPerBar = (numerator * 4) / denominator;
  const stepsPerBar = beatsPerBar * 4;
  if (!Number.isInteger(stepsPerBar) || stepsPerBar < 1 || stepsPerBar > 192) {
    return refuse('この拍子ではドラムのマス目を作れないため、伴奏を作れません。');
  }

  const seed = accompanimentSeed(project, mood);
  const generated = generateAccompaniment(chords, {
    seed,
    mood,
    complexity: 0.5,
    intensity: 0.5,
    beatsPerBar,
    drumStepsPerBar: stepsPerBar,
    windows: { drums: { startBeat: rangeStart, endBeat: rangeEnd } },
  });
  if (!generated.ok) return refuse(generated.reason);
  const bass = bassSpans(project, index, chords, rangeStartTick, rangeEndTick);
  if (bass.length > MAX_EVENTS_PER_CLIP || generated.drums.length > MAX_EVENTS_PER_CLIP) {
    return refuse(`伴奏の音が 1 クリップの上限(${MAX_EVENTS_PER_CLIP} 個)を超えます。コードの範囲を短くしてください。`);
  }
  const clipTicks = rangeEndTick - rangeStartTick;
  for (const hit of generated.drums) {
    const tick = Math.round(hit.startBeat * PPQ);
    if (!Number.isInteger(hit.stepIndex) || hit.stepIndex < 0 || tick < 0 || tick >= clipTicks) {
      return refuse('ドラムの位置が範囲を外れるため、伴奏を作れませんでした。');
    }
  }
  for (const span of bass) {
    if (span.pitch < BASS_LOW || span.pitch > BASS_HIGH) {
      return refuse('ベースの音の高さが範囲(E1〜G3)を外れるため、伴奏を作れませんでした。');
    }
  }
  const bassPreset = canonicalSynthPresetName(BASS_PRESET);
  if (bassPreset === null) return refuse('ベースの音色を読み込めませんでした。');

  // 決定的な id でトラック・クリップ・音を作る。
  const idSource = createIdSource(project, seed);
  const noteIds = (part: string) => {
    const make = idSource(`${part}n`);
    return () => make('note');
  };
  const addPart = (base: Project, kind: 'instrument' | 'drum', part: string, name: string) => {
    const added = addTrack(base, kind, { name: uniqueName(base, name), idFactory: idSource(part) });
    if (!added.ok) return null;
    const track = added.project.tracks.find((candidate) => candidate.id === added.trackId)!;
    return { project: added.project, track, clipId: track.clips[0]!.id };
  };
  const withClip = (base: Project, trackId: string, clip: Clip, instrument?: { type: 'synth'; preset: string }): Project => ({
    ...base,
    tracks: base.tracks.map((track) => track.id === trackId
      ? { ...track, clips: [clip], ...(instrument ? { instrument } : {}) }
      : track),
  });
  const clipStart = rangeStart;
  const clipLength = rangeEnd - rangeStart;
  const midiClip = (id: string, trackId: string, notes: NoteEvent[]): Clip => ({
    id, trackId, type: 'midi', startBeat: clipStart, lengthBeats: clipLength, loop: false, notes,
  });
  const preset = compingSource.instrument?.preset ?? COMPING_FALLBACK_PRESET;

  const chordsPart = addPart(project, 'instrument', 'c', uniqueName(project, COMPING_TRACK_NAME));
  if (!chordsPart) return refuse('伴奏のトラックを足せませんでした。トラックの数や名前を確かめてください。');
  const chordNoteId = noteIds('c');
  const chordNotes: NoteEvent[] = (compingClipSource.notes ?? []).map((note) => ({ ...note, id: chordNoteId() }));
  let next = withClip(chordsPart.project, chordsPart.track.id, midiClip(chordsPart.clipId, chordsPart.track.id, chordNotes),
    { type: 'synth', preset });

  const bassPart = addPart(next, 'instrument', 'b', BASS_TRACK_NAME);
  if (!bassPart) return refuse('ベースのトラックを足せませんでした。トラックの数や名前を確かめてください。');
  const bassNoteId = noteIds('b');
  const bassNotes: NoteEvent[] = bass.map((span) => ({
    id: bassNoteId(),
    pitch: span.pitch,
    startBeat: (span.start - rangeStartTick) / PPQ,
    durationBeats: (span.end - span.start) / PPQ,
    velocity: span.velocity,
  }));
  next = withClip(bassPart.project, bassPart.track.id, midiClip(bassPart.clipId, bassPart.track.id, bassNotes),
    { type: 'synth', preset: bassPreset });

  const drumPart = addPart(next, 'drum', 'd', DRUM_TRACK_NAME);
  if (!drumPart) return refuse('ドラムのトラックを足せませんでした。トラックの数や名前を確かめてください。');
  const drumId = idSource('dn');
  const drumEvents: DrumEvent[] = generated.drums.map((hit) => ({
    id: drumId('drum'),
    lane: hit.lane,
    stepIndex: hit.stepIndex,
    velocity: hit.velocity,
  }));
  // drumGroove は付けない = 曲のスウィングを引き継ぐ。
  const drumClip: Clip = {
    id: drumPart.clipId, trackId: drumPart.track.id, type: 'drum', startBeat: clipStart, lengthBeats: clipLength,
    loop: false, stepsPerBar, drumEvents,
  };
  next = withClip(drumPart.project, drumPart.track.id, drumClip);

  const clipEndBeat = rangeEnd;
  const expected: ExpectedAccompaniment = {
    notes: [
      ...chordNotes.map((note) => ({ trackId: chordsPart.track.id, preset, beat: clipStart + note.startBeat,
        durationBeats: note.durationBeats, pitch: note.pitch, velocity: note.velocity, clipEndBeat })),
      ...bassNotes.map((note) => ({ trackId: bassPart.track.id, preset: bassPreset, beat: clipStart + note.startBeat,
        durationBeats: note.durationBeats, pitch: note.pitch, velocity: note.velocity, clipEndBeat })),
    ],
    drums: generated.drums.map((hit) => ({
      trackId: drumPart.track.id, lane: hit.lane, tick: rangeStartTick + Math.round(hit.startBeat * PPQ), velocity: hit.velocity,
    })),
  };
  const problem = accompanimentScheduleProblem(project, next, expected);
  if (problem) return refuse(problem);

  const counts = { chords: chordNotes.length, bass: bassNotes.length, drums: drumEvents.length };
  return {
    ok: true,
    project: next,
    trackIds: { chords: chordsPart.track.id, bass: bassPart.track.id, drums: drumPart.track.id },
    startBar,
    endBar,
    counts,
    expected,
    message: `${startBar}〜${endBar} 小節に、新しいトラック 3 本(コード・ベース・ドラム)を作りました。今のトラックはそのままです。`,
  };
}

export type AccompanimentResult =
  | Readonly<{ ok: true; message: string; counts: Readonly<{ chords: number; bass: number; drums: number }> }>
  | Readonly<{ ok: false; reason: string }>;

/** 店(store)への反映。Undo 1 段。録音中・プロジェクトを開いている途中・操作が開いている間は断る。 */
export function generateAccompanimentSet(request: AccompanimentRequest): AccompanimentResult {
  const state = useStore.getState();
  if (state.audioRecordingOperationId !== null) {
    return refuse('録音中は伴奏を作れません。録音を止めてからやり直してください。');
  }
  if (state.projectOperationBusy) return refuse('プロジェクトを開いている途中のため、今は伴奏を作れません。');
  if (state.isProjectTransactionOpen()) return refuse(BUSY_REASON);
  const snapshot = state.project;
  const outcome = generateAccompanimentInProject(snapshot, request);
  if (!outcome.ok) return outcome;
  const applied = state.applyProjectChange((current) => (current === snapshot ? outcome.project : current));
  if (!applied || useStore.getState().project === snapshot) {
    return refuse('今は伴奏を反映できませんでした。曲はそのままです。もう一度お試しください。');
  }
  return { ok: true, message: outcome.message, counts: outcome.counts };
}
