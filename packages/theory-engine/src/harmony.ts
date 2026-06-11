/**
 * 和声解析 (diatonic chords / degree / function / secondary dominant)
 *
 * - getDiatonicChords: ヘプタトニックスケールのダイアトニックトライアド7つ
 * - analyzeChord: コードの度数・機能・説明・セカンダリドミナント判定
 * - suggestNextChords: 直前コードの機能/度数に基づく決定論的な次コード提案
 *
 * 度数 (ローマ数字) の大小: メジャー/ドミナントは大文字、マイナー/ディミニッシュは小文字。
 * 機能グループ (メジャー): I,iii,vi=T / ii,IV=SD / V,vii°=D。
 */

import type { ScaleName, HarmonicFunction } from './types';
import { getScaleIntervals } from './scales';
import { noteNameToPitchClass } from './pitch';
import { parseNoteName } from './notes';
import {
  parseChordSymbol,
  type CanonicalChordQuality,
  type ParsedChordSymbol,
} from './parse-chord';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** 度数別のローマ数字 (大文字。マイナー/ディミニッシュ時に小文字化する)。 */
const ROMAN_UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const;

/** ヘプタトニックなスケールか。 */
const HEPTATONIC: ReadonlySet<ScaleName> = new Set<ScaleName>([
  'major',
  'naturalMinor',
  'harmonicMinor',
  'melodicMinor',
]);

/** getDiatonicChords の1要素。 */
export type DiatonicChord = {
  symbol: string;
  degree: string;
  function: HarmonicFunction;
  root: string;
  quality: string;
};

/** analyzeChord 入力。 */
export type AnalyzeChordInput = {
  symbol: string;
  key: string;
  scale: ScaleName;
};

/** analyzeChord 出力。 */
export type ChordAnalysisResult = {
  symbol: string;
  root: string;
  quality: string;
  notes: string[];
  degree?: string;
  function?: HarmonicFunction;
  explanation: string;
  isSecondaryDominant?: boolean;
  secondaryDominantOf?: string;
  tags?: string[];
};

/** suggestNextChords 入力。 */
export type SuggestNextChordsInput = {
  key: string;
  scale: ScaleName;
  currentProgression: string[];
};

/** suggestNextChords の1候補。 */
export type ChordSuggestion = {
  symbol: string;
  reason: string;
};

/** 借用和音候補。 */
export type BorrowedChord = {
  symbol: string;
  degree: string;
  source: 'parallelMinor' | 'parallelMajor';
  reason: string;
};

/** Dominant Motion 候補入力。 */
export type DominantMotionInput = {
  key: string;
  scale: ScaleName;
  /** 指定すると、その次コードへ向かう V7/x だけを返す。 */
  targetSymbol?: string;
  /** true なら V7/I も候補に含める。未指定時は targetSymbol 指定時のみ含める。 */
  includePrimary?: boolean;
};

/** Dominant Motion 候補。 */
export type DominantMotionChord = {
  symbol: string;
  degree: string;
  targetSymbol: string;
  targetDegree: string;
  reason: string;
};

/** キー文字列のルート部分を取り出してフラット志向か判定する。 */
function keyPrefersFlats(keyRootName: string): boolean {
  return keyRootName.includes('b') || keyRootName === 'F';
}

/** ピッチクラスをキーの綴り志向で音名にする。 */
function spell(pc: number, preferFlats: boolean): string {
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return names[((pc % 12) + 12) % 12] as string;
}

