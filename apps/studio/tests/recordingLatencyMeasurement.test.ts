import { describe, expect, it } from 'vitest';
import {
  MAX_RECORDING_LATENCY_SECONDS,
  analyzeRecordingLatency,
  createRecordingLatencyProbe,
  type RecordingLatencyMeasurementFailureCode,
  type RecordingLatencyProbe,
} from '../src/audio/recordingLatencyMeasurement';

type CaptureOptions = Readonly<{
  gain?: number;
  noiseAmplitude?: number;
  secondDelayFrames?: number;
  stereoSignalChannel?: 0 | 1;
}>;

function nextNoise(state: number): Readonly<{ state: number; sample: number }> {
  let next = state | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  const normalized = (next >>> 0) / 0xffff_ffff;
  return { state: next >>> 0, sample: normalized * 2 - 1 };
}

function capturedProbe(
  probe: RecordingLatencyProbe,
  delayFrames: number,
  options: CaptureOptions = {},
): readonly Float32Array[] {
  const gain = options.gain ?? 0.5;
  const lastDelay = Math.max(delayFrames, options.secondDelayFrames ?? delayFrames);
  const length = lastDelay + probe.samples.length + 32;
  const channelCount = options.stereoSignalChannel === undefined ? 1 : 2;
  const channels = Array.from(
    { length: channelCount },
    () => new Float32Array(length),
  );
  const targetChannel = channels[options.stereoSignalChannel ?? 0];
  if (!targetChannel) throw new Error('test channel missing');

  let noiseState = 0x1234abcd;
  const noiseAmplitude = options.noiseAmplitude ?? 0;
  for (const channel of channels) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      const noise = nextNoise(noiseState);
      noiseState = noise.state;
      channel[frame] = noise.sample * noiseAmplitude;
    }
  }
  const addProbe = (offset: number): void => {
    for (let frame = 0; frame < probe.samples.length; frame += 1) {
      targetChannel[offset + frame] =
        (targetChannel[offset + frame] ?? 0) + (probe.samples[frame] ?? 0) * gain;
    }
  };
  addProbe(delayFrames);
  if (options.secondDelayFrames !== undefined) addProbe(options.secondDelayFrames);
  return channels;
}

function fractionalCapturedProbe(
  probe: RecordingLatencyProbe,
  delayFrames: number,
  fraction: number,
): Float32Array {
  const channel = new Float32Array(delayFrames + probe.samples.length + 64);
  for (let frame = 0; frame < probe.samples.length; frame += 1) {
    const sample = (probe.samples[frame] ?? 0) * 0.45;
    channel[delayFrames + frame] =
      (channel[delayFrames + frame] ?? 0) + sample * (1 - fraction);
    channel[delayFrames + frame + 1] =
      (channel[delayFrames + frame + 1] ?? 0) + sample * fraction;
  }
  return channel;
}

function centeredMovingAverage(source: Float32Array, width: number): Float32Array {
  const oddWidth = width % 2 === 0 ? width + 1 : width;
  const radius = Math.floor(oddWidth / 2);
  const prefix = new Float64Array(source.length + 1);
  for (let frame = 0; frame < source.length; frame += 1) {
    prefix[frame + 1] = (prefix[frame] ?? 0) + (source[frame] ?? 0);
  }
  const filtered = new Float32Array(source.length);
  for (let frame = 0; frame < source.length; frame += 1) {
    const first = Math.max(0, frame - radius);
    const lastExclusive = Math.min(source.length, frame + radius + 1);
    filtered[frame] =
      ((prefix[lastExclusive] ?? 0) - (prefix[first] ?? 0))
      / (lastExclusive - first);
  }
  return filtered;
}

function expectFailure(
  result: ReturnType<typeof analyzeRecordingLatency>,
  code: RecordingLatencyMeasurementFailureCode,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
}

describe('recording latency probe', () => {
  it('is deterministic, bounded, low-level, and contains multiple separated bursts', () => {
    const first = createRecordingLatencyProbe(48_000);
    const second = createRecordingLatencyProbe(48_000);

    expect(first.samples).toEqual(second.samples);
    expect(first.bursts).toEqual(second.bursts);
    expect(first.bursts.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...first.samples.map(Math.abs))).toBeLessThanOrEqual(0.08);
    for (let index = 1; index < first.bursts.length; index += 1) {
      const previous = first.bursts[index - 1];
      const current = first.bursts[index];
      expect(current!.startFrame).toBeGreaterThan(
        previous!.startFrame + previous!.length,
      );
    }
  });
});

