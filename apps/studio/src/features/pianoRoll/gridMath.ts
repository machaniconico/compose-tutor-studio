// Pure grid-geometry + quantization helpers for the piano roll and other
// beat-based editors. No React, no store — easy to unit test.

import { beatTick } from '@cts/project-model';

/**
 * Available snap resolutions, in beats. 1 = quarter note in 4/4; 1/3 and 1/6
 * are the eighth- and sixteenth-note triplet grids.
 */
export const GRID_SNAP_OPTIONS: readonly number[] = [1 / 6, 0.25, 1 / 3, 0.5, 1, 2];

/** Labels (Japanese) for each snap resolution. */
export const GRID_SNAP_LABELS: Record<number, string> = {
  [1 / 6]: '1/16 3連',
  0.25: '1/16',
  [1 / 3]: '1/8 3連',
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

/**
 * Grid lines per beat when `snap` divides one beat evenly (1/3 → 3, 0.25 → 4,
 * 1 → 1), else null. Snapping and moving on such a grid count whole lines and
 * divide once (round(beat * 3) / 3), so triplet steps never pile up float error.
 */
function linesPerBeat(snap: number): number | null {
  if (!(snap > 0) || !Number.isFinite(snap) || snap > 1) return null;
  const lines = Math.round(1 / snap);
  return Math.abs(1 / snap - lines) < 1e-9 ? lines : null;
}

/** Snap a beat value to the nearest grid line of `snap` beats. */
export function snapBeat(beat: number, snap: number): number {
  if (snap <= 0) return Math.max(0, beat);
  const lines = linesPerBeat(snap);
  return Math.max(0, lines === null ? Math.round(beat / snap) * snap : Math.round(beat * lines) / lines);
}

/**
 * `beat` moved by `steps` grid lines of `snap` beats. A result within 1e-9 beats
 * of a grid line lands exactly on it (three 1/3-beat steps from 0 give exactly
 * 1); an off-grid beat keeps its offset (1/1200 + 1/3 stays as it is).
 */
export function addGridSteps(beat: number, snap: number, steps: number): number {
  const moved = beat + steps * snap;
  const lines = linesPerBeat(snap);
  if (lines === null) return moved;
  const line = Math.round(moved * lines);
  return Math.abs(moved * lines - line) < 1e-9 ? line / lines : moved;
}

/** Snap a beat value DOWN to the grid line at or before it (for placement). */
export function floorToGrid(beat: number, snap: number): number {
  if (snap <= 0) return Math.max(0, beat);
  return Math.max(0, Math.floor(beat / snap) * snap);
}

/**
 * The piano roll's edit range: keep a note inside a clip of `clipLength` beats
 * (beats past it are shaded and only open up when the clip is lengthened).
 * - `keep: 'length'` (move, quantize): the note keeps its length (cut to the
 *   clip length at most) and its start moves back to the last `snap` grid line
 *   where it still ends inside the clip (any beat when `snap` <= 0).
 * - `keep: 'start'` (place, resize): the start moves back only when it is at or
 *   past the clip end, to the last grid line before it; the length is cut to
 *   end at the clip end.
 */
export function clampNoteToClip(
  note: { startBeat: number; durationBeats: number },
  clipLength: number,
  opts: { snap: number; keep: 'length' | 'start' },
): { startBeat: number; durationBeats: number } {
  const { snap } = opts;
  if (opts.keep === 'length') {
    const durationBeats = Math.min(note.durationBeats, clipLength);
    const limit = clipLength - durationBeats;
    const lastStart = snap > 0 ? Math.floor(limit / snap + 1e-9) * snap : limit;
    return { startBeat: Math.max(0, Math.min(note.startBeat, lastStart)), durationBeats };
  }
  let startBeat = Math.max(0, note.startBeat);
  if (startBeat >= clipLength - 1e-9) {
    startBeat =
      snap > 0
        ? Math.max(0, Math.ceil(clipLength / snap - 1e-9) - 1) * snap
        : Math.max(0, clipLength - note.durationBeats);
  }
  return { startBeat, durationBeats: Math.min(note.durationBeats, clipLength - startBeat) };
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

// ---------------------------------------------------------------------------
// Ghost notes: other tracks' sounding notes, shown read-only behind the clip.
// ---------------------------------------------------------------------------

/** Upper bound on mounted ghost notes (same idea as the ruler's MAX_RENDERED_BEATS). */
export const MAX_RENDERED_GHOSTS = 600;

/** A sounding note of another track, in the viewed clip's relative beats. */
export type GhostNote = {
  key: string;
  trackId: string;
  pitch: number;
  /** Absolute song beat of the onset (swing included), the source of truth for range checks. */
  absStartBeat: number;
  /** Beats from the viewed clip's start (may be negative or past the grid). */
  startBeat: number;
  durationBeats: number;
  velocity: number;
};

/** The part of a `soundingEvents` event the ghost view reads (absolute song beats). */
type GhostSourceEvent = {
  kind: string;
  trackId: string;
  clipId: string;
  sourceIndex: number;
  repeat: number;
  startBeat: number;
  durationBeats?: number;
  pitch?: number;
  velocity: number;
};

/**
 * Turn `soundingEvents` output into ghost notes for the viewed clip. Events
 * carry absolute song beats (loops, links and the song-end cut already
 * applied), so the relative beat is `event.startBeat - viewClip.startBeat`.
 * Drum events, the viewed clip's own track and hidden tracks are left out.
 */
export function ghostNotesFromEvents(
  events: readonly GhostSourceEvent[],
  opts: {
    viewClip: { startBeat: number };
    ownTrackId: string;
    hiddenTrackIds: ReadonlySet<string>;
  },
): GhostNote[] {
  const out: GhostNote[] = [];
  for (const e of events) {
    if (e.kind !== 'note' || e.pitch === undefined || e.durationBeats === undefined) continue;
    if (e.trackId === opts.ownTrackId || opts.hiddenTrackIds.has(e.trackId)) continue;
    out.push({
      key: `${e.clipId}:${e.sourceIndex}:${e.repeat}`,
      trackId: e.trackId,
      pitch: e.pitch,
      absStartBeat: e.startBeat,
      startBeat: e.startBeat - opts.viewClip.startBeat,
      durationBeats: e.durationBeats,
      velocity: e.velocity,
    });
  }
  return out;
}

/**
 * Ghosts that intersect the shown pitch rows and the clip's span, capped at
 * `max` so a dense song cannot flood the DOM. The span test runs on absolute
 * ticks (each edge rounded on its own, as soundingEvents does), so float error
 * in relative beats cannot add or drop an edge ghost. `startBeat` is only the
 * drawing position.
 */
export function visibleGhostNotes(
  ghosts: readonly GhostNote[],
  view: { lowMidi: number; highMidi: number; clipStartBeat: number; gridLength: number },
  max = MAX_RENDERED_GHOSTS,
): GhostNote[] {
  const viewStartTick = beatTick(view.clipStartBeat);
  const viewEndTick = beatTick(view.clipStartBeat + view.gridLength);
  const out: GhostNote[] = [];
  for (const g of ghosts) {
    if (out.length >= max) break;
    if (g.pitch < view.lowMidi || g.pitch > view.highMidi) continue;
    if (beatTick(g.absStartBeat) >= viewEndTick || beatTick(g.absStartBeat + g.durationBeats) <= viewStartTick) continue;
    out.push(g);
  }
  return out;
}

/**
 * Where each of a clip's own notes actually sounds, by note id: the absolute
 * onset from soundingEvents (swing included), first repeat only. Colouring
 * looks up the chord at this beat, not at the stored one.
 */
export function soundingStartByNoteId(
  events: readonly GhostSourceEvent[],
  clip: { id: string; notes?: readonly { id: string }[] },
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'note' || e.clipId !== clip.id || e.repeat !== 0) continue;
    const note = clip.notes?.[e.sourceIndex];
    if (note) out.set(note.id, e.startBeat);
  }
  return out;
}

/**
 * Chord lookup for colouring, by integer ticks: a note sounds in a chord when
 * `startTick <= noteTick < endTick`, each edge rounded on its own as
 * soundingEvents does. No tolerance constant, so a swung onset just before a
 * chord change stays in the earlier chord. Overlaps go to the chord with the earliest raw startBeat.
 * (useScaleInfo's `chordFinder` keeps its 1e-6 tolerance for its other callers.)
 */
export function chordTickFinder<C extends { startBeat: number; durationBeats: number }>(
  chordTrack: readonly C[],
): (beat: number) => C | undefined {
  const spans = chordTrack
    .map((chord) => ({ chord, start: beatTick(chord.startBeat), end: beatTick(chord.startBeat + chord.durationBeats) }))
    // chordFinder's rule: order by the raw startBeat (stable, so equal starts keep stored order),
    // never by the rounded tick; the first covering chord wins.
    .sort((a, b) => a.chord.startBeat - b.chord.startBeat);
  return (beat) => {
    const tick = beatTick(beat);
    return spans.find((s) => tick >= s.start && tick < s.end)?.chord;
  };
}
