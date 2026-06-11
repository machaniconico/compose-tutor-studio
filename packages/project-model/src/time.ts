// Beat/time math utilities. All functions are pure.

import type { Project } from './types';

/**
 * Number of quarter-note beats in one bar for a given time signature.
 * A beat here is always a quarter note (the MIDI/PPQ convention), so a bar of
 * `num/den` contains `num * (4 / den)` quarter-note beats.
 * Example: 4/4 -> 4, 6/8 -> 3, 3/4 -> 3, 5/8 -> 2.5.
 */
export function beatsPerBar(timeSignature: [number, number]): number {
  const [num, den] = timeSignature;
  return num * (4 / den);
}

/** Convert a bar index (0-based) to its starting beat. */
export function barToBeat(bar: number, timeSignature: [number, number]): number {
  return bar * beatsPerBar(timeSignature);
}

/** Convert a beat position to a (possibly fractional) bar index. */
export function beatToBar(beat: number, timeSignature: [number, number]): number {
  return beat / beatsPerBar(timeSignature);
}

/**
 * Seconds per quarter-note beat at a given tempo.
 * 60 seconds / bpm beats.
 */
export function beatToSeconds(bpm: number): number {
  return 60 / bpm;
}

/** Total length of the project in quarter-note beats. */
export function projectLengthBeats(project: Project): number {
  return project.lengthBars * beatsPerBar(project.timeSignature);
}
