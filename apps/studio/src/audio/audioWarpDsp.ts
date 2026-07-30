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
export const FORMANT_FFT_SIZE = 2048;
export const FORMANT_HOP_SIZE = 1024;
export const FORMANT_SCRATCH_BYTES = 147_456;
export const FORMANT_RELEASE_LIMITATION =
  'Synthetic quality gates do not establish perceptual quality on real voices; '
  + 'release requires a licensed-voice blind A/B or MUSHRA evaluation.';
const FORMANT_RMS_THRESHOLD = 1e-4;
const FORMANT_ANTI_PHASE_THRESHOLD = 1e-4;
const FORMANT_PERIODICITY_THRESHOLD = 0.60;
const FORMANT_FLATNESS_THRESHOLD = 0.35;
const FORMANT_AMBIGUITY_THRESHOLD = 0.85;
// Below this median odd/even amplitude ratio the analyzed F0 behaves like a
// missing fundamental, so a supported integer-multiple candidate may be used.
const FORMANT_ODD_HARMONIC_EVIDENCE_THRESHOLD = 5e-4;

export type AudioWarpFormantFallbackReason =
  | 'unsupported-rate'
  | 'too-short/too-few-periods'
  | 'insufficient-energy'
  | 'anti-phase'
  | 'flat/unvoiced'
  | 'ambiguous';

export type AudioWarpFormantAnalysis = Readonly<{
  active: boolean;
  reason: AudioWarpFormantFallbackReason | null;
  linkedRms: number;
  midToLinkedEnergyRatio: number;
  periodicity: number;
  spectralFlatness: number;
  ambiguityRatio: number;
  estimatedF0: number | null;
  usefulSamples: number;
  usefulPeriodCount: number;
}>;

export type AudioWarpFormantGateInput = Readonly<{
  supported: boolean;
  availableSamples: number;
  sampleRate: number;
  linkedRms: number;
  midToLinkedEnergyRatio: number;
  periodicity: number;
  spectralFlatness: number;
  ambiguityRatio: number;
  aggregateF0: number | null;
  estimatedF0: number | null;
  usefulSamples: number;
  usefulEnergy: number;
  nonSilentEnergy: number;
}>;

export type AudioWarpFormantGateResult = Readonly<{
  active: boolean;
  reason: AudioWarpFormantFallbackReason | null;
  stableVoiced: boolean;
  usefulPeriodCount: number;
}>;

/** Pure, production-owned predicate order used by every formant consumer. */
export function evaluateAudioWarpFormantGates(
  input: AudioWarpFormantGateInput,
): AudioWarpFormantGateResult {
  if (!input.supported) {
    return {
      active: false,
      reason: 'unsupported-rate',
      stableVoiced: false,
      usefulPeriodCount: 0,
    };
  }
  const stableVoiced = input.aggregateF0 !== null
    && input.periodicity >= FORMANT_PERIODICITY_THRESHOLD
    && input.spectralFlatness <= FORMANT_FLATNESS_THRESHOLD
    && input.ambiguityRatio <= FORMANT_AMBIGUITY_THRESHOLD
    && input.usefulEnergy >= input.nonSilentEnergy * 0.60;
  const usefulPeriodCount = input.estimatedF0 === null
    ? 0
    : input.usefulSamples * input.estimatedF0 / input.sampleRate;
  const tooShortApplies = stableVoiced
    && input.linkedRms >= FORMANT_RMS_THRESHOLD
    && input.midToLinkedEnergyRatio >= FORMANT_ANTI_PHASE_THRESHOLD
    && (input.availableSamples < FORMANT_FFT_SIZE || usefulPeriodCount < 8);
  let reason: AudioWarpFormantFallbackReason | null = null;
  if (tooShortApplies) reason = 'too-short/too-few-periods';
  else if (input.linkedRms < FORMANT_RMS_THRESHOLD) reason = 'insufficient-energy';
  else if (input.midToLinkedEnergyRatio < FORMANT_ANTI_PHASE_THRESHOLD) reason = 'anti-phase';
  else if (
    !stableVoiced
    && (
      input.periodicity < FORMANT_PERIODICITY_THRESHOLD
      || input.spectralFlatness > FORMANT_FLATNESS_THRESHOLD
    )
  ) reason = 'flat/unvoiced';
  else if (!stableVoiced || input.ambiguityRatio > FORMANT_AMBIGUITY_THRESHOLD) {
    reason = 'ambiguous';
  }
  return {
    active: reason === null,
    reason,
    stableVoiced,
    usefulPeriodCount,
  };
}

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
    let rendered = renderSegmentAtPitch(
      input,
      outputLength,
      pitchRegion?.cents ?? 0,
      signal,
    );
    if (
      request.formantMode === 'preserve'
      && pitchRegion !== undefined
      && pitchRegion.cents !== 0
    ) {
      const naturalLength = Math.max(1, Math.round(
        input[0]!.length * request.targetSampleRate / request.sourceSampleRate,
      ));
      const naturalRateDry = bandLimitedResample(input, naturalLength);
      const dryForFormants = naturalLength === outputLength
        ? naturalRateDry
        : wsolaTimeScale(naturalRateDry, outputLength, signal);
      const analysis = analyzeAudioWarpFormants(dryForFormants, request.targetSampleRate, signal);
      if (analysis.active) {
        const resonant = renderResonantVoicedPitch(
          dryForFormants,
          pitchRegion.cents,
          request.targetSampleRate,
          analysis.estimatedF0,
          signal,
        );
        rendered = resonant ?? renderSegmentAtPitch(
          dryForFormants,
          outputLength,
          pitchRegion.cents,
          signal,
        );
        if (resonant === null) {
          preserveFormants(dryForFormants, rendered, request.targetSampleRate, signal);
        }
        matchFormantLevel(dryForFormants, rendered, signal);
      }
    }
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

type FormantFrameMetric = Readonly<{
  start: number;
  actualStart: number;
  actualEnd: number;
  energy: number;
  periodicity: number;
  flatness: number;
  ambiguity: number;
  f0: number | null;
  useful: boolean;
}>;

