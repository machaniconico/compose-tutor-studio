/**
 * コード解析 (キーに対する度数・機能・ダイアトニック判定・タグ付け)
 *
 * - ローマ数字度数 (品質を反映: I, ii, V7, viiø ...)
 * - 和声機能 T / SD / D / Other
 * - ダイアトニックか否か
 * - 借用和音 (モーダルインターチェンジ) と セカンダリドミナントのタグ付け
 * - 初心者向け日本語説明
 *
 * docs/06 section 6 の chord analyze 出力形状に一致させる。
 * 公開関数 analyzeChord({symbol, key, scale}) を提供する。
 */

import type { ChordAnalysis, ChordQuality, HarmonicFunction, ScaleName } from './types';
import { parseChord, qualityLabel } from './chords';
import { noteNameToPitchClass, parseKeyRoot, spellPitchClass } from './pitch';
import { getScalePitchClasses } from './scales';

/** メジャーキーのダイアトニック各度数の標準品質。 */
const MAJOR_DIATONIC_QUALITIES: ChordQuality[] = [
  'major', // I
  'minor', // ii
  'minor', // iii
  'major', // IV
  'major', // V
  'minor', // vi
  'diminished', // vii
];

/** ナチュラルマイナーキーのダイアトニック各度数の標準品質。 */
const MINOR_DIATONIC_QUALITIES: ChordQuality[] = [
  'minor', // i
  'diminished', // ii
  'major', // III
  'minor', // iv
  'minor', // v
  'major', // VI
  'major', // VII
];

/** メジャーキーの各度数の機能。 */
const MAJOR_FUNCTIONS: HarmonicFunction[] = ['T', 'SD', 'T', 'SD', 'D', 'T', 'D'];

/** マイナーキーの各度数の機能。 */
const MINOR_FUNCTIONS: HarmonicFunction[] = ['T', 'SD', 'T', 'SD', 'D', 'SD', 'D'];

/** ローマ数字 (大文字基準)。0始まりインデックス。 */
const ROMAN_UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** メジャースケールのインターバル (度数算出の基準)。 */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

type KeyMode = 'major' | 'minor';

/** スケール名からメジャー/マイナーの基準モードを得る。 */
function keyModeOf(scale: ScaleName): KeyMode {
  switch (scale) {
    case 'major':
    case 'majorPentatonic':
      return 'major';
    default:
      return 'minor';
  }
}

/**
 * ルートピッチクラスがキーの何度 (0-6) に当たるかを返す。
 * メジャースケールのステップに一致しなければ -1 (非ダイアトニック位置)。
 */
function scaleDegreeIndex(rootPc: number, keyRootPc: number): number {
  const interval = (((rootPc - keyRootPc) % 12) + 12) % 12;
  return MAJOR_STEPS.indexOf(interval);
}

/** 機能を日本語名にする。 */
function functionLabel(fn: HarmonicFunction): string {
  switch (fn) {
    case 'T':
      return 'トニック (安定)';
    case 'SD':
      return 'サブドミナント (中間)';
    case 'D':
      return 'ドミナント (緊張)';
    default:
      return 'その他';
  }
}

/**
 * 品質に応じてローマ数字の表記を装飾する。
 * - メジャー系トライアド/7th -> 大文字
 * - マイナー系 -> 小文字
 * - diminished -> 小文字 + °
 * - minor7b5 -> 小文字 + ø
 * - 7th 系は数字を付与 (V7, IImaj7 ...)
 */
function decorateRoman(degreeIndex: number, quality: ChordQuality): string {
  const upper = ROMAN_UPPER[degreeIndex] ?? '?';
  const lower = upper.toLowerCase();
  switch (quality) {
    case 'major':
      return upper;
    case 'minor':
      return lower;
    case 'diminished':
      return `${lower}°`;
    case 'augmented':
      return `${upper}+`;
    case 'major7':
      return `${upper}maj7`;
    case 'minor7':
      return `${lower}7`;
    case 'dominant7':
      return `${upper}7`;
    case 'minor7b5':
      return `${lower}ø`;
    case 'diminished7':
      return `${lower}°7`;
    case 'minorMajor7':
      return `${lower}maj7`;
    case 'sus2':
      return `${upper}sus2`;
    case 'sus4':
      return `${upper}sus4`;
    case '6':
      return `${upper}6`;
    case 'minor6':
      return `${lower}6`;
    case 'add9':
      return `${upper}add9`;
    case '9':
      return `${upper}9`;
    case 'major9':
      return `${upper}maj9`;
    case 'minor9':
      return `${lower}9`;
    default:
      return upper;
  }
}

