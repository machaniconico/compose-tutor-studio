/**
 * useInspection — Theory Inspector の状態ロジック。
 *
 * UI描画から切り離した純粋なデータ変換フック。
 * 選択中のコード/ノートをtheory-engineで解析し、
 * InspectorPanelが描画するためのデータ構造を返す。
 */

import { useMemo } from 'react';
import type { NoteEvent, ChordEvent } from '@cts/project-model';
import type { ScaleName, HarmonicFunction, NoteAnalysis } from '@cts/theory-engine';
import {
  analyzeChord,
  analyzeNoteAgainstChordAndScale,
  getNoteScaleDegree,
  describeNoteInKey,
  detectChordTensions,
  midiToNoteName,
  getScaleNoteNames,
  type ChordAnalysisResult,
} from '@cts/theory-engine';
import { useStore } from '../../state/store';
import { useScaleInfo } from '../pianoRoll/useScaleInfo';

/** 選択中ノートの解析結果。 */
export type NoteInspectionResult = {
  /** 音名 (例 "E4") */
  noteName: string;
  /** キー/スケールに対する度数ラベル (例 "Ⅲ") — スケール外なら null */
  scaleDegree: string | null;
  /** スケール内文脈の説明 (例 "Ⅲ度（スケール内）") */
  scaleContext: string;
  /**
   * キー文脈の説明 (describeNoteInKey の結果)。
   * コード選択が併存する場合でも常時保持し、スケール外音のクロマチック文脈説明を落とさずに表示できる。
   */
  keyContext: string;
  /** コードトーン判定結果 */
  noteAnalysis: NoteAnalysis | null;
  /** コード内での度数表記 (例 "3度") — コードトーンのときのみ */
  degreeInChord: string | null;
  /** 現在のコードシンボル — コードが存在しない場合 null */
  currentChordSymbol: string | null;
  /** スケール内かどうか */
  inScale: boolean;
};

/** 選択中コードの解析結果。 */
export type ChordInspectionResult = {
  /** コードシンボル (例 "G7") */
  symbol: string;
  /** 構成音の音名リスト */
  notes: string[];
  /** ローマ数字度数 (例 "V7") */
  degree: string;
  /** 和声機能 */
  harmonicFunction: HarmonicFunction;
  /** 機能の日本語ラベル */
  functionLabel: string;
  /** 説明文 */
  explanation: string;
  /** このコードに使えるテンション音のラベルリスト (例 ["9th", "13th"])。なければ空配列。 */
  tension: string[];
};

/** 未選択時のキー/スケール概要。 */
export type KeyScaleOverview = {
  key: string;
  scaleName: string;
  /** スケール構成音の音名リスト */
  scaleNotes: string[];
  /** スケール名の日本語ラベル */
  scaleLabel: string;
};

/** useInspection の戻り値。選択状態に応じて排他的にいずれか1つが非 null。 */
export type InspectionState =
  | { kind: 'note'; data: NoteInspectionResult }
  | { kind: 'chord'; data: ChordInspectionResult }
  | { kind: 'overview'; data: KeyScaleOverview };

const HARMONIC_FUNCTION_LABEL: Record<HarmonicFunction, string> = {
  T: 'トニック（安定）',
  SD: 'サブドミナント（展開）',
  D: 'ドミナント（緊張）',
  Other: 'その他',
};

const SCALE_LABEL: Record<string, string> = {
  major: 'メジャー（長調）',
  naturalMinor: 'ナチュラルマイナー（自然短調）',
  harmonicMinor: 'ハーモニックマイナー（和声的短調）',
  melodicMinor: 'メロディックマイナー（旋律的短調）',
  majorPentatonic: 'メジャーペンタトニック',
  minorPentatonic: 'マイナーペンタトニック',
  blues: 'ブルーススケール',
};