/** Production fallback analysis used by direct DSP; tests recompute it independently. */
export function analyzeAudioWarpFormants(
  input: readonly Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
): AudioWarpFormantAnalysis {
  throwIfCancelled(signal);
  const length = input[0]?.length ?? 0;
  if (
    (sampleRate !== 44_100 && sampleRate !== 48_000)
    || input.length < 1
    || input.length > 2
    || input.some((channel) => channel.length !== length)
  ) {
    return fallbackAnalysis('unsupported-rate');
  }
  let linkedEnergy = 0;
  let midEnergy = 0;
  for (let frame = 0; frame < length; frame += 1) {
    let mid = 0;
    for (const channel of input) {
      const value = channel[frame]!;
      linkedEnergy += value * value;
      mid += value;
    }
    mid /= input.length;
    midEnergy += mid * mid;
  }
  const linkedRms = length === 0
    ? 0
    : Math.sqrt(linkedEnergy / (length * input.length));
  const midToLinkedEnergyRatio = linkedEnergy === 0
    ? 0
    : midEnergy * input.length / linkedEnergy;
  const starts = analysisFrameStarts(length);
  const metrics = starts.map((start) =>
    analyzeFormantFrame(input, start, sampleRate, signal));
  const nonSilent = metrics.filter((metric) => metric.energy > 1e-12);
  const periodicity = weightedMedian(nonSilent, (metric) => metric.periodicity);
  const spectralFlatness = weightedMedian(nonSilent, (metric) => metric.flatness);
  const ambiguityRatio = weightedMedian(nonSilent, (metric) => metric.ambiguity);
  const f0 = weightedMedianNullable(
    nonSilent.filter((metric) => metric.f0 !== null),
    (metric) => metric.f0!,
  );
  const usefulNearF0 = f0 === null
    ? []
    : nonSilent.filter((metric) =>
        metric.useful
        && metric.f0 !== null
        && Math.abs(1200 * Math.log2(metric.f0 / f0)) <= 50);
  const nonSilentEnergy = nonSilent.reduce((sum, metric) => sum + metric.energy, 0);
  const usefulEnergy = usefulNearF0.reduce((sum, metric) => sum + metric.energy, 0);
  const estimatedF0 = weightedMedianNullable(
    usefulNearF0,
    (metric) => metric.f0!,
  );
  const usefulSamples = length < FORMANT_FFT_SIZE
    ? length
    : unionUsefulHopSamples(usefulNearF0, length);
  const gates = evaluateAudioWarpFormantGates({
    supported: true,
    availableSamples: length,
    sampleRate,
    linkedRms,
    midToLinkedEnergyRatio,
    periodicity,
    spectralFlatness,
    ambiguityRatio,
    aggregateF0: f0,
    estimatedF0,
    usefulSamples,
    usefulEnergy,
    nonSilentEnergy,
  });
  return Object.freeze({
    active: gates.active,
    reason: gates.reason,
    linkedRms,
    midToLinkedEnergyRatio,
    periodicity,
    spectralFlatness,
    ambiguityRatio,
    estimatedF0,
    usefulSamples,
    usefulPeriodCount: gates.usefulPeriodCount,
  });
}

function fallbackAnalysis(reason: AudioWarpFormantFallbackReason): AudioWarpFormantAnalysis {
  return Object.freeze({
    active: false,
    reason,
    linkedRms: 0,
    midToLinkedEnergyRatio: 0,
    periodicity: 0,
    spectralFlatness: 1,
    ambiguityRatio: 1,
    estimatedF0: null,
    usefulSamples: 0,
    usefulPeriodCount: 0,
  });
}

function analysisFrameStarts(length: number): number[] {
  if (length < FORMANT_FFT_SIZE) return [0];
  const starts: number[] = [];
  for (
    let start = 0;
    start + FORMANT_FFT_SIZE <= length;
    start += FORMANT_HOP_SIZE
  ) starts.push(start);
  const tail = length - FORMANT_FFT_SIZE;
  if (starts.at(-1) !== tail) starts.push(tail);
  return starts;
}