/**
 * コードがセカンダリドミナント (V7/x または V/x) かどうかを判定する。
 * ドミナント7 もしくはメジャートライアドで、その完全5度下のダイアトニックなコードへ
 * 解決する場合に成立する。
 *
 * @returns 解決先がある場合 { targetDegreeIndex, targetRootPc }。なければ null。
 */
function detectSecondaryDominant(
  rootPc: number,
  quality: ChordQuality,
  keyRootPc: number,
  scale: ScaleName,
): { targetDegreeIndex: number; targetRootPc: number } | null {
  // ドミナント機能を持つ品質のみ対象
  if (quality !== 'dominant7' && quality !== 'major' && quality !== '9') {
    return null;
  }
  // 解決先ルート = このコードのルートの完全5度下 (= 完全4度上)
  const targetRootPc = (rootPc + 5) % 12;
  const targetDegreeIndex = scaleDegreeIndex(targetRootPc, keyRootPc);
  if (targetDegreeIndex < 0) {
    return null; // 解決先がダイアトニックでない
  }
  // 解決先が I (トニック) の場合は本来の V なのでセカンダリ扱いしない
  if (targetDegreeIndex === 0) {
    return null;
  }
  // メジャーキーで vii(dim) を解決先にするセカンダリは特殊なので除外
  const mode = keyModeOf(scale);
  if (mode === 'major' && targetDegreeIndex === 6) {
    return null;
  }
  // このコード自身がキーの V (本来のドミナント) なら除外
  const selfDegree = scaleDegreeIndex(rootPc, keyRootPc);
  if (selfDegree === 4) {
    return null;
  }
  return { targetDegreeIndex, targetRootPc };
}

/** 解決先度数indexに対応するダイアトニックコードの品質を返す。 */
function diatonicQualityAt(degreeIndex: number, mode: KeyMode): ChordQuality {
  const table = mode === 'major' ? MAJOR_DIATONIC_QUALITIES : MINOR_DIATONIC_QUALITIES;
  return table[degreeIndex] ?? 'major';
}

/** 解決先度数index/品質からローマ数字 (小文字/大文字) を返す。 */
function targetRomanLabel(degreeIndex: number, mode: KeyMode): string {
  const q = diatonicQualityAt(degreeIndex, mode);
  const upper = ROMAN_UPPER[degreeIndex] ?? '?';
  return q === 'minor' || q === 'diminished' ? upper.toLowerCase() : upper;
}

/** 解決先コードのシンボルを (キー綴りで) 組み立てる。 */
function targetSymbolOf(targetRootPc: number, degreeIndex: number, mode: KeyMode, key: string): string {
  const q = diatonicQualityAt(degreeIndex, mode);
  const rootName = spellPitchClass(targetRootPc, key);
  if (q === 'minor') return `${rootName}m`;
  if (q === 'diminished') return `${rootName}dim`;
  return rootName;
}

export type AnalyzeChordInput = {
  symbol: string;
  key: string;
  scale: ScaleName;
};

/**
 * コードをキーに対して解析する。
 * docs/06 section 6 chord analyze の出力形状に一致 (+ diatonic/tags/target を追加)。
 */
