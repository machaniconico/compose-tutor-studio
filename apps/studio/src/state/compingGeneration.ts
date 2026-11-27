// 伴奏パターンの生成(移植 P38 / wave5 US-021)。
//
// コードトラックを元に、新しい楽器トラック「伴奏」を 1 本作り、小節範囲を覆うクリップ 1 つに
// 伴奏の音を入れる。既存のトラック・クリップ・音には触らない(重なるクリップが生まれない)。
//
// 決めた規則:
// - 生成先は必ず新しいトラック(名前は「伴奏」、使われていれば「伴奏 2」…)。音色は利用者が選ぶ
//   (既定はピアノ風)。トラック・クリップ・音の追加が全体で Undo 1 段。トラック数が上限なら断る。
// - 録音中、プロジェクトを開いている途中、フェーダーなどの操作(トランザクション)が開いている間は断る。
// - 音はコードイベントの保存された構成音(なければ chordTones、再生と同じ)から作る。
//   コード名は読み直さない。スラッシュのベースは使えない(main のコードイベントに欄がない。P39)。
// - 音域: 利用者が選ぶ最低音(floor)以上、floor+24(最大 127)以下に必ず収める。
//   ボイスリーディングは、この範囲の全転回形 × 全オクターブから総移動量が最小のものを選ぶ
//   (同点は最高音が低い方、さらに低い音の並びが小さい方)。
// - パターンは小節ごとに適用する。どの音も小節線とコードの区間を越えない。
//   小節が「空」なのは、その小節のどこにもコードが鳴らないとき。拍子は拍子マップに従う。
// - 位置と長さは整数 tick(PPQ 480)。クリップは曲の長さを超えない。
// - 音の数は 1 クリップ MAX_EVENTS_PER_CLIP、実行時の予定は MAX_RUNTIME_SCHEDULE_EVENTS まで。
// - 事後確認: buildScheduleEvents が「生成前の予定 + 生成した音だけ」と多重集合で完全一致し、
//   同じ高さの重なりがないこと(newClipScheduleProblem)。
// - パターンに乱数はない(同じ入力なら同じ出力)。乱数を足すときは seed つきの PRNG を使うこと。

import {
  MAX_EVENTS_PER_CLIP,
  MAX_PROJECT_TRACKS,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  PPQ,
  addTrack,
  barToBeatAt,
  beatToBarPosition,
  chordTones,
  compileMusicalTime,
  createMidiClip,
  pitchClassNumber,
  type ChordEvent,
  type NoteEvent,
  type Project,
} from '@cts/project-model';
import { compareVoicings, type CompingPattern } from '@cts/theory-engine';
import { buildScheduleEvents } from '../audio/events';
import { canonicalSynthPresetName } from '../audio/presets';
import { uid } from './ids';
import { newClipScheduleProblem } from './noteEditActions';
import { useStore } from './store';

export const COMPING_TRACK_NAME = '伴奏';
export const COMPING_DEFAULT_PRESET = 'p22:pianoLike';
const VELOCITY = 90;
/** 最低音から最高音までの許す幅(半音)。 */
const REGISTER_SPAN = 24;
const BUSY_REASON = 'ほかの操作が終わってから試してください。';

const PATTERN_TIMING: Record<CompingPattern, { step: number; length: number }> = {
  whole: { step: Number.POSITIVE_INFINITY, length: Number.POSITIVE_INFINITY },
  eighths: { step: PPQ / 2, length: PPQ / 2 },
  arpUp: { step: PPQ, length: PPQ },
  arpUpDown: { step: PPQ, length: PPQ },
  stab: { step: PPQ, length: PPQ / 4 },
};

export const COMPING_PATTERN_OPTIONS: ReadonlyArray<{ value: CompingPattern; label: string; hint: string }> = [
  { value: 'whole', label: '全音符', hint: 'コードの長さいっぱい、和音を伸ばします。' },
  { value: 'eighths', label: '8分刻み', hint: '和音を8分音符で刻みます。' },
  { value: 'arpUp', label: 'アルペジオ(上行)', hint: '低い音から高い音へ、1拍に1音ずつ弾きます。' },
  { value: 'arpUpDown', label: 'アルペジオ(往復)', hint: '上がって下がるを繰り返し、1拍に1音ずつ弾きます。' },
  { value: 'stab', label: 'スタブ', hint: '拍の頭で和音を短く弾きます。' },
];

export const COMPING_REGISTER_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 48, label: '低め' },
  { value: 55, label: 'ふつう' },
  { value: 64, label: '高め' },
];

