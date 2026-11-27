/** MIDI ticks per quarter note. */
export const PPQ = 480;

/** Round a quarter-note beat position to the nearest tick. */
export function beatTick(beat: number): number {
  return Math.round(beat * PPQ);
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
