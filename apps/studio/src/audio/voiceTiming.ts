import type { DrumLane } from '@cts/project-model';

/** Keep oscillators alive briefly after the ADSR reaches zero. */
export const SYNTH_OSCILLATOR_STOP_PAD_SECONDS = 0.02;

/** Maximum impulse amplitude before the reverb wet gain is applied. */
export const REVERB_IMPULSE_PEAK_AMPLITUDE = 0.35;

/** Web Audio 1.1 DynamicsCompressorNode's fixed internal look-ahead delay. */
export const DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS = 0.006;

const hatTiming = (envelopeDecaySeconds: number) =>
  Object.freeze({
    envelopeDecaySeconds,
    sourceStopSeconds: envelopeDecaySeconds + 0.05,
  });

const clapBurstOffsetsSeconds = Object.freeze([0, 0.012, 0.024] as const);

/**
 * Source-node lifetimes used by the synthesized drumkit.
 *
 * Keeping the individual sources here lets the runtime schedule each voice
 * precisely while the tail planner derives the latest stop without copying
 * timing literals into a second module.
 */
export const DRUM_VOICE_TIMING = Object.freeze({
  kick: Object.freeze({
    bodySourceStopSeconds: 0.35,
    clickSourceStopSeconds: 0.05,
  }),
  snare: Object.freeze({
    noiseSourceStopSeconds: 0.25,
    toneSourceStopSeconds: 0.15,
  }),
  closedHat: hatTiming(0.045),
  openHat: hatTiming(0.32),
  clap: Object.freeze({
    burstOffsetsSeconds: clapBurstOffsetsSeconds,
    burstSourceStopSeconds: 0.12,
  }),
  perc: Object.freeze({
    sourceStopSeconds: 0.28,
  }),
});

/** Latest source-node stop, relative to each drum lane's trigger time. */
export const DRUM_SOURCE_STOP_SECONDS: Readonly<Record<DrumLane, number>> =
  Object.freeze({
    kick: Math.max(
      DRUM_VOICE_TIMING.kick.bodySourceStopSeconds,
      DRUM_VOICE_TIMING.kick.clickSourceStopSeconds,
    ),
    snare: Math.max(
      DRUM_VOICE_TIMING.snare.noiseSourceStopSeconds,
      DRUM_VOICE_TIMING.snare.toneSourceStopSeconds,
    ),
    closedHat: DRUM_VOICE_TIMING.closedHat.sourceStopSeconds,
    openHat: DRUM_VOICE_TIMING.openHat.sourceStopSeconds,
    clap:
      Math.max(...DRUM_VOICE_TIMING.clap.burstOffsetsSeconds) +
      DRUM_VOICE_TIMING.clap.burstSourceStopSeconds,
    perc: DRUM_VOICE_TIMING.perc.sourceStopSeconds,
  });
