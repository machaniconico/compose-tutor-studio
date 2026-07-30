import { describe, expect, it } from 'vitest';
import {
  bandLimitedResample,
  renderAudioWarp,
  wsolaTimeScale,
} from '../src/audio/audioWarpDsp';
import type { AudioWarpRenderRequest } from '../src/audio/audioWarpPlan';

function request(
  outputFrameCount = 6_000,
  cents = 0,
  channelCount: 1 | 2 = 1,
): AudioWarpRenderRequest {
  return {
    algorithmVersion: 'wsola-v1/dsp-1',
    assetId: 'asset',
    checksumSha256: 'a'.repeat(64),
    sourceSampleRate: 48_000,
    sourceStartFrame: 0,
    sourceFrameCount: 4_800,
    sourceStartIndex: 0,
    sourceFrameCountAtTargetRate: 4_800,
    targetSampleRate: 48_000,
    channelCount,
    outputFrameCount,
    knots: [
      { sourceFrame: 0, sourceIndex: 0, outputFrame: 0 },
      { sourceFrame: 2_400, sourceIndex: 2_400, outputFrame: Math.round(outputFrameCount * 0.4) },
      { sourceFrame: 4_800, sourceIndex: 4_800, outputFrame: outputFrameCount },
    ],
    pitchRegions: cents === 0 ? [] : [{
      sourceStartFrame: 0,
      sourceFrameCount: 4_800,
      sourcePitchCents: 6_900,
      targetPitchCents: 6_900 + cents,
      correctionAmount: 1,
      transitionFrames: 0,
      sourceStartIndex: 0,
      sourceFrameCountAtTargetRate: 4_800,
      transitionFramesAtTargetRate: 0,
      cents,
    }],
    cacheKey: `fixture:${outputFrameCount}:${cents}:${channelCount}`,
  };
}

function sine(frames: number, frequency: number, scale = 1): Float32Array {
  return Float32Array.from(
    { length: frames },
    (_, frame) => Math.sin(2 * Math.PI * frequency * frame / 48_000) * scale,
  );
}

function meanSquaredDistance(
  left: Float32Array,
  right: Float32Array,
  start: number,
  end: number,
): number {
  let total = 0;
  for (let frame = start; frame < end; frame += 1) {
    const difference = left[frame]! - right[frame]!;
    total += difference * difference;
  }
  return total / Math.max(1, end - start);
}