function analyzeFormantFrame(
  input: readonly Float32Array[],
  start: number,
  sampleRate: number,
  signal?: AbortSignal,
): FormantFrameMetric {
  throwIfCancelled(signal);
  const length = input[0]!.length;
  const actualStart = Math.max(0, start);
  const actualEnd = Math.min(length, start + FORMANT_FFT_SIZE);
  const real = new Float64Array(FORMANT_FFT_SIZE);
  const imaginary = new Float64Array(FORMANT_FFT_SIZE);
  let energy = 0;
  for (let local = 0; local < FORMANT_FFT_SIZE; local += 1) {
    const sourceFrame = start + local;
    if (sourceFrame < 0 || sourceFrame >= length) continue;
    let mid = 0;
    for (const channel of input) {
      const value = channel[sourceFrame]!;
      energy += value * value / input.length;
      mid += value;
    }
    mid /= input.length;
    real[local] = mid * (
      0.5 - 0.5 * Math.cos(2 * Math.PI * (local + 0.5) / FORMANT_FFT_SIZE)
    );
  }
  fftRadix2(real, imaginary, false, signal);
  let logSum = 0;
  let linearSum = 0;
  let binCount = 0;
  const firstBin = Math.max(1, Math.ceil(70 * FORMANT_FFT_SIZE / sampleRate));
  const lastBin = Math.min(
    FORMANT_FFT_SIZE / 2 - 1,
    Math.floor(5_000 * FORMANT_FFT_SIZE / sampleRate),
  );
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const power = real[bin]! ** 2 + imaginary[bin]! ** 2;
    logSum += Math.log(Math.max(power, 1e-14));
    linearSum += power;
    binCount += 1;
  }
  const flatness = linearSum <= 0 || binCount === 0
    ? 1
    : Math.exp(logSum / binCount) / (linearSum / binCount);
  const mid = new Float64Array(Math.max(0, actualEnd - actualStart));
  for (let index = 0; index < mid.length; index += 1) {
    const sourceFrame = actualStart + index;
    for (const channel of input) mid[index] = mid[index]! + channel[sourceFrame]! / input.length;
  }
  const minLag = Math.max(1, Math.ceil(sampleRate / 400));
  const maxLag = Math.min(Math.floor(sampleRate / 70), mid.length - 1);
  const scores: Array<{ lag: number; score: number }> = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const pairs = mid.length - lag;
    if (pairs < 2 * lag) continue;
    let cross = 0;
    let left = 0;
    let right = 0;
    for (let index = 0; index < pairs; index += 1) {
      const a = mid[index]!;
      const b = mid[index + lag]!;
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    scores.push({ lag, score: cross / Math.sqrt(Math.max(1e-24, left * right)) });
  }
  const byLag = new Map(scores.map((candidate) => [candidate.lag, candidate.score]));
  const primary = [...scores].sort((left, right) => right.score - left.score)[0];
  if (!primary) {
    return {
      start, actualStart, actualEnd, energy,
      periodicity: 0, flatness, ambiguity: 1, f0: null, useful: false,
    };
  }
  const previous = byLag.get(primary.lag - 1) ?? primary.score;
  const next = byLag.get(primary.lag + 1) ?? primary.score;
  const denominator = previous - 2 * primary.score + next;
  const offset = Math.abs(denominator) < 1e-12
    ? 0
    : Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / denominator));
  const f0 = sampleRate / (primary.lag + offset);
  const harmonicRatios = [0.25, 1 / 3, 0.5, 1, 2, 3, 4];
  const minimumRunnerLagDistance = Math.max(2, Math.round(0.15 * primary.lag));
  const runner = scores
    .filter((candidate) => {
      const previousScore = byLag.get(candidate.lag - 1);
      const nextScore = byLag.get(candidate.lag + 1);
      if (
        previousScore === undefined
        || nextScore === undefined
        || candidate.score <= previousScore
        || candidate.score <= nextScore
        || Math.abs(candidate.lag - primary.lag) < minimumRunnerLagDistance
      ) return false;
      const candidateF0 = sampleRate / candidate.lag;
      return harmonicRatios.every((ratio) =>
        Math.abs(1200 * Math.log2(candidateF0 / (f0 * ratio))) > 50);
    })
    .sort((left, right) => right.score - left.score)[0];
  const ambiguity = primary.score <= 0
    ? 1
    : Math.max(0, runner?.score ?? 0) / primary.score;
  const useful = primary.score >= FORMANT_PERIODICITY_THRESHOLD
    && flatness <= FORMANT_FLATNESS_THRESHOLD
    && ambiguity <= FORMANT_AMBIGUITY_THRESHOLD;
  return {
    start, actualStart, actualEnd, energy,
    periodicity: primary.score, flatness, ambiguity, f0, useful,
  };
}

function weightedMedian(
  metrics: readonly FormantFrameMetric[],
  value: (metric: FormantFrameMetric) => number,
): number {
  return weightedMedianNullable(metrics, value) ?? 0;
}

function weightedMedianNullable(
  metrics: readonly FormantFrameMetric[],
  value: (metric: FormantFrameMetric) => number,
): number | null {
  if (metrics.length === 0) return null;
  const sorted = [...metrics].sort((left, right) => value(left) - value(right));
  const total = sorted.reduce((sum, metric) => sum + metric.energy, 0);
  let accumulated = 0;
  for (const metric of sorted) {
    accumulated += metric.energy;
    if (accumulated >= total / 2) return value(metric);
  }
  return value(sorted.at(-1)!);
}

function unionUsefulHopSamples(
  useful: readonly FormantFrameMetric[],
  length: number,
): number {
  const intervals = useful
    .map((metric) => [
      Math.max(0, metric.start),
      Math.min(length, metric.start + FORMANT_HOP_SIZE),
    ] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let end = 0;
  for (const [start, nextEnd] of intervals) {
    if (nextEnd <= end) continue;
    total += nextEnd - Math.max(start, end);
    end = nextEnd;
  }
  return total;
}

/** Safe local fallback: cepstral envelope transfer with one linked gain curve. */
export function preserveFormants(
  dry: readonly Float32Array[],
  wet: readonly Float32Array[],
  sampleRate: number,
  signal?: AbortSignal,
): void {
  throwIfCancelled(signal);
  const length = wet[0]?.length ?? 0;
  if (
    (sampleRate !== 44_100 && sampleRate !== 48_000)
    || dry.length !== wet.length
    || wet.length < 1
    || wet.length > 2
    || dry.some((channel) => channel.length !== length)
    || wet.some((channel) => channel.length !== length)
  ) return;
  // Eight Float64 and two Float32 N-vectors are the fixed reusable scratch
  // contract accounted by FORMANT_SCRATCH_BYTES. Segment-sized accumulation
  // belongs to the 9*O processing projection, not this fixed scratch block.
  const real = new Float64Array(FORMANT_FFT_SIZE);
  const imaginary = new Float64Array(FORMANT_FFT_SIZE);
  const dryMagnitude = new Float64Array(FORMANT_FFT_SIZE);
  const wetMagnitude = new Float64Array(FORMANT_FFT_SIZE);
  const dryEnvelope = new Float64Array(FORMANT_FFT_SIZE);
  const wetEnvelope = new Float64Array(FORMANT_FFT_SIZE);
  const cepstrumReal = new Float64Array(FORMANT_FFT_SIZE);
  const cepstrumImaginary = new Float64Array(FORMANT_FFT_SIZE);
  const normalization = new Float32Array(length);
  const window = new Float32Array(FORMANT_FFT_SIZE);
  const gain = new Float32Array(FORMANT_FFT_SIZE);
  const accumulated = wet.map(() => new Float32Array(length));
  for (let index = 0; index < FORMANT_FFT_SIZE; index += 1) {
    window[index] = Math.sqrt(
      0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / FORMANT_FFT_SIZE),
    );
  }
  const q = Math.round(0.0015 * sampleRate);
  const clampLog = 12 * Math.LN10 / 20;
  for (
    let start = -FORMANT_FFT_SIZE / 2;
    start < length + FORMANT_FFT_SIZE / 2;
    start += FORMANT_HOP_SIZE
  ) {
    throwIfCancelled(signal);
    linkedMagnitude(dry, start, window, dryMagnitude, real, imaginary, signal);
    linkedMagnitude(wet, start, window, wetMagnitude, real, imaginary, signal);
    cepstralEnvelope(
      dryMagnitude,
      dryEnvelope,
      cepstrumReal,
      cepstrumImaginary,
      q,
      signal,
    );
    cepstralEnvelope(
      wetMagnitude,
      wetEnvelope,
      cepstrumReal,
      cepstrumImaginary,
      q,
      signal,
    );
    for (let bin = 0; bin < FORMANT_FFT_SIZE; bin += 1) {
      gain[bin] = Math.exp(Math.max(
        -clampLog,
        Math.min(clampLog, dryEnvelope[bin]! - wetEnvelope[bin]!),
      ));
    }
    for (let channel = 0; channel < wet.length; channel += 1) {
      synthesizeFormantFrame(
        wet[channel]!,
        accumulated[channel]!,
        channel === 0 ? normalization : undefined,
        start,
        window,
        gain,
        real,
        imaginary,
        signal,
      );
    }
  }
  for (let channel = 0; channel < wet.length; channel += 1) {
    for (let frame = 0; frame < length; frame += 1) {
      throwIfCancelled(signal);
      wet[channel]![frame] = normalization[frame]! < 1e-12
        ? wet[channel]![frame]!
        : accumulated[channel]![frame]! / normalization[frame]!;
    }
  }
}

