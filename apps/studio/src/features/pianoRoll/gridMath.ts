// Pure grid-geometry + quantization helpers for the piano roll and other
// beat-based editors. No React, no store — easy to unit test.

/** Available snap resolutions, in beats. 1 = quarter note in 4/4. */
export const GRID_SNAP_OPTIONS: readonly number[] = [0.25, 0.5, 1, 2];

/** Labels (Japanese) for each snap resolution. */
export const GRID_SNAP_LABELS: Record<number, string> = {
  0.25: '1/16',
  0.5: '1/8',
  1: '1/4',
  2: '1/2小節',
};

/** Lowest / highest MIDI pitch shown in the editable range (C2..C6). */
export const PIANO_LOW_MIDI = 36; // C2
export const PIANO_HIGH_MIDI = 84; // C6

/** Snap a beat value to the nearest grid line of `snap` beats. */
export function snapBeat(beat: number, snap: number): number {
  if (snap <= 0) return Math.max(0, beat);
  return Math.max(0, Math.round(beat / snap) * snap);
}

/** Snap a beat value DOWN to the grid line at or before it (for placement). */
export function floorToGrid(beat: number, snap: number): number {
  if (snap <= 0) return Math.max(0, beat);
  return Math.max(0, Math.floor(beat / snap) * snap);
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
 * preferring the candidate itself, then searching outward.
 */
export function snapPitchToPitchClasses(pitch: number, allowedPcs: ReadonlySet<number>): number {
  if (allowedPcs.size === 0) return pitch;
  const pc = ((pitch % 12) + 12) % 12;
  if (allowedPcs.has(pc)) return pitch;
  for (let delta = 1; delta <= 6; delta += 1) {
    const up = pitch + delta;
    if (allowedPcs.has(((up % 12) + 12) % 12)) return up;
    const down = pitch - delta;
    if (allowedPcs.has(((down % 12) + 12) % 12)) return down;
  }
  return pitch;
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
