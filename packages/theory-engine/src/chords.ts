/**
 * コードシンボルパーサ
 *
 * 対応シンボル例:
 *   C, Cm, Am, Fmaj7, G7, Dm7, Bdim, Bm7b5, Caug, Csus4, Csus2,
 *   C6, Cm6, Cadd9, C9, Cmaj9, Cm9, スラッシュコード Dm7/G
 *
 * 出力 ParsedChord: root, quality, intervals, pitchClasses, notes, bass。
 */

import type { ChordQuality, ParsedChord, RealizedChord } from './types';
import { parseNoteName } from './notes';
import { noteNameToPitchClass, spellPitchClass, pitchClassToSharpName } from './pitch';

/** 各品質のルートからの半音インターバル。 */
const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
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

/** 品質の人間向け表示ラベル (日本語説明で利用)。 */
const QUALITY_LABELS: Record<ChordQuality, string> = {
  major: 'メジャー',
  minor: 'マイナー',
  diminished: 'ディミニッシュ',
  augmented: 'オーギュメント',
  major7: 'メジャーセブンス',
  minor7: 'マイナーセブンス',
  dominant7: 'ドミナントセブンス',
  minor7b5: 'ハーフディミニッシュ (m7♭5)',
  diminished7: 'ディミニッシュセブンス',
  minorMajor7: 'マイナーメジャーセブンス',
  sus2: 'サスペンデッド2',
  sus4: 'サスペンデッド4',
  '6': 'シックスス',
  minor6: 'マイナーシックスス',
  add9: 'アドナイン',
  '9': 'ナインス',
  major9: 'メジャーナインス',
  minor9: 'マイナーナインス',
};

/** 品質の表示ラベルを返す。 */
export function qualityLabel(quality: ChordQuality): string {
  return QUALITY_LABELS[quality];
}

/** 品質のインターバルを返す (コピー)。 */
export function chordIntervals(quality: ChordQuality): number[] {
  return [...QUALITY_INTERVALS[quality]];
}

const DEFAULT_BASS_FLOOR_MIDI = 36;

/**
 * 品質サフィックス文字列を正規化された ChordQuality へ変換する。
 * 入力は root を除いたサフィックス部分 (例 "maj7", "m7b5", "")。
 */
function parseQuality(suffix: string): ChordQuality {
  const s = suffix.trim();

  // 長い綴りから順にマッチ (誤判定防止)
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
  if (/^add9$/i.test(s)) return 'add9';

  // メジャー7 / メジャー9 (m で始まらないので先に判定)
  if (/^(maj9|M9|Maj9|major9|Δ9)$/.test(s)) return 'major9';
  if (/^(maj7|M7|Maj7|major7|Δ7|Δ)$/.test(s)) return 'major7';

  // マイナー系 (m / min / - で始まる。ただし maj は除外済み)
  const minorMatch = s.match(/^(m|min|-)(.*)$/i);
  if (minorMatch) {
    const rest = (minorMatch[2] ?? '').trim();
    if (rest === '') return 'minor';
    if (/^(maj7|M7|Maj7)$/.test(rest)) return 'minorMajor7';
    if (/^7b5$/i.test(rest)) return 'minor7b5';
    if (/^7$/.test(rest)) return 'minor7';
    if (/^9$/.test(rest)) return 'minor9';
    if (/^6$/.test(rest)) return 'minor6';
    // 未知のマイナー拡張は minor トライアドにフォールバック
    return 'minor';
  }

  // ドミナント / 拡張
  if (/^9$/.test(s)) return '9';
  if (/^7$/.test(s)) return 'dominant7';
  if (/^6$/.test(s)) return '6';

  // 何もサフィックスが無い、または maj 単体 -> メジャートライアド
  if (s === '' || /^(maj|major|M)$/.test(s)) return 'major';

  throw new Error(`未対応のコード品質です: "${suffix}"`);
}

/**
 * コードシンボルをパースする。
 * @param symbol コード文字列 (例 "Fmaj7", "Dm7/G")
 * @param key 綴りに使うキー (省略時はシンボルのルート自身)
 */