function synthesizeFormantFrame(
  wet: Float32Array,
  accumulated: Float32Array,
  normalization: Float32Array | undefined,
  start: number,
  window: Float32Array,
  gain: Float32Array,
  real: Float64Array,
  imaginary: Float64Array,
  signal?: AbortSignal,
): void {
  real.fill(0);
  imaginary.fill(0);
  for (let local = 0; local < FORMANT_FFT_SIZE; local += 1) {
    const sourceFrame = start + local;
    if (sourceFrame >= 0 && sourceFrame < wet.length) {
      real[local] = wet[sourceFrame]! * window[local]!;
    }
  }
  fftRadix2(real, imaginary, false, signal);
  for (let bin = 0; bin < FORMANT_FFT_SIZE; bin += 1) {
    real[bin] = real[bin]! * gain[bin]!;
    imaginary[bin] = imaginary[bin]! * gain[bin]!;
  }
  fftRadix2(real, imaginary, true, signal);
  for (let local = 0; local < FORMANT_FFT_SIZE; local += 1) {
    throwIfCancelled(signal);
    const destination = start + local;
    if (destination < 0 || destination >= wet.length) continue;
    accumulated[destination] = accumulated[destination]!
      + real[local]! * window[local]!;
    if (normalization !== undefined) {
      normalization[destination] = normalization[destination]! + window[local]! ** 2;
    }
  }
}

function linkedMagnitude(
  channels: readonly Float32Array[],
  start: number,
  window: Float32Array,
  magnitude: Float64Array,
  real: Float64Array,
  imaginary: Float64Array,
  signal?: AbortSignal,
): void {
  magnitude.fill(0);
  for (const channel of channels) {
    real.fill(0);
    imaginary.fill(0);
    for (let local = 0; local < FORMANT_FFT_SIZE; local += 1) {
      const sourceFrame = start + local;
      if (sourceFrame >= 0 && sourceFrame < channel.length) {
        real[local] = channel[sourceFrame]! * window[local]!;
      }
    }
    fftRadix2(real, imaginary, false, signal);
    for (let bin = 0; bin < FORMANT_FFT_SIZE; bin += 1) {
      magnitude[bin] = magnitude[bin]!
        + (real[bin]! ** 2 + imaginary[bin]! ** 2) / channels.length;
    }
  }
  for (let bin = 0; bin < FORMANT_FFT_SIZE; bin += 1) {
    magnitude[bin] = Math.sqrt(magnitude[bin]!);
  }
}

function cepstralEnvelope(
  magnitude: Float64Array,
  envelope: Float64Array,
  cepstrumReal: Float64Array,
  cepstrumImaginary: Float64Array,
  q: number,
  signal?: AbortSignal,
): void {
  for (let bin = 0; bin < FORMANT_FFT_SIZE; bin += 1) {
    cepstrumReal[bin] = Math.log(Math.max(magnitude[bin]!, 1e-7));
    cepstrumImaginary[bin] = 0;
  }
  fftRadix2(cepstrumReal, cepstrumImaginary, true, signal);
  for (let index = q + 1; index < FORMANT_FFT_SIZE - q; index += 1) {
    cepstrumReal[index] = 0;
    cepstrumImaginary[index] = 0;
  }
  // A real cepstrum is liftered as a real sequence. Explicitly discard the
  // inverse-FFT round-off imaginary component before reconstruction.
  cepstrumImaginary.fill(0);
  fftRadix2(cepstrumReal, cepstrumImaginary, false, signal);
  envelope.set(cepstrumReal);
}

function fftRadix2(
  real: Float64Array,
  imaginary: Float64Array,
  inverse: boolean,
  signal?: AbortSignal,
): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed]!, real[index]!];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed]!, imaginary[index]!];
    }
  }
  for (let width = 2; width <= size; width <<= 1) {
    throwIfCancelled(signal);
    const angle = (inverse ? 2 : -2) * Math.PI / width;
    const baseReal = Math.cos(angle);
    const baseImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < width / 2; index += 1) {
        const even = offset + index;
        const odd = even + width / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
        const nextReal = twiddleReal * baseReal - twiddleImaginary * baseImaginary;
        twiddleImaginary = twiddleReal * baseImaginary + twiddleImaginary * baseReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      real[index] = real[index]! / size;
      imaginary[index] = imaginary[index]! / size;
    }
  }
}

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

type HarmonicCoefficient = Readonly<{
  sine: number;
  cosine: number;
  amplitude: number;
}>;

type ResonanceModel = Readonly<{
  parameters: Float64Array;
  resonanceCount: number;
}>;

