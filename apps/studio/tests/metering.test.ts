import { describe, expect, it } from 'vitest';
import {
  CLIP_THRESHOLD_DB,
  isClipPeak,
  meterFillFromDb,
  peakAmplitude,
  peakAmplitudeToDb,
  peakDbFromSamples,
} from '../src/audio/metering';

describe('metering helpers', () => {
  it('reads the largest absolute sample peak', () => {
    expect(peakAmplitude(new Float32Array([0, -0.2, 0.75, -0.5]))).toBeCloseTo(0.75);
  });

  it('treats empty and non-finite sample blocks as silence', () => {
    expect(peakAmplitude(new Float32Array())).toBe(0);
    expect(peakAmplitude(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]))).toBe(0);
    expect(peakDbFromSamples(new Float32Array())).toBe(Number.NEGATIVE_INFINITY);
  });

  it('converts linear peak amplitude to dBFS', () => {
    expect(peakAmplitudeToDb(1)).toBeCloseTo(0, 6);
    expect(peakAmplitudeToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(peakDbFromSamples(new Float32Array([0.25, -0.5]))).toBeCloseTo(-6.0206, 4);
  });

  it('returns silence for invalid peak amplitudes', () => {
    expect(peakAmplitudeToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(peakAmplitudeToDb(-1)).toBe(Number.NEGATIVE_INFINITY);
    expect(peakAmplitudeToDb(Number.NaN)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('normalizes meter fill between the floor and 0 dB', () => {
    expect(meterFillFromDb(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(meterFillFromDb(-60)).toBe(0);
    expect(meterFillFromDb(-30)).toBeCloseTo(0.5);
    expect(meterFillFromDb(0)).toBe(1);
    expect(meterFillFromDb(3)).toBe(1);
  });

  it('detects clipping at the configured threshold', () => {
    expect(CLIP_THRESHOLD_DB).toBeLessThan(0);
    expect(isClipPeak(CLIP_THRESHOLD_DB - 0.01)).toBe(false);
    expect(isClipPeak(CLIP_THRESHOLD_DB)).toBe(true);
    expect(isClipPeak(0)).toBe(true);
    expect(isClipPeak(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});
