import { describe, expect, it, vi } from 'vitest';
import {
  CLIP_THRESHOLD_DB,
  isClipPeak,
  meterFillFromDb,
  peakAmplitude,
  peakAmplitudeToDb,
  peakDbFromSamples,
  SPECTRUM_FFT_SIZE,
  spectrumBars,
  syncSpectrumTap,
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

describe('spectrum tap', () => {
  function mockAudio() {
    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      disconnect: vi.fn(),
    };
    const context = { createAnalyser: vi.fn(() => analyser as unknown as AnalyserNode) };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    return { analyser, context, source };
  }

  it('creates no AnalyserNode while the spectrum is off', () => {
    const { context, source } = mockAudio();
    const tap = syncSpectrumTap(null, false, context, source as unknown as AudioNode);
    expect(tap).toBeNull();
    expect(context.createAnalyser).not.toHaveBeenCalled();
    expect(source.connect).not.toHaveBeenCalled();
  });

  it('creates and connects an AnalyserNode when turned on, and reuses it', () => {
    const { analyser, context, source } = mockAudio();
    const tap = syncSpectrumTap(null, true, context, source as unknown as AudioNode);
    expect(tap).toBe(analyser);
    expect(context.createAnalyser).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.fftSize).toBe(SPECTRUM_FFT_SIZE);

    const again = syncSpectrumTap(tap, true, context, source as unknown as AudioNode);
    expect(again).toBe(analyser);
    expect(context.createAnalyser).toHaveBeenCalledTimes(1);
  });

  it('disconnects the AnalyserNode when turned off', () => {
    const { analyser, context, source } = mockAudio();
    const tap = syncSpectrumTap(null, true, context, source as unknown as AudioNode);
    const off = syncSpectrumTap(tap, false, context, source as unknown as AudioNode);
    expect(off).toBeNull();
    expect(source.disconnect).toHaveBeenCalledWith(analyser);
    expect(analyser.disconnect).toHaveBeenCalled();
  });

  it('waits for the audio context before connecting', () => {
    expect(syncSpectrumTap(null, true, null, null)).toBeNull();
  });
});

describe('spectrumBars', () => {
  it('averages frequency bins into normalized bars', () => {
    const bins = new Uint8Array([255, 255, 0, 0, 51, 51, 102, 102]);
    expect(spectrumBars(bins, 4)).toEqual([1, 0, 0.2, 0.4]);
  });

  it('returns silent bars for empty data or invalid counts', () => {
    expect(spectrumBars(new Uint8Array(), 3)).toEqual([0, 0, 0]);
    expect(spectrumBars(new Uint8Array([10]), 0)).toEqual([]);
  });
});
