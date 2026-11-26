// Pure geometry for the song overview (ArrangeView): pixels ↔ beats, bar
// snapping, where a dropped clip lands and how far a resize may go.

import { beatsPerBar, moveClip, splitClip, type Clip, type Project } from '@cts/project-model';

const EPSILON = 1e-9;

/** Beat under a pixel offset from the lane's left edge (never before 0). */
export function xToBeat(x: number, ppb: number): number {
  return Math.max(0, x / ppb);
}

/** The bar start nearest to `beat` (never before 0). */
export function snapBeatToBar(beat: number, bpb: number): number {
  return Math.max(0, Math.round(beat / bpb) * bpb);
}

/** Start beat of the bar a pixel offset falls in. */
export function barStartAtX(x: number, ppb: number, bpb: number): number {
  return Math.floor(xToBeat(x, ppb) / bpb + EPSILON) * bpb;
}

/**
 * Where a clip dropped at `requestedBeat` lands: the nearest bar start, moved
 * on to the nearest spot that overlaps no other clip on its track (the same
 * rule moveClip applies).
 */
export function dropStartBeat(project: Project, clipId: string, requestedBeat: number, bpb: number): number {
  const snapped = snapBeatToBar(requestedBeat, bpb);
  const moved = moveClip(project, clipId, snapped);
  for (const track of moved.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip.startBeat;
  }
  return snapped;
}

/**
 * Length of a clip starting at `startBeat` whose right edge is dragged to
 * `pointerBeat`: whole beats, at least 1, and never past `nextClipStart`
 * (when the gap to it is under 1 beat, the clip fills just the gap).
 */
export function resizedLengthBeats(startBeat: number, pointerBeat: number, nextClipStart?: number): number {
  const length = Math.max(1, Math.round(pointerBeat - startBeat));
  return nextClipStart === undefined ? length : Math.min(length, nextClipStart - startBeat);
}

/** Start of the clip after `clip` on its track, if any. */
export function nextClipStart(clips: readonly Clip[], clip: Clip): number | undefined {
  let next: number | undefined;
  for (const other of clips) {
    if (other.id === clip.id || other.startBeat < clip.startBeat + EPSILON) continue;
    if (next === undefined || other.startBeat < next) next = other.startBeat;
  }
  return next;
}

/**
 * Whether splitting the clip at `beat` would cut it inside (not on an edge),
 * with the same rounding splitClip applies (a drum clip is cut on the nearest
 * step). Other failures (a broken link, too many events) still count as
 * available so the split can explain them.
 */
export function canSplitAt(project: Project, clipId: string | null, beat: number): boolean {
  if (!clipId) return false;
  const result = splitClip(project, clipId, beat);
  return result.ok || (result.reason !== 'invalidBoundary' && result.reason !== 'missingClip');
}

/**
 * Song length in bars that covers the edited clip's end, never shorter than
 * `floorBars` (by default the current length). Null when a clip would end past
 * both `maxBars` and `floorBars`, because it could not be heard there.
 */
export function songBarsFor(
  project: Project,
  clipEndBeat: number,
  maxBars: number,
  floorBars = project.lengthBars,
): number | null {
  const bpb = beatsPerBar(project.timeSignature);
  const needed = Math.ceil(clipEndBeat / bpb - EPSILON);
  if (needed > Math.max(maxBars, floorBars)) return null;
  return Math.max(floorBars, needed);
}

/** `next` with its bar count set by songBarsFor, or null when a clip would end past the limit. */
export function withSongLength(
  next: Project,
  clipEndBeat: number,
  maxBars: number,
  floorBars = next.lengthBars,
): Project | null {
  const lengthBars = songBarsFor(next, clipEndBeat, maxBars, floorBars);
  if (lengthBars === null) return null;
  return lengthBars === next.lengthBars ? next : { ...next, lengthBars };
}
