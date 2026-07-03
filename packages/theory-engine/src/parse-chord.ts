/**
 * 公開 parseChordSymbol API
 *
 * prompt 02 が要求する正規 quality 文字列に正規化する:
 *   'major','minor','dominant7','major7','minor7','diminished','augmented',
 *   'minor7b5','dim7','sus2','sus4','sixth','minorSixth'。
 *
 * 不正なシンボルでは null を返す (例外は投げない)。
 */

import type { ChordQuality } from './types';
import { FLAT_NAMES, SHARP_NAMES, noteNameToPitchClass } from './pitch';
import { parseNoteName } from './notes';

/** 正規化されたコード品質 (公開API用)。 */
export type CanonicalChordQuality =
  | 'major'
  | 'minor'
  | 'dominant7'
  | 'major7'
  | 'minor7'
  | 'diminished'
  | 'augmented'
  | 'minor7b5'
  | 'dim7'
  | 'sus2'
  | 'sus4'
  | 'sixth'
  | 'minorSixth';

/** parseChordSymbol の戻り値。 */
export type ParsedChordSymbol = {
  symbol: string;
  root: string;
  quality: CanonicalChordQuality;
  intervals: number[];
  pitchClasses: number[];
  notes: string[];
};

/** 各品質のルートからの半音インターバル。 */
const CHORD_QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  dominant7: [0, 4, 7, 10],
  minor7b5: [0, 3, 6, 10],
  diminished7: [0, 3, 6, 9],
  minorMajor7: [0, 3, 7, 11],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '6': [0, 4, 7, 9],
  minor6: [0, 3, 7, 9],
  add9: [0, 4, 7, 14],
  '9': [0, 4, 7, 10, 14],
  major9: [0, 4, 7, 11, 14],
  minor9: [0, 3, 7, 10, 14],
};

const CANONICAL_TO_CHORD_QUALITY: Record<CanonicalChordQuality, ChordQuality> = {
  major: 'major',
  minor: 'minor',
  major7: 'major7',
  minor7: 'minor7',
  dominant7: 'dominant7',
  diminished: 'diminished',
  augmented: 'augmented',
  minor7b5: 'minor7b5',
  dim7: 'diminished7',
  sus2: 'sus2',
  sus4: 'sus4',
  sixth: '6',
  minorSixth: 'minor6',
};

const CHORD_TO_CANONICAL_QUALITY: Partial<Record<ChordQuality, CanonicalChordQuality>> = {
  major: 'major',
  minor: 'minor',
  dominant7: 'dominant7',
  major7: 'major7',
  minor7: 'minor7',
  diminished: 'diminished',
  augmented: 'augmented',
  minor7b5: 'minor7b5',
  diminished7: 'dim7',
  sus2: 'sus2',
  sus4: 'sus4',
  '6': 'sixth',
  minor6: 'minorSixth',
};

type QualityParseOptions = {
  allowExtendedQualities: boolean;
  excludeMajFromMinor: boolean;
  minorCaseInsensitive: boolean;
  unknownMinorFallback: boolean;
};

const CHORD_QUALITY_PARSE_OPTIONS: QualityParseOptions = {
  allowExtendedQualities: true,
  excludeMajFromMinor: false,
  minorCaseInsensitive: true,
  unknownMinorFallback: true,
};

const CANONICAL_QUALITY_PARSE_OPTIONS: QualityParseOptions = {
  allowExtendedQualities: false,
  excludeMajFromMinor: true,
  minorCaseInsensitive: false,
  unknownMinorFallback: false,
};

type ParsedChordTokens = {
  raw: string;
  rootToken: string;
  rootPc: number;
  suffix: string;
  bassSpelling?: string;
};

/**
 * コード文字列を root / suffix / bass に分解する共有実装。
 * allowSlash=false の場合、"/" は suffix 側に残るため parseChordSymbol は null 化できる。
 */
