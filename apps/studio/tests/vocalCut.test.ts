import { describe, expect, it } from 'vitest';
import {
  MAX_VOCAL_CUT_SECONDS,
  MIN_PROCESSABLE_STEREO_WIDTH,
  VOCAL_CUT_PRESETS,
  VocalCutError,
  analyzeStereoChannels,
  applyVocalCutInPlace,
  planVocalCut,
  planVocalCutDecode,
  renderVocalCutToWav,
  trimVocalCutCodecPadding,
  validateVocalCutEncodedTiming,
  validateVocalCutSourceTiming,
  vocalCutCodecPaddingSeconds,
} from '../src/audio/vocalCut';

const SAMPLE_RATE = 44_100;

function sine(frequency: number, seconds: number, amplitude = 1): Float32Array {
  const frames = Math.round(seconds * SAMPLE_RATE);
  return Float32Array.from(
    { length: frames },
    (_, frame) => amplitude * Math.sin((2 * Math.PI * frequency * frame) / SAMPLE_RATE),
  );
}

function rms(values: Float32Array, skip = 0): number {
  let power = 0;
  for (let index = skip; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    power += value * value;
  }
  return Math.sqrt(power / Math.max(1, values.length - skip));
}

function mid(left: Float32Array, right: Float32Array): Float32Array {
  return Float32Array.from(left, (value, index) => (value + (right[index] ?? 0)) * 0.5);
}

function side(left: Float32Array, right: Float32Array): Float32Array {
  return Float32Array.from(left, (value, index) => (value - (right[index] ?? 0)) * 0.5);
}

function audioBufferShape(left: Float32Array, right?: Float32Array) {
  const channels = right ? [left, right] : [left];
  return {
    numberOfChannels: channels.length,
    length: left.length,
    sampleRate: SAMPLE_RATE,
    getChannelData(index: number) {
      const channel = channels[index];
      if (!channel) throw new RangeError('channel');
      return channel;
    },
  };
}

