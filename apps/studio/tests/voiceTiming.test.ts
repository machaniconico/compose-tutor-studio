import type { DrumLane } from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import {
  DRUM_SOURCE_STOP_SECONDS,
  DRUM_VOICE_TIMING,
  DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS,
  REVERB_IMPULSE_PEAK_AMPLITUDE,
  SYNTH_OSCILLATOR_STOP_PAD_SECONDS,
} from '../src/audio/voiceTiming';

describe('audio voice timing contract', () => {
  it.each(
    [
      ['kick', 0.35],
      ['snare', 0.25],
      ['closedHat', 0.095],
      ['openHat', 0.37],
      ['clap', 0.144],
      ['perc', 0.28],
    ] satisfies Array<[DrumLane, number]>,
  )('derives the latest %s source stop at %ss', (lane, seconds) => {
    expect(DRUM_SOURCE_STOP_SECONDS[lane]).toBeCloseTo(seconds, 10);
  });

  it('derives compound lane lifetimes from the runtime source timings', () => {
    expect(DRUM_SOURCE_STOP_SECONDS.kick).toBe(
      Math.max(
        DRUM_VOICE_TIMING.kick.bodySourceStopSeconds,
        DRUM_VOICE_TIMING.kick.clickSourceStopSeconds,
      ),
    );
    expect(DRUM_SOURCE_STOP_SECONDS.snare).toBe(
      Math.max(
        DRUM_VOICE_TIMING.snare.noiseSourceStopSeconds,
        DRUM_VOICE_TIMING.snare.toneSourceStopSeconds,
      ),
    );
    expect(DRUM_SOURCE_STOP_SECONDS.clap).toBe(
      Math.max(...DRUM_VOICE_TIMING.clap.burstOffsetsSeconds) +
        DRUM_VOICE_TIMING.clap.burstSourceStopSeconds,
    );
  });

  it('keeps the shared timing tables immutable at runtime', () => {
    expect(Object.isFrozen(DRUM_VOICE_TIMING)).toBe(true);
    expect(Object.values(DRUM_VOICE_TIMING).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(DRUM_VOICE_TIMING.clap.burstOffsetsSeconds)).toBe(true);
    expect(Object.isFrozen(DRUM_SOURCE_STOP_SECONDS)).toBe(true);
  });

  it('exposes bounded positive synth and reverb timing constants', () => {
    expect(SYNTH_OSCILLATOR_STOP_PAD_SECONDS).toBeGreaterThan(0);
    expect(REVERB_IMPULSE_PEAK_AMPLITUDE).toBeGreaterThan(0);
    expect(REVERB_IMPULSE_PEAK_AMPLITUDE).toBeLessThanOrEqual(1);
    expect(DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS).toBe(0.006);
  });
});
