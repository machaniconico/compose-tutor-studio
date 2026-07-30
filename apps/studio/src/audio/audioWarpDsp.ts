import {
  isValidAudioWarpRenderRequest,
  type AudioWarpRenderRequest,
} from './audioWarpPlan';
import type { CanonicalPcm16 } from './canonicalPcm16';

export type AudioWarpDspErrorCode =
  | 'invalid-request'
  | 'invalid-pcm'
  | 'resource-limit'
  | 'cancelled';

export class AudioWarpDspError extends Error {
  constructor(readonly code: AudioWarpDspErrorCode, message: string) {
    super(message);
    this.name = 'AudioWarpDspError';
  }
}

export type DerivedAudioPcm = Readonly<{
  sampleRate: number;
  frameCount: number;
  channelCount: number;
  channels: readonly Float32Array[];
}>;

const GRAIN = 1024;
const OVERLAP = 256;
const HOP = GRAIN - OVERLAP;
const SEARCH = 256;
const SINC_RADIUS = 12;
const SEAM_FRAMES = 96;

/**
 * Deterministic WSOLA + band-limited-resampling render. Every channel uses
 * alignment selected from one averaged mono reference.
 */
export function renderAudioWarp(
  request: AudioWarpRenderRequest,
  pcm: CanonicalPcm16 | DerivedAudioPcm,
  signal?: AbortSignal,
): DerivedAudioPcm {
  validateRenderInputs(request, pcm);
  throwIfCancelled(signal);
  const sourceStart = request.sourceStartFrame;
  const sourceEnd = sourceStart + request.sourceFrameCount;
  const source = pcm.channels.map((channel) => channel.slice(sourceStart, sourceEnd));
  const output = Array.from(
    { length: request.channelCount },
    () => new Float32Array(request.outputFrameCount),
  );

  const boundaries = new Set<number>(request.knots.map((knot) => knot.sourceIndex));
  for (const region of request.pitchRegions) {
    if (region.cents === 0) continue;
    boundaries.add(region.sourceStartIndex);
    boundaries.add(region.sourceStartIndex + region.sourceFrameCountAtTargetRate);
  }
  const sorted = [...boundaries]
    .filter((frame) => frame >= 0 && frame <= request.sourceFrameCountAtTargetRate)
    .sort((left, right) => left - right);
  if (sorted[0] !== 0) sorted.unshift(0);
  if (sorted.at(-1) !== request.sourceFrameCountAtTargetRate) {
    sorted.push(request.sourceFrameCountAtTargetRate);
  }

  for (let index = 1; index < sorted.length; index += 1) {
    throwIfCancelled(signal);
    const sourceStartIndex = sorted[index - 1]!;
    const sourceEndIndex = sorted[index]!;
    if (sourceEndIndex <= sourceStartIndex) continue;
    const outputStart = sourceToOutputFrame(request, sourceStartIndex);
    const outputEnd = sourceToOutputFrame(request, sourceEndIndex);
    const outputLength = outputEnd - outputStart;
    if (outputLength <= 0) continue;
    const sourceStartAtAssetRate = Math.round(
      sourceStartIndex * request.sourceSampleRate / request.targetSampleRate,
    );
    const sourceEndAtAssetRate = Math.round(
      sourceEndIndex * request.sourceSampleRate / request.targetSampleRate,
    );
    const input = source.map((channel) =>
      channel.slice(sourceStartAtAssetRate, sourceEndAtAssetRate),
    );
    const pitchRegion = pitchRegionAt(
      request,
      (sourceStartIndex + sourceEndIndex) / 2,
    );
    const rendered = renderSegmentAtPitch(
      input,
      outputLength,
      pitchRegion?.cents ?? 0,
      signal,
    );
    if (pitchRegion && pitchRegion.transitionFramesAtTargetRate > 0) {
      const dry = renderSegmentAtPitch(input, outputLength, 0, signal);
      applyPitchTransitionEnvelope(
        rendered,
        dry,
        pitchRegion,
        sourceStartIndex,
        sourceEndIndex,
      );
    }
    mixSegment(output, rendered, outputStart);
  }
  for (const channel of output) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      if (!Number.isFinite(channel[frame])) {
        throw new AudioWarpDspError('invalid-pcm', 'DSP produced a non-finite sample.');
      }
      channel[frame] = Math.max(-1, Math.min(1, channel[frame]!));
    }
  }
  return Object.freeze({
    sampleRate: request.targetSampleRate,
    frameCount: request.outputFrameCount,
    channelCount: request.channelCount,
    channels: Object.freeze(output),
  });
}