describe('analyzeRecordingLatency', () => {
  it.each([
    { label: '0 ms', delayFrames: 0 },
    { label: '1 frame', delayFrames: 1 },
    { label: '1 ms', delayFrames: 48 },
    { label: '500 ms', delayFrames: 24_000 },
  ])('accepts the exact $label measurement boundary', ({ delayFrames }) => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, delayFrames),
      probe,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latencyFrames).toBe(delayFrames);
  });

  it.each([44_100, 48_000, 96_000])(
    'recovers an integer-frame delay at %i Hz',
    (sampleRate) => {
      const probe = createRecordingLatencyProbe(sampleRate);
      const expectedFrames = Math.round(sampleRate * 0.12345);
      const result = analyzeRecordingLatency({
        sampleRate,
        channels: capturedProbe(probe, expectedFrames),
        captureFirstContextFrame: 80_000,
        probeStartContextFrame: 80_000,
        probe,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Math.abs(result.latencyFrames - expectedFrames)).toBeLessThanOrEqual(1);
      expect(result.roundTripLatencySeconds).toBeCloseTo(expectedFrames / sampleRate, 12);
      expect(result.sampleRate).toBe(sampleRate);
      expect(result.confidence).toBeGreaterThan(0.9);
    },
  );

  it.each([
    { name: 'reduced gain', gain: 0.18, noiseAmplitude: 0 },
    { name: 'polarity inversion', gain: -0.5, noiseAmplitude: 0 },
    { name: 'fixed noise', gain: 0.35, noiseAmplitude: 0.006 },
  ])('handles $name', ({ gain, noiseAmplitude }) => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const expectedFrames = 2_345;
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, expectedFrames, { gain, noiseAmplitude }),
      probe,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latencyFrames).toBe(expectedFrames);
  });

  it('uses the valid side of a stereo capture when the other side is silent', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const expectedFrames = 3_210;
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, expectedFrames, {
        gain: -0.3,
        stereoSignalChannel: 1,
      }),
      probe,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latencyFrames).toBe(expectedFrames);
    expect(result.channelIndex).toBe(1);
  });

  it.each([96_000, 192_000])(
    'survives a roughly 20 kHz analog low-pass path at %i Hz',
    (sampleRate) => {
      const probe = createRecordingLatencyProbe(sampleRate);
      const expectedFrames = Math.round(sampleRate * 0.49);
      const unfiltered = capturedProbe(probe, expectedFrames, { gain: -0.42 })[0]!;
      const filterWidth = Math.max(3, Math.round(sampleRate / 20_000));
      const result = analyzeRecordingLatency({
        sampleRate,
        channels: [centeredMovingAverage(unfiltered, filterWidth)],
        probe,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Math.abs(result.latencyFrames - expectedFrames)).toBeLessThanOrEqual(1);
      expect(result.confidence).toBeGreaterThan(0.7);
    },
  );

  it('resolves a band-limited fractional-frame path to the nearest frame', () => {
    const sampleRate = 96_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const integerDelay = 7_654;
    const fraction = 0.4;
    const filtered = centeredMovingAverage(
      fractionalCapturedProbe(probe, integerDelay, fraction),
      5,
    );
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: [filtered],
      probe,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      Math.abs(result.latencyFrames - (integerDelay + fraction)),
    ).toBeLessThanOrEqual(1);
  });

  it('accounts for different capture and probe context-frame origins', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const physicalLatencyFrames = 1_500;
    const captureFirstContextFrame = 10_000;
    const probeStartContextFrame = 10_500;
    const signalOffset = probeStartContextFrame
      + physicalLatencyFrames
      - captureFirstContextFrame;
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, signalOffset),
      captureFirstContextFrame,
      probeStartContextFrame,
      probe,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latencyFrames).toBe(physicalLatencyFrames);
  });

  it('rejects silence, clipping, non-finite PCM, empty and mismatched channels', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const silent = new Float32Array(probe.samples.length + 1_000);
    expectFailure(
      analyzeRecordingLatency({ sampleRate, channels: [silent], probe }),
      'silence',
    );

    const clipped = capturedProbe(probe, 100)[0]!;
    clipped[200] = 1;
    expectFailure(
      analyzeRecordingLatency({ sampleRate, channels: [clipped], probe }),
      'clipped',
    );

    const nonFinite = capturedProbe(probe, 100)[0]!;
    nonFinite[200] = Number.NaN;
    expectFailure(
      analyzeRecordingLatency({ sampleRate, channels: [nonFinite], probe }),
      'non-finite-pcm',
    );
    expectFailure(
      analyzeRecordingLatency({ sampleRate, channels: [new Float32Array(0)], probe }),
      'empty-channel',
    );
    expectFailure(
      analyzeRecordingLatency({
        sampleRate,
        channels: [new Float32Array(20), new Float32Array(21)],
        probe,
      }),
      'channel-length-mismatch',
    );
  });

  it('rejects two similarly strong delay peaks as ambiguous', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, 500, {
        gain: 0.4,
        secondDelayFrames: 4_000,
      }),
      probe,
    });

    expectFailure(result, 'ambiguous');
  });

  it('rejects bursts that imply inconsistent physical delays', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const offsets = [700, 2_500, 5_200] as const;
    const channel = new Float32Array(
      offsets[offsets.length - 1]! + probe.samples.length + 64,
    );
    probe.bursts.forEach((burst, burstIndex) => {
      const offset = offsets[burstIndex]!;
      for (let frame = 0; frame < burst.length; frame += 1) {
        channel[offset + burst.startFrame + frame] =
          (probe.samples[burst.startFrame + frame] ?? 0) * 0.45;
      }
    });

    const result = analyzeRecordingLatency({
      sampleRate,
      channels: [channel],
      probe,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['ambiguous', 'low-confidence']).toContain(result.error.code);
  });

  it('rejects noise-only input as low confidence', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, 2_000, {
        gain: 0,
        noiseAmplitude: 0.02,
      }),
      probe,
    });

    expectFailure(result, 'low-confidence');
  });

  it('reports a confident signal beyond 500 ms as out of range', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const delayFrames =
      Math.floor(sampleRate * MAX_RECORDING_LATENCY_SECONDS) + 17;
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: capturedProbe(probe, delayFrames),
      probe,
    });

    expectFailure(result, 'out-of-range');
  });

  it('finds an out-of-range full probe even when an earlier first-burst decoy is stronger', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const fullDelay = Math.floor(sampleRate * MAX_RECORDING_LATENCY_SECONDS) + 50;
    const channel = capturedProbe(probe, fullDelay, { gain: 0.35 })[0]!;
    const decoyOffset = 1_000;
    const firstBurst = probe.bursts[0]!;
    for (let frame = 0; frame < firstBurst.length; frame += 1) {
      const probeFrame = firstBurst.startFrame + frame;
      channel[decoyOffset + probeFrame] =
        (channel[decoyOffset + probeFrame] ?? 0)
        + (probe.samples[probeFrame] ?? 0) * 0.7;
    }

    expectFailure(
      analyzeRecordingLatency({ sampleRate, channels: [channel], probe }),
      'out-of-range',
    );
  });

  it('bounds outside-range scanning for extreme but valid clock coordinates', () => {
    const sampleRate = 48_000;
    const probe = createRecordingLatencyProbe(sampleRate);
    const channel = capturedProbe(probe, 100)[0]!;
    const result = analyzeRecordingLatency({
      sampleRate,
      channels: [channel],
      probe,
      captureFirstContextFrame: 0,
      probeStartContextFrame: Number.MAX_SAFE_INTEGER - 100,
    });

    expectFailure(result, 'out-of-range');
  });

  it('fails closed for invalid rates, ranges, coordinates, and PCM layout', () => {
    const probe = createRecordingLatencyProbe(48_000);
    const captured = capturedProbe(probe, 100);
    expectFailure(
      analyzeRecordingLatency({
        sampleRate: 48_000.5,
        channels: captured,
        probe,
      }),
      'invalid-sample-rate',
    );
    expectFailure(
      analyzeRecordingLatency({
        sampleRate: 48_000,
        channels: captured,
        probe,
        maxLatencySeconds: 0.501,
      }),
      'invalid-pcm',
    );
    expectFailure(
      analyzeRecordingLatency({
        sampleRate: 48_000,
        channels: captured,
        probe,
        captureFirstContextFrame: -1,
      }),
      'invalid-pcm',
    );
    expectFailure(
      analyzeRecordingLatency({
        sampleRate: 48_000,
        channels: [],
        probe,
      }),
      'invalid-pcm',
    );
  });
});