export type CompingRequest = Readonly<{
  /** 1 始まり。範囲は開始・終了の小節を含む。 */
  startBar: number;
  endBar: number;
  pattern: CompingPattern;
  /** ボイシングの最低音の基準(MIDI)。 */
  register: number;
  voiceLeading: boolean;
  /** 新しいトラックの音色(省略時はピアノ風)。 */
  preset?: string;
}>;

export type CompingOutcome =
  | Readonly<{
    ok: true;
    project: Project;
    trackId: string;
    clipId: string;
    noteCount: number;
    emptyBars: readonly number[];
    message: string;
  }>
  | Readonly<{ ok: false; reason: string }>;

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** 曲の小節数(最後の小節が曲の終わりで切れる場合も 1 小節と数える)。 */
export function projectBarCount(project: Project): number {
  try {
    const index = compileMusicalTime(project);
    const last = Math.max(0, project.lengthBeats - 1 / PPQ);
    return beatToBarPosition(index, last).bar + 1;
  } catch {
    return 0;
  }
}

function isWholeTick(beat: number): boolean {
  if (typeof beat !== 'number' || !Number.isFinite(beat)) return false;
  const ticks = Math.round(beat * PPQ);
  return Number.isSafeInteger(ticks) && ticks / PPQ === beat;
}

// 区間の端を内側へ丸める(音が必ず区間に収まる)。
const TICK_EPSILON = 1e-9;
const inwardStart = (beat: number) => Math.ceil(beat * PPQ - TICK_EPSILON) + 0;
const inwardEnd = (beat: number) => Math.floor(beat * PPQ + TICK_EPSILON);

function uniqueTrackName(project: Project): string {
  const used = new Set(project.tracks.map((track) => track.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? COMPING_TRACK_NAME : `${COMPING_TRACK_NAME} ${n}`;
    if (!used.has(name)) return name;
  }
}

/** コードの構成音(保存値、なければ chordTones と同じ)をルートからの近い順のピッチクラスにする。 */
function orderedPitchClasses(chord: ChordEvent): number[] {
  const tones = chordTones(chord);
  const pcs = [...new Set(tones.map((tone) => ((Math.trunc(tone) % 12) + 12) % 12))];
  if (pcs.length === 0) return [];
  let rootPc = pcs[0]!;
  try {
    rootPc = pitchClassNumber(chord.root);
  } catch {
    // 読めないルートは最初の構成音を基準にする(再生と同じ)。
  }
  return pcs.sort((a, b) => ((a - rootPc + 12) % 12) - ((b - rootPc + 12) % 12));
}

/** 全音が `floor` 以上 `ceiling` 以下に収まる、上へ近い順に積んだ全候補(転回形 × オクターブ)。 */
function voicingCandidates(pcs: readonly number[], floor: number, ceiling: number): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < pcs.length; r += 1) {
    const order = [...pcs.slice(r), ...pcs.slice(0, r)];
    for (let low = floor; low <= ceiling; low += 1) {
      if (low % 12 !== order[0]) continue;
      const voicing = [low];
      for (let i = 1; i < order.length; i += 1) {
        const prev = voicing[i - 1]!;
        voicing.push(prev + ((order[i]! - (prev % 12) + 12) % 12 || 12));
      }
      if (voicing[voicing.length - 1]! <= ceiling) out.push(voicing);
    }
  }
  return out;
}

function chooseVoicing(
  pcs: readonly number[],
  prev: readonly number[],
  floor: number,
  ceiling: number,
  voiceLeading: boolean,
): number[] | null {
  const all = voicingCandidates(pcs, floor, ceiling);
  if (all.length === 0) return null;
  const rootPosition = all.filter((voicing) => voicing[0]! % 12 === pcs[0]);
  const pool = voiceLeading && prev.length > 0 ? all : rootPosition;
  if (pool.length === 0) return null;
  // ボイスリーディングなしと最初のコードは、移動量を見ず最も低い根音位置にする(同点は低い方)。
  const from = voiceLeading ? prev : [];
  return [...pool].sort((a, b) => compareVoicings(from, a, b))[0]!;
}

type Segment = { start: number; end: number; bar: number };

