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

/** Drum grid resolution: steps per quarter-note beat (16 steps in a 4/4 bar). */
export const DRUM_STEPS_PER_BEAT = 4;

/**
 * Steps in one bar of the drum grid for a time signature: 4/4 -> 16, 3/4 -> 12,
 * 6/8 -> 12. The single rule for new drum clips and for regridding on a meter
 * change, so every bar keeps `DRUM_STEPS_PER_BEAT` whole steps per beat.
 */
export function drumStepsPerBar(timeSignature: [number, number]): number {
  return Math.max(1, Math.round(beatsPerBar(timeSignature) * DRUM_STEPS_PER_BEAT));
}

/**
 * Nearest drum step for a beat position inside a clip whose bar has
 * `stepsPerBar` steps and `beatsPerBar` beats (inverse of step -> beat).
 * Pattern presets and lesson checks must share this rounding so a grid that
 * does not divide the bar evenly (e.g. 16 steps in 3/4) still agrees on where
 * each beat lands.
 */
export function drumBeatToStep(beat: number, stepsPerBar: number, beatsPerBar: number): number {
  return Math.round((beat * stepsPerBar) / beatsPerBar);
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

export const PPQ = 480;

export function beatTick(beat: number): number {
  return Math.round(beat * PPQ);
}