export const renderAudioWarpDerivedPcm = renderAudioWarp;

/** Exported for deterministic public DSP fixtures. */
export function wsolaTimeScale(
  input: readonly Float32Array[],
  outputLength: number,
  signal?: AbortSignal,
): Float32Array[] {
  if (
    input.length < 1
    || input.length > 2
    || !Number.isSafeInteger(outputLength)
    || outputLength <= 0
    || input.some((channel) => channel.length !== input[0]!.length)
  ) {
    throw new AudioWarpDspError('invalid-pcm', 'WSOLA input shape is invalid.');
  }
  const inputLength = input[0]!.length;
  if (inputLength === 0) return input.map(() => new Float32Array(outputLength));
  if (inputLength === outputLength) return input.map((channel) => channel.slice());
  if (inputLength < GRAIN || outputLength < GRAIN) {
    return bandLimitedResample(input, outputLength);
  }

  const mono = new Float32Array(inputLength);
  for (let frame = 0; frame < inputLength; frame += 1) {
    let sum = 0;
    for (const channel of input) sum += channel[frame]!;
    mono[frame] = sum / input.length;
  }
  const output = input.map(() => new Float32Array(outputLength));
  const weights = new Float32Array(outputLength);
  const analysisHop = HOP * inputLength / outputLength;
  let grainIndex = 0;
  let previousInput = 0;
  for (let outputPosition = 0; outputPosition < outputLength; outputPosition += HOP) {
    throwIfCancelled(signal);
    const nominal = grainIndex === 0
      ? 0
      : Math.round(grainIndex * analysisHop);
    const maxStart = Math.max(0, inputLength - GRAIN);
    const boundedNominal = Math.max(0, Math.min(maxStart, nominal));
    const aligned = grainIndex === 0
      ? 0
      : bestAlignment(
          mono,
          previousInput + HOP,
          Math.max(0, boundedNominal - SEARCH),
          Math.min(maxStart, boundedNominal + SEARCH),
        );
    const frames = Math.min(GRAIN, outputLength - outputPosition, inputLength - aligned);
    for (let frame = 0; frame < frames; frame += 1) {
      const weight = grainWindow(frame, frames);
      weights[outputPosition + frame] = weights[outputPosition + frame]! + weight;
      for (let channel = 0; channel < input.length; channel += 1) {
        output[channel]![outputPosition + frame] = output[channel]![outputPosition + frame]!
          + input[channel]![aligned + frame]! * weight;
      }
    }
    previousInput = aligned;
    grainIndex += 1;
  }
  for (let frame = 0; frame < outputLength; frame += 1) {
    const weight = weights[frame] || 1;
    for (const channel of output) channel[frame] = channel[frame]! / weight;
  }
  return output;
}

function bestAlignment(
  mono: Float32Array,
  previousOverlapStart: number,
  searchStart: number,
  searchEnd: number,
): number {
  let best = searchStart;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let candidate = searchStart; candidate <= searchEnd; candidate += 1) {
    let score = 0;
    let leftEnergy = 1e-12;
    let rightEnergy = 1e-12;
    for (let frame = 0; frame < OVERLAP; frame += 1) {
      const left = mono[Math.min(mono.length - 1, previousOverlapStart + frame)]!;
      const right = mono[Math.min(mono.length - 1, candidate + frame)]!;
      score += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const normalized = score / Math.sqrt(leftEnergy * rightEnergy);
    if (normalized > bestScore) {
      bestScore = normalized;
      best = candidate;
    }
  }
  return best;
}

