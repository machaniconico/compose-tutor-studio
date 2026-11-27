/** MIDI ticks per quarter note. */
export const PPQ = 480;

/** Round a quarter-note beat position to the nearest tick. */
export function beatTick(beat: number): number {
  return Math.round(beat * PPQ);
}

/** Recognize whole ticks despite floating-point arithmetic at the beat boundary. */
export function wholeBeatTick(beat: number): number | null {
  const tick = beatTick(beat);
  if (!Number.isSafeInteger(tick)) return null;
  const canonicalBeat = tick / PPQ;
  const tolerance = Number.EPSILON * Math.max(Math.abs(beat), Math.abs(canonicalBeat));
  return Math.abs(beat - canonicalBeat) <= tolerance ? tick : null;
}

/** A clip's [start, end) in ticks. Round each absolute edge independently. */
export function clipTickSpan(startBeat: number, lengthBeats: number): readonly [number, number] {
  return [beatTick(startBeat), beatTick(startBeat + lengthBeats)];
}

/**
 * Whether two [start, end) tick spans overlap. An empty span (end <= start)
 * overlaps nothing.
 */
export function tickSpansOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[1] > a[0] && b[1] > b[0] && a[0] < b[1] && b[0] < a[1];
}