type ResynthesisFundamental = Readonly<{
  f0: number;
  sparseOddHarmonics: boolean;
}>;

/**
 * Stable voiced material needs its spectral envelope sampled at the new
 * harmonic frequencies. Comparing the dry and wet FFT bins directly confuses
 * a moved harmonic with a moved formant, so use a compact resonant-envelope
 * model and retain one linked gain per harmonic across channels.
 */
function renderResonantVoicedPitch(
  input: readonly Float32Array[],
  cents: number,
  sampleRate: number,
  analyzedF0: number | null,
  signal?: AbortSignal,
): Float32Array[] | null {
  throwIfCancelled(signal);
  const length = input[0]?.length ?? 0;
  if (length < FORMANT_FFT_SIZE) return null;
  const fundamental = estimateResynthesisFundamental(
    input,
    sampleRate,
    analyzedF0,
    signal,
  );
  if (fundamental === null) return null;
  const sourceF0 = fundamental.f0;
  const targetF0 = sourceF0 * 2 ** (cents / 1200);
  const maximumFrequency = Math.min(5_000, sampleRate / 2 - 100);
  const sourceHarmonicCount = Math.floor(maximumFrequency / sourceF0);
  const targetHarmonicCount = Math.floor(maximumFrequency / targetF0);
  if (sourceHarmonicCount < 8 || targetHarmonicCount < 8) return null;

  const analysisSize = Math.min(length, 8_192);
  const analysisStart = Math.floor((length - analysisSize) / 2);
  const channelCoefficients = input.map((channel) =>
    measureHarmonicCoefficients(
      channel,
      sourceF0,
      sourceHarmonicCount,
      sampleRate,
      analysisStart,
      analysisSize,
      signal,
    ));
  const linkedAmplitudes = new Float64Array(sourceHarmonicCount);
  const envelopeSamples = new Float64Array(sourceHarmonicCount);
  for (let harmonic = 0; harmonic < sourceHarmonicCount; harmonic += 1) {
    let energy = 0;
    for (const coefficients of channelCoefficients) {
      energy += coefficients[harmonic]!.amplitude ** 2 / channelCoefficients.length;
    }
    linkedAmplitudes[harmonic] = Math.sqrt(energy);
    envelopeSamples[harmonic] = linkedAmplitudes[harmonic]! * (harmonic + 1);
  }
  const stationary = hasStationaryHarmonicEnvelope(
    input,
    sourceF0,
    sampleRate,
    linkedAmplitudes,
    channelCoefficients,
    fundamental.sparseOddHarmonics,
    signal,
  );
  if (!stationary) return null;
  const fitSamples = fundamental.sparseOddHarmonics
    ? Float64Array.from(
        { length: Math.floor(envelopeSamples.length / 2) },
        (_, index) => envelopeSamples[index * 2 + 1]!,
      )
    : envelopeSamples;
  const fitF0 = fundamental.sparseOddHarmonics ? sourceF0 * 2 : sourceF0;
  const model = fitResonantEnvelope(fitSamples, fitF0, signal);
  if (model === null) return null;

  const accumulated = input.map(() => new Float64Array(length));
  const localAmplitude = linkedLocalAmplitude(
    input,
    sourceF0,
    sampleRate,
    analysisStart,
    analysisSize,
    signal,
  );
  const clamp = 10 ** (12 / 20);
  const targetAmplitudes = new Float64Array(targetHarmonicCount);
  for (let harmonic = 1; harmonic <= targetHarmonicCount; harmonic += 1) {
    const sourceIndex = Math.min(harmonic, sourceHarmonicCount) - 1;
    let excitationSourceIndex = sourceIndex;
    if (
      harmonic > sourceHarmonicCount
      && (excitationSourceIndex + 1) % 2 !== harmonic % 2
    ) excitationSourceIndex -= 1;
    const excitation = fundamental.sparseOddHarmonics
      ? envelopeSamples[excitationSourceIndex]! / Math.max(
          1e-12,
          evaluateResonantEnvelope(
            model,
            (excitationSourceIndex + 1) * sourceF0,
          ),
        )
      : 1;
    const amplitude = evaluateResonantEnvelope(model, harmonic * targetF0)
      / harmonic * excitation;
    if (!Number.isFinite(amplitude) || amplitude <= 0) return null;
    targetAmplitudes[harmonic - 1] = amplitude;
  }
  for (let harmonic = 1; harmonic <= targetHarmonicCount; harmonic += 1) {
    throwIfCancelled(signal);
    const desiredLinkedAmplitude = targetAmplitudes[harmonic - 1]!;
    const sourceIndex = Math.min(harmonic, sourceHarmonicCount) - 1;
    const sourceLinkedAmplitude = linkedAmplitudes[sourceIndex]!;
    if (sourceLinkedAmplitude <= 1e-12) continue;
    const gain = harmonic <= sourceHarmonicCount
      ? Math.max(
          1 / clamp,
          Math.min(clamp, desiredLinkedAmplitude / sourceLinkedAmplitude),
        )
      : desiredLinkedAmplitude / sourceLinkedAmplitude;
    const phaseStep = 2 * Math.PI * harmonic * targetF0 / sampleRate;
    const stepCosine = Math.cos(phaseStep);
    const stepSine = Math.sin(phaseStep);
    let oscillatorCosine = 1;
    let oscillatorSine = 0;
    for (let frame = 0; frame < length; frame += 1) {
      if ((frame & 1_023) === 0) throwIfCancelled(signal);
      for (let channel = 0; channel < accumulated.length; channel += 1) {
        const coefficients = channelCoefficients[channel]!;
        const coefficient = harmonic <= sourceHarmonicCount
          ? coefficients[sourceIndex]!
          : extrapolateHarmonicCoefficient(
              coefficients,
              harmonic,
              sourceHarmonicCount,
            );
        accumulated[channel]![frame] = accumulated[channel]![frame]!
          + gain * (
            coefficient.sine * oscillatorSine
            + coefficient.cosine * oscillatorCosine
          );
      }
      const nextCosine = oscillatorCosine * stepCosine
        - oscillatorSine * stepSine;
      oscillatorSine = oscillatorCosine * stepSine
        + oscillatorSine * stepCosine;
      oscillatorCosine = nextCosine;
    }
  }
  const rendered: Float32Array[] = [];
  for (const channel of accumulated) {
    const output = new Float32Array(length);
    for (let frame = 0; frame < length; frame += 1) {
      const sample = channel[frame]! * localAmplitude[frame]!;
      if (!Number.isFinite(sample)) return null;
      output[frame] = sample;
    }
    rendered.push(output);
  }
  return rendered;
}

