/**
 * コードシンボルパーサ
 *
 * 対応シンボル例:
 *   C, Cm, Am, Fmaj7, G7, Dm7, Bdim, Bm7b5, Caug, Csus4, Csus2,
 *   C6, Cm6, Cadd9, C9, Cmaj9, Cm9, スラッシュコード Dm7/G
 *
 * 出力 ParsedChord: root, quality, intervals, pitchClasses, notes, bass。
 */

import type { ChordQuality, ParsedChord } from './types';
import { noteNameToPitchClass, spellPitchClass, pitchClassToSharpName } from './pitch';
import { chordQualityIntervals, parseChordQuality, parseChordTokens } from './parse-chord';

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
  return chordQualityIntervals(quality);
}

/**
 * コードシンボルをパースする。
 * @param symbol コード文字列 (例 "Fmaj7", "Dm7/G")
 * @param key 綴りに使うキー (省略時はシンボルのルート自身)
 */
export function parseChord(symbol: string, key?: string): ParsedChord {
  const tokens = parseChordTokens(symbol, { allowSlash: true });
  const rootPc = tokens.rootPc;
  const quality = parseChordQuality(tokens.suffix);
  const intervals = chordIntervals(quality);
  const pitchClasses = intervals.map((iv) => (rootPc + iv) % 12);

  const spellKey = key ?? tokens.rootToken;
  const root = key ? spellPitchClass(rootPc, spellKey) : tokens.rootToken;
  const notes = pitchClasses.map((pc) => spellPitchClass(pc, spellKey));

  let bass = root;
  let bassPc = rootPc;
  if (tokens.bassSpelling !== undefined && tokens.bassSpelling !== '') {
    bassPc = noteNameToPitchClass(tokens.bassSpelling);
    bass = key ? spellPitchClass(bassPc, spellKey) : tokens.bassSpelling;
  }

  return {
    symbol: tokens.raw,
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