export function parseChord(symbol: string, key?: string): ParsedChord {
  const raw = symbol.trim();
  if (raw === '') {
    throw new Error('空のコードシンボルです');
  }

  // スラッシュコード分離
  const slashParts = raw.split('/');
  if (slashParts.length > 2) {
    throw new Error(`不正なスラッシュコードです: ${symbol}`);
  }
  const body = slashParts[0]?.trim() ?? '';
  const bassSpelling = slashParts[1]?.trim();
  if (body === '' || bassSpelling === '') {
    throw new Error(`不正なスラッシュコードです: ${symbol}`);
  }
  const parsedBass = bassSpelling === undefined ? null : parseNoteName(bassSpelling);
  if (bassSpelling !== undefined && parsedBass === null) {
    throw new Error(`ベース音を解析できません: ${symbol}`);
  }

  // ルート音名抽出 (文字 + 任意の # / b)
  const rootMatch = body.match(/^([A-Ga-g])([#b♯♭]*)(.*)$/);
  if (!rootMatch) {
    throw new Error(`コードのルートを解析できません: ${symbol}`);
  }
  const [, letter = '', accidentals = '', suffix = ''] = rootMatch;
  const rootToken = letter.toUpperCase() + accidentals.replace(/♯/g, '#').replace(/♭/g, 'b');
  const rootPc = noteNameToPitchClass(rootToken);

  const quality = parseQuality(suffix);
  const intervals = chordIntervals(quality);
  const chordPitchClasses = intervals.map((iv) => (rootPc + iv) % 12);

  const spellKey = key ?? rootToken;
  const root = key ? spellPitchClass(rootPc, spellKey) : rootToken;
  const chordNotes = chordPitchClasses.map((pc) => spellPitchClass(pc, spellKey));

  let bass = root;
  let bassPc = rootPc;
  if (parsedBass !== null) {
    bassPc = parsedBass.pitchClass;
    bass = parsedBass.name;
  }
  const pitchClasses = chordPitchClasses.includes(bassPc) ? chordPitchClasses : [...chordPitchClasses, bassPc];
  const notes =
    chordPitchClasses.includes(bassPc) ? chordNotes : [...chordNotes, parsedBass?.name ?? spellPitchClass(bassPc, spellKey)];

  return {
    symbol: raw,
    root,
    rootPc,
    quality,
    intervals,
    pitchClasses,
    notes,
    bass,
    bassPc,
  };
}

function pitchClassOfMidi(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

function pitchAtOrAbove(pc: number, minimumMidi: number): number {
  let pitch = minimumMidi + ((pc - pitchClassOfMidi(minimumMidi) + 12) % 12);
  while (pitch < minimumMidi) pitch += 12;
  return pitch;
}

function chordVoicing(parsed: ParsedChord, bassFloorMidi: number): number[] {
  const bassPitch = pitchAtOrAbove(parsed.bassPc, bassFloorMidi);
  const upper = parsed.pitchClasses
    .filter((pc) => pc !== parsed.bassPc)
    .map((pc) => pitchAtOrAbove(pc, bassPitch + 1));
  return [bassPitch, ...upper].sort((a, b) => a - b);
}

export type RealizeChordOptions = {
  /** ベース音を置く最低MIDIノート。既定は C2 (36)。 */
  bassFloorMidi?: number;
};

/** コードシンボルをMIDIボイシングへ展開する。 */
export function realizeChord(symbol: string, key?: string, options: RealizeChordOptions = {}): RealizedChord {
  const parsed = parseChord(symbol, key);
  return {
    ...parsed,
    voicing: chordVoicing(parsed, options.bassFloorMidi ?? DEFAULT_BASS_FLOOR_MIDI),
  };
}

/** コードシンボル列を低音から高音へ並んだMIDIボイシング列に展開する。 */
export function realizeChords(
  symbols: string[],
  key?: string,
  options: RealizeChordOptions = {},
): RealizedChord[] {
  return symbols.map((symbol) => realizeChord(symbol, key, options));
}

/** 品質 -> シンボルのサフィックス (buildChordSymbol 用)。 */
const QUALITY_SYMBOL_SUFFIX: Record<ChordQuality, string> = {
  major: '',
  minor: 'm',
  diminished: 'dim',
  augmented: 'aug',
  major7: 'maj7',
  minor7: 'm7',
  dominant7: '7',
  minor7b5: 'm7b5',
  diminished7: 'dim7',
  minorMajor7: 'mMaj7',
  sus2: 'sus2',
  sus4: 'sus4',
  '6': '6',
  minor6: 'm6',
  add9: 'add9',
  '9': '9',
  major9: 'maj9',
  minor9: 'm9',
};

/**
 * ルートピッチクラスと品質からコードシンボル文字列を組み立てる。
 * キーに応じた綴りを使う。
 */
export function buildChordSymbol(rootPc: number, quality: ChordQuality, key?: string): string {
  const rootName = key ? spellPitchClass(rootPc, key) : pitchClassToSharpName(rootPc);
  const suffix = QUALITY_SYMBOL_SUFFIX[quality];
  return rootName + suffix;
}