function hasStationaryHarmonicEnvelope(
  input: readonly Float32Array[],
  f0: number,
  sampleRate: number,
  reference: Float64Array,
  referenceCoefficients: readonly (readonly HarmonicCoefficient[])[],
  evenHarmonicsOnly: boolean,
  signal?: AbortSignal,
): boolean {
  const length = input[0]?.length ?? 0;
  const peakReference = Math.max(...reference);
  const included = [...reference.keys()].filter((index) =>
    (!evenHarmonicsOnly || (index + 1) % 2 === 0)
    && reference[index]! >= peakReference * 1e-4);
  if (included.length < 8) return false;
  let comparedFrames = 0;
  for (const start of analysisFrameStarts(length)) {
    throwIfCancelled(signal);
    const size = Math.min(FORMANT_FFT_SIZE, length - start);
    const measured = input.map((channel) =>
      measureHarmonicCoefficients(
        channel,
        f0,
        reference.length,
        sampleRate,
        start,
        size,
        signal,
      ));
    const logRatios: number[] = [];
    let linkedEnergy = 0;
    for (const index of included) {
      let energy = 0;
      for (const coefficients of measured) {
        energy += coefficients[index]!.amplitude ** 2 / measured.length;
      }
      const amplitude = Math.sqrt(energy);
      linkedEnergy += amplitude ** 2;
      logRatios.push(Math.log(
        Math.max(1e-12, amplitude) / Math.max(1e-12, reference[index]!),
      ));
      for (let channel = 0; channel < measured.length; channel += 1) {
        const coefficient = measured[channel]![index]!;
        const referenceCoefficient = referenceCoefficients[channel]![index]!;
        if (
          coefficient.amplitude >= peakReference * 1e-4
          && referenceCoefficient.amplitude >= peakReference * 1e-4
        ) {
          const phase = Math.atan2(coefficient.cosine, coefficient.sine);
          const referencePhase = Math.atan2(
            referenceCoefficient.cosine,
            referenceCoefficient.sine,
          );
          const phaseError = Math.abs(Math.atan2(
            Math.sin(phase - referencePhase),
            Math.cos(phase - referencePhase),
          ));
          if (phaseError > 0.35) return false;
        }
      }
    }
    if (linkedEnergy <= peakReference ** 2 * 1e-6) continue;
    comparedFrames += 1;
    const mean = logRatios.reduce((sum, value) => sum + value, 0)
      / logRatios.length;
    const shapeError = Math.sqrt(logRatios.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) / logRatios.length);
    if (shapeError > 0.20) return false;
  }
  return comparedFrames > 0;
}

function extrapolateHarmonicCoefficient(
  coefficients: readonly HarmonicCoefficient[],
  harmonic: number,
  sourceHarmonicCount: number,
): HarmonicCoefficient {
  const last = coefficients[sourceHarmonicCount - 1]!;
  const previous = coefficients[Math.max(0, sourceHarmonicCount - 2)]!;
  const lastPhase = Math.atan2(last.cosine, last.sine);
  const previousPhase = Math.atan2(previous.cosine, previous.sine);
  const phaseStep = Math.atan2(
    Math.sin(lastPhase - previousPhase),
    Math.cos(lastPhase - previousPhase),
  );
  const phase = lastPhase + phaseStep * (harmonic - sourceHarmonicCount);
  return {
    sine: last.amplitude * Math.cos(phase),
    cosine: last.amplitude * Math.sin(phase),
    amplitude: last.amplitude,
  };
}

function linkedLocalAmplitude(
  input: readonly Float32Array[],
  f0: number,
  sampleRate: number,
  analysisStart: number,
  analysisSize: number,
  signal?: AbortSignal,
): Float32Array {
  const length = input[0]?.length ?? 0;
  const energy = new Float64Array(length);
  let referenceEnergy = 0;
  for (let frame = 0; frame < length; frame += 1) {
    if ((frame & 1_023) === 0) throwIfCancelled(signal);
    for (const channel of input) {
      energy[frame] = energy[frame]!
        + channel[frame]! ** 2 / input.length;
    }
    if (frame >= analysisStart && frame < analysisStart + analysisSize) {
      referenceEnergy += energy[frame]!;
    }
  }
  const referenceRms = Math.sqrt(referenceEnergy / analysisSize);
  const period = Math.max(16, Math.round(sampleRate / f0));
  const amplitude = new Float32Array(length);
  let runningEnergy = 0;
  for (let frame = 0; frame < length; frame += 1) {
    if ((frame & 1_023) === 0) throwIfCancelled(signal);
    runningEnergy += energy[frame]!;
    if (frame >= period) runningEnergy -= energy[frame - period]!;
    const localRms = Math.sqrt(
      Math.max(0, runningEnergy) / Math.min(period, frame + 1),
    );
    amplitude[frame] = referenceRms <= 1e-12 ? 0 : localRms / referenceRms;
  }
  return amplitude;
}

