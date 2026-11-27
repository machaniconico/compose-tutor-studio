// ピアノロールの「コードを調べる」: 選んだ音(または小節の範囲)からコード名の候補を出し、
// コードトラックへ 1 手(Undo 1 段)で足す。候補は目安であり、断定はしない。
//
// 小節の範囲だけを指定した時は、再生で実際に鳴る音(buildScheduleEvents)から調べる。
// 音は「音名(0〜11)」だけで見る。オクターブの違いは、いちばん低い音(転回形・分数コード)
// の判定にだけ使う。長さによる重みづけはしない(wave5 の detectChords も同じ)。

import type { ChordEvent, Clip, Project } from '@cts/project-model';
import {
  MAX_PROJECT_TIMELINE_BEATS,
  PPQ,
  barToBeatAt,
  beatToBarPosition,
  compileMusicalTime,
} from '@cts/project-model';
import {
  MAX_CHORD_DETECTION_NOTES,
  detectChords,
  parseChord,
  pitchClassToSharpName,
  type ChordDetectionCandidate,
} from '@cts/theory-engine';
import { buildScheduleEvents, type NoteScheduleEvent } from '../audio/events';
import { publishAppEvent } from './appEvents';
import { buildChordEvent } from './editorActions';
import { useStore } from './store';

export const MAX_CHORD_SUGGESTIONS = 3;

const KANA = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'] as const;
const INVERSION_NAMES = ['', '第1転回形', '第2転回形', '第3転回形'] as const;

const names = (pcs: readonly number[]): string => pcs.map(pitchClassToSharpName).join('・');
const kana = (pcs: readonly number[]): string => pcs.map((pc) => KANA[pc] ?? '').join('');

export type ChordSuggestion = Readonly<{
  symbol: string;
  /** 1 位だけ「いちばん近い」、以降は「ほかの可能性」。 */
  rank: number;
  reason: string;
}>;

export type ChordSuggestionResult = Readonly<{
  suggestions: readonly ChordSuggestion[];
  /** 候補が無い時の、やさしい説明。候補がある時は null。 */
  emptyMessage: string | null;
}>;

export type BarRange = Readonly<{ startBar: number; endBar: number }>;

type RangeNote = Readonly<{ id: string; pitch: number; startBeat: number; durationBeats: number }>;

function clipNotes(clip: Clip | null): readonly RangeNote[] {
  return clip?.type === 'midi' ? clip.notes ?? [] : [];
}

function isWholeBar(value: number): boolean {
  return Number.isSafeInteger(value);
}

/** 小節範囲([startBar, endBar) 、0 始まり)を曲の長さに収めた拍位置へ。範囲が不正なら null。 */
export function barRangeBeats(
  project: Project,
  range: BarRange,
): { startBeat: number; endBeat: number; endBar: number } | null {
  if (!isWholeBar(range.startBar) || !isWholeBar(range.endBar)) return null;
  const endBar = Math.min(range.endBar, project.lengthBars);
  if (range.startBar < 0 || endBar <= range.startBar) return null;
  const time = compileMusicalTime(project);
  const startBeat = barToBeatAt(time, range.startBar);
  const endBeat = Math.min(barToBeatAt(time, endBar), project.lengthBeats);
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat <= startBeat) return null;
  // コードは tick の整数位置にだけ置く。
  const tick = (beat: number): boolean => Math.abs(beat * PPQ - Math.round(beat * PPQ)) < 1e-6;
  if (!tick(startBeat) || !tick(endBeat)) return null;
  return { startBeat, endBeat, endBar };
}

/** 選んだ音(なければクリップ全体)が入る小節範囲。 */
export function initialBarRange(
  project: Project,
  clip: Clip | null,
  selectedNoteIds: readonly string[],
): BarRange {
  const time = compileMusicalTime(project);
  const notes = clipNotes(clip);
  const picked = notes.filter((note) => selectedNoteIds.includes(note.id));
  const base = clip?.startBeat ?? 0;
  const first = picked.length > 0
    ? Math.min(...picked.map((note) => base + note.startBeat))
    : base;
  const last = picked.length > 0
    ? Math.max(...picked.map((note) => base + note.startBeat + note.durationBeats))
    : base + (clip?.lengthBeats ?? project.lengthBeats);
  const clamp = (beat: number): number => Math.min(project.lengthBeats, Math.max(0, beat));
  const startBar = beatToBarPosition(time, clamp(first)).bar;
  const endBar = beatToBarPosition(time, clamp(last - 1 / PPQ)).bar + 1;
  return { startBar, endBar: Math.max(endBar, startBar + 1) };
}