export function parseChordTokens(
  symbol: string,
  options: { allowSlash?: boolean } = {},
): ParsedChordTokens {
  const raw = symbol.trim();
  if (raw === '') {
    throw new Error('空のコードシンボルです');
  }

  let body = raw;
  let bassSpelling: string | undefined;
  if (options.allowSlash) {
    const slashIdx = raw.indexOf('/');
    if (slashIdx >= 0) {
      body = raw.slice(0, slashIdx);
      bassSpelling = raw.slice(slashIdx + 1).trim();
    }
  }

  const rootMatch = body.match(/^([A-Ga-g])([#b♯♭]*)(.*)$/);
  if (!rootMatch) {
    throw new Error(`コードのルートを解析できません: ${symbol}`);
  }

  const [, letter = '', accidentals = '', suffix = ''] = rootMatch;
  const rootToken = letter.toUpperCase() + accidentals.replace(/♯/g, '#').replace(/♭/g, 'b');
  return {
    raw,
    rootToken,
    rootPc: noteNameToPitchClass(rootToken),
    suffix,
    bassSpelling,
  };
}

function parseQualitySuffix(suffix: string, options: QualityParseOptions): ChordQuality | null {
  const s = suffix.trim();

  // ハーフディミニッシュ
  if (/^(m7b5|m7-5|ø|hdim|halfdim)$/i.test(s)) return 'minor7b5';
  // ディミニッシュ7
  if (/^(dim7|o7|°7)$/i.test(s)) return 'diminished7';
  // ディミニッシュ (トライアド)
  if (/^(dim|°)$/i.test(s) || s === 'o') return 'diminished';
  // オーギュメント
  if (/^(aug|\+)$/i.test(s)) return 'augmented';

  // sus 系
  if (/^sus2$/i.test(s)) return 'sus2';
  if (/^(sus4|sus)$/i.test(s)) return 'sus4';

  // add9
  if (/^add9$/i.test(s)) return options.allowExtendedQualities ? 'add9' : null;

  // メジャー7 / メジャー9 (m で始まらないので先に判定)
  if (/^(maj9|M9|Maj9|major9|Δ9)$/.test(s)) {
    return options.allowExtendedQualities ? 'major9' : null;
  }
  if (/^(maj7|M7|Maj7|major7|Δ7|Δ)$/.test(s)) return 'major7';

  // マイナー系 (m / min / - で始まる)
  const minorMatch = options.minorCaseInsensitive
    ? s.match(/^(m|min|-)(.*)$/i)
    : s.match(/^(m|min|-)(.*)$/);
  if (minorMatch && (!options.excludeMajFromMinor || !/^maj/i.test(s))) {
    const rest = (minorMatch[2] ?? '').trim();
    if (rest === '') return 'minor';
    if (/^(maj7|M7|Maj7)$/.test(rest)) {
      return options.allowExtendedQualities ? 'minorMajor7' : null;
    }
    if (/^7b5$/i.test(rest)) return 'minor7b5';
    if (/^7$/.test(rest)) return 'minor7';
    if (/^9$/.test(rest)) return options.allowExtendedQualities ? 'minor9' : null;
    if (/^6$/.test(rest)) return 'minor6';
    return options.unknownMinorFallback ? 'minor' : null;
  }

  // ドミナント / 拡張
  if (/^9$/.test(s)) return options.allowExtendedQualities ? '9' : null;
  if (/^7$/.test(s)) return 'dominant7';
  if (/^6$/.test(s)) return '6';

  // 何もサフィックスが無い、または maj 単体 -> メジャートライアド
  if (s === '' || /^(maj|major|M)$/.test(s)) return 'major';

  return null;
}

export function parseChordQuality(suffix: string): ChordQuality {
  const quality = parseQualitySuffix(suffix, CHORD_QUALITY_PARSE_OPTIONS);
  if (quality !== null) return quality;
  throw new Error(`未対応のコード品質です: "${suffix}"`);
}

function normalizeQuality(suffix: string): CanonicalChordQuality | null {
  const quality = parseQualitySuffix(suffix, CANONICAL_QUALITY_PARSE_OPTIONS);
  return quality === null ? null : (CHORD_TO_CANONICAL_QUALITY[quality] ?? null);
}

export function chordQualityIntervals(quality: ChordQuality): number[] {
  return [...CHORD_QUALITY_INTERVALS[quality]];
}

/** 品質のインターバルを返す (コピー)。 */
export function chordIntervals(quality: CanonicalChordQuality): number[] {
  return chordQualityIntervals(CANONICAL_TO_CHORD_QUALITY[quality]);
}

/** ルートの綴りからフラット志向か判定する。 */
function preferFlatsFromRoot(rootName: string): boolean {
  return rootName.includes('b') || rootName === 'F';
}

/** ピッチクラスをルートの綴り志向に合わせて音名(オクターブ無し)へ。 */
function spell(pc: number, preferFlats: boolean): string {
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return names[((pc % 12) + 12) % 12] as string;
}

/**
 * コードシンボルをパースする。
 * 対応: major(""), minor("m"/"min"/"-"), dominant7("7"), major7("maj7"/"M7"),
 * minor7("m7"), diminished("dim"/"°"), augmented("aug"/"+"),
 * minor7b5("m7b5"/"ø"), dim7("dim7"), sus2, sus4, 6, m6。
 */
export function parseChordSymbol(symbol: string): ParsedChordSymbol | null {
  if (typeof symbol !== 'string') return null;
  let tokens: ParsedChordTokens;
  try {
    tokens = parseChordTokens(symbol);
  } catch {
    return null;
  }

  const parsedRoot = parseNoteName(tokens.rootToken);
  if (parsedRoot === null) return null;

  const quality = normalizeQuality(tokens.suffix);
  if (quality === null) return null;

  const intervals = chordIntervals(quality);
  const pitchClasses = intervals.map((iv) => (tokens.rootPc + iv) % 12);
  const preferFlats = preferFlatsFromRoot(parsedRoot.name);
  const notes = pitchClasses.map((pc) => spell(pc, preferFlats));

  return {
    symbol: tokens.raw,
    root: parsedRoot.name,
    quality,
    intervals,
    pitchClasses,
    notes,
  };
}
