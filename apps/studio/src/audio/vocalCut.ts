/**
 * Local center-vocal reduction for existing stereo mixes.
 *
 * This is deliberately not stem separation. It attenuates the in-phase Mid
 * signal above a protected bass band while preserving the Side signal. Panned,
 * doubled, chorused or reverberant vocals can remain, and centered instruments
 * can be reduced with the voice.
 */

import { encodeWavAsync } from './wav';

export const MAX_VOCAL_CUT_SECONDS = 5 * 60;
export const MAX_VOCAL_CUT_OUTPUT_BYTES = 192 * 1024 * 1024;
export const MAX_VOCAL_CUT_WORKING_BYTES = 384 * 1024 * 1024;
export const MIN_PROCESSABLE_STEREO_WIDTH = 0.005;
export const MAX_VOCAL_CUT_DECODER_RESYNC_SECONDS = 2;
const VOCAL_CUT_RUNTIME_OVERHEAD_BYTES = 16 * 1024 * 1024;

export const VOCAL_CUT_PRESETS = {
  gentle: {
    id: 'gentle',
    label: '自然',
    description: '中央の楽器を残しやすい',
    strength: 0.75,
    preserveBassHz: 150,
  },
  standard: {
    id: 'standard',
    label: '標準',
    description: '声の軽減と伴奏のバランス',
    strength: 0.9,
    preserveBassHz: 120,
  },
  strong: {
    id: 'strong',
    label: '強め',
    description: '中央成分を最大限抑える',
    strength: 1,
    preserveBassHz: 100,
  },
} as const;

export type VocalCutPresetId = keyof typeof VOCAL_CUT_PRESETS;

export type VocalCutOptions = Readonly<{
  strength: number;
  preserveBassHz: number;
}>;

export type VocalCutErrorCode =
  | 'invalid-audio'
  | 'stereo-required'
  | 'near-mono'
  | 'duration-limit-exceeded'
  | 'resource-limit-exceeded'
  | 'non-finite-sample'
  | 'cancelled';

export class VocalCutError extends Error {
  constructor(
    readonly code: VocalCutErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'VocalCutError';
  }
}

export type VocalCutPlan = Readonly<{
  frames: number;
  sampleRate: number;
  durationSeconds: number;
  outputBytes: number;
  estimatedWorkingBytes: number;
}>;

export type VocalCutSuitability = 'good' | 'fair' | 'poor';

export type StereoAnalysis = Readonly<{
  inputRms: number;
  inputPeak: number;
  midRms: number;
  sideRms: number;
  stereoWidth: number;
  suitability: VocalCutSuitability;
}>;

export type VocalCutResult = Readonly<{
  blob: Blob;
  analysis: StereoAnalysis;
  outputRms: number;
  outputPeak: number;
  outputGain: number;
  plan: VocalCutPlan;
}>;

export type VocalCutProgress = Readonly<{
  phase: 'analyzing' | 'processing' | 'encoding';
  fraction: number;
}>;

export type RenderVocalCutOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: VocalCutProgress) => void;
  /** Test seam for deterministic chunk scheduling. */
  yieldControl?: () => Promise<void>;
  chunkFrames?: number;
  /** Encoded source bytes retained while the decoded PCM is processed. */
  sourceBytes?: number;
}>;

export type AudioBufferShape = Readonly<{
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
}>;

export type VocalCutSourceFormat = 'wav' | 'mp3' | 'm4a' | 'aac';

export type VocalCutSourceTiming = Readonly<{
  format: VocalCutSourceFormat;
  sampleRate: number;
  presentationDurationSeconds: number;
  containerDurationSeconds: number;
  decodeDurationSeconds: number;
}>;

export type VocalCutEncodedTiming = Omit<
  VocalCutSourceTiming,
  'presentationDurationSeconds'
>;

type StereoAccumulator = {
  leftPower: number;
  rightPower: number;
  midPower: number;
  sidePower: number;
  peak: number;
};

