/**
 * 公開 parseChordSymbol API
 *
 * prompt 02 が要求する正規 quality 文字列に正規化する:
 *   'major','minor','dominant7','major7','minor7','diminished','augmented',
 *   'minor7b5','dim7','sus2','sus4','sixth','minorSixth'。
 *
 * 不正なシンボルでは null を返す (例外は投げない)。
 */

import { noteNameToPitchClass } from './pitch';
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
const QUALITY_INTERVALS: Record<CanonicalChordQuality, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dominant7: [0, 4, 7, 10],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  minor7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sixth: [0, 4, 7, 9],
  minorSixth: [0, 3, 7, 9],
};

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** 品質のインターバルを返す (コピー)。 */
export function chordIntervals(quality: CanonicalChordQuality): number[] {
  return [...QUALITY_INTERVALS[quality]];
}

/**
 * サフィックス文字列を正規化された品質へ変換する。未対応なら null。
 * 順序が重要: 長い綴り/誤判定しやすい綴りから先に判定する。
 */
function normalizeQuality(suffix: string): CanonicalChordQuality | null {
  const s = suffix.trim();

  // ハーフディミニッシュ
  if (/^(m7b5|m7-5|ø|hdim|halfdim)$/i.test(s)) return 'minor7b5';
  // ディミニッシュ7
  if (/^(dim7|o7|°7)$/i.test(s)) return 'dim7';
  // ディミニッシュ (トライアド)
  if (/^(dim|°)$/i.test(s) || s === 'o') return 'diminished';
  // オーギュメント
  if (/^(aug|\+)$/i.test(s)) return 'augmented';

  // sus 系
  if (/^sus2$/i.test(s)) return 'sus2';
  if (/^(sus4|sus)$/i.test(s)) return 'sus4';

  // メジャー7 (m で始まらないので先に判定)
  if (/^(maj7|M7|Maj7|major7|Δ7|Δ)$/.test(s)) return 'major7';

  // マイナー系 (m / min / - で始まる。maj は除外済み)
  const minorMatch = s.match(/^(m|min|-)(.*)$/);
  if (minorMatch && !/^maj/i.test(s)) {
    const rest = (minorMatch[2] ?? '').trim();
    if (rest === '') return 'minor';
    if (/^7b5$/i.test(rest)) return 'minor7b5';
    if (/^7$/.test(rest)) return 'minor7';
    if (/^6$/.test(rest)) return 'minorSixth';
    return null;
  }

  // ドミナント / シックス / メジャー
  if (/^7$/.test(s)) return 'dominant7';
  if (/^6$/.test(s)) return 'sixth';
  if (s === '' || /^(maj|major|M)$/.test(s)) return 'major';

  return null;
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
  const raw = symbol.trim();
  if (raw === '') return null;

  // ルート音名抽出 (文字 + 任意の #/b/♯/♭)。
  const rootMatch = raw.match(/^([A-Ga-g])([#b♯♭]*)(.*)$/);
  if (!rootMatch) return null;
  const [, letter = '', accidentalsRaw = '', suffix = ''] = rootMatch;
  const rootToken = letter.toUpperCase() + accidentalsRaw.replace(/♯/g, '#').replace(/♭/g, 'b');

  const parsedRoot = parseNoteName(rootToken);
  if (parsedRoot === null) return null;

  const quality = normalizeQuality(suffix);
  if (quality === null) return null;

  const rootPc = noteNameToPitchClass(rootToken);
  const intervals = chordIntervals(quality);
  const pitchClasses = intervals.map((iv) => (rootPc + iv) % 12);
  const preferFlats = preferFlatsFromRoot(parsedRoot.name);
  const notes = pitchClasses.map((pc) => spell(pc, preferFlats));

  return {
    symbol: raw,
    root: parsedRoot.name,
    quality,
    intervals,
    pitchClasses,
    notes,
  };
}
