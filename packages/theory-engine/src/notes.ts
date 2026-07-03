/**
 * 公開ノートAPI (parseNoteName / midiToNoteName / noteNameToMidi)
 *
 * ピッチクラス規約: C=0, C#/Db=1, ... B=11。
 * MIDI規約: C4=60 (octave = floor(midi/12) - 1)。
 *
 * 内部の pitch.ts ヘルパを土台にしつつ、prompt 02 が要求する公開シグネチャに合わせる。
 */

import {
  FLAT_NAMES,
  SHARP_NAMES,
  formatMidiNoteName,
  parsedNoteNameToMidi,
  parsePitchNoteName,
} from './pitch';

/** parseNoteName の戻り値。octave はオクターブ表記があった場合のみ付与される。 */
export type ParsedNoteName = {
  /** 正規化された音名 (例 "C", "F#", "Bb")。 */
  name: string;
  /** ピッチクラス 0-11。 */
  pitchClass: number;
  /** オクターブ番号 (入力に含まれていた場合のみ)。 */
  octave?: number;
};

/**
 * 音名文字列をパースする。
 * 受理例: "C", "F#", "Bb", "C4", "Eb3", "B#", "Cb"。
 * 不正な入力では null を返す (例外は投げない)。
 */
export function parseNoteName(input: string): ParsedNoteName | null {
  if (typeof input !== 'string') return null;
  try {
    return parsePitchNoteName(input);
  } catch {
    return null;
  }
}

/**
 * MIDIノート番号を音名 (オクターブ付き) へ変換する。
 * 既定はシャープ綴り。flats=true でフラット綴り。
 * 60 -> "C4"。
 */
export function midiToNoteName(midi: number, options?: { flats?: boolean }): string {
  return formatMidiNoteName(midi, { flats: options?.flats, truncatePitchClass: true });
}

/**
 * 音名とオクターブ番号から MIDI番号へ。
 * - "C" + 4 -> 60
 * - 音名にオクターブが含まれる場合 ("C4") はそちらを優先する。
 * - octave 省略時は 4 を既定とする。
 * 不正な音名では null を返す。
 */
export function noteNameToMidi(name: string, octave = 4): number | null {
  try {
    return parsedNoteNameToMidi(parsePitchNoteName(name), octave);
  } catch {
    return null;
  }
}

export { SHARP_NAMES, FLAT_NAMES };