type ProcessAccumulator = {
  power: number;
  peak: number;
};

function codecPaddingSamples(format: VocalCutSourceFormat): number {
  if (format === 'wav') return 0;
  // Three MPEG/AAC access units cover encoder delay and end padding observed
  // in gapless MP3/M4A files. Raw ADTS has no edit list, so browsers may retain
  // a larger priming window; keep that allowance explicit and bounded.
  if (format === 'aac') return 12 * 1_024;
  return format === 'mp3' ? 3 * 1_152 : 3 * 1_024;
}

/** Maximum codec priming/end padding allowed around an otherwise five-minute source. */
export function vocalCutCodecPaddingSeconds(
  format: VocalCutSourceFormat,
  sampleRate: number,
): number {
  if (
    !Number.isFinite(sampleRate) ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000
  ) {
    throw new VocalCutError('invalid-audio');
  }
  const samples = codecPaddingSamples(format);
  return Math.ceil((samples * 1_000_000) / sampleRate) / 1_000_000;
}

/** Validate the strict encoded frame/sample chain before browser metadata I/O. */
export function validateVocalCutEncodedTiming(
  timing: VocalCutEncodedTiming,
  maximumSeconds = MAX_VOCAL_CUT_SECONDS,
): number {
  const { containerDurationSeconds, decodeDurationSeconds } = timing;
  if (
    !Number.isFinite(maximumSeconds) ||
    maximumSeconds <= 0 ||
    !Number.isFinite(containerDurationSeconds) ||
    containerDurationSeconds <= 0 ||
    !Number.isFinite(decodeDurationSeconds) ||
    decodeDurationSeconds <= 0
  ) {
    throw new VocalCutError('invalid-audio');
  }
  const paddingSeconds = vocalCutCodecPaddingSeconds(timing.format, timing.sampleRate);
  if (
    containerDurationSeconds > maximumSeconds + paddingSeconds ||
    decodeDurationSeconds >
      containerDurationSeconds + MAX_VOCAL_CUT_DECODER_RESYNC_SECONDS
  ) {
    throw new VocalCutError('duration-limit-exceeded');
  }
  return paddingSeconds;
}

/**
 * Reject over-limit metadata before decode while allowing only bounded codec
 * priming/padding and a small, measured decoder-resynchronization envelope.
 */
export function validateVocalCutSourceTiming(timing: VocalCutSourceTiming): number {
  const { presentationDurationSeconds } = timing;
  if (
    !Number.isFinite(presentationDurationSeconds) ||
    presentationDurationSeconds <= 0
  ) {
    throw new VocalCutError('invalid-audio');
  }
  const paddingSeconds = validateVocalCutEncodedTiming(timing);
  // Raw ADTS has no duration table. Chromium estimates HTMLMediaElement
  // duration from bitrate and can overstate an exact five-minute stream by
  // several seconds; the fully walked ADTS frame chain is authoritative.
  if (
    timing.format !== 'aac' &&
    presentationDurationSeconds > MAX_VOCAL_CUT_SECONDS + paddingSeconds
  ) {
    throw new VocalCutError('duration-limit-exceeded');
  }
  return paddingSeconds;
}

/**
 * Present only the first five minutes when a decoder retains allowed codec
 * padding. Channel arrays are zero-copy views; content beyond the limit is not
 * processed or encoded.
 */
