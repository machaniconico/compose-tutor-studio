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

/** Lowest / highest MIDI pitch shown in the editable range (88 keys, A0..C8). */
export const PIANO_LOW_MIDI = 21; // A0
export const PIANO_HIGH_MIDI = 108; // C8

/** An inclusive range of MIDI note numbers, `low` <= `high`. */
export type PitchRange = { low: number; high: number };

/** The full editable piano range. */
export const FULL_PIANO_RANGE: PitchRange = { low: PIANO_LOW_MIDI, high: PIANO_HIGH_MIDI };

/** Range shown for a clip with no notes (C3..C5). */
const EMPTY_CLIP_WINDOW: PitchRange = { low: 48, high: 72 };

/** Convert a MIDI note number to its row index (row 0 = `range.high`), or null outside the range. */
export function midiToRow(midi: number, range: PitchRange = FULL_PIANO_RANGE): number | null {
  if (!Number.isInteger(midi) || midi < range.low || midi > range.high) return null;
  return range.high - midi;
}

/** Convert a row index (row 0 = `range.high`) to its MIDI note number, or null outside the range. */
export function rowToMidi(row: number, range: PitchRange = FULL_PIANO_RANGE): number | null {
  if (!Number.isInteger(row) || row < 0 || row > range.high - range.low) return null;
  return range.high - row;
}

/** Collect notes for the inclusive range of rendered rows, in row order. */
export function notesInRows<Note>(
  notesByRow: ReadonlyMap<number, readonly Note[]>,
  firstRow: number,
  lastRow: number,
): Note[] {
  const out: Note[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const list = notesByRow.get(row);
    if (list) {
      for (const note of list) out.push(note);
    }
  }
  return out;
}

/**
 * Lowest and highest pitch, or null for no pitches. One pass, so a dense clip
 * (hundreds of thousands of notes) cannot overflow the call stack.
 */
export function pitchSpan(pitches: readonly number[]): PitchRange | null {
  if (pitches.length === 0) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const pitch of pitches) {
    if (pitch < low) low = pitch;
    if (pitch > high) high = pitch;
  }
  return { low, high };
}

/**
 * Pitch window to show when a clip opens: the clip's note range padded by one
 * octave on each side, clamped into `range`. A clip without notes shows C3..C5.
 */
export function initialPitchWindow(
  pitches: readonly number[],
  range: PitchRange = FULL_PIANO_RANGE,
): PitchRange {
  const span = pitchSpan(pitches);
  if (span === null) return { ...EMPTY_CLIP_WINDOW };
  return {
    low: Math.max(range.low, span.low - 12),
    high: Math.min(range.high, span.high + 12),
  };
}

/**
 * scrollTop that opens a pitch window: the window is centred in the viewport,
 * clamped to the scrollable range. When the window does not fit and the clip's
 * actual note range `notes` is given, the notes are centred instead, and when
 * even they do not fit, their highest note is shown at the top, so a note is
 * always in view. `viewportHeight` is the height available to rows (without a
 * sticky ruler). Rows run from `highMidi` at the top down to
 * `highMidi - rowCount + 1`.
 */
export function windowScrollTop(
  win: PitchRange,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  highMidi = PIANO_HIGH_MIDI,
  notes?: PitchRange,
): number {
  const height = Math.max(0, viewportHeight);
  const fits = (r: PitchRange) => (r.high - r.low + 1) * rowHeight <= height;
  const target = notes && !fits(win) ? notes : win;
  const targetTop = (highMidi - target.high) * rowHeight;
  const targetBottom = (highMidi - target.low + 1) * rowHeight;
  const desired = notes && !fits(target) ? targetTop : (targetTop + targetBottom) / 2 - height / 2;
  const maxTop = Math.max(0, rowCount * rowHeight - height);
  return Math.min(maxTop, Math.max(0, desired));
}

/**
 * Inclusive row indices that intersect the viewport, widened by `overscan`
 * rows and clamped to `[0, rowCount - 1]`. Used to render only visible rows.
 */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 0,
): { first: number; last: number } {
  if (rowCount <= 0) return { first: 0, last: -1 };
  if (rowHeight <= 0) return { first: 0, last: rowCount - 1 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan;
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight) - 1 + overscan;
  return { first: Math.max(0, first), last: Math.min(rowCount - 1, Math.max(0, last)) };
}

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

/** Quantize every provided note's start to the given grid resolution. */
export function quantizeNotes<T extends { startBeat: number }>(
  notes: readonly T[],
  resolution: number,
): Array<Omit<T, 'startBeat'> & { startBeat: number }> {
  return notes.map((note) => ({ ...note, startBeat: quantizeStart(note.startBeat, resolution) }));
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
 * preferring the candidate itself, then searching outward. Candidates outside
 * `[low, high]` are skipped, so at the edge of the keyboard the snap goes
 * inward (e.g. B major at MIDI 108 gives 107, not 109).
 */
export function snapPitchToPitchClasses(
  pitch: number,
  allowedPcs: ReadonlySet<number>,
  low = Number.NEGATIVE_INFINITY,
  high = Number.POSITIVE_INFINITY,
): number {
  if (allowedPcs.size === 0) return pitch;
  const allowed = (p: number) => p >= low && p <= high && allowedPcs.has(((p % 12) + 12) % 12);
  if (allowed(pitch)) return pitch;
  for (let delta = 1; delta <= 6; delta += 1) {
    if (allowed(pitch + delta)) return pitch + delta;
    if (allowed(pitch - delta)) return pitch - delta;
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
