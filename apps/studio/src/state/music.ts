// Small, self-contained musical helpers for the skeleton.
//
// These are deliberately minimal: wave 2 replaces this with @cts/theory-engine.
// For now we only need pitch-class math to build a default chord progression
// and to render crude scale/chord-tone highlighting in the editors.

import type { PitchClassName, ScaleName } from '@cts/project-model';

/** Canonical pitch-class index (0-11) for each note name. */
export const PITCH_CLASS: Record<PitchClassName, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

/** Sharp spelling for each pitch class index, for crude labels. */
export const PITCH_CLASS_NAMES: readonly string[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

/** Return the pitch-class index (0-11) of a MIDI note or pitch-class number. */
export function pitchClass(midiOrPc: number): number {
  return ((midiOrPc % 12) + 12) % 12;
}

/** Human-readable name for a MIDI note number, e.g. 60 -> "C4". */
export function midiNoteName(midi: number): string {
  const pc = pitchClass(midi);
  const octave = Math.floor(midi / 12) - 1;
  const name = PITCH_CLASS_NAMES[pc] ?? '?';
  return `${name}${octave}`;
}

/** Semitone intervals (from the tonic) for each supported scale. */
export const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

/** True when the given MIDI/pitch-class is in the scale rooted at `tonicPc`. */
export function isInScale(midiOrPc: number, tonicPc: number, scale: ScaleName): boolean {
  const interval = pitchClass(midiOrPc - tonicPc);
  return SCALE_INTERVALS[scale].includes(interval);
}