export function trimVocalCutCodecPadding(
  buffer: AudioBufferShape,
  timing: VocalCutSourceTiming,
): AudioBufferShape {
  const paddingSeconds = validateVocalCutSourceTiming(timing);
  if (
    !Number.isSafeInteger(buffer.length) ||
    buffer.length <= 0 ||
    !Number.isSafeInteger(buffer.numberOfChannels) ||
    buffer.numberOfChannels <= 0 ||
    !Number.isFinite(buffer.sampleRate) ||
    !Number.isInteger(buffer.sampleRate) ||
    buffer.sampleRate < 8_000 ||
    buffer.sampleRate > 192_000
  ) {
    throw new VocalCutError('invalid-audio');
  }
  const maximumFrames = Math.floor(MAX_VOCAL_CUT_SECONDS * buffer.sampleRate);
  if (buffer.length <= maximumFrames) return buffer;
  const maximumPaddedFrames = Math.floor(
    (MAX_VOCAL_CUT_SECONDS + paddingSeconds) * buffer.sampleRate,
  );
  if (buffer.length > maximumPaddedFrames) {
    throw new VocalCutError('duration-limit-exceeded');
  }
  return {
    numberOfChannels: buffer.numberOfChannels,
    length: maximumFrames,
    sampleRate: buffer.sampleRate,
    getChannelData(channel: number): Float32Array {
      const data = buffer.getChannelData(channel);
      if (data.length < buffer.length) throw new VocalCutError('invalid-audio');
      return data.subarray(0, maximumFrames);
    },
  };
}

function planVocalCutFrames(
  frames: number,
  sampleRate: number,
  sourceBytes: number,
  decodedChannelCount = 2,
): VocalCutPlan {
  if (
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000
  ) {
    throw new VocalCutError('invalid-audio');
  }
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new VocalCutError('invalid-audio');
  }
  if (
    !Number.isSafeInteger(decodedChannelCount) ||
    decodedChannelCount <= 0 ||
    decodedChannelCount > 32
  ) {
    throw new VocalCutError('invalid-audio');
  }
  const durationSeconds = frames / sampleRate;
  const outputBytes = 44 + frames * 2 * 2;
  // Conservatively count the source Blob, decode input and decoder scratch,
  // decoded PCM at its conservative channel upper bound, WAV ArrayBuffer plus
  // Blob snapshot, and fixed runtime
  // overhead.
  // Processing itself remains in-place and does not allocate another PCM copy.
  const estimatedWorkingBytes =
    sourceBytes * 3 +
    frames * decodedChannelCount * Float32Array.BYTES_PER_ELEMENT +
    outputBytes * 2 +
    VOCAL_CUT_RUNTIME_OVERHEAD_BYTES;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_VOCAL_CUT_SECONDS
  ) {
    throw new VocalCutError('duration-limit-exceeded');
  }
  if (
    !Number.isSafeInteger(outputBytes) ||
    !Number.isSafeInteger(estimatedWorkingBytes) ||
    outputBytes > MAX_VOCAL_CUT_OUTPUT_BYTES ||
    estimatedWorkingBytes > MAX_VOCAL_CUT_WORKING_BYTES
  ) {
    throw new VocalCutError('resource-limit-exceeded');
  }
  return { frames, sampleRate, durationSeconds, outputBytes, estimatedWorkingBytes };
}