export function analyzeChord(input: AnalyzeChordInput): ChordAnalysis {
  const { symbol, key, scale } = input;
  const parsed = parseChord(symbol, key);
  const keyRootName = parseKeyRoot(key);
  const keyRootPc = noteNameToPitchClass(keyRootName);
  const mode = keyModeOf(scale);

  const scalePcs = getScalePitchClasses(key, scale);
  const allTonesInScale = parsed.pitchClasses.every((pc) => scalePcs.includes(pc));
  const degreeIndex = scaleDegreeIndex(parsed.rootPc, keyRootPc);

  let diatonic = false;
  if (degreeIndex >= 0 && allTonesInScale) {
    diatonic = true;
  }

  const tags: string[] = [];
  let target: string | undefined;
  let degree: string;
  let fn: HarmonicFunction;
  let explanation: string;

  const qLabel = qualityLabel(parsed.quality);
  const notesText = parsed.notes.join('・');

  const secondary = diatonic
    ? null
    : detectSecondaryDominant(parsed.rootPc, parsed.quality, keyRootPc, scale);

  if (secondary) {
    const targetRoman = targetRomanLabel(secondary.targetDegreeIndex, mode);
    const baseRoman = parsed.quality === 'dominant7' || parsed.quality === '9' ? 'V7' : 'V';
    degree = `${baseRoman}/${targetRoman}`;
    fn = 'D';
    target = targetSymbolOf(secondary.targetRootPc, secondary.targetDegreeIndex, mode, key);
    tags.push('secondaryDominant');
    explanation =
      `${symbol}はキー${keyRootName}では一時的に${target}を仮のトニックと見なすセカンダリドミナント(${degree})です。` +
      `${target}へ強く進みたいときに使うと、進行に推進力が出ます。`;
  } else if (diatonic && degreeIndex >= 0) {
    degree = decorateRoman(degreeIndex, parsed.quality);
    const fnTable = mode === 'major' ? MAJOR_FUNCTIONS : MINOR_FUNCTIONS;
    fn = fnTable[degreeIndex] ?? 'Other';
    explanation =
      `キー${keyRootName}では${symbol}は${degree}にあたる${functionLabel(fn)}のコードです。` +
      `構成音は${notesText}で、${qLabel}の響きを持ちます。`;
  } else {
    // 非ダイアトニックかつセカンダリでない -> 借用 (モーダルインターチェンジ)
    if (degreeIndex >= 0) {
      degree = decorateRoman(degreeIndex, parsed.quality);
    } else {
      degree = approximateChromaticRoman(parsed.rootPc, keyRootPc, parsed.quality);
    }
    fn = estimateBorrowedFunction(parsed.rootPc, keyRootPc, parsed.quality, mode);
    tags.push('borrowed');
    explanation =
      `${symbol}はキー${keyRootName}のダイアトニックには無い借用和音(モーダルインターチェンジ)です。` +
      `同主調などから色を借りており、${functionLabel(fn)}的な役割で印象的な響きを加えます。`;
  }

  const result: ChordAnalysis = {
    symbol,
    root: parsed.root,
    quality: parsed.quality,
    notes: parsed.notes,
    degree,
    function: fn,
    diatonic,
    tags,
    explanation,
  };
  if (target !== undefined) {
    result.target = target;
  }
  return result;
}

/** スケール外ルートのコードに ♭/♯ 付きローマ数字を近似で割り当てる。 */
function approximateChromaticRoman(
  rootPc: number,
  keyRootPc: number,
  quality: ChordQuality,
): string {
  const interval = (((rootPc - keyRootPc) % 12) + 12) % 12;
  const mapping: Record<number, string> = {
    1: '♭II',
    3: '♭III',
    6: '♭V',
    8: '♭VI',
    10: '♭VII',
  };
  const base = mapping[interval] ?? '?';
  const isMinor = quality === 'minor' || quality === 'minor7' || quality === 'diminished';
  return isMinor ? base.toLowerCase() : base;
}

/** 借用和音の機能を推定する (典型パターンのみ)。 */
function estimateBorrowedFunction(
  rootPc: number,
  keyRootPc: number,
  quality: ChordQuality,
  mode: KeyMode,
): HarmonicFunction {
  const interval = (((rootPc - keyRootPc) % 12) + 12) % 12;
  if (mode === 'major') {
    if (interval === 5 && (quality === 'minor' || quality === 'minor7')) return 'SD'; // iv
    if (interval === 8) return 'SD'; // ♭VI
    if (interval === 10) return 'SD'; // ♭VII
    if (interval === 3) return 'SD'; // ♭III
    if (interval === 1) return 'D'; // ♭II
  }
  return 'Other';
}

/** 補助エクスポート (テスト/UI用)。 */
export { functionLabel, scaleDegreeIndex, decorateRoman, keyModeOf };