describe('center vocal reduction', () => {
  it('attenuates a centered vocal band while retaining the Side signal', () => {
    const center = sine(1_000, 1, 0.5);
    const stereoSide = sine(2_000, 1, 0.25);
    const left = Float32Array.from(center, (value, index) => value + (stereoSide[index] ?? 0));
    const right = Float32Array.from(center, (value, index) => value - (stereoSide[index] ?? 0));
    const originalMid = mid(left, right);
    const originalSide = side(left, right);

    const result = applyVocalCutInPlace(left, right, SAMPLE_RATE, {
      strength: 1,
      preserveBassHz: 120,
    });
    const skip = Math.round(SAMPLE_RATE * 0.1);
    expect(rms(mid(left, right), skip) / rms(originalMid, skip)).toBeLessThan(0.03);
    expect(rms(side(left, right), skip) / rms(originalSide, skip)).toBeCloseTo(1, 5);
    expect(result.outputGain).toBeLessThanOrEqual(1);
    expect(result.outputPeak).toBeLessThanOrEqual(1);
  });

  it('makes the standard 90% setting approximately a 20 dB center reduction', () => {
    const left = sine(1_000, 1, 0.6);
    const right = left.slice();
    const original = left.slice();
    applyVocalCutInPlace(left, right, SAMPLE_RATE, VOCAL_CUT_PRESETS.standard);
    const skip = Math.round(SAMPLE_RATE * 0.1);
    const ratio = rms(mid(left, right), skip) / rms(original, skip);
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.13);
  });

  it('preserves centered bass below the protected cutoff', () => {
    const left = sine(40, 2, 0.5);
    const right = left.slice();
    const original = left.slice();
    applyVocalCutInPlace(left, right, SAMPLE_RATE, {
      strength: 1,
      preserveBassHz: 120,
    });
    const skip = Math.round(SAMPLE_RATE * 0.5);
    expect(rms(left, skip) / rms(original, skip)).toBeGreaterThan(0.98);
  });

  it('uses an exact bypass at strength zero and never boosts a quiet residual', () => {
    const left = sine(440, 0.1, 0.1);
    const right = sine(660, 0.1, 0.05);
    const expectedLeft = left.slice();
    const expectedRight = right.slice();
    const result = applyVocalCutInPlace(left, right, SAMPLE_RATE, {
      strength: 0,
      preserveBassHz: 120,
    });
    expect(left).toEqual(expectedLeft);
    expect(right).toEqual(expectedRight);
    expect(result.outputGain).toBe(1);
  });

  it('rejects non-finite samples before mutating the input', () => {
    const left = new Float32Array([0.2, Number.NaN, 0.1]);
    const right = new Float32Array([0.1, 0.1, 0.1]);
    const original = left.slice();
    expect(() =>
      applyVocalCutInPlace(left, right, SAMPLE_RATE, VOCAL_CUT_PRESETS.standard),
    ).toThrowError(expect.objectContaining({ code: 'non-finite-sample' }));
    expect(left).toEqual(original);
  });

  it('reports stereo suitability and rejects a near-mono render', async () => {
    const mono = sine(440, 0.05, 0.3);
    const analysis = analyzeStereoChannels(mono, mono.slice());
    expect(analysis.stereoWidth).toBeLessThan(MIN_PROCESSABLE_STEREO_WIDTH);
    expect(analysis.suitability).toBe('poor');

    await expect(
      renderVocalCutToWav(
        audioBufferShape(mono, mono.slice()),
        VOCAL_CUT_PRESETS.standard,
        { yieldControl: async () => undefined, chunkFrames: 128 },
      ),
    ).rejects.toMatchObject({ code: 'near-mono' });
  });

  it('preflights stereo, duration and resource limits', () => {
    const oneSecond = sine(440, 1);
    expect(planVocalCut(audioBufferShape(oneSecond, oneSecond.slice()))).toMatchObject({
      frames: SAMPLE_RATE,
      durationSeconds: 1,
    });
    expect(() => planVocalCut(audioBufferShape(oneSecond))).toThrowError(
      expect.objectContaining({ code: 'stereo-required' }),
    );
    const tooLongFrames = Math.floor((MAX_VOCAL_CUT_SECONDS + 1) * SAMPLE_RATE);
    const shape = {
      numberOfChannels: 2,
      length: tooLongFrames,
      sampleRate: SAMPLE_RATE,
      getChannelData: () => {
        throw new Error('must not allocate');
      },
    };
    expect(() => planVocalCut(shape)).toThrowError(
      expect.objectContaining({ code: 'duration-limit-exceeded' }),
    );
    expect(() =>
      planVocalCutDecode(60, SAMPLE_RATE, 8 * 1024 * 1024, 6),
    ).toThrowError(expect.objectContaining({ code: 'stereo-required' }));
    const stereoDecodePlan = planVocalCutDecode(60, SAMPLE_RATE, 0, 2, 2);
    const eightChannelDecodePlan = planVocalCutDecode(60, SAMPLE_RATE, 0, 2, 8);
    expect(eightChannelDecodePlan.estimatedWorkingBytes).toBeGreaterThan(
      stereoDecodePlan.estimatedWorkingBytes,
    );
    expect(() =>
      planVocalCutDecode(60, SAMPLE_RATE, 0, 2, 1),
    ).toThrowError(expect.objectContaining({ code: 'invalid-audio' }));
    expect(planVocalCutDecode(60, SAMPLE_RATE, 0, 2, 2, 120)).toMatchObject({
      frames: 120 * SAMPLE_RATE,
      durationSeconds: 120,
    });
    expect(
      planVocalCutDecode(
        MAX_VOCAL_CUT_SECONDS,
        SAMPLE_RATE,
        12 * 1024 * 1024,
        2,
        2,
        601,
      ),
    ).toMatchObject({
      frames: 601 * SAMPLE_RATE,
    });
    expect(() =>
      planVocalCutDecode(
        MAX_VOCAL_CUT_SECONDS,
        SAMPLE_RATE,
        0,
        2,
        2,
        2_000,
      ),
    ).toThrowError(expect.objectContaining({ code: 'resource-limit-exceeded' }));
    expect(() =>
      planVocalCutDecode(
        MAX_VOCAL_CUT_SECONDS,
        SAMPLE_RATE,
        128 * 1024 * 1024,
        2,
      ),
    ).toThrowError(expect.objectContaining({ code: 'resource-limit-exceeded' }));
    expect(
      planVocalCutDecode(
        MAX_VOCAL_CUT_SECONDS,
        SAMPLE_RATE,
        50 * 1024 * 1024,
        2,
      ).estimatedWorkingBytes,
    ).toBeGreaterThan(300 * 1024 * 1024);
  });

  it('accepts bounded exact-five-minute codec padding but rejects forged long timing', () => {
    expect(vocalCutCodecPaddingSeconds('mp3', SAMPLE_RATE)).toBe(0.078368);
    expect(
      validateVocalCutSourceTiming({
        format: 'mp3',
        sampleRate: SAMPLE_RATE,
        presentationDurationSeconds: 300,
        containerDurationSeconds: 300.068572,
        decodeDurationSeconds: 300.999,
      }),
    ).toBe(0.078368);
    expect(() =>
      validateVocalCutSourceTiming({
        format: 'mp3',
        sampleRate: SAMPLE_RATE,
        presentationDurationSeconds: 299.983673,
        containerDurationSeconds: 600.058776,
        decodeDurationSeconds: 600.071433,
      }),
    ).toThrowError(expect.objectContaining({ code: 'duration-limit-exceeded' }));
    expect(() =>
      validateVocalCutSourceTiming({
        format: 'mp3',
        sampleRate: SAMPLE_RATE,
        presentationDurationSeconds: 1,
        containerDurationSeconds: 1,
        decodeDurationSeconds: 600,
      }),
    ).toThrowError(expect.objectContaining({ code: 'duration-limit-exceeded' }));
    expect(() =>
      validateVocalCutEncodedTiming({
        format: 'mp3',
        sampleRate: SAMPLE_RATE,
        containerDurationSeconds: 60,
        decodeDurationSeconds: 540,
      }),
    ).toThrowError(expect.objectContaining({ code: 'duration-limit-exceeded' }));
  });

  it('trims only allowed decoded AAC padding with zero-copy channel views', () => {
    const decodedSampleRate = 8_000;
    const paddedFrames = Math.ceil(300.025034 * decodedSampleRate);
    const left = new Float32Array(paddedFrames);
    const right = new Float32Array(paddedFrames);
    const source = {
      numberOfChannels: 2,
      length: paddedFrames,
      sampleRate: decodedSampleRate,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    };
    const timing = {
      format: 'aac' as const,
      sampleRate: SAMPLE_RATE,
      presentationDurationSeconds: 299.755617,
      containerDurationSeconds: 300.025035,
      decodeDurationSeconds: 300.025035,
    };
    const trimmed = trimVocalCutCodecPadding(source, timing);
    expect(trimmed.length).toBe(300 * decodedSampleRate);
    expect(trimmed.getChannelData(0).buffer).toBe(left.buffer);
    expect(trimmed.getChannelData(0).length).toBe(300 * decodedSampleRate);

    const excessiveFrames = Math.ceil(301 * decodedSampleRate);
    const excessive = {
      numberOfChannels: 2,
      length: excessiveFrames,
      sampleRate: decodedSampleRate,
      getChannelData: () => new Float32Array(excessiveFrames),
    };
    expect(() => trimVocalCutCodecPadding(excessive, timing)).toThrowError(
      expect.objectContaining({ code: 'duration-limit-exceeded' }),
    );
  });

  it('renders deterministic stereo PCM16 WAV bytes with real progress', async () => {
    const center = sine(1_000, 0.05, 0.3);
    const stereoSide = sine(2_000, 0.05, 0.2);
    const makeBuffer = () => {
      const left = Float32Array.from(center, (value, index) => value + (stereoSide[index] ?? 0));
      const right = Float32Array.from(center, (value, index) => value - (stereoSide[index] ?? 0));
      return audioBufferShape(left, right);
    };
    const progress: string[] = [];
    const first = await renderVocalCutToWav(makeBuffer(), VOCAL_CUT_PRESETS.standard, {
      chunkFrames: 128,
      yieldControl: async () => undefined,
      onProgress: ({ phase, fraction }) => progress.push(`${phase}:${fraction}`),
    });
    const second = await renderVocalCutToWav(makeBuffer(), VOCAL_CUT_PRESETS.standard, {
      chunkFrames: 128,
      yieldControl: async () => undefined,
    });
    const firstBytes = new Uint8Array(await first.blob.arrayBuffer());
    const secondBytes = new Uint8Array(await second.blob.arrayBuffer());
    expect(new TextDecoder().decode(firstBytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(firstBytes.subarray(8, 12))).toBe('WAVE');
    expect(firstBytes).toEqual(secondBytes);
    expect(progress.some((value) => value.startsWith('analyzing:'))).toBe(true);
    expect(progress.some((value) => value.startsWith('processing:'))).toBe(true);
    expect(progress.at(-1)).toBe('encoding:1');
  });

  it('cancels before producing a partial result', async () => {
    const center = sine(440, 0.05, 0.2);
    const stereoSide = sine(880, 0.05, 0.1);
    const left = Float32Array.from(center, (value, index) => value + (stereoSide[index] ?? 0));
    const right = Float32Array.from(center, (value, index) => value - (stereoSide[index] ?? 0));
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderVocalCutToWav(
        audioBufferShape(left, right),
        VOCAL_CUT_PRESETS.standard,
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(VocalCutError);
  });
});