/** Preflight channel and worst-case allocations before decodeAudioData runs. */
export function planVocalCutDecode(
  durationSeconds: number,
  sampleRate: number,
  sourceBytes: number,
  channelCount: number,
  decodeChannelCountUpperBound = channelCount,
  decodeDurationSeconds = durationSeconds,
): VocalCutPlan {
  if (channelCount !== 2) throw new VocalCutError('stereo-required');
  if (
    !Number.isSafeInteger(decodeChannelCountUpperBound) ||
    decodeChannelCountUpperBound < channelCount ||
    decodeChannelCountUpperBound > 32
  ) {
    throw new VocalCutError('invalid-audio');
  }
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_VOCAL_CUT_SECONDS
  ) {
    throw new VocalCutError('duration-limit-exceeded');
  }
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000 ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0 ||
    !Number.isFinite(decodeDurationSeconds) ||
    decodeDurationSeconds <= 0
  ) {
    throw new VocalCutError('invalid-audio');
  }
  const plannedDecodeDurationSeconds = Math.max(
    durationSeconds,
    decodeDurationSeconds,
  );
  const frames = Math.ceil(plannedDecodeDurationSeconds * sampleRate);
  const maximumOutputFrames = Math.floor(MAX_VOCAL_CUT_SECONDS * sampleRate);
  const outputFrames = Math.min(frames, maximumOutputFrames);
  const outputBytes = 44 + outputFrames * 2 * 2;
  const decodePhaseBytes =
    sourceBytes * 3 +
    frames * decodeChannelCountUpperBound * Float32Array.BYTES_PER_ELEMENT +
    VOCAL_CUT_RUNTIME_OVERHEAD_BYTES;
  const outputPhaseBytes =
    sourceBytes * 3 +
    outputFrames * 2 * Float32Array.BYTES_PER_ELEMENT +
    outputBytes * 2 +
    VOCAL_CUT_RUNTIME_OVERHEAD_BYTES;
  const estimatedWorkingBytes = Math.max(decodePhaseBytes, outputPhaseBytes);
  const plannedDurationSeconds = frames / sampleRate;
  if (
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    !Number.isSafeInteger(outputBytes) ||
    !Number.isSafeInteger(decodePhaseBytes) ||
    !Number.isSafeInteger(outputPhaseBytes) ||
    !Number.isSafeInteger(estimatedWorkingBytes) ||
    outputBytes > MAX_VOCAL_CUT_OUTPUT_BYTES ||
    estimatedWorkingBytes > MAX_VOCAL_CUT_WORKING_BYTES
  ) {
    throw new VocalCutError('resource-limit-exceeded');
  }
  return {
    frames,
    sampleRate,
    durationSeconds: plannedDurationSeconds,
    outputBytes,
    estimatedWorkingBytes,
  };
}

/** Bound decoded PCM and final WAV allocation before starting the transform. */
export function planVocalCut(
  buffer: AudioBufferShape,
  sourceBytes = 0,
): VocalCutPlan {
  if (buffer.numberOfChannels !== 2) {
    throw new VocalCutError('stereo-required');
  }
  return planVocalCutFrames(buffer.length, buffer.sampleRate, sourceBytes);
}

function validateOptions(options: VocalCutOptions, sampleRate: number): void {
  if (
    !Number.isFinite(options.strength) ||
    options.strength < 0 ||
    options.strength > 1 ||
    !Number.isFinite(options.preserveBassHz) ||
    options.preserveBassHz < 20 ||
    options.preserveBassHz >= sampleRate / 2
  ) {
    throw new VocalCutError('invalid-audio');
  }
}

function assertStereoChannels(left: Float32Array, right: Float32Array): void {
  if (left.length === 0 || left.length !== right.length) {
    throw new VocalCutError('invalid-audio');
  }
}

function createStereoAccumulator(): StereoAccumulator {
  return { leftPower: 0, rightPower: 0, midPower: 0, sidePower: 0, peak: 0 };
}

function accumulateStereoRange(
  left: Float32Array,
  right: Float32Array,
  start: number,
  end: number,
  accumulator: StereoAccumulator,
): void {
  for (let frame = start; frame < end; frame += 1) {
    const leftSample = left[frame] ?? 0;
    const rightSample = right[frame] ?? 0;
    if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample)) {
      throw new VocalCutError('non-finite-sample');
    }
    const mid = (leftSample + rightSample) * 0.5;
    const side = (leftSample - rightSample) * 0.5;
    accumulator.leftPower += leftSample * leftSample;
    accumulator.rightPower += rightSample * rightSample;
    accumulator.midPower += mid * mid;
    accumulator.sidePower += side * side;
    accumulator.peak = Math.max(
      accumulator.peak,
      Math.abs(leftSample),
      Math.abs(rightSample),
    );
  }
}

function finalizeStereoAnalysis(
  accumulator: StereoAccumulator,
  frames: number,
): StereoAnalysis {
  const inputRms = Math.sqrt(
    (accumulator.leftPower + accumulator.rightPower) / (frames * 2),
  );
  const midRms = Math.sqrt(accumulator.midPower / frames);
  const sideRms = Math.sqrt(accumulator.sidePower / frames);
  const stereoEnergy = accumulator.midPower + accumulator.sidePower;
  const stereoWidth =
    stereoEnergy > Number.EPSILON
      ? Math.min(1, Math.sqrt(accumulator.sidePower / stereoEnergy))
      : 0;
  const suitability: VocalCutSuitability =
    stereoWidth >= 0.18 ? 'good' : stereoWidth >= 0.06 ? 'fair' : 'poor';
  return {
    inputRms,
    inputPeak: accumulator.peak,
    midRms,
    sideRms,
    stereoWidth,
    suitability,
  };
}

