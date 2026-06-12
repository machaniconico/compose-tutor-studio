/** Lowest dB value shown by the UI meter. */
export const METER_FLOOR_DB = -60;

/** Master peaks at or above this value are treated as clipping risk. */
export const CLIP_THRESHOLD_DB = -0.1;

/** Web Audio analyser size used by the level meters. */
export const METER_ANALYSER_FFT_SIZE = 1024;

/** Maximum absolute sample value in a block of float PCM data. Pure. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    if (!Number.isFinite(sample)) continue;
    const amplitude = Math.abs(sample);
    if (amplitude > peak) peak = amplitude;
  }
  return peak;
}

/** Convert a linear peak amplitude to dBFS. Pure. */
export function peakAmplitudeToDb(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(peak);
}

/** Read the peak dBFS value from a float PCM block. Pure. */
export function peakDbFromSamples(samples: Float32Array): number {
  return peakAmplitudeToDb(peakAmplitude(samples));
}

/** Convert dBFS to a normalized 0..1 meter fill value. Pure. */
export function meterFillFromDb(peakDb: number, floorDb = METER_FLOOR_DB): number {
  if (!Number.isFinite(peakDb)) return 0;
  const floor = Number.isFinite(floorDb) && floorDb < 0 ? floorDb : METER_FLOOR_DB;
  const clamped = Math.min(0, Math.max(floor, peakDb));
  return (clamped - floor) / Math.abs(floor);
}

/** True when a peak dBFS value crosses the clipping warning threshold. Pure. */
export function isClipPeak(
  peakDb: number,
  thresholdDb = CLIP_THRESHOLD_DB,
): boolean {
  return Number.isFinite(peakDb) && peakDb >= thresholdDb;
}
