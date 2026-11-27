import type { ScaleName } from '@cts/project-model';
import { keySignatureUsesFlats, noteNameToPitchClass } from '@cts/theory-engine';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11] as const;
/** Heptatonic scales spell each degree with its own letter. */
const DEGREE_STEPS: Partial<Record<ScaleName, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
};
const MINOR_SCALES: ReadonlySet<string> = new Set(['naturalMinor', 'harmonicMinor', 'melodicMinor', 'minorPentatonic', 'blues']);

/** Whether the scale's key signature is the minor one (pentatonic / blues use their parent). */
export function scaleIsMinor(scale: string): boolean {
  return MINOR_SCALES.has(scale);
}
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/**
 * Spell a pitch class (0-11) for the key `tonic` (e.g. "Db", "F#") and scale.
 * Degrees of a heptatonic scale take the letter of their degree (F# major has
 * E#, Eb minor has Cb, harmonic / melodic minor keep their raised 6th / 7th on
 * their own letter). Other notes, and every note of a pentatonic or blues
 * scale, follow the key signature of the parent major / minor. A degree that
 * would need a double accidental falls back to the chromatic spelling.
 */
export function spellPitchClassInKey(pc: number, tonic: string, scale: ScaleName): string {
  const minor = scaleIsMinor(scale);
  const normalized = ((pc % 12) + 12) % 12;
  const tonicPc = noteNameToPitchClass(tonic);
  const tonicLetter = LETTERS.indexOf(tonic.trim().charAt(0).toUpperCase() as (typeof LETTERS)[number]);
  const steps = DEGREE_STEPS[scale] ?? (minor ? DEGREE_STEPS.naturalMinor! : DEGREE_STEPS.major!);
  if (tonicLetter >= 0) {
    for (let degree = 0; degree < 7; degree += 1) {
      if ((tonicPc + steps[degree]!) % 12 !== normalized) continue;
      const letter = (tonicLetter + degree) % 7;
      const diff = (normalized - LETTER_PC[letter]! + 12) % 12;
      if (diff === 0) return LETTERS[letter]!;
      if (diff === 1) return `${LETTERS[letter]}#`;
      if (diff === 11) return `${LETTERS[letter]}b`;
      break;
    }
  }
  const flats = keySignatureUsesFlats(`${tonic} ${minor ? 'minor' : 'major'}`);
  return (flats ? FLATS : SHARPS)[normalized]!;
}

/**
 * Re-spell the root and slash bass of an already transposed chord symbol for
 * the new key. Returns the symbol and its root spelling.
 */
export function respellChordSymbol(
  symbol: string,
  tonic: string,
  scale: ScaleName,
): { symbol: string; root: string } {
  const head = /^([A-G][#b]?)/.exec(symbol);
  if (!head) throw new Error(`「${symbol}」はコード名として読み取れません。`);
  const spell = (name: string): string => spellPitchClassInKey(noteNameToPitchClass(name), tonic, scale);
  const root = spell(head[1]!);
  let rest = symbol.slice(head[1]!.length);
  const bass = /\/([A-G][#b]?)$/.exec(rest);
  if (bass) rest = `${rest.slice(0, bass.index)}/${spell(bass[1]!)}`;
  return { symbol: `${root}${rest}`, root };
}