/** Analyze Mid/Side energy without mutating the decoded audio. */
export function analyzeStereoChannels(
  left: Float32Array,
  right: Float32Array,
): StereoAnalysis {
  assertStereoChannels(left, right);
  const accumulator = createStereoAccumulator();
  accumulateStereoRange(left, right, 0, left.length, accumulator);
  return finalizeStereoAnalysis(accumulator, left.length);
}

class LowPassBiquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;

  constructor(sampleRate: number, frequency: number) {
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const q = Math.SQRT1_2;
    const alpha = sine / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosine) * 0.5) / a0;
    this.b1 = (1 - cosine) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosine) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(input: number): number {
    const output =
      this.b0 * input +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}

function processVocalCutRange(
  left: Float32Array,
  right: Float32Array,
  start: number,
  end: number,
  strength: number,
  filter: LowPassBiquad | null,
  accumulator: ProcessAccumulator,
): void {
  for (let frame = start; frame < end; frame += 1) {
    const leftSample = left[frame] ?? 0;
    const rightSample = right[frame] ?? 0;
    let outputLeft = leftSample;
    let outputRight = rightSample;
    if (strength > 0 && filter) {
      const mid = (leftSample + rightSample) * 0.5;
      const side = (leftSample - rightSample) * 0.5;
      const protectedBass = filter.process(mid);
      const reducedMid = mid - strength * (mid - protectedBass);
      outputLeft = reducedMid + side;
      outputRight = reducedMid - side;
      left[frame] = outputLeft;
      right[frame] = outputRight;
    }
    accumulator.power += outputLeft * outputLeft + outputRight * outputRight;
    accumulator.peak = Math.max(
      accumulator.peak,
      Math.abs(outputLeft),
      Math.abs(outputRight),
    );
  }
}

export type AppliedVocalCut = Readonly<{
  analysis: StereoAnalysis;
  outputRms: number;
  outputPeak: number;
  outputGain: number;
}>;

/** Synchronous pure-DSP entry point used by unit tests and small buffers. */
export function applyVocalCutInPlace(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  options: VocalCutOptions,
): AppliedVocalCut {
  assertStereoChannels(left, right);
  validateOptions(options, sampleRate);
  const analysis = analyzeStereoChannels(left, right);
  const accumulator: ProcessAccumulator = { power: 0, peak: 0 };
  const filter =
    options.strength > 0
      ? new LowPassBiquad(sampleRate, options.preserveBassHz)
      : null;
  processVocalCutRange(
    left,
    right,
    0,
    left.length,
    options.strength,
    filter,
    accumulator,
  );
  const outputGain = accumulator.peak > 1 ? 0.999 / accumulator.peak : 1;
  if (outputGain < 1) applyGainRange(left, right, 0, left.length, outputGain);
  return {
    analysis,
    outputRms: Math.sqrt(accumulator.power / (left.length * 2)) * outputGain,
    outputPeak: accumulator.peak * outputGain,
    outputGain,
  };
}

