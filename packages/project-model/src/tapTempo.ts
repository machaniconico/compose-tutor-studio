// Tap tempo: turn the times of a few button taps into a BPM.

/** Lowest and highest BPM a tap can produce (the app's tempo range). */
const MIN_TAP_BPM = 20;
const MAX_TAP_BPM = 300;
/** Only the most recent intervals count, so a tempo change is picked up quickly. */
const INTERVALS_USED = 4;

/**
 * BPM from tap times in milliseconds (ascending). Averages the last 4
 * intervals, rounds to a whole BPM and clamps it to 20-300. Fewer than 2
 * taps give no tempo (null).
 */
export function tapTempo(timesMs: readonly number[]): number | null {
  if (timesMs.length < 2) return null;
  const intervalCount = Math.min(INTERVALS_USED, timesMs.length - 1);
  const last = timesMs[timesMs.length - 1];
  const first = timesMs[timesMs.length - 1 - intervalCount];
  if (typeof last !== 'number' || typeof first !== 'number') return null;
  const averageMs = (last - first) / intervalCount;
  if (!(averageMs > 0)) return MAX_TAP_BPM;
  const bpm = Math.round(60000 / averageMs);
  return Math.min(MAX_TAP_BPM, Math.max(MIN_TAP_BPM, bpm));
}
