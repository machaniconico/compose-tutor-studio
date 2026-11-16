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

/** Web Audio analyser size used by the optional master spectrum view. */
export const SPECTRUM_FFT_SIZE = 256;

/**
 * Bring the optional spectrum analyser in line with the toggle. While the
 * spectrum is off no AnalyserNode exists, so it costs nothing at playback.
 * Returns the analyser to keep (null when off or before audio has started).
 */
export function syncSpectrumTap(
  current: AnalyserNode | null,
  enabled: boolean,
  context: Pick<BaseAudioContext, 'createAnalyser'> | null,
  source: AudioNode | null,
): AnalyserNode | null {
  if (!enabled) {
    if (current) {
      try {
        source?.disconnect(current);
      } catch {
        // Already disconnected (e.g. the context was rebuilt).
      }
      current.disconnect();
    }
    return null;
  }
  if (current) return current;
  if (!context || !source) return null;
  const analyser = context.createAnalyser();
  analyser.fftSize = SPECTRUM_FFT_SIZE;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  return analyser;
}

/** Average byte frequency bins (0..255) into `barCount` bars of 0..1. Pure. */
export function spectrumBars(bins: Uint8Array, barCount: number): number[] {
  if (!Number.isInteger(barCount) || barCount <= 0) return [];
  const bars: number[] = [];
  for (let bar = 0; bar < barCount; bar += 1) {
    const start = Math.floor((bar * bins.length) / barCount);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * bins.length) / barCount));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end && i < bins.length; i += 1) {
      sum += bins[i] ?? 0;
      count += 1;
    }
    bars.push(count > 0 ? sum / count / 255 : 0);
  }
  return bars;
}
