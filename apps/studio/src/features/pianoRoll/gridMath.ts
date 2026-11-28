// Pure grid-geometry + quantization helpers for the piano roll and other
// beat-based editors. No React, no store — easy to unit test.

import { PPQ } from '@cts/project-model';

/** Round a beat to the nearest whole tick (480 per beat), so triplet grids never drift off the tick grid. */
function tickAligned(beat: number): number {
  return Math.round(beat * PPQ) / PPQ;
}

/** Available snap resolutions, in beats. 1 = quarter note in 4/4. */
export const TRIPLET_EIGHTH_BEATS = 160 / PPQ;
export const TRIPLET_SIXTEENTH_BEATS = 80 / PPQ;
/** 1/16T (80 ticks) and 1/8T (160 ticks) are whole ticks, like every other option. */
export const GRID_SNAP_OPTIONS: readonly number[] = [
  TRIPLET_SIXTEENTH_BEATS,
  0.25,
  TRIPLET_EIGHTH_BEATS,
  0.5,
  1,
  2,
];

/** Labels (Japanese) for each snap resolution. */
export const GRID_SNAP_LABELS: Record<number, string> = {
  [TRIPLET_SIXTEENTH_BEATS]: '1/16三連',
  [TRIPLET_EIGHTH_BEATS]: '1/8三連',
  0.25: '1/16',
  0.5: '1/8',
  1: '1/4',
  2: '1/2小節',
};

/** Lowest / highest MIDI pitch shown in the editable range (C2..C6). */
export const PIANO_LOW_MIDI = 36; // C2
export const PIANO_HIGH_MIDI = 84; // C6

/** The whole tick of a beat, or null when the beat is not exactly on the 1/480-beat grid. */
function wholeTick(beat: number): number | null {
  if (typeof beat !== 'number' || !Number.isFinite(beat)) return null;
  const tick = Math.round(beat * PPQ);
  return Number.isSafeInteger(tick) && tick / PPQ === beat ? tick : null;
}

/**
 * `beat + delta` for grid-derived values: when both are whole ticks the sum is
 * done in integer ticks and converted once (so 1/3 + 1/3 is 320/480). Any other
 * value, and a zero delta, is returned exactly as plain addition would.
 */
export function addGridBeats(beat: number, delta: number): number {
  if (delta === 0) return beat;
  const a = wholeTick(beat);
  const b = wholeTick(delta);
  return a === null || b === null ? beat + delta : (a + b) / PPQ;
}

/** `a - b` for grid-derived values, in integer ticks when both are whole ticks. */
export function beatDifference(a: number, b: number): number {
  const x = wholeTick(a);
  const y = wholeTick(b);
  return x === null || y === null ? a - b : (x - y) / PPQ;
}

/** Snap a beat value to the nearest grid line of `snap` beats. */
export function snapBeat(beat: number, snap: number): number {
  if (snap <= 0) return Math.max(0, beat);
  return Math.max(0, tickAligned(Math.round(beat / snap) * snap));
}

/** Snap a beat value DOWN to the grid line at or before it (for placement). */
export function floorToGrid(beat: number, snap: number): number {
  if (snap <= 0) return Math.max(0, beat);
  return Math.max(0, tickAligned(Math.floor(beat / snap) * snap));
}

/** Quantize a note start to the grid; keeps non-negative. */
export function quantizeStart(startBeat: number, snap: number): number {
  return snapBeat(startBeat, snap);
}

/** Convert an x pixel offset (relative to grid origin) into a beat value. */
export function xToBeat(x: number, pxPerBeat: number): number {
  if (pxPerBeat <= 0) return 0;
  return x / pxPerBeat;
}

/** Convert a beat value into an x pixel offset. */
export function beatToX(beat: number, pxPerBeat: number): number {
  return beat * pxPerBeat;
}

/** Convert a y pixel offset (top=highest pitch) into a MIDI pitch. */
export function yToPitch(y: number, rowHeight: number, highMidi = PIANO_HIGH_MIDI): number {
  if (rowHeight <= 0) return highMidi;
  return highMidi - Math.floor(y / rowHeight);
}

/** Convert a MIDI pitch into a y pixel offset (top of its row). */
export function pitchToY(pitch: number, rowHeight: number, highMidi = PIANO_HIGH_MIDI): number {
  return (highMidi - pitch) * rowHeight;
}

/** Clamp a pitch into the visible editable range. */
export function clampPitch(
  pitch: number,
  low = PIANO_LOW_MIDI,
  high = PIANO_HIGH_MIDI,
): number {
  return Math.max(low, Math.min(high, pitch));
}

/**
 * Snap a candidate MIDI pitch to the nearest member of a set of pitch classes
 * (used for scale-snapped vertical moves). `allowedPcs` is a set of 0-11
 * pitch classes. Returns the nearest pitch whose pitch-class is allowed,
 * preferring the candidate itself, then searching outward. `up` and `down`
 * are strict directions: if no allowed pitch exists that way, the bounded
 * candidate is returned so the caller can treat the edit as a no-op.
 */
export function snapPitchToPitchClasses(
  pitch: number,
  allowedPcs: ReadonlySet<number>,
  low = PIANO_LOW_MIDI,
  high = PIANO_HIGH_MIDI,
  preference: 'nearest' | 'up' | 'down' = 'nearest',
): number {
  const bounded = Math.max(low, Math.min(high, pitch));
  if (allowedPcs.size === 0) return bounded;
  const pc = ((bounded % 12) + 12) % 12;
  if (allowedPcs.has(pc)) return bounded;
  for (let delta = 1; delta <= high - low; delta += 1) {
    const up = bounded + delta;
    const down = bounded - delta;
    const upAllowed = up <= high && allowedPcs.has(((up % 12) + 12) % 12);
    const downAllowed = down >= low && allowedPcs.has(((down % 12) + 12) % 12);
    if (preference === 'down') {
      if (downAllowed) return down;
    } else if (preference === 'up') {
      if (upAllowed) return up;
    } else {
      if (upAllowed) return up;
      if (downAllowed) return down;
    }
  }
  return bounded;
}

/** True when two axis-aligned rectangles overlap (for marquee selection). */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/** Normalize a drag rectangle (from anchor to current) to x/y/w/h with w,h >= 0. */
export function normalizeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}
