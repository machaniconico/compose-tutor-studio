/**
 * 共有型定義 (Theory Engine)
 *
 * すべてのモジュールが参照する公開型をここに集約する。
 * docs/06_data_model.md のI/O形状に合わせている。
 */

/** キーのルート音名。フラット/シャープ両方の綴りを許容する。 */
export type MusicalKey = string;

/** サポートするスケール名。 */
export type ScaleName =
  | 'major'
  | 'naturalMinor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'majorPentatonic'
  | 'minorPentatonic'
  | 'blues';

/** 和声機能。Tonic / Subdominant / Dominant / その他。 */
export type HarmonicFunction = 'T' | 'SD' | 'D' | 'Other';

/** コード品質の正規化された識別子。 */
export type ChordQuality =
  | 'major'
  | 'minor'
  | 'diminished'
  | 'augmented'
  | 'major7'
  | 'minor7'
  | 'dominant7'
  | 'minor7b5'
  | 'diminished7'
  | 'minorMajor7'
  | 'sus2'
  | 'sus4'
  | '6'
  | 'minor6'
  | 'add9'
  | '9'
  | 'major9'
  | 'minor9';

/** パース済みコード情報。 */
export type ParsedChord = {
  /** 元のコードシンボル文字列。 */
  symbol: string;
  /** ルート音名 (キーに応じた綴り)。 */
  root: string;
  /** ルートのピッチクラス 0-11。 */
  rootPc: number;
  /** 正規化された品質。 */
  quality: ChordQuality;
  /** ルートからの半音インターバル (0始まり)。 */
  intervals: number[];
  /** 構成音のピッチクラス配列 (ルート順)。 */
  pitchClasses: number[];
  /** 構成音の音名配列。 */
  notes: string[];
  /** ベース音名 (スラッシュコードなら分母、それ以外はルート)。 */
  bass: string;
  /** ベースのピッチクラス。 */
  bassPc: number;
};

/** MIDIノートへ展開済みのコード。voicing は低い音から高い音の順。 */
export type RealizedChord = ParsedChord & {
  /** 発音するMIDIノート番号。先頭は bassPc と一致する最低音。 */
  voicing: number[];
};

/** コード解析結果 (docs/06 chord analyze 出力形状)。 */
export type ChordAnalysis = {
  symbol: string;
  root: string;
  quality: ChordQuality;
  notes: string[];
  degree: string;
  function: HarmonicFunction;
  /** ダイアトニックか否か。 */
  diatonic: boolean;
  /** 借用・セカンダリドミナント等のタグ。 */
  tags: string[];
  /** セカンダリドミナントの解決先 (例 'Am')。なければ undefined。 */
  target?: string;
  /** 初心者向け日本語説明。 */
  explanation: string;
};

/** 次コード候補。 */
export type ChordSuggestion = {
  /** コードシンボル (実キーに展開済み)。 */
  symbol: string;
  /** ローマ数字度数。 */
  degree: string;
  /** 候補カテゴリ。 */
  category: 'diatonic' | 'secondaryDominant' | 'borrowed';
  /** 0-1 のおすすめスコア (高いほど推奨)。 */
  score: number;
  /** 日本語の理由。 */
  reason: string;
};

/** 進行テンプレート。 */
export type ProgressionTemplate = {
  id: string;
  /** 日本語名。 */
  name: string;
  /** 日本語説明。 */
  description: string;
  /** 度数表記の進行 (例 ['I','V','vi','IV'])。 */
  degrees: string[];
};

/** コードイベント入力 (ベース/メロディ生成用)。 */
export type ChordEventInput = {
  symbol: string;
  startBeat: number;
  durationBeats: number;
};

/** ベースライン生成モード。 */
export type BassMode = 'rootOnly' | 'rootFifth' | 'walkingSimple' | 'octavePulse';

/** 生成された音符 (理由付き)。 */
export type GeneratedNote = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  /** なぜこの音を置いたかの短い日本語説明。 */
  reason: string;
};

/** メロディ解析の入力ノート。 */
export type MelodyNoteInput = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
};

/** メロディ解析の所見種別。 */
export type MelodyFindingType =
  | 'chord_tone'
  | 'passing_tone'
  | 'approach_tone'
  | 'tension'
  | 'leap'
  | 'repetition'
  | 'variation'
  | 'unresolved_tension'
  | 'range';

/** メロディ解析の1所見。 */
export type MelodyFinding = {
  type: MelodyFindingType;
  severity: 'info' | 'warn';
  message: string;
};

/** メロディ解析結果 (docs/06 melody analysis 出力形状)。 */
export type MelodyAnalysis = {
  /** 0-1 の総合スコア。 */
  score: number;
  findings: MelodyFinding[];
};