function applyGainRange(
  left: Float32Array,
  right: Float32Array,
  start: number,
  end: number,
  gain: number,
): void {
  for (let frame = start; frame < end; frame += 1) {
    left[frame] = (left[frame] ?? 0) * gain;
    right[frame] = (right[frame] ?? 0) * gain;
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new VocalCutError('cancelled');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function progressFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Process a decoded stereo buffer in bounded chunks and create a stereo PCM16
 * WAV. The source buffer is mutated in-place and must be treated as consumed.
 */
export async function renderVocalCutToWav(
  buffer: AudioBufferShape,
  options: VocalCutOptions,
  renderOptions: RenderVocalCutOptions = {},
): Promise<VocalCutResult> {
  const plan = planVocalCut(buffer, renderOptions.sourceBytes ?? 0);
  validateOptions(options, plan.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  assertStereoChannels(left, right);
  if (left.length !== plan.frames) throw new VocalCutError('invalid-audio');

  const chunkFrames =
    Number.isSafeInteger(renderOptions.chunkFrames) &&
    (renderOptions.chunkFrames ?? 0) > 0
      ? (renderOptions.chunkFrames as number)
      : 262_144;
  const yieldControl = renderOptions.yieldControl ?? yieldToEventLoop;
  const onProgress = renderOptions.onProgress;

  try {
    const stereoAccumulator = createStereoAccumulator();
    onProgress?.({ phase: 'analyzing', fraction: 0 });
    for (let start = 0; start < plan.frames; start += chunkFrames) {
      throwIfCancelled(renderOptions.signal);
      const end = Math.min(plan.frames, start + chunkFrames);
      accumulateStereoRange(left, right, start, end, stereoAccumulator);
      onProgress?.({
        phase: 'analyzing',
        fraction: progressFraction(end / plan.frames),
      });
      if (end < plan.frames) await yieldControl();
    }
    const analysis = finalizeStereoAnalysis(stereoAccumulator, plan.frames);
    if (analysis.stereoWidth < MIN_PROCESSABLE_STEREO_WIDTH) {
      throw new VocalCutError('near-mono');
    }

    const processAccumulator: ProcessAccumulator = { power: 0, peak: 0 };
    const filter =
      options.strength > 0
        ? new LowPassBiquad(plan.sampleRate, options.preserveBassHz)
        : null;
    onProgress?.({ phase: 'processing', fraction: 0 });
    for (let start = 0; start < plan.frames; start += chunkFrames) {
      throwIfCancelled(renderOptions.signal);
      const end = Math.min(plan.frames, start + chunkFrames);
      processVocalCutRange(
        left,
        right,
        start,
        end,
        options.strength,
        filter,
        processAccumulator,
      );
      onProgress?.({
        phase: 'processing',
        fraction: progressFraction((end / plan.frames) * 0.9),
      });
      if (end < plan.frames) await yieldControl();
    }

    // Never boost a weak residual. Only attenuate a mathematical overshoot so
    // the encoder does not clip, using the same gain for both channels.
    const outputGain = processAccumulator.peak > 1 ? 0.999 / processAccumulator.peak : 1;
    if (outputGain < 1) {
      for (let start = 0; start < plan.frames; start += chunkFrames) {
        throwIfCancelled(renderOptions.signal);
        const end = Math.min(plan.frames, start + chunkFrames);
        applyGainRange(left, right, start, end, outputGain);
        onProgress?.({
          phase: 'processing',
          fraction: progressFraction(0.9 + (end / plan.frames) * 0.1),
        });
        if (end < plan.frames) await yieldControl();
      }
    } else {
      onProgress?.({ phase: 'processing', fraction: 1 });
    }

    throwIfCancelled(renderOptions.signal);
    const wav = await encodeWavAsync([left, right], plan.sampleRate, {
      signal: renderOptions.signal,
      chunkFrames,
      yieldControl,
      onProgress: (fraction) =>
        onProgress?.({ phase: 'encoding', fraction: progressFraction(fraction) }),
    });
    throwIfCancelled(renderOptions.signal);
    return {
      blob: new Blob([wav], { type: 'audio/wav' }),
      analysis,
      outputRms:
        Math.sqrt(processAccumulator.power / (plan.frames * 2)) * outputGain,
      outputPeak: processAccumulator.peak * outputGain,
      outputGain,
      plan,
    };
  } catch (error) {
    if (error instanceof VocalCutError) throw error;
    if (
      renderOptions.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new VocalCutError('cancelled');
    }
    throw error;
  }
}
