import type { Envelope } from './presets';

/** Timing of a scheduled note, including the full attack and decay for uncut notes. */
export function noteEnvelopeTiming(env: Envelope, startTime: number, duration: number, cutAtEnd?: boolean) {
  const gate = cutAtEnd ? Math.max(0, duration) : Math.max(duration, env.attack + env.decay);
  const releaseStart = startTime + gate;
  return { gate, releaseStart, releaseEnd: releaseStart + env.release };
}
