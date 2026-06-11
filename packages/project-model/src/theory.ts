// Minimal pitch helpers used by templates to compute chord tones as MIDI
// pitch classes (0..11). This is deliberately small: full theory analysis lives
// in the separate theory-engine package.

import type { PitchClassName } from './types';

const PITCH_CLASS: Record<string, number> = {
  C: 0,
  'B#': 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  F: 5,
  'E#': 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};

/** Map a pitch class name (e.g. "F#", "Bb") to its 0..11 pitch-class number. */
export function pitchClassNumber(name: string): number {
  const value = PITCH_CLASS[name];
  if (value === undefined) {
    throw new Error(`Unknown pitch class name: ${name}`);
  }
  return value;
}

/** Semitone intervals above the root for the chord qualities we ship in templates. */
const CHORD_INTERVALS: Record<string, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  major7: [0, 4, 7, 11],
  minor7: [0, 3, 7, 10],
  dominant7: [0, 4, 7, 10],
  minor7b5: [0, 3, 6, 10],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
};

/**
 * Compute the chord tones as MIDI pitch classes (0..11) for a root + quality.
 * Returns the unique pitch classes of the chord.
 */
export function chordPitchClasses(root: PitchClassName, quality: string): number[] {
  const intervals = CHORD_INTERVALS[quality];
  if (!intervals) {
    throw new Error(`Unknown chord quality: ${quality}`);
  }
  const rootPc = pitchClassNumber(root);
  return intervals.map((semi) => (rootPc + semi) % 12);
}

export const CHORD_QUALITIES = Object.keys(CHORD_INTERVALS);