function estimateResynthesisFundamental(
  input: readonly Float32Array[],
  sampleRate: number,
  analyzedF0: number | null,
  signal?: AbortSignal,
): ResynthesisFundamental | null {
  const length = input[0]?.length ?? 0;
  const size = Math.min(length, 8_192);
  const start = Math.floor((length - size) / 2);
  const linked = new Float32Array(size);
  for (let frame = 0; frame < size; frame += 1) {
    for (const channel of input) {
      linked[frame] = linked[frame]! + channel[start + frame]! / input.length;
    }
  }
  const minimumLag = Math.max(1, Math.ceil(sampleRate / 400));
  const maximumLag = Math.min(Math.floor(sampleRate / 70), size - 1);
  const scores = new Float64Array(maximumLag + 1);
  let maximumScore = -1;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if ((lag & 31) === 0) throwIfCancelled(signal);
    let cross = 0;
    let left = 0;
    let right = 0;
    for (let frame = 0; frame + lag < size; frame += 1) {
      const a = linked[frame]!;
      const b = linked[frame + lag]!;
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    scores[lag] = cross / Math.sqrt(Math.max(1e-24, left * right));
    maximumScore = Math.max(maximumScore, scores[lag]!);
  }
  const analyzedOddEvidence = analyzedF0 === null
    ? null
    : oddHarmonicEvidence(
        input,
        analyzedF0,
        sampleRate,
        start,
        size,
        signal,
      );
  const allowAnalyzedMultiple = analyzedOddEvidence !== null
    && analyzedOddEvidence < FORMANT_ODD_HARMONIC_EVIDENCE_THRESHOLD;
  const candidates: Array<{ f0: number; coverage: number }> = [];
  for (let lag = minimumLag + 1; lag < maximumLag; lag += 1) {
    const candidateF0 = sampleRate / lag;
    const analyzedMultiple = analyzedF0 === null || !allowAnalyzedMultiple
      ? 1
      : Math.max(1, Math.min(4, Math.round(candidateF0 / analyzedF0)));
    const agreesWithAnalysis = analyzedF0 === null
      || Math.abs(1_200 * Math.log2(
        candidateF0 / (analyzedF0 * analyzedMultiple),
      )) <= 50;
    if (
      agreesWithAnalysis
      &&
      scores[lag]! >= maximumScore - 0.01
      && scores[lag]! > scores[lag - 1]!
      && scores[lag]! >= scores[lag + 1]!
    ) {
      const previous = scores[lag - 1]!;
      const center = scores[lag]!;
      const next = scores[lag + 1]!;
      const denominator = previous - 2 * center + next;
      const offset = Math.abs(denominator) < 1e-12
        ? 0
        : Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / denominator));
      const refinedF0 = sampleRate / (lag + offset);
      candidates.push({
        f0: refinedF0,
        coverage: harmonicCoverage(linked, refinedF0, sampleRate, signal),
      });
    }
  }
  const selected = candidates.sort((left, right) =>
    right.coverage - left.coverage || left.f0 - right.f0)[0];
  return selected === undefined
    ? null
    : {
        f0: selected.f0,
        sparseOddHarmonics: analyzedOddEvidence !== null
          && analyzedOddEvidence >= FORMANT_ODD_HARMONIC_EVIDENCE_THRESHOLD
          && analyzedOddEvidence < Math.sqrt(FORMANT_ODD_HARMONIC_EVIDENCE_THRESHOLD),
      };
}

function oddHarmonicEvidence(
  input: readonly Float32Array[],
  analyzedF0: number,
  sampleRate: number,
  start: number,
  size: number,
  signal?: AbortSignal,
): number {
  const coefficients = input.map((channel) =>
    measureHarmonicCoefficients(
      channel,
      analyzedF0,
      13,
      sampleRate,
      start,
      size,
      signal,
    ));
  const linkedAmplitudes = Array.from({ length: 13 }, (_, index) => {
    let energy = 0;
    for (const channel of coefficients) {
      energy += channel[index]!.amplitude ** 2 / coefficients.length;
    }
    return Math.sqrt(energy);
  });
  const ratios: number[] = [];
  for (let harmonic = 3; harmonic <= 11; harmonic += 2) {
    const lower = linkedAmplitudes[harmonic - 2]!;
    const odd = linkedAmplitudes[harmonic - 1]!;
    const upper = linkedAmplitudes[harmonic]!;
    ratios.push(odd / Math.sqrt(Math.max(1e-24, lower * upper)));
  }
  return ratios.sort((left, right) => left - right)[Math.floor(ratios.length / 2)]!;
}

function harmonicCoverage(
  linked: Float32Array,
  f0: number,
  sampleRate: number,
  signal?: AbortSignal,
): number {
  const harmonicCount = Math.min(12, Math.floor(5_000 / f0));
  const coefficients = measureHarmonicCoefficients(
    linked,
    f0,
    harmonicCount,
    sampleRate,
    0,
    linked.length,
    signal,
  );
  const peak = Math.max(...coefficients.map((coefficient) => coefficient.amplitude));
  if (peak <= 1e-12) return 0;
  return coefficients.reduce((count, coefficient) =>
    count + (coefficient.amplitude >= peak * 0.01 ? 1 : 0), 0)
    / harmonicCount;
}

function measureHarmonicCoefficients(
  channel: Float32Array,
  f0: number,
  harmonicCount: number,
  sampleRate: number,
  start: number,
  size: number,
  signal?: AbortSignal,
): HarmonicCoefficient[] {
  const result: HarmonicCoefficient[] = [];
  for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
    throwIfCancelled(signal);
    const phaseStep = 2 * Math.PI * harmonic * f0 / sampleRate;
    const stepCosine = Math.cos(phaseStep);
    const stepSine = Math.sin(phaseStep);
    let oscillatorCosine = Math.cos(phaseStep * start);
    let oscillatorSine = Math.sin(phaseStep * start);
    let real = 0;
    let imaginary = 0;
    let windowSum = 0;
    for (let local = 0; local < size; local += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (local + 0.5) / size);
      const sample = channel[start + local]! * window;
      real += sample * oscillatorCosine;
      imaginary -= sample * oscillatorSine;
      windowSum += window;
      const nextCosine = oscillatorCosine * stepCosine
        - oscillatorSine * stepSine;
      oscillatorSine = oscillatorCosine * stepSine
        + oscillatorSine * stepCosine;
      oscillatorCosine = nextCosine;
    }
    const sine = -2 * imaginary / windowSum;
    const cosine = 2 * real / windowSum;
    result.push({ sine, cosine, amplitude: Math.hypot(sine, cosine) });
  }
  return result;
}