function reasonFor(
  candidate: ChordDetectionCandidate,
  observed: ReadonlySet<number>,
  key: string,
): string {
  const slash = candidate.symbol.indexOf('/');
  let chordPcs = candidate.pitchClasses;
  let inversion = 0;
  let external = false;
  if (slash >= 0) {
    try {
      chordPcs = parseChord(candidate.symbol.slice(0, slash), key).pitchClasses;
    } catch {
      chordPcs = candidate.pitchClasses.filter((pc) => pc !== candidate.bassPitchClass);
    }
    inversion = chordPcs.indexOf(candidate.bassPitchClass);
    external = inversion < 0;
  }
  const present = chordPcs.filter((pc) => observed.has(pc));
  const missing = chordPcs.filter((pc) => !observed.has(pc));
  const extra = [...observed].filter((pc) => !chordPcs.includes(pc) && pc !== candidate.bassPitchClass);
  const bass = pitchClassToSharpName(candidate.bassPitchClass);

  let text: string;
  if (slash < 0) {
    text = `${names(present)} が入っているので ${candidate.symbol}(${kana(chordPcs)})かもしれません。`;
  } else if (external) {
    text = `${names(present)} の和音の下で ${bass} が低く鳴っているので、${candidate.symbol}(${bass} を低音にした形)かもしれません。`;
  } else {
    const rootName = candidate.symbol.slice(0, slash);
    text = `${names(present)} が入っていて、いちばん低い音が ${bass} なので、${rootName} の${INVERSION_NAMES[inversion] ?? '転回形'}(${candidate.symbol})かもしれません。`;
  }
  if (missing.length > 0) text += `${names(missing)} はまだ入っていません。足すとはっきりします。`;
  if (extra.length > 0) text += `ほかに ${names(extra)} も鳴っているので、飾りの音かもしれません。`;
  return text;
}

/** 範囲内の音(選んだ音があればそれだけ)からコードの候補を最大 3 つ。 */
export function suggestChordsForRange(
  project: Project,
  clip: Clip | null,
  selectedNoteIds: readonly string[],
  range: BarRange,
): ChordSuggestionResult {
  const beats = barRangeBeats(project, range);
  if (!beats) {
    return { suggestions: [], emptyMessage: '小節の範囲を決められませんでした。曲の長さの中で、開始より後ろの小節を選んでください。' };
  }
  const base = clip?.startBeat ?? 0;
  const onlySelected = selectedNoteIds.length > 0;
  let inRange: readonly RangeNote[];
  if (onlySelected) {
    // 選んだ音だけ。絶対位置は選んだクリップの開始から数える。
    inRange = clipNotes(clip).filter((note) => (
      selectedNoteIds.includes(note.id)
      && Number.isInteger(note.pitch)
      && base + note.startBeat < beats.endBeat
      && base + note.startBeat + note.durationBeats > beats.startBeat
    )).map((note) => ({ ...note, startBeat: base + note.startBeat }));
  } else {
    // 小節の範囲は「実際に鳴る音」で調べる。全トラック・ループ・リンク・スウィングは
    // 再生と同じ buildScheduleEvents の結果をそのまま使う(ドラムは除く)。
    let events: ReturnType<typeof buildScheduleEvents>;
    try {
      events = buildScheduleEvents(project);
    } catch {
      return { suggestions: [], emptyMessage: '音が多すぎて調べられません。範囲を狭くしてください。' };
    }
    const sounding: RangeNote[] = [];
    for (const event of events) {
      const payload = event.payload as Partial<NoteScheduleEvent> | null;
      if (!payload || payload.kind !== 'note') continue;
      const { pitch, durationBeats } = payload;
      if (!Number.isInteger(pitch) || typeof durationBeats !== 'number' || !(durationBeats > 0)) continue;
      if (event.beat < beats.endBeat && event.beat + durationBeats > beats.startBeat) {
        sounding.push({ id: '', pitch: pitch as number, startBeat: event.beat, durationBeats });
      }
    }
    inRange = sounding;
  }
  const observed = new Set(inRange.map((note) => ((note.pitch % 12) + 12) % 12));
  if (observed.size === 0) {
    return { suggestions: [], emptyMessage: 'この範囲には音がありません。音を選ぶか、小節の範囲を変えてみてください。' };
  }
  if (observed.size === 1) {
    const only = [...observed][0] ?? 0;
    return { suggestions: [], emptyMessage: `${pitchClassToSharpName(only)} の音だけなので、コードは決められません。ほかの音も選んでみてください。` };
  }
  if (inRange.length > MAX_CHORD_DETECTION_NOTES) {
    return { suggestions: [], emptyMessage: '音が多すぎて調べられません。範囲を狭くしてください。' };
  }
  const length = beats.endBeat - beats.startBeat;
  const segments = detectChords(
    inRange.map((note) => ({
      pitch: note.pitch,
      startBeat: note.startBeat - beats.startBeat,
      durationBeats: note.durationBeats,
    })),
    { segmentBeats: length, lengthBeats: length },
  );
  const candidates = segments[0]?.candidates.slice(0, MAX_CHORD_SUGGESTIONS) ?? [];
  if (candidates.length === 0) {
    return { suggestions: [], emptyMessage: 'はっきりしたコードになっていません(経過音かもしれません)。範囲を短くして、音を絞ると見つかるかもしれません。' };
  }
  return {
    suggestions: candidates.map((candidate, index) => ({
      symbol: candidate.symbol,
      rank: index + 1,
      reason: reasonFor(candidate, observed, project.key),
    })),
    emptyMessage: null,
  };
}