/** キー文字列から正規化したルート音名を返す (例 "Cm" -> "C", "Bbmaj" -> "Bb")。 */
function parseKeyRootName(key: string): string {
  const match = key.trim().match(/^([A-Ga-g][#b♯♭]*)/);
  const token = match?.[1];
  if (!token) {
    throw new Error(`不正なキーです: ${key}`);
  }
  const parsed = parseNoteName(token);
  if (parsed === null) {
    throw new Error(`不正なキーです: ${key}`);
  }
  return parsed.name;
}

/** 3和音のピッチクラスから品質を推定する。 */
function triadQuality(pcs: number[]): CanonicalChordQuality {
  const [r = 0, third = 0, fifth = 0] = pcs;
  const t = (third - r + 12) % 12;
  const f = (fifth - r + 12) % 12;
  if (t === 4 && f === 7) return 'major';
  if (t === 3 && f === 7) return 'minor';
  if (t === 3 && f === 6) return 'diminished';
  if (t === 4 && f === 8) return 'augmented';
  return 'major';
}

/** 品質ごとのシンボルサフィックス。 */
const QUALITY_SUFFIX: Record<CanonicalChordQuality, string> = {
  major: '',
  minor: 'm',
  dominant7: '7',
  major7: 'maj7',
  minor7: 'm7',
  diminished: 'dim',
  augmented: 'aug',
  minor7b5: 'm7b5',
  dim7: 'dim7',
  sus2: 'sus2',
  sus4: 'sus4',
  sixth: '6',
  minorSixth: 'm6',
};

/** ローマ数字を品質に応じて大小・装飾する (7th 付きは degree に 7 を付ける)。 */
function romanForDegree(degreeIndex: number, quality: CanonicalChordQuality): string {
  const base = ROMAN_UPPER[degreeIndex] ?? '';
  const isMajorish =
    quality === 'major' ||
    quality === 'dominant7' ||
    quality === 'major7' ||
    quality === 'augmented' ||
    quality === 'sus2' ||
    quality === 'sus4' ||
    quality === 'sixth';
  let roman: string;
  if (quality === 'diminished' || quality === 'dim7' || quality === 'minor7b5') {
    roman = base.toLowerCase() + '°';
  } else {
    roman = isMajorish ? base : base.toLowerCase();
  }
  const isSeventh = quality === 'dominant7' || quality === 'major7' || quality === 'minor7';
  if (isSeventh) {
    roman += '7';
  }
  return roman;
}

/** メジャーキーにおける度数機能。 */
function functionForMajorDegree(degreeIndex: number): HarmonicFunction {
  // 0=I,1=ii,2=iii,3=IV,4=V,5=vi,6=vii°
  switch (degreeIndex) {
    case 0:
    case 2:
    case 5:
      return 'T';
    case 1:
    case 3:
      return 'SD';
    case 4:
    case 6:
      return 'D';
    default:
      return 'Other';
  }
}

/** マイナーキー (naturalMinor) の度数機能。 */
function functionForMinorDegree(degreeIndex: number): HarmonicFunction {
  // i, ii°, III, iv, v, VI, VII
  switch (degreeIndex) {
    case 0:
    case 2:
    case 5:
      return 'T';
    case 1:
    case 3:
      return 'SD';
    case 4:
    case 6:
      return 'D';
    default:
      return 'Other';
  }
}

function isMinorScale(scale: ScaleName): boolean {
  return scale === 'naturalMinor' || scale === 'harmonicMinor' || scale === 'melodicMinor';
}

/** スケールのダイアトニックトライアド情報。 */
type DegreeInfo = {
  degreeIndex: number;
  rootPc: number;
  quality: CanonicalChordQuality;
  pitchClasses: number[];
};

function diatonicDegreeInfos(key: string, scale: ScaleName): DegreeInfo[] {
  if (!HEPTATONIC.has(scale)) {
    throw new Error(`ダイアトニックトライアドはヘプタトニックスケールのみ対応です: ${scale}`);
  }
  const keyRootName = parseKeyRootName(key);
  const rootPc = noteNameToPitchClass(keyRootName);
  const intervals = getScaleIntervals(scale);
  const scalePcs = intervals.map((iv) => (rootPc + iv) % 12);

  return scalePcs.map((degRootPc, i) => {
    const thirdPc = scalePcs[(i + 2) % scalePcs.length] as number;
    const fifthPc = scalePcs[(i + 4) % scalePcs.length] as number;
    const pcs = [degRootPc, thirdPc, fifthPc];
    return {
      degreeIndex: i,
      rootPc: degRootPc,
      quality: triadQuality(pcs),
      pitchClasses: pcs,
    };
  });
}

/** ダイアトニックトライアド (7和音) を返す。 */
export function getDiatonicChords(key: string, scale: ScaleName): DiatonicChord[] {
  const keyRootName = parseKeyRootName(key);
  const preferFlats = keyPrefersFlats(keyRootName);
  const isMinorKey =
    scale === 'naturalMinor' || scale === 'harmonicMinor' || scale === 'melodicMinor';
  const infos = diatonicDegreeInfos(key, scale);

  return infos.map((info) => {
    const rootName = spell(info.rootPc, preferFlats);
    const symbol = rootName + QUALITY_SUFFIX[info.quality];
    const degree = romanForDegree(info.degreeIndex, info.quality);
    const fn = isMinorKey
      ? functionForMinorDegree(info.degreeIndex)
      : functionForMajorDegree(info.degreeIndex);
    return { symbol, degree, function: fn, root: rootName, quality: info.quality };
  });
}

/** ダイアトニックなコードルートPC -> 度数情報 のマップ。 */
function degreeInfoByRootPc(key: string, scale: ScaleName): Map<number, DegreeInfo> {
  const map = new Map<number, DegreeInfo>();
  for (const info of diatonicDegreeInfos(key, scale)) {
    if (!map.has(info.rootPc)) map.set(info.rootPc, info);
  }
  return map;
}

function chordSymbolForQuality(rootPc: number, quality: CanonicalChordQuality, preferFlats: boolean): string {
  return spell(rootPc, preferFlats) + QUALITY_SUFFIX[quality];
}

function diatonicQualityKey(info: DegreeInfo): string {
  return `${info.rootPc}:${info.quality}`;
}

/** 同主調から借りやすいコードを返す。 */
export function borrowedChords(key: string, scale: ScaleName): BorrowedChord[] {
  if (!HEPTATONIC.has(scale)) return [];

  const keyRootName = parseKeyRootName(key);
  const rootPc = noteNameToPitchClass(keyRootName);
  const currentDiatonic = new Set(diatonicDegreeInfos(key, scale).map(diatonicQualityKey));
  const currentIsMinor = isMinorScale(scale);
  const preferFlats = currentIsMinor ? keyPrefersFlats(keyRootName) : true;

  const majorBorrowed = [
    {
      degree: 'bVII',
      offset: 10,
      quality: 'major' as const,
      reason: '同主短調から借りるbVIIで、Iへ戻る前にロックや映画音楽のような広がりを作れます。',
    },
    {
      degree: 'iv',
      offset: 5,
      quality: 'minor' as const,
      reason: '同主短調のivは、IVより少し切ない色でIへ自然に戻れます。',
    },
    {
      degree: 'bVI',
      offset: 8,
      quality: 'major' as const,
      reason: '同主短調のbVIは、明るいキーに一瞬だけ陰りを足して展開の変化を作れます。',
    },
    {
      degree: 'bIII',
      offset: 3,
      quality: 'major' as const,
      reason: '同主短調のbIIIは、トニックから遠すぎず大きな景色の変化を出せます。',
    },
  ];

  const minorBorrowed = [
    {
      degree: 'I',
      offset: 0,
      quality: 'major' as const,
      reason: '同主長調からIを借りると、短調の中で一瞬明るく終わる感じを作れます。',
    },
    {
      degree: 'IV',
      offset: 5,
      quality: 'major' as const,
      reason: '同主長調のIVは、短調のivより前向きな展開を作れます。',
    },
    {
      degree: 'V',
      offset: 7,
      quality: 'major' as const,
      reason: '同主長調のVは、iへ戻る力を強くする明るいドミナントです。',
    },
  ];

  const source = currentIsMinor ? 'parallelMajor' : 'parallelMinor';
  const patterns = currentIsMinor ? minorBorrowed : majorBorrowed;

  return patterns.flatMap((pattern) => {
    const root = (rootPc + pattern.offset) % 12;
    if (currentDiatonic.has(`${root}:${pattern.quality}`)) return [];
    return [
      {
        symbol: chordSymbolForQuality(root, pattern.quality, preferFlats),
        degree: pattern.degree,
        source,
        reason: pattern.reason,
      },
    ];
  });
}

function dominantTargetCandidates(key: string, scale: ScaleName): DegreeInfo[] {
  return diatonicDegreeInfos(key, scale).filter((info) => info.degreeIndex !== 6);
}

function dominantMotionCandidateForTarget(
  key: string,
  scale: ScaleName,
  target: DegreeInfo,
  preferFlats: boolean,
): DominantMotionChord {
  const dominantRootPc = (target.rootPc + 7) % 12;
  const symbol = chordSymbolForQuality(dominantRootPc, 'dominant7', preferFlats);
  const targetSymbol = chordSymbolForQuality(target.rootPc, target.quality, preferFlats);
  const targetDegree = romanForDegree(target.degreeIndex, target.quality);
  const degree = `V7/${targetDegree}`;
  return {
    symbol,
    degree,
    targetSymbol,
    targetDegree,
    reason: `${targetSymbol}（${targetDegree}）へ向かう一時的なドミナントです。次のコードへ強く着地する流れを作れます。`,
  };
}

/** 次のコード、または各ダイアトニックコードへ向かう V7/x 候補を返す。 */
export function dominantMotionChords(input: DominantMotionInput): DominantMotionChord[] {
  if (!HEPTATONIC.has(input.scale)) return [];

  const keyRootName = parseKeyRootName(input.key);
  const preferFlats = keyPrefersFlats(keyRootName);
  const includePrimary = input.includePrimary ?? input.targetSymbol !== undefined;

  if (input.targetSymbol !== undefined) {
    const parsed = parseChordSymbol(input.targetSymbol);
    if (parsed === null) return [];
    const targetPc = noteNameToPitchClass(parsed.root);
    const target = degreeInfoByRootPc(input.key, input.scale).get(targetPc);
    if (!target) return [];
    if (target.degreeIndex === 0 && !includePrimary) return [];
    return [dominantMotionCandidateForTarget(input.key, input.scale, target, preferFlats)];
  }

  return dominantTargetCandidates(input.key, input.scale)
    .filter((target) => includePrimary || target.degreeIndex !== 0)
    .map((target) => dominantMotionCandidateForTarget(input.key, input.scale, target, preferFlats));
}

/** ダイアトニックなトライアドのローマ数字(大小のみ、7なし)を取得する。 */
function diatonicRomanByRootPc(key: string, scale: ScaleName, rootPc: number): string | undefined {
  const info = degreeInfoByRootPc(key, scale).get(rootPc);
  if (!info) return undefined;
  return romanForDegree(info.degreeIndex, info.quality);
}

/** あるピッチクラスがダイアトニックなコードルートならその度数indexを返す。 */
function diatonicDegreeIndexByRootPc(
  key: string,
  scale: ScaleName,
  rootPc: number,
): number | undefined {
  return degreeInfoByRootPc(key, scale).get(rootPc)?.degreeIndex;
}

/** トニックのピッチクラス。 */
function tonicPc(key: string): number {
  return noteNameToPitchClass(parseKeyRootName(key));
}

/** 品質が「ドミナント的」(長3度 + 短7度) か。 */
function isDominantQuality(parsed: ParsedChordSymbol): boolean {
  return parsed.quality === 'dominant7';
}

/** 日本語の機能ラベル。 */
const FUNCTION_LABEL: Record<HarmonicFunction, string> = {
  T: 'トニック（安定）',
  SD: 'サブドミナント（展開）',
  D: 'ドミナント（緊張）',
  Other: 'その他',
};

/** コードを調性の中で解析する。 */
export function analyzeChord(input: AnalyzeChordInput): ChordAnalysisResult {
  const parsed = parseChordSymbol(input.symbol);
  if (parsed === null) {
    return {
      symbol: input.symbol,
      root: input.symbol,
      quality: 'unknown',
      notes: [],
      explanation: `「${input.symbol}」はコードとして解釈できませんでした。`,
    };
  }

  const keyRootName = parseKeyRootName(input.key);
  const preferFlats = keyPrefersFlats(keyRootName);
  const heptatonic = HEPTATONIC.has(input.scale);

  const result: ChordAnalysisResult = {
    symbol: parsed.symbol,
    root: parsed.root,
    quality: parsed.quality,
    notes: parsed.notes,
    explanation: '',
  };

  if (!heptatonic) {
    result.explanation = `${input.key}（${input.scale}）における ${parsed.symbol} です。`;
    return result;
  }

  const rootPc = noteNameToPitchClass(parsed.root);
  const degreeIndex = diatonicDegreeIndexByRootPc(input.key, input.scale, rootPc);
  const isMinorKey =
    input.scale === 'naturalMinor' ||
    input.scale === 'harmonicMinor' ||
    input.scale === 'melodicMinor';

  // セカンダリドミナント判定: ドミナント品質で、ルート+5半音(完全5度下)の
  // 解決先がトニック以外のダイアトニックコードである場合。
  if (isDominantQuality(parsed)) {
    const targetPc = (rootPc + 5) % 12;
    const targetRoman = diatonicRomanByRootPc(input.key, input.scale, targetPc);
    const targetIsTonic = targetPc === tonicPc(input.key);
    const targetIsDiatonic = targetRoman !== undefined;
    const isPrimaryDominant = rootPc === (tonicPc(input.key) + 7) % 12;

    if (targetIsDiatonic && !targetIsTonic && !isPrimaryDominant) {
      result.isSecondaryDominant = true;
      result.secondaryDominantOf = targetRoman;
      result.degree = `V7/${targetRoman}`;
      result.function = 'D';
      result.tags = ['secondaryDominant'];
      result.explanation =
        `${input.key}では${parsed.symbol}はセカンダリドミナント（V7/${targetRoman}）です。` +
        `${targetRoman}の和音へ強く進みたくなる、一時的なドミナント（緊張）として働きます。`;
      return result;
    }
  }

  if (degreeIndex === undefined) {
    result.function = 'Other';
    result.tags = ['nonDiatonic'];
    result.explanation =
      `${input.key}（${input.scale}）では${parsed.symbol}はダイアトニック（基本7和音）の外にある和音です。` +
      `色付け（借用和音）として使われることがあります。`;
    return result;
  }

  const degree = romanForDegree(degreeIndex, parsed.quality);
  const fn = isMinorKey
    ? functionForMinorDegree(degreeIndex)
    : functionForMajorDegree(degreeIndex);
  result.degree = degree;
  result.function = fn;

  if (fn === 'D') {
    const tonicName = spell(tonicPc(input.key), preferFlats);
    result.explanation =
      `${input.key}では${parsed.symbol}は${degree}で、主和音${tonicName}へ進みたくなるドミナント（緊張）です。`;
  } else if (fn === 'T') {
    result.explanation = `${input.key}では${parsed.symbol}は${degree}で、安定して落ち着くトニック（主和音グループ）です。`;
  } else if (fn === 'SD') {
    result.explanation =
      `${input.key}では${parsed.symbol}は${degree}で、次の展開を準備するサブドミナント（展開）です。`;
  } else {
    result.explanation = `${input.key}では${parsed.symbol}は${degree}（${FUNCTION_LABEL[fn]}）です。`;
  }

  return result;
}

/** 直前のコードの機能/度数に基づいて、決定論的に次コード候補を返す。 */
export function suggestNextChords(input: SuggestNextChordsInput): ChordSuggestion[] {
  const { key, scale, currentProgression } = input;
  const heptatonic = HEPTATONIC.has(scale);
  const diatonic = heptatonic ? getDiatonicChords(key, scale) : [];

  const byBaseDegree = new Map<string, DiatonicChord>();
  for (const ch of diatonic) {
    byBaseDegree.set(ch.degree, ch);
  }
  const pick = (deg: string): DiatonicChord | undefined => byBaseDegree.get(deg);

  const last = currentProgression[currentProgression.length - 1];
  if (last === undefined || !heptatonic) {
    const tonic = pick('I') ?? pick('i') ?? diatonic[0];
    if (tonic) {
      return [
        { symbol: tonic.symbol, reason: '進行の起点として、安定する主和音（トニック）から始めましょう。' },
      ];
    }
    return [];
  }

  const analysis = analyzeChord({ symbol: last, key, scale });
  const degree = analysis.degree ?? '';
  const suggestions: ChordSuggestion[] = [];

  const push = (deg: string, reason: string) => {
    const ch = pick(deg);
    if (ch) suggestions.push({ symbol: ch.symbol, reason });
  };

  // 度数の基底 (7や/を除いた I, ii, V, ...)。
  const base = degree.replace(/7$/, '').replace(/\/.*/, '');

  if (base === 'V' || base === 'v') {
    push('I', '属和音（V）のあとは主和音（I）へ解決すると最も収まりが良いです。');
    push('vi', '一度 vi へ逸らす「偽終止」で意外性を出すこともできます。');
  } else if (base === 'ii') {
    push('V', 'サブドミナントの ii のあとは属和音（V）へ進むのが王道（ツーファイブ）です。');
  } else if (base === 'IV') {
    push('V', 'サブドミナントの IV のあとは属和音（V）へ進んで緊張を高められます。');
    push('I', 'IV から I へ戻ると、おだやかな終止感になります。');
  } else if (base === 'vi') {
    push('IV', 'vi のあとは IV へ進むと自然な流れになります。');
    push('ii', 'vi から ii へ進めて、次の V につなげる準備もできます。');
  } else if (base === 'I' || base === 'i') {
    push('IV', '主和音のあとは IV で展開を作るのが定番です。');
    push('V', '主和音のあとに V を置くと、すぐに緊張と解決の動きを作れます。');
    push('vi', 'I から vi へ進むと、しっとりした雰囲気に変化します。');
  } else if (base === 'iii') {
    push('vi', 'iii のあとは vi へ進むと滑らかにつながります。');
    push('IV', 'iii から IV へ進めて展開を作ることもできます。');
  } else {
    push('I', '次は安定する主和音（I）へ戻すと、まとまりが出ます。');
  }

  if (suggestions.length === 0) {
    const tonic = pick('I') ?? pick('i') ?? diatonic[0];
    if (tonic) {
      suggestions.push({
        symbol: tonic.symbol,
        reason: '安定する主和音（トニック）へ戻すと収まります。',
      });
    }
  }

  return suggestions;
}