function fitResonantEnvelope(
  samples: Float64Array,
  f0: number,
  signal?: AbortSignal,
): ResonanceModel | null {
  const peakIndices: number[] = [];
  for (let index = 1; index + 1 < samples.length; index += 1) {
    if (
      samples[index]! > samples[index - 1]!
      && samples[index]! > samples[index + 1]!
    ) peakIndices.push(index);
  }
  const resonanceCount = 3;
  const selected = peakIndices
    .sort((left, right) => samples[right]! - samples[left]!)
    .slice(0, resonanceCount)
    .sort((left, right) => left - right);
  if (selected.length < resonanceCount) return null;

  const sortedSamples = [...samples].sort((left, right) => left - right);
  const baseline = Math.max(
    1e-7,
    sortedSamples[Math.floor(sortedSamples.length * 0.2)]!,
  );
  const parameters = new Float64Array(1 + resonanceCount * 3);
  parameters[0] = Math.log(baseline);
  for (let resonance = 0; resonance < resonanceCount; resonance += 1) {
    const peak = selected[resonance]!;
    parameters[1 + resonance * 3] = (peak + 1) * f0;
    parameters[2 + resonance * 3] = Math.log(f0 / 3);
    parameters[3 + resonance * 3] = Math.log(
      Math.max(1e-7, samples[peak]! - baseline),
    );
  }
  const firstMoment = new Float64Array(parameters.length);
  const secondMoment = new Float64Array(parameters.length);
  for (let iteration = 1; iteration <= 2_000; iteration += 1) {
    if ((iteration & 63) === 0) throwIfCancelled(signal);
    const gradient = new Float64Array(parameters.length);
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const frequency = (sampleIndex + 1) * f0;
      const base = Math.exp(parameters[0]!);
      let model = base;
      const components: Array<{
        amplitude: number;
        distance: number;
        value: number;
        width: number;
      }> = [];
      for (let resonance = 0; resonance < resonanceCount; resonance += 1) {
        const offset = 1 + resonance * 3;
        const center = parameters[offset]!;
        const width = Math.exp(parameters[offset + 1]!);
        const amplitude = Math.exp(parameters[offset + 2]!);
        const distance = (frequency - center) / width;
        const value = amplitude / (1 + distance ** 2);
        components.push({ amplitude, distance, value, width });
        model += value;
      }
      const residual = Math.log(model)
        - Math.log(Math.max(1e-12, samples[sampleIndex]!));
      const common = 2 * residual / (model * samples.length);
      gradient[0] = gradient[0]! + common * base;
      for (let resonance = 0; resonance < resonanceCount; resonance += 1) {
        const offset = 1 + resonance * 3;
        const component = components[resonance]!;
        const denominator = 1 + component.distance ** 2;
        gradient[offset] = gradient[offset]! + common
          * component.amplitude * 2 * component.distance
          / (component.width * denominator ** 2);
        gradient[offset + 1] = gradient[offset + 1]! + common
          * component.amplitude * 2 * component.distance ** 2
          / denominator ** 2;
        gradient[offset + 2] = gradient[offset + 2]!
          + common * component.value;
      }
    }
    for (let index = 0; index < parameters.length; index += 1) {
      firstMoment[index] = 0.9 * firstMoment[index]! + 0.1 * gradient[index]!;
      secondMoment[index] = 0.999 * secondMoment[index]!
        + 0.001 * gradient[index]! ** 2;
      const correctedFirst = firstMoment[index]! / (1 - 0.9 ** iteration);
      const correctedSecond = secondMoment[index]! / (1 - 0.999 ** iteration);
      parameters[index] = parameters[index]!
        - 0.05 * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8);
      if (!Number.isFinite(parameters[index])) return null;
    }
    for (let resonance = 0; resonance < resonanceCount; resonance += 1) {
      const offset = 1 + resonance * 3;
      parameters[offset] = Math.max(
        80,
        Math.min(4_900, parameters[offset]!),
      );
      parameters[offset + 1] = Math.max(
        Math.log(10),
        Math.min(Math.log(800), parameters[offset + 1]!),
      );
      parameters[offset + 2] = Math.max(
        Math.log(1e-7),
        Math.min(Math.log(10), parameters[offset + 2]!),
      );
    }
  }
  const model = { parameters, resonanceCount };
  let squaredLogError = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const predicted = evaluateResonantEnvelope(model, (index + 1) * f0);
    const error = Math.log(Math.max(1e-12, predicted))
      - Math.log(Math.max(1e-12, samples[index]!));
    squaredLogError += error ** 2;
  }
  return Math.sqrt(squaredLogError / samples.length) <= 0.04
    ? model
    : null;
}

function evaluateResonantEnvelope(
  model: ResonanceModel,
  frequency: number,
): number {
  let value = Math.exp(model.parameters[0]!);
  for (let resonance = 0; resonance < model.resonanceCount; resonance += 1) {
    const offset = 1 + resonance * 3;
    const center = model.parameters[offset]!;
    const width = Math.exp(model.parameters[offset + 1]!);
    const amplitude = Math.exp(model.parameters[offset + 2]!);
    value += amplitude / (1 + ((frequency - center) / width) ** 2);
  }
  return value;
}

function matchFormantLevel(
  dry: readonly Float32Array[],
  wet: readonly Float32Array[],
  signal?: AbortSignal,
): void {
  const length = wet[0]?.length ?? 0;
  const size = Math.min(4_096, length);
  const start = Math.floor((length - size) / 2);
  let dryEnergy = 0;
  let wetEnergy = 0;
  for (let frame = start; frame < start + size; frame += 1) {
    for (let channel = 0; channel < wet.length; channel += 1) {
      dryEnergy += dry[channel]![frame]! ** 2;
      wetEnergy += wet[channel]![frame]! ** 2;
    }
  }
  if (dryEnergy <= 0 || wetEnergy <= 1e-24) return;
  const gain = Math.sqrt(dryEnergy / wetEnergy);
  for (const channel of wet) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      throwIfCancelled(signal);
      channel[frame] = channel[frame]! * gain;
    }
  }
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
    const error = new AudioWarpDspError('cancelled', 'Elastic Audio render was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