/** 選択中ノートを同期的に解析する。 */
function buildNoteInspection(
  note: NoteEvent,
  key: string,
  scale: ScaleName,
  chordAtBeat: (beat: number) => ChordEvent | undefined,
): NoteInspectionResult {
  const noteName = midiToNoteName(note.pitch);

  let scaleDegree: string | null = null;
  let scaleContext = '';
  let keyContext = '';
  let inScale = false;
  try {
    scaleDegree = getNoteScaleDegree(note.pitch, key, scale);
    scaleContext = describeNoteInKey(note.pitch, key, scale);
    keyContext = scaleContext;
    inScale = scaleDegree !== null;
  } catch {
    scaleContext = 'スケール情報を取得できませんでした。';
    keyContext = scaleContext;
  }

  const chord = chordAtBeat(note.startBeat);
  let noteAnalysis: NoteAnalysis | null = null;
  let degreeInChord: string | null = null;

  if (chord) {
    try {
      noteAnalysis = analyzeNoteAgainstChordAndScale(note.pitch, chord.symbol, key, scale);
      degreeInChord = noteAnalysis.degreeInChord ?? null;
    } catch {
      noteAnalysis = null;
    }
  }

  return {
    noteName,
    scaleDegree,
    scaleContext,
    keyContext,
    noteAnalysis,
    degreeInChord,
    currentChordSymbol: chord?.symbol ?? null,
    inScale,
  };
}

/** 選択中コードを解析する。 */
function buildChordInspection(
  symbol: string,
  key: string,
  scale: ScaleName,
): ChordInspectionResult {
  let analysis: ChordAnalysisResult;
  try {
    analysis = analyzeChord({ symbol, key, scale });
  } catch {
    return {
      symbol,
      notes: [],
      degree: '—',
      harmonicFunction: 'Other',
      functionLabel: 'その他',
      explanation: `コード「${symbol}」の解析に失敗しました。`,
      tension: [],
    };
  }

  const fn: HarmonicFunction = analysis.function ?? 'Other';
  const tension = detectChordTensions(symbol, key, scale);
  return {
    symbol: analysis.symbol,
    notes: analysis.notes,
    degree: analysis.degree ?? '—',
    harmonicFunction: fn,
    functionLabel: HARMONIC_FUNCTION_LABEL[fn],
    explanation: analysis.explanation,
    tension,
  };
}

/** キー/スケール概要を構築する。 */
function buildOverview(key: string, scale: ScaleName): KeyScaleOverview {
  let scaleNotes: string[] = [];
  try {
    scaleNotes = getScaleNoteNames(key, scale);
  } catch {
    scaleNotes = [];
  }
  return {
    key,
    scaleName: scale,
    scaleNotes,
    scaleLabel: SCALE_LABEL[scale] ?? scale,
  };
}

/**
 * Theory Inspector の状態を返すフック。
 * 選択中のコード/ノートの状態に応じて InspectionState を返す。
 */
export function useInspection(): InspectionState {
  const project = useStore((s) => s.project);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);
  const selectedNoteIds = useStore((s) => s.editor.selectedNoteIds);
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const scaleInfo = useScaleInfo(project);

  return useMemo((): InspectionState => {
    // 選択中ノートを優先
    if (selectedNoteIds.length > 0) {
      const id = selectedNoteIds[selectedNoteIds.length - 1];
      for (const track of project.tracks) {
        const clip = track.clips.find((c) => c.id === selectedClipId);
        const found = clip?.notes?.find((n) => n.id === id);
        if (found) {
          return {
            kind: 'note',
            data: buildNoteInspection(found, project.key, project.scale, scaleInfo.chordAtBeat),
          };
        }
      }
    }

    // 選択中コード
    if (selectedChordId) {
      const chord = project.chordTrack.find((c) => c.id === selectedChordId);
      if (chord) {
        return {
          kind: 'chord',
          data: buildChordInspection(chord.symbol, project.key, project.scale),
        };
      }
    }

    // 未選択: 概要
    return { kind: 'overview', data: buildOverview(project.key, project.scale) };
  }, [
    project.key,
    project.scale,
    project.tracks,
    project.chordTrack,
    selectedChordId,
    selectedNoteIds,
    selectedClipId,
    scaleInfo.chordAtBeat,
  ]);
}