function grainWindow(frame: number, length: number): number {
  const edge = Math.min(OVERLAP, Math.floor(length / 2));
  if (edge === 0) return 1;
  if (frame < edge) return 0.5 - 0.5 * Math.cos(Math.PI * (frame + 1) / edge);
  if (frame >= length - edge) {
    return 0.5 - 0.5 * Math.cos(Math.PI * (length - frame) / edge);
  }
  return 1;
}

/** Fixed-radius Hann-windowed sinc resampler. */
export function bandLimitedResample(
  input: readonly Float32Array[],
  outputLength: number,
): Float32Array[] {
  if (!Number.isSafeInteger(outputLength) || outputLength <= 0) {
    throw new AudioWarpDspError('invalid-request', 'Resample length is invalid.');
  }
  const inputLength = input[0]?.length ?? 0;
  const output = input.map(() => new Float32Array(outputLength));
  if (inputLength === 0) return output;
  const ratio = inputLength / outputLength;
  const cutoff = Math.min(1, 1 / ratio);
  for (let outputFrame = 0; outputFrame < outputLength; outputFrame += 1) {
    const position = (outputFrame + 0.5) * ratio - 0.5;
    const center = Math.floor(position);
    let normalization = 0;
    for (let tap = center - SINC_RADIUS + 1; tap <= center + SINC_RADIUS; tap += 1) {
      if (tap < 0 || tap >= inputLength) continue;
      const distance = position - tap;
      const scaled = distance * cutoff;
      const sinc = Math.abs(scaled) < 1e-12
        ? 1
        : Math.sin(Math.PI * scaled) / (Math.PI * scaled);
      const windowPosition = distance / SINC_RADIUS;
      const window = Math.abs(windowPosition) >= 1
        ? 0
        : 0.5 + 0.5 * Math.cos(Math.PI * windowPosition);
      const weight = cutoff * sinc * window;
      normalization += weight;
      for (let channel = 0; channel < input.length; channel += 1) {
        output[channel]![outputFrame] = output[channel]![outputFrame]!
          + input[channel]![tap]! * weight;
      }
    }
    if (Math.abs(normalization) > 1e-12) {
      for (const channel of output) {
        channel[outputFrame] = channel[outputFrame]! / normalization;
      }
    }
  }
  return output;
}

function mixSegment(
  output: readonly Float32Array[],
  segment: readonly Float32Array[],
  offset: number,
): void {
  const fade = Math.min(SEAM_FRAMES, Math.floor(segment[0]!.length / 2), offset);
  const seamStart = output.map((channel) => channel[offset - 1] ?? 0);
  for (let frame = 0; frame < segment[0]!.length; frame += 1) {
    const destination = offset + frame;
    if (destination >= output[0]!.length) break;
    const incoming = fade > 0 && frame < fade
      ? 0.5 - 0.5 * Math.cos(Math.PI * frame / fade)
      : 1;
    for (let channel = 0; channel < output.length; channel += 1) {
      const outgoing = frame < fade ? seamStart[channel]! : output[channel]![destination]!;
      output[channel]![destination] = outgoing * (1 - incoming)
        + segment[channel]![frame]! * incoming;
    }
  }
}

function sourceToOutputFrame(request: AudioWarpRenderRequest, sourceIndex: number): number {
  const knots = request.knots;
  if (sourceIndex <= knots[0]!.sourceIndex) return knots[0]!.outputFrame;
  for (let index = 1; index < knots.length; index += 1) {
    const right = knots[index]!;
    if (sourceIndex <= right.sourceIndex) {
      const left = knots[index - 1]!;
      const fraction = (sourceIndex - left.sourceIndex) / (right.sourceIndex - left.sourceIndex);
      return Math.round(left.outputFrame + fraction * (right.outputFrame - left.outputFrame));
    }
  }
  return knots.at(-1)!.outputFrame;
}

