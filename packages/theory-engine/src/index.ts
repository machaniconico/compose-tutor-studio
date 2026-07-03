/**
 * @cts/theory-engine 公開エントリポイント (barrel)
 *
 * docs/06_data_model.md section 6 / docs/02_feature_specification.md の
 * Theory Engine 入出力に対応する純粋・依存ライトな音楽理論 API を再エクスポートする。
 */

// 共有型
// 注意: ChordSuggestion は prompt 02 準拠の harmony 版 ({symbol, reason}) を公開するため、
// types.ts 側のリッチ版は ChordSuggestionDetailed として別名公開する。
export type {
  MusicalKey,
  ScaleName,
  HarmonicFunction,
  ChordQuality,
  ParsedChord,
  ChordAnalysis,
  ChordSuggestion as ChordSuggestionDetailed,
  ProgressionTemplate,
  ChordEventInput,
  BassMode,
  GeneratedNote,
  MelodyNoteInput,
  MelodyFindingType,
  MelodyFinding,
  MelodyAnalysis,
} from './types';

// 1. ピッチユーティリティ
// 注意: midiToNoteName / noteNameToMidi は prompt 02 準拠の ./notes 版を公開する。
export {
  noteNameToPitchClass,
  pitchClassOf,
  parseKeyRoot,
  keyPrefersFlats,
  spellPitchClass,
  pitchClassToSharpName,
  SHARP_NAMES,
  FLAT_NAMES,
} from './pitch';

// prompt 02 関数 1,2,3: ノート変換 (公開シグネチャ)
export {
  parseNoteName,
  midiToNoteName,
  noteNameToMidi,
  type ParsedNoteName,
} from './notes';

// prompt 02 関数 4: スケール構築
export { buildScale, type BuiltScale } from './build-scale';

// 2. スケール
export {
  getScaleIntervals,
  getScalePitchClasses,
  getScaleNoteNames,
  isInScale,
  isPitchClassInScale,
  scaleDegreeToPitchClass,
  SCALE_NAMES,
} from './scales';

// 3. コードシンボルパーサ (内部 parseChord 系。chordIntervals は parse-chord 側を採用)
export { parseChord, qualityLabel, buildChordSymbol } from './chords';

// prompt 02 関数 5: コードシンボルパーサ (公開シグネチャ)
export {
  parseChordSymbol,
  chordIntervals,
  type ParsedChordSymbol,
  type CanonicalChordQuality,
} from './parse-chord';

// 4. コード解析の補助 (analysis.ts のヘルパー。analyzeChord は harmony 版を公開)
export { functionLabel, scaleDegreeIndex, decorateRoman, keyModeOf } from './analysis';

// prompt 02 関数 6,7,8: 和声解析 / ダイアトニック / 次コード提案 (公開シグネチャ)
export {
  analyzeChord,
  getDiatonicChords,
  suggestNextChords,
  type AnalyzeChordInput,
  type ChordAnalysisResult,
  type DiatonicChord,
  type SuggestNextChordsInput,
  type ChordSuggestion,
  type ChordSuggestionTag,
} from './harmony';

// prompt 02 関数 9: 単音解析 (公開シグネチャ)
export {
  analyzeNoteAgainstChordAndScale,
  type NoteRelation,
  type NoteAnalysis,
} from './note-analysis';

// 6. 進行テンプレート
export {
  PROGRESSION_TEMPLATES,
  realizeDegrees,
  realizeProgression,
  getProgressionTemplate,
} from './progressions';

// 7. ベースライン生成
export { generateBassLine, type BassOptions } from './bass';

// 8 & 9. メロディ解析 / ヘルパー
export {
  analyzeMelody,
  chordToneTargets,
  generateScaleMelody,
  repeatMotif,
  type AnalyzeMelodyInput,
  type GenerateScaleMelodyInput,
  type RepeatMotifInput,
  type Motif,
} from './melody';

// PRNG (決定論的乱数)
export { mulberry32, createPrng, randomInt, pick, type RandomFn } from './prng';
