/**
 * 公開ノートAPI (parseNoteName / midiToNoteName / noteNameToMidi)
 *
 * ピッチクラス規約: C=0, C#/Db=1, ... B=11。
 * MIDI規約: C4=60 (octave = floor(midi/12) - 1)。
 *
 * 内部の pitch.ts ヘルパを土台にしつつ、prompt 02 が要求する公開シグネチャに合わせる。
 */

import { noteNameToPitchClass } from './pitch';

/** シャープ綴りのピッチクラス名 (C=0)。 */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** フラット綴りのピッチクラス名 (C=0)。 */
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** parseNoteName の戻り値。octave はオクターブ表記があった場合のみ付与される。 */
export type ParsedNoteName = {
  /** 正規化された音名 (例 "C", "F#", "Bb")。 */
  name: string;
  /** ピッチクラス 0-11。 */
  pitchClass: number;
  /** オクターブ番号 (入力に含まれていた場合のみ)。 */
  octave?: number;
};

/** 臨時記号を正規化する (♯->#, ♭->b)。 */
function normalizeAccidentals(accidentals: string): string {
  return accidentals.replace(/♯/g, '#').replace(/♭/g, 'b');
}

/**
 * 音名文字列をパースする。
 * 受理例: "C", "F#", "Bb", "C4", "Eb3", "B#", "Cb"。
 * 不正な入力では null を返す (例外は投げない)。
 */
export function parseNoteName(input: string): ParsedNoteName | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const match = trimmed.match(/^([A-Ga-g])([#x♯b♭]*)(-?\d+)?$/);
  if (!match) return null;

  const [, letterRaw = '', accidentalsRaw = '', octaveStr] = match;
  const letter = letterRaw.toUpperCase();
  const accidentals = normalizeAccidentals(accidentalsRaw);
  const name = letter + accidentals;

  let pitchClass: number;
  try {
    pitchClass = noteNameToPitchClass(name);
  } catch {
    return null;
  }

  if (octaveStr === undefined) {
    return { name, pitchClass };
  }
  return { name, pitchClass, octave: Number.parseInt(octaveStr, 10) };
}

/**
 * MIDIノート番号を音名 (オクターブ付き) へ変換する。
 * 既定はシャープ綴り。flats=true でフラット綴り。
 * 60 -> "C4"。
 */
export function midiToNoteName(midi: number, options?: { flats?: boolean }): string {
  const pc = ((Math.trunc(midi) % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const names = options?.flats ? FLAT_NAMES : SHARP_NAMES;
  return `${names[pc]}${octave}`;
}

/**
 * 音名とオクターブ番号から MIDI番号へ。
 * - "C" + 4 -> 60
 * - 音名にオクターブが含まれる場合 ("C4") はそちらを優先する。
 * - octave 省略時は 4 を既定とする。
 * 不正な音名では null を返す。
 */
export function noteNameToMidi(name: string, octave = 4): number | null {
  const parsed = parseNoteName(name);
  if (parsed === null) return null;
  const oct = parsed.octave ?? octave;
  return (oct + 1) * 12 + parsed.pitchClass;
}

export { SHARP_NAMES, FLAT_NAMES };
