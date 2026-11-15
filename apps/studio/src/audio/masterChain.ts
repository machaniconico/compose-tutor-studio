// Master bus shared by live playback (engine.ts) and WAV export (wav.ts):
// master gain (follows the master track's volume) -> soft limiter -> destination,
// with a meter tap on the gain before the limiter.

import type { Track } from '@cts/project-model';
import { METER_ANALYSER_FFT_SIZE } from './metering';

export type MasterChain = {
  /** Per-track chains connect here. */
  readonly input: GainNode;
  /** Level meter tap, before the limiter. */
  readonly analyser: AnalyserNode;
  readonly limiter: DynamicsCompressorNode;
};

/** Master gain from the master track's volume (0..2). Missing master => 1. */
export function masterGainFor(tracks: readonly Track[]): number {
  const master = tracks.find((t) => t.type === 'master');
  if (!master || !Number.isFinite(master.volume)) return 1;
  return Math.min(2, Math.max(0, master.volume));
}

export function createMasterChain(
  ctx: BaseAudioContext,
  tracks: readonly Track[],
): MasterChain {
  const input = ctx.createGain();
  input.gain.value = masterGainFor(tracks);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = METER_ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0;

  // Soft limiter: gentle compression with a high threshold acts as a
  // brick-wall-ish safety net against summed-voice clipping.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  input.connect(analyser);
  input.connect(limiter);
  limiter.connect(ctx.destination);
  return { input, analyser, limiter };
}

/** Follow the master track's volume on a live chain (short ramp, no zipper noise). */
export function applyMasterVolume(
  input: GainNode,
  tracks: readonly Track[],
  when: number,
): void {
  input.gain.setTargetAtTime(masterGainFor(tracks), when, 0.01);
}