/** コードの区間を小節線で分ける(拍子マップに従う)。端は整数 tick に内側へ丸める。 */
function barSegments(index: ReturnType<typeof compileMusicalTime>, startBeat: number, endBeat: number): Segment[] {
  const segments: Segment[] = [];
  let bar = beatToBarPosition(index, startBeat).bar;
  for (;;) {
    const barStart = barToBeatAt(index, bar);
    if (barStart >= endBeat) break;
    const barEnd = barToBeatAt(index, bar + 1);
    const start = inwardStart(Math.max(startBeat, barStart));
    const end = inwardEnd(Math.min(endBeat, barEnd));
    if (end > start) segments.push({ start, end, bar });
    bar += 1;
  }
  return segments;
}

/** 純粋関数: 条件を満たせば、新しいトラックと伴奏クリップを足した Project を返す。 */
export function generateCompingInProject(project: Project, request: CompingRequest): CompingOutcome {
  if (request === null || typeof request !== 'object') return refuse('伴奏の設定が読み取れませんでした。');
  const { startBar, endBar, pattern, register, voiceLeading } = request;
  if (typeof pattern !== 'string' || !COMPING_PATTERN_OPTIONS.some((option) => option.value === pattern)) {
    return refuse('伴奏のパターンを選んでください。');
  }
  if (typeof register !== 'number' || !Number.isInteger(register) || register < 0 || register > 127) {
    return refuse('音域は 0〜127 の整数で指定してください。');
  }
  if (!Number.isSafeInteger(startBar) || !Number.isSafeInteger(endBar) || startBar < 1 || endBar < startBar) {
    return refuse('小節の範囲は、1 以上で「はじめ ≦ おわり」になるように指定してください。');
  }
  const preset = request.preset === undefined ? COMPING_DEFAULT_PRESET : canonicalSynthPresetName(request.preset);
  if (preset === null) return refuse('音色を選び直してください。');
  if (project.tracks.length >= MAX_PROJECT_TRACKS) {
    return refuse(`トラックの数が上限(${MAX_PROJECT_TRACKS} 本)に達しているため、伴奏のトラックを足せません。使わないトラックを消してください。`);
  }

  let index: ReturnType<typeof compileMusicalTime>;
  let rangeStart: number;
  let rangeEnd: number;
  try {
    index = compileMusicalTime(project);
    rangeStart = barToBeatAt(index, startBar - 1);
    rangeEnd = Math.min(barToBeatAt(index, endBar), project.lengthBeats);
  } catch {
    return refuse('小節の位置を計算できませんでした。範囲を選び直してください。');
  }
  if (!(rangeStart < rangeEnd)) return refuse('指定した小節が曲の長さを超えています。範囲を選び直してください。');
  if (!isWholeTick(rangeStart) || !isWholeTick(rangeEnd)) {
    return refuse('この範囲は 1/480 拍の目盛りに乗っていないため、伴奏を作れません。');
  }

  const floor = register;
  const ceiling = Math.min(127, floor + REGISTER_SPAN);
  const { step, length } = PATTERN_TIMING[pattern];
  const arpeggio = pattern === 'arpUp' || pattern === 'arpUpDown';
  const chords = [...project.chordTrack]
    .filter((chord) => Number.isFinite(chord?.startBeat) && Number.isFinite(chord?.durationBeats))
    .sort((a, b) => a.startBeat - b.startBeat);

  const notes: NoteEvent[] = [];
  const soundingBars = new Set<number>();
  let previous: number[] = [];
  for (const chord of chords) {
    const start = Math.max(chord.startBeat, rangeStart);
    const end = Math.min(chord.startBeat + chord.durationBeats, rangeEnd);
    if (!(start < end)) continue;
    const pcs = orderedPitchClasses(chord);
    if (pcs.length === 0) continue; // 読めないコードは再生と同じく鳴らさない。
    const segments = barSegments(index, start, end);
    if (segments.length === 0) continue;
    const pitches = chooseVoicing(pcs, previous, floor, ceiling, voiceLeading === true);
    if (pitches === null) {
      return refuse('この音域では伴奏の音が 0〜127 に収まりません。音域を変えてみてください。');
    }
    previous = pitches;
    const sequence = pattern === 'arpUpDown' ? [...pitches, ...pitches.slice(1, -1).reverse()] : pitches;
    for (const segment of segments) {
      soundingBars.add(segment.bar);
      const ticks = segment.end - segment.start;
      const stepTicks = Math.min(step, ticks);
      if (notes.length + Math.ceil(ticks / stepTicks) * (arpeggio ? 1 : pitches.length) > MAX_EVENTS_PER_CLIP) {
        return refuse(`伴奏の音が ${MAX_EVENTS_PER_CLIP} 個を超えます。範囲を短くするか、音の数が少ないパターンにしてください。`);
      }
      for (let tick = segment.start, i = 0; tick < segment.end; tick += stepTicks, i += 1) {
        const durationTicks = Math.min(length, segment.end - tick);
        for (const pitch of arpeggio ? [sequence[i % sequence.length]!] : pitches) {
          notes.push({
            id: uid('note'),
            pitch,
            startBeat: (tick - rangeStart * PPQ) / PPQ,
            durationBeats: durationTicks / PPQ,
            velocity: VELOCITY,
          });
        }
      }
    }
  }
  if (notes.length === 0) {
    return refuse('範囲内にコードがないため、伴奏を作れません。先にコードトラックにコードを置いてください。');
  }
  for (const note of notes) {
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || !isWholeTick(note.startBeat)
      || !isWholeTick(note.durationBeats) || note.durationBeats <= 0
      || note.startBeat < 0 || note.startBeat + note.durationBeats > rangeEnd - rangeStart) {
      return refuse('音の高さか位置が範囲を外れるため、伴奏を作れませんでした。音域を変えてみてください。');
    }
  }

  const added = addTrack(project, 'instrument', { name: uniqueTrackName(project) });
  if (!added.ok) {
    return refuse('伴奏のトラックを足せませんでした。トラックの数や名前を確かめてください。');
  }
  const clip = { ...createMidiClip(added.trackId, rangeStart, rangeEnd - rangeStart), notes };
  const next: Project = {
    ...added.project,
    tracks: added.project.tracks.map((track) => track.id === added.trackId
      ? { ...track, clips: [clip], instrument: { type: 'synth' as const, preset } }
      : track),
  };

  // 事後確認: 予定(buildScheduleEvents)が「生成前 + 生成した音だけ」と完全に一致すること。
  let scheduleLength: number;
  try {
    scheduleLength = buildScheduleEvents(next).length;
  } catch {
    return refuse('伴奏を入れると再生の予定を組めなくなるため、取りやめました。曲はそのままです。');
  }
  if (scheduleLength > MAX_RUNTIME_SCHEDULE_EVENTS) {
    return refuse('伴奏を入れると曲全体の音の数が再生できる上限を超えるため、取りやめました。範囲を短くしてください。');
  }
  const problem = newClipScheduleProblem(project, next, clip.id);
  if (problem) return refuse(problem);

  const emptyBars: number[] = [];
  for (let bar = startBar; bar <= endBar; bar += 1) {
    if (barToBeatAt(index, bar - 1) < rangeEnd && !soundingBars.has(bar - 1)) emptyBars.push(bar);
  }
  const emptyText = emptyBars.length > 0
    ? ` ${emptyBars.join('・')} 小節目はコードがない(または読めない)ため、空けてあります。`
    : '';
  const trackName = added.project.tracks.find((track) => track.id === added.trackId)?.name ?? COMPING_TRACK_NAME;
  return {
    ok: true,
    project: next,
    trackId: added.trackId,
    clipId: clip.id,
    noteCount: notes.length,
    emptyBars,
    message: `新しいトラック「${trackName}」の ${startBar}〜${endBar} 小節に、伴奏を ${notes.length} 音つくりました。${emptyText}`,
  };
}