function pitchRegionAt(
  request: AudioWarpRenderRequest,
  sourceIndex: number,
): AudioWarpRenderRequest['pitchRegions'][number] | undefined {
  return request.pitchRegions.find((candidate) =>
    candidate.cents !== 0
    && sourceIndex >= candidate.sourceStartIndex
    && sourceIndex < candidate.sourceStartIndex + candidate.sourceFrameCountAtTargetRate);
}

function pitchCorrectionAmountAt(
  region: AudioWarpRenderRequest['pitchRegions'][number],
  sourceIndex: number,
): number {
  const local = sourceIndex - region.sourceStartIndex;
  const remaining = region.sourceFrameCountAtTargetRate - local;
  const transition = region.transitionFramesAtTargetRate;
  return transition > 0
    ? Math.min(1, local / transition, remaining / transition)
    : 1;
}

function renderSegmentAtPitch(
  input: readonly Float32Array[],
  outputLength: number,
  cents: number,
  signal?: AbortSignal,
): Float32Array[] {
  const factor = 2 ** (cents / 1200);
  const intermediateLength = Math.max(1, Math.round(outputLength * factor));
  const stretched = wsolaTimeScale(input, intermediateLength, signal);
  return bandLimitedResample(stretched, outputLength);
}

function applyPitchTransitionEnvelope(
  corrected: readonly Float32Array[],
  dry: readonly Float32Array[],
  region: AudioWarpRenderRequest['pitchRegions'][number],
  sourceStartIndex: number,
  sourceEndIndex: number,
): void {
  // Keep one WSOLA alignment per marker segment: source-positioned wet/dry
  // smoothing avoids sub-grain boundary resets while honoring exact transition frames.
  const outputLength = corrected[0]?.length ?? 0;
  const sourceLength = sourceEndIndex - sourceStartIndex;
  for (let frame = 0; frame < outputLength; frame += 1) {
    const sourceIndex = sourceStartIndex
      + sourceLength * (frame + 0.5) / outputLength;
    const amount = Math.max(0, pitchCorrectionAmountAt(region, sourceIndex));
    for (let channel = 0; channel < corrected.length; channel += 1) {
      corrected[channel]![frame] = dry[channel]![frame]! * (1 - amount)
        + corrected[channel]![frame]! * amount;
    }
  }
}

function validateRenderInputs(
  request: AudioWarpRenderRequest,
  pcm: CanonicalPcm16 | DerivedAudioPcm,
): void {
  if (!isValidAudioWarpRenderRequest(request)) {
    throw new AudioWarpDspError('invalid-request', 'Warp render request is invalid.');
  }
  if (
    typeof pcm !== 'object'
    || pcm === null
    || !Number.isSafeInteger(pcm.frameCount)
    || pcm.frameCount <= 0
    || pcm.sampleRate !== request.sourceSampleRate
    || pcm.channelCount !== request.channelCount
    || !Array.isArray(pcm.channels)
    || pcm.channels.length !== request.channelCount
    || pcm.channels.some(
      (channel) => !(channel instanceof Float32Array) || channel.length !== pcm.frameCount,
    )
    || request.sourceStartFrame + request.sourceFrameCount > pcm.frameCount
  ) {
    throw new AudioWarpDspError('invalid-pcm', 'Source PCM does not match the render request.');
  }
  const sourceEnd = request.sourceStartFrame + request.sourceFrameCount;
  for (const channel of pcm.channels) {
    for (let frame = request.sourceStartFrame; frame < sourceEnd; frame += 1) {
      if (!Number.isFinite(channel[frame])) {
        throw new AudioWarpDspError('invalid-pcm', 'Source PCM contains a non-finite sample.');
      }
    }
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AudioWarpDspError('cancelled', 'Elastic Audio render was cancelled.');
  }
}