export type AddChordResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; reason: string }>;

const refuse = (reason: string): AddChordResult => ({ ok: false, reason });

/** 候補のコードを小節範囲いっぱいにコードトラックへ足す(Undo 1 段)。重なる時は足さない。 */
export function addDetectedChord(symbol: string, range: BarRange): AddChordResult {
  if (typeof symbol !== 'string' || symbol.trim() === '' || symbol.length > 24) {
    return refuse('このコード名は足せません。候補から選んでください。');
  }
  const state = useStore.getState();
  if (state.audioRecordingOperationId !== null) return refuse('録音中はコードを足せません。録音を止めてからやり直してください。');
  if (state.projectOperationBusy) return refuse('プロジェクトを開いている途中のため、今はコードを足せません。');
  const project = state.project;
  const beats = barRangeBeats(project, range);
  if (!beats || beats.endBeat > MAX_PROJECT_TIMELINE_BEATS) {
    return refuse('小節の範囲を決められませんでした。曲の長さの中で、開始より後ろの小節を選んでください。');
  }
  const overlaps = project.chordTrack.some(
    (chord) => chord.startBeat < beats.endBeat && beats.startBeat < chord.startBeat + chord.durationBeats,
  );
  if (overlaps) return refuse('その小節にはもうコードがあります。先にそのコードを消すか、空いている小節を選んでください。');

  // コードトラックのコードは低音(分数コードのベース)を持てない。再生とラベルがずれる
  // 「C/D」は作らず、元のコード(C)として足し、そのことを伝える。
  const slash = symbol.indexOf('/');
  const plain = slash >= 0 ? symbol.slice(0, slash).trim() : symbol;
  if (plain === '') return refuse('このコード名は足せません。候補から選んでください。');
  const bassName = slash >= 0 ? symbol.slice(slash + 1).trim() : '';
  const captured: ChordEvent[] = [];
  const applied = state.applyProjectChange((current) => {
    if (current !== project) return current;
    const event = buildChordEvent(current, plain, beats.startBeat, beats.endBeat - beats.startBeat);
    captured.push(event);
    return { ...current, chordTrack: [...current.chordTrack, event] };
  });
  const event = captured[0];
  if (!applied || !event) return refuse('今はコードを足せませんでした。曲はそのままです。もう一度お試しください。');
  publishAppEvent({
    type: 'chord.added',
    payload: {
      bar: beatToBarPosition(compileMusicalTime(project), event.startBeat).bar,
      chordSymbol: event.symbol,
      ...(event.degree !== undefined ? { degree: event.degree } : {}),
    },
  });
  const lead = slash >= 0 ? `低音(${bassName})はコードトラックでは鳴らせないので、${plain} として追加します。` : '';
  return { ok: true, message: `${lead}${plain} を第${range.startBar + 1}小節から${beats.endBar - range.startBar}小節分、コードトラックに足しました。` };
}