describe('audio warp DSP', () => {
  it('returns exact finite deterministic output with bounded seams and peaks', () => {
    const channel = sine(4_800, 440, 0.8);
    const pcm = { sampleRate: 48_000, frameCount: 4_800, channelCount: 1, channels: [channel] };
    const first = renderAudioWarp(request(), pcm);
    const second = renderAudioWarp(request(), pcm);

    expect(first.frameCount).toBe(6_000);
    expect([...first.channels[0]!]).toEqual([...second.channels[0]!]);
    expect(first.channels[0]!.every(Number.isFinite)).toBe(true);
    expect(Math.max(...first.channels[0]!.map(Math.abs))).toBeLessThanOrEqual(1);
    let discontinuity = 0;
    for (let frame = 1; frame < first.frameCount; frame += 1) {
      discontinuity = Math.max(
        discontinuity,
        Math.abs(first.channels[0]![frame]! - first.channels[0]![frame - 1]!),
      );
    }
    expect(discontinuity).toBeLessThan(0.35);
  });

  it('uses one mono alignment decision for coherent stereo', () => {
    const left = sine(4_800, 220, 0.5);
    const right = Float32Array.from(left, (sample) => sample * 0.5);
    const rendered = renderAudioWarp(request(6_000, 0, 2), {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 2,
      channels: [left, right],
    });
    for (let frame = 0; frame < rendered.frameCount; frame += 1) {
      expect(rendered.channels[1]![frame]).toBeCloseTo(rendered.channels[0]![frame]! * 0.5, 6);
    }
  });

  it('realizes pitch through time scaling plus deterministic band-limited resampling', () => {
    const input = [sine(4_800, 440)];
    const stretched = wsolaTimeScale(input, 9_600);
    const corrected = bandLimitedResample(stretched, 4_800)[0]!;
    let crossings = 0;
    for (let frame = 1; frame < corrected.length; frame += 1) {
      if (corrected[frame - 1]! <= 0 && corrected[frame]! > 0) crossings += 1;
    }
    const frequency = crossings / (corrected.length / 48_000);
    expect(frequency).toBeGreaterThan(850);
    expect(frequency).toBeLessThan(910);
  });

  it('corrects a sine within a documented 20-cent deterministic tolerance', () => {
    const rendered = renderAudioWarp(request(6_000, 100), {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1,
      channels: [sine(4_800, 440)],
    }).channels[0]!;
    let crossings = 0;
    const start = 1_000;
    const end = rendered.length - 1_000;
    for (let frame = start + 1; frame < end; frame += 1) {
      if (rendered[frame - 1]! <= 0 && rendered[frame]! > 0) crossings += 1;
    }
    const observed = crossings / ((end - start) / 48_000);
    const expected = 440 * 2 ** (100 / 1200);
    const centsError = 1200 * Math.log2(observed / expected);
    expect(Math.abs(centsError)).toBeLessThan(20);
  });

  it('applies short pitch transitions as a deterministic source-positioned envelope', () => {
    const dryRequest = request(6_000);
    const abruptRequest = request(6_000, 300);
    const region = abruptRequest.pitchRegions[0]!;
    const transitionedRequest: AudioWarpRenderRequest = {
      ...abruptRequest,
      pitchRegions: [{
        ...region,
        transitionFrames: 480,
        transitionFramesAtTargetRate: 480,
      }],
      cacheKey: `${abruptRequest.cacheKey}:transition-480`,
    };
    const pcm = {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1 as const,
      channels: [sine(4_800, 440)],
    };
    const dry = renderAudioWarp(dryRequest, pcm).channels[0]!;
    const abrupt = renderAudioWarp(abruptRequest, pcm).channels[0]!;
    const first = renderAudioWarp(transitionedRequest, pcm).channels[0]!;
    const second = renderAudioWarp(transitionedRequest, pcm).channels[0]!;

    expect([...first]).toEqual([...second]);
    expect([...first]).not.toEqual([...abrupt]);
    expect(meanSquaredDistance(first, dry, 0, 480))
      .toBeLessThan(meanSquaredDistance(abrupt, dry, 0, 480));
    expect(meanSquaredDistance(first, abrupt, 900, 1_800)).toBeLessThan(1e-12);
  });

  it('treats a zero-percent pitch region as exact DSP bypass', () => {
    const bypass = request();
    const zeroRegion: AudioWarpRenderRequest = {
      ...bypass,
      pitchRegions: [{
        sourceStartFrame: 600,
        sourceFrameCount: 3_600,
        sourcePitchCents: 6_900,
        targetPitchCents: 7_200,
        correctionAmount: 0,
        transitionFrames: 240,
        sourceStartIndex: 600,
        sourceFrameCountAtTargetRate: 3_600,
        transitionFramesAtTargetRate: 240,
        cents: 0,
      }],
      cacheKey: `${bypass.cacheKey}:zero-region`,
    };
    const pcm = {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1 as const,
      channels: [sine(4_800, 440)],
    };

    expect([
      ...renderAudioWarp(zeroRegion, pcm).channels[0]!,
    ]).toEqual([
      ...renderAudioWarp(bypass, pcm).channels[0]!,
    ]);
  });

  it('fills the deterministic WSOLA tail when the nominal search passes maxStart', () => {
    const input = [new Float32Array(1_025).fill(1)];
    const first = wsolaTimeScale(input, 2_050)[0]!;
    const second = wsolaTimeScale(input, 2_050)[0]!;

    expect([...first]).toEqual([...second]);
    expect(first.every((sample) => sample > 0.999 && sample < 1.001)).toBe(true);
    expect(first.at(-1)).toBeCloseTo(1, 6);
  });

  it.each([
    ['non-increasing output knot', (candidate: AudioWarpRenderRequest) => {
      (candidate.knots[1] as { outputFrame: number }).outputFrame = 0;
    }],
    ['out-of-range local stretch', (candidate: AudioWarpRenderRequest) => {
      (candidate.knots[1] as { outputFrame: number }).outputFrame = 1;
    }],
    ['wrong source endpoint', (candidate: AudioWarpRenderRequest) => {
      (candidate.knots.at(-1) as { sourceIndex: number }).sourceIndex -= 1;
    }],
    ['pitch region outside the source window', (candidate: AudioWarpRenderRequest) => {
      (candidate.pitchRegions[0] as { sourceStartFrame: number }).sourceStartFrame = 4_799;
    }],
  ])('rejects a malformed %s before rendering', (_name, corrupt) => {
    const malformed = structuredClone(request(6_000, 100));
    corrupt(malformed);
    expect(() => renderAudioWarp(malformed, {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1,
      channels: [sine(4_800, 440)],
    })).toThrowError(
      expect.objectContaining({ code: 'invalid-request' }),
    );
  });

  it('rejects a non-finite source sample before it can enter DSP', () => {
    const channel = sine(4_800, 440);
    channel[2_400] = Number.NaN;
    expect(() => renderAudioWarp(request(), {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1,
      channels: [channel],
    })).toThrowError(
      expect.objectContaining({ code: 'invalid-pcm' }),
    );
  });

  it('keeps an impulse close to its compiled interior knot', () => {
    const impulse = new Float32Array(4_800);
    impulse[2_400] = 1;
    const warped = request();
    (warped as { knots: AudioWarpRenderRequest['knots'] }).knots = [
      warped.knots[0]!,
      { sourceFrame: 2_400, sourceIndex: 2_400, outputFrame: 1_920 },
      warped.knots[2]!,
    ];
    const rendered = renderAudioWarp(warped, {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1,
      channels: [impulse],
    });
    let peak = 0;
    for (let frame = 1; frame < rendered.frameCount; frame += 1) {
      if (Math.abs(rendered.channels[0]![frame]!) > Math.abs(rendered.channels[0]![peak]!)) {
        peak = frame;
      }
    }
    expect(Math.abs(peak - 1_920)).toBeLessThan(300);
  });
});