export type CompingResult =
  | Readonly<{ ok: true; trackId: string; clipId: string; noteCount: number; emptyBars: readonly number[]; message: string }>
  | Readonly<{ ok: false; reason: string }>;

/** 店(store)への反映。Undo 1 段。録音中・プロジェクトを開いている途中・操作が開いている間は断る。 */
export function generateCompingClip(request: CompingRequest): CompingResult {
  const state = useStore.getState();
  if (state.audioRecordingOperationId !== null) {
    return refuse('録音中は伴奏を作れません。録音を止めてからやり直してください。');
  }
  if (state.projectOperationBusy) return refuse('プロジェクトを開いている途中のため、今は伴奏を作れません。');
  if (state.isProjectTransactionOpen()) return refuse(BUSY_REASON);
  const snapshot = state.project;
  const outcome = generateCompingInProject(snapshot, request);
  if (!outcome.ok) return outcome;
  const applied = state.applyProjectChange((current) => (current === snapshot ? outcome.project : current));
  if (!applied || useStore.getState().project === snapshot) {
    return refuse('今は伴奏を反映できませんでした。曲はそのままです。もう一度お試しください。');
  }
  return {
    ok: true,
    trackId: outcome.trackId,
    clipId: outcome.clipId,
    noteCount: outcome.noteCount,
    emptyBars: outcome.emptyBars,
    message: outcome.message,
  };
}
