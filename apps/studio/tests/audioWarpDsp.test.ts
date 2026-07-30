import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeAudioWarpFormants,
  bandLimitedResample,
  evaluateAudioWarpFormantGates,
  FORMANT_RELEASE_LIMITATION,
  preserveFormants,
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
    algorithmVersion: 'wsola-v1/dsp-2',
    formantMode: 'off' as const,
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

function checksum(channel: Float32Array): string {
  return createHash('sha256')
    .update(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength))
    .digest('hex');
}

function deterministicNoise(frames: number, scale = 0.4): Float32Array {
  let state = 0x1234_5678;
  return Float32Array.from({ length: frames }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffff_ffff * 2 - 1) * scale;
  });
}

function exactRequest(
  sourceFrames: number,
  targetSampleRate: number,
  cents: number,
  formantMode: 'off' | 'preserve',
  channelCount: 1 | 2 = 1,
): AudioWarpRenderRequest {
  const targetFrames = Math.round(sourceFrames * targetSampleRate / 48_000);
  return {
    algorithmVersion: 'wsola-v1/dsp-2',
    formantMode,
    assetId: 'asset',
    checksumSha256: 'b'.repeat(64),
    sourceSampleRate: 48_000,
    sourceStartFrame: 0,
    sourceFrameCount: sourceFrames,
    sourceStartIndex: 0,
    sourceFrameCountAtTargetRate: targetFrames,
    targetSampleRate,
    channelCount,
    outputFrameCount: targetFrames,
    knots: [
      { sourceFrame: 0, sourceIndex: 0, outputFrame: 0 },
      { sourceFrame: sourceFrames, sourceIndex: targetFrames, outputFrame: targetFrames },
    ],
    pitchRegions: cents === 0 ? [] : [{
      sourceStartFrame: 0,
      sourceFrameCount: sourceFrames,
      sourcePitchCents: 6_900,
      targetPitchCents: 6_900 + cents,
      correctionAmount: 1,
      transitionFrames: 0,
      sourceStartIndex: 0,
      sourceFrameCountAtTargetRate: targetFrames,
      transitionFramesAtTargetRate: 0,
      cents,
    }],
    cacheKey: `exact:${sourceFrames}:${targetSampleRate}:${cents}:${formantMode}:${channelCount}`,
  };
}

function nextPositiveFloat(value: number, direction: -1 | 1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, direction < 0 ? bits - 1n : bits + 1n);
  return view.getFloat64(0);
}

type VoiceSpec = Readonly<{
  f0: number;
  formants: readonly [number, number, number];
  bandwidths: readonly [number, number, number];
}>;

const VOICE_SPECS: readonly VoiceSpec[] = [
  { f0: 140, formants: [700, 1_220, 2_500], bandwidths: [90, 120, 180] },
  { f0: 210, formants: [550, 1_850, 2_850], bandwidths: [80, 140, 200] },
];

function generatedVoice(
  spec: VoiceSpec,
  f0: number,
  seed: number,
  sampleRate: number,
  frames: number,
): Float32Array {
  const result = new Float32Array(frames);
  const harmonicCount = Math.floor(
    Math.min(5_000, sampleRate / 2 - 100) / f0,
  );
  for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
    const frequency = harmonic * f0;
    const resonance = spec.formants.reduce((sum, formant, index) => {
      const halfBandwidth = spec.bandwidths[index]! / 2;
      return sum + 1 / (1 + ((frequency - formant) / halfBandwidth) ** 2);
    }, 0.2);
    const amplitude = resonance / harmonic;
    const phase = 2 * Math.PI * (
      Math.sin((harmonic + 17) * 12.9898) * 43_758.5453 % 1
    ) + seed * Math.PI / 64;
    for (let frame = 0; frame < frames; frame += 1) {
      result[frame] = result[frame]!
        + amplitude * Math.sin(2 * Math.PI * frequency * frame / sampleRate + phase);
    }
  }
  let peak = 0;
  for (const sample of result) peak = Math.max(peak, Math.abs(sample));
  const edge = Math.min(
    Math.round(512 * sampleRate / 48_000),
    Math.floor(frames / 4),
  );
  for (let frame = 0; frame < frames; frame += 1) {
    const fade = frame < edge
      ? 0.5 - 0.5 * Math.cos(Math.PI * frame / edge)
      : frame >= frames - edge
        ? 0.5 - 0.5 * Math.cos(Math.PI * (frames - 1 - frame) / edge)
        : 1;
    result[frame] = result[frame]! / Math.max(peak, 1e-12) * 0.7 * fade;
  }
  return result;
}

function generatedEnvelopeVoice(
  f0: number,
  seed: number,
  sampleRate: number,
  frames: number,
  envelopeAt: (frequency: number, harmonic: number) => number,
  phaseOffsetAt: (harmonic: number) => number = () => 0,
): Float32Array {
  const result = new Float32Array(frames);
  const harmonicCount = Math.floor(
    Math.min(5_000, sampleRate / 2 - 100) / f0,
  );
  for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
    const frequency = harmonic * f0;
    const amplitude = envelopeAt(frequency, harmonic);
    const phase = 2 * Math.PI * (
      Math.sin((harmonic + 17) * 12.9898) * 43_758.5453 % 1
    ) + seed * Math.PI / 64 + phaseOffsetAt(harmonic);
    for (let frame = 0; frame < frames; frame += 1) {
      result[frame] = result[frame]!
        + amplitude * Math.sin(2 * Math.PI * frequency * frame / sampleRate + phase);
    }
  }
  let peak = 0;
  for (const sample of result) peak = Math.max(peak, Math.abs(sample));
  const edge = Math.min(
    Math.round(512 * sampleRate / 48_000),
    Math.floor(frames / 4),
  );
  for (let frame = 0; frame < frames; frame += 1) {
    const fade = frame < edge
      ? 0.5 - 0.5 * Math.cos(Math.PI * frame / edge)
      : frame >= frames - edge
        ? 0.5 - 0.5 * Math.cos(Math.PI * (frames - 1 - frame) / edge)
        : 1;
    result[frame] = result[frame]! / Math.max(peak, 1e-12) * 0.7 * fade;
  }
  return result;
}

function canonicalVoice(spec: VoiceSpec, seed: number, frames = 24_000): Float32Array {
  return generatedVoice(spec, spec.f0, seed, 48_000, frames);
}

function estimateF0TestOwned(channel: Float32Array, sampleRate: number, expected: number): number {
  const start = Math.max(0, Math.floor((channel.length - 8_192) / 2));
  const frame = channel.subarray(start, Math.min(channel.length, start + 8_192));
  const minFrequency = expected / 2 ** (100 / 1200);
  const maxFrequency = expected * 2 ** (100 / 1200);
  const minLag = Math.floor(sampleRate / maxFrequency);
  const maxLag = Math.ceil(sampleRate / minFrequency);
  const scores = new Map<number, number>();
  for (let lag = minLag - 1; lag <= maxLag + 1; lag += 1) {
    let cross = 0;
    let left = 0;
    let right = 0;
    for (let index = 0; index + lag < frame.length; index += 1) {
      const a = frame[index]!;
      const b = frame[index + lag]!;
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    scores.set(lag, cross / Math.sqrt(Math.max(1e-24, left * right)));
  }
  let lag = minLag;
  for (let candidate = minLag + 1; candidate <= maxLag; candidate += 1) {
    if (scores.get(candidate)! > scores.get(lag)!) lag = candidate;
  }
  const previous = scores.get(lag - 1)!;
  const center = scores.get(lag)!;
  const next = scores.get(lag + 1)!;
  const denominator = previous - 2 * center + next;
  const offset = Math.abs(denominator) < 1e-12
    ? 0
    : Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / denominator));
  return sampleRate / (lag + offset);
}

function directComplexDftTestOwned(
  channel: Float32Array,
  sampleRate: number,
  frequency: number,
  start = Math.max(0, Math.floor((channel.length - 8_192) / 2)),
  size = Math.min(8_192, channel.length - start),
): Readonly<{ real: number; imaginary: number; amplitude: number; phase: number }> {
  const phaseStep = 2 * Math.PI * frequency / sampleRate;
  const stepReal = Math.cos(phaseStep);
  const stepImaginary = -Math.sin(phaseStep);
  let oscillatorReal = Math.cos(phaseStep * start);
  let oscillatorImaginary = -Math.sin(phaseStep * start);
  let real = 0;
  let imaginary = 0;
  let windowSum = 0;
  for (let index = 0; index < size; index += 1) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / size);
    const sample = channel[start + index]! * window;
    real += sample * oscillatorReal;
    imaginary += sample * oscillatorImaginary;
    windowSum += window;
    const nextReal = oscillatorReal * stepReal
      - oscillatorImaginary * stepImaginary;
    oscillatorImaginary = oscillatorReal * stepImaginary
      + oscillatorImaginary * stepReal;
    oscillatorReal = nextReal;
  }
  real = 2 * real / windowSum;
  imaginary = 2 * imaginary / windowSum;
  return {
    real,
    imaginary,
    amplitude: Math.hypot(real, imaginary),
    phase: Math.atan2(imaginary, real),
  };
}

function oddHarmonicEvidenceTestOwned(
  channel: Float32Array,
  sampleRate: number,
  analyzedF0: number,
): number {
  const amplitudes = Array.from({ length: 13 }, (_, index) =>
    directComplexDftTestOwned(
      channel,
      sampleRate,
      (index + 1) * analyzedF0,
    ).amplitude);
  const ratios: number[] = [];
  for (let harmonic = 3; harmonic <= 11; harmonic += 2) {
    ratios.push(amplitudes[harmonic - 1]! / Math.sqrt(Math.max(
      1e-24,
      amplitudes[harmonic - 2]! * amplitudes[harmonic]!,
    )));
  }
  return [...ratios].sort((left, right) => left - right)[Math.floor(ratios.length / 2)]!;
}

function wrappedPhaseDifference(left: number, right: number): number {
  return Math.atan2(Math.sin(left - right), Math.cos(left - right));
}

function fftTestOwned(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const fftSize = real.length;
  for (let index = 1, reversed = 0; index < fftSize; index += 1) {
    let bit = fftSize >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed]!, real[index]!];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed]!, imaginary[index]!];
    }
  }
  for (let width = 2; width <= fftSize; width <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / width;
    for (let offset = 0; offset < fftSize; offset += width) {
      for (let index = 0; index < width / 2; index += 1) {
        const phase = angle * index;
        const odd = offset + index + width / 2;
        const even = offset + index;
        const oddReal = real[odd]! * Math.cos(phase) - imaginary[odd]! * Math.sin(phase);
        const oddImaginary = real[odd]! * Math.sin(phase) + imaginary[odd]! * Math.cos(phase);
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < fftSize; index += 1) {
      real[index] = real[index]! / fftSize;
      imaginary[index] = imaginary[index]! / fftSize;
    }
  }
}

type HarmonicDftPoint = Readonly<{
  harmonic: number;
  frequency: number;
  amplitude: number;
  power: number;
}>;

function directTargetHarmonicDft(
  channel: Float32Array,
  sampleRate: number,
  targetF0: number,
): HarmonicDftPoint[] {
  const size = Math.min(4_096, channel.length);
  const start = Math.floor((channel.length - size) / 2);
  const minimumHarmonic = Math.max(1, Math.ceil(100 / targetF0));
  const maximumHarmonic = Math.floor(
    Math.min(5_000, sampleRate / 2 - 100) / targetF0,
  );
  const points: HarmonicDftPoint[] = [];
  for (
    let harmonic = minimumHarmonic;
    harmonic <= maximumHarmonic;
    harmonic += 1
  ) {
    const frequency = harmonic * targetF0;
    const phaseStep = 2 * Math.PI * frequency / sampleRate;
    const stepReal = Math.cos(phaseStep);
    const stepImaginary = -Math.sin(phaseStep);
    let oscillatorReal = 1;
    let oscillatorImaginary = 0;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < size; index += 1) {
      const sample = channel[start + index]!;
      real += sample * oscillatorReal;
      imaginary += sample * oscillatorImaginary;
      const nextReal = oscillatorReal * stepReal
        - oscillatorImaginary * stepImaginary;
      oscillatorImaginary = oscillatorReal * stepImaginary
        + oscillatorImaginary * stepReal;
      oscillatorReal = nextReal;
    }
    const amplitude = 2 * Math.hypot(real, imaginary) / size;
    points.push({
      harmonic,
      frequency,
      amplitude,
      power: amplitude * amplitude,
    });
  }
  return points;
}

function centeredHarmonicEnvelopeRms(
  ideal: readonly HarmonicDftPoint[],
  candidate: readonly HarmonicDftPoint[],
): number {
  expect(candidate.map((point) => point.harmonic))
    .toEqual(ideal.map((point) => point.harmonic));
  const differences = ideal.map((point, index) => {
    const idealDb = 20 * Math.log10(Math.max(1e-12, point.amplitude));
    const candidateDb = 20 * Math.log10(
      Math.max(1e-12, candidate[index]!.amplitude),
    );
    return candidateDb - idealDb;
  });
  const mean = differences.reduce((sum, value) => sum + value, 0)
    / differences.length;
  return Math.sqrt(
    differences.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) / differences.length,
  );
}

function formantEnergyCentroid(
  points: readonly HarmonicDftPoint[],
  formant: number,
): number {
  const band = points.filter((point) =>
    point.frequency >= formant * 0.5 && point.frequency <= formant * 2);
  if (band.length < 3) {
    throw new Error(`formant ${formant} has fewer than three target harmonics`);
  }
  const minimumPower = Math.min(...band.map((point) => point.power));
  let weightedFrequency = 0;
  let weightSum = 0;
  for (const point of band) {
    const weight = point.power - minimumPower;
    weightedFrequency += point.frequency * weight;
    weightSum += weight;
  }
  if (weightSum <= 1e-24) {
    throw new Error(`formant ${formant} has no band-minimum-subtracted energy`);
  }
  return weightedFrequency / weightSum;
}

function centerRms(channel: Float32Array): number {
  const size = Math.min(4_096, channel.length);
  const start = Math.floor((channel.length - size) / 2);
  let sum = 0;
  for (let index = start; index < start + size; index += 1) sum += channel[index]! ** 2;
  return Math.sqrt(sum / size);
}

function intervalRms(channel: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += channel[index]! ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
}

function matchFormantLevelReference(
  dry: readonly Float32Array[],
  wet: readonly Float32Array[],
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
  const gain = Math.sqrt(dryEnergy / wetEnergy);
  for (const channel of wet) {
    for (let frame = 0; frame < length; frame += 1) {
      channel[frame] = channel[frame]! * gain;
    }
  }
}

function centsBetween(actual: number, expected: number): number {
  return Math.abs(1_200 * Math.log2(actual / expected));
}

const REFERENCE_FORMANT_FFT_SIZE = 2_048;
const REFERENCE_FORMANT_HOP_SIZE = 1_024;

type ReferenceFormantFrameMetric = Readonly<{
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

type ReferenceFormantAnalysis = Readonly<{
  active: boolean;
  reason:
    | 'unsupported-rate'
    | 'too-short/too-few-periods'
    | 'insufficient-energy'
    | 'anti-phase'
    | 'flat/unvoiced'
    | 'ambiguous'
    | null;
  linkedRms: number;
  midToLinkedEnergyRatio: number;
  periodicity: number;
  spectralFlatness: number;
  ambiguityRatio: number;
  estimatedF0: number | null;
  usefulSamples: number;
  usefulPeriodCount: number;
  stableVoiced: boolean;
  frames: readonly ReferenceFormantFrameMetric[];
}>;

function fallbackFrameStartsReference(length: number): number[] {
  if (length < REFERENCE_FORMANT_FFT_SIZE) return [0];
  const starts: number[] = [];
  for (
    let start = 0;
    start + REFERENCE_FORMANT_FFT_SIZE <= length;
    start += REFERENCE_FORMANT_HOP_SIZE
  ) starts.push(start);
  const tail = length - REFERENCE_FORMANT_FFT_SIZE;
  if (starts.at(-1) !== tail) starts.push(tail);
  return starts;
}

function fallbackFrameMetricReference(
  channels: readonly Float32Array[],
  start: number,
  sampleRate: number,
): ReferenceFormantFrameMetric {
  const length = channels[0]!.length;
  const actualStart = Math.max(0, start);
  const actualEnd = Math.min(length, start + REFERENCE_FORMANT_FFT_SIZE);
  const real = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
  const imaginary = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
  let energy = 0;
  for (let local = 0; local < REFERENCE_FORMANT_FFT_SIZE; local += 1) {
    const sourceFrame = start + local;
    if (sourceFrame < 0 || sourceFrame >= length) continue;
    let mid = 0;
    for (const channel of channels) {
      const value = channel[sourceFrame]!;
      energy += value * value / channels.length;
      mid += value;
    }
    mid /= channels.length;
    const hann = 0.5 - 0.5 * Math.cos(
      2 * Math.PI * (local + 0.5) / REFERENCE_FORMANT_FFT_SIZE,
    );
    real[local] = mid * hann;
  }
  fftTestOwned(real, imaginary, false);
  const firstBin = Math.max(
    1,
    Math.ceil(70 * REFERENCE_FORMANT_FFT_SIZE / sampleRate),
  );
  const lastBin = Math.min(
    REFERENCE_FORMANT_FFT_SIZE / 2 - 1,
    Math.floor(5_000 * REFERENCE_FORMANT_FFT_SIZE / sampleRate),
  );
  let logPowerSum = 0;
  let powerSum = 0;
  let bins = 0;
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const power = real[bin]! ** 2 + imaginary[bin]! ** 2;
    logPowerSum += Math.log(Math.max(power, 1e-14));
    powerSum += power;
    bins += 1;
  }
  const flatness = powerSum <= 0 || bins === 0
    ? 1
    : Math.exp(logPowerSum / bins) / (powerSum / bins);

  const mid = new Float64Array(actualEnd - actualStart);
  for (let index = 0; index < mid.length; index += 1) {
    const sourceFrame = actualStart + index;
    for (const channel of channels) {
      mid[index] = mid[index]! + channel[sourceFrame]! / channels.length;
    }
  }
  const minLag = Math.max(1, Math.ceil(sampleRate / 400));
  const maxLag = Math.min(Math.floor(sampleRate / 70), mid.length - 1);
  const scores: Array<{ lag: number; score: number }> = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const pairs = mid.length - lag;
    if (pairs < 2 * lag) continue;
    let cross = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < pairs; index += 1) {
      const left = mid[index]!;
      const right = mid[index + lag]!;
      cross += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    scores.push({
      lag,
      score: cross / Math.sqrt(Math.max(1e-24, leftEnergy * rightEnergy)),
    });
  }
  const scoreByLag = new Map(scores.map((candidate) => [candidate.lag, candidate.score]));
  const primary = [...scores].sort((left, right) => right.score - left.score)[0];
  if (primary === undefined) {
    return {
      start,
      actualStart,
      actualEnd,
      energy,
      periodicity: 0,
      flatness,
      ambiguity: 1,
      f0: null,
      useful: false,
    };
  }
  const previous = scoreByLag.get(primary.lag - 1) ?? primary.score;
  const next = scoreByLag.get(primary.lag + 1) ?? primary.score;
  const denominator = previous - 2 * primary.score + next;
  const offset = Math.abs(denominator) < 1e-12
    ? 0
    : Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / denominator));
  const f0 = sampleRate / (primary.lag + offset);
  const harmonicRatios = [0.25, 1 / 3, 0.5, 1, 2, 3, 4];
  const minimumRunnerLagDistance = Math.max(2, Math.round(0.15 * primary.lag));
  const runnerUp = scores
    .filter((candidate) => {
      const previousScore = scoreByLag.get(candidate.lag - 1);
      const nextScore = scoreByLag.get(candidate.lag + 1);
      if (
        previousScore === undefined
        || nextScore === undefined
        || candidate.score <= previousScore
        || candidate.score <= nextScore
        || Math.abs(candidate.lag - primary.lag) < minimumRunnerLagDistance
      ) return false;
      const candidateF0 = sampleRate / candidate.lag;
      return harmonicRatios.every((ratio) =>
        Math.abs(1_200 * Math.log2(candidateF0 / (f0 * ratio))) > 50);
    })
    .sort((left, right) => right.score - left.score)[0];
  const ambiguity = primary.score <= 0
    ? 1
    : Math.max(0, runnerUp?.score ?? 0) / primary.score;
  const useful = primary.score >= 0.60 && flatness <= 0.35 && ambiguity <= 0.85;
  return {
    start,
    actualStart,
    actualEnd,
    energy,
    periodicity: primary.score,
    flatness,
    ambiguity,
    f0,
    useful,
  };
}

function weightedMedianReference(
  frames: readonly ReferenceFormantFrameMetric[],
  value: (frame: ReferenceFormantFrameMetric) => number,
): number | null {
  if (frames.length === 0) return null;
  const sorted = [...frames].sort((left, right) => value(left) - value(right));
  const totalEnergy = sorted.reduce((sum, frame) => sum + frame.energy, 0);
  let accumulated = 0;
  for (const frame of sorted) {
    accumulated += frame.energy;
    if (accumulated >= totalEnergy / 2) return value(frame);
  }
  return value(sorted.at(-1)!);
}

function usefulHopUnionReference(
  frames: readonly ReferenceFormantFrameMetric[],
  length: number,
): number {
  const intervals = frames
    .map((frame) => [
      Math.max(0, frame.start),
      Math.min(length, frame.start + REFERENCE_FORMANT_HOP_SIZE),
    ] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let union = 0;
  let previousEnd = 0;
  for (const [start, end] of intervals) {
    if (end <= previousEnd) continue;
    union += end - Math.max(start, previousEnd);
    previousEnd = end;
  }
  return union;
}

type ReferenceGateInput = Readonly<{
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

function fallbackGateReference(input: ReferenceGateInput): Pick<
  ReferenceFormantAnalysis,
  'active' | 'reason' | 'stableVoiced' | 'usefulPeriodCount'
> {
  if (!input.supported) {
    return {
      active: false,
      reason: 'unsupported-rate',
      stableVoiced: false,
      usefulPeriodCount: 0,
    };
  }
  const stableVoiced = input.aggregateF0 !== null
    && input.periodicity >= 0.60
    && input.spectralFlatness <= 0.35
    && input.ambiguityRatio <= 0.85
    && input.usefulEnergy >= input.nonSilentEnergy * 0.60;
  const usefulPeriodCount = input.estimatedF0 === null
    ? 0
    : input.usefulSamples * input.estimatedF0 / input.sampleRate;
  const tooShortApplies = stableVoiced
    && input.linkedRms >= 1e-4
    && input.midToLinkedEnergyRatio >= 1e-4
    && (
      input.availableSamples < REFERENCE_FORMANT_FFT_SIZE
      || usefulPeriodCount < 8
    );
  let reason: ReferenceFormantAnalysis['reason'] = null;
  if (tooShortApplies) reason = 'too-short/too-few-periods';
  else if (input.linkedRms < 1e-4) reason = 'insufficient-energy';
  else if (input.midToLinkedEnergyRatio < 1e-4) reason = 'anti-phase';
  else if (
    !stableVoiced
    && (input.periodicity < 0.60 || input.spectralFlatness > 0.35)
  ) reason = 'flat/unvoiced';
  else if (!stableVoiced || input.ambiguityRatio > 0.85) reason = 'ambiguous';
  return {
    active: reason === null,
    reason,
    stableVoiced,
    usefulPeriodCount,
  };
}

function expectProductionGateToMatchReference(
  input: ReferenceGateInput,
): ReturnType<typeof fallbackGateReference> {
  const reference = fallbackGateReference(input);
  const production = evaluateAudioWarpFormantGates(input);
  expect(production).toEqual(reference);
  return reference;
}

function analyzeFormantsReference(
  channels: readonly Float32Array[],
  sampleRate: number,
): ReferenceFormantAnalysis {
  const length = channels[0]?.length ?? 0;
  if (
    (sampleRate !== 44_100 && sampleRate !== 48_000)
    || channels.length < 1
    || channels.length > 2
    || channels.some((channel) => channel.length !== length)
  ) {
    return {
      active: false,
      reason: 'unsupported-rate',
      linkedRms: 0,
      midToLinkedEnergyRatio: 0,
      periodicity: 0,
      spectralFlatness: 1,
      ambiguityRatio: 1,
      estimatedF0: null,
      usefulSamples: 0,
      usefulPeriodCount: 0,
      stableVoiced: false,
      frames: [],
    };
  }
  let linkedEnergy = 0;
  let midEnergy = 0;
  for (let frame = 0; frame < length; frame += 1) {
    let mid = 0;
    for (const channel of channels) {
      const value = channel[frame]!;
      linkedEnergy += value * value;
      mid += value;
    }
    mid /= channels.length;
    midEnergy += mid * mid;
  }
  const linkedRms = length === 0
    ? 0
    : Math.sqrt(linkedEnergy / (length * channels.length));
  const midToLinkedEnergyRatio = linkedEnergy === 0
    ? 0
    : midEnergy * channels.length / linkedEnergy;
  const frames = fallbackFrameStartsReference(length).map((start) =>
    fallbackFrameMetricReference(channels, start, sampleRate));
  const nonSilent = frames.filter((frame) => frame.energy > 1e-12);
  const periodicity = weightedMedianReference(nonSilent, (frame) => frame.periodicity) ?? 0;
  const spectralFlatness = weightedMedianReference(nonSilent, (frame) => frame.flatness) ?? 0;
  const ambiguityRatio = weightedMedianReference(nonSilent, (frame) => frame.ambiguity) ?? 0;
  const aggregateF0 = weightedMedianReference(
    nonSilent.filter((frame) => frame.f0 !== null),
    (frame) => frame.f0!,
  );
  const usefulNearF0 = aggregateF0 === null
    ? []
    : nonSilent.filter((frame) =>
        frame.useful
        && frame.f0 !== null
        && Math.abs(1_200 * Math.log2(frame.f0 / aggregateF0)) <= 50);
  const nonSilentEnergy = nonSilent.reduce((sum, frame) => sum + frame.energy, 0);
  const usefulEnergy = usefulNearF0.reduce((sum, frame) => sum + frame.energy, 0);
  const estimatedF0 = weightedMedianReference(usefulNearF0, (frame) => frame.f0!);
  const usefulSamples = length < REFERENCE_FORMANT_FFT_SIZE
    ? length
    : usefulHopUnionReference(usefulNearF0, length);
  const gate = fallbackGateReference({
    supported: true,
    availableSamples: length,
    sampleRate,
    linkedRms,
    midToLinkedEnergyRatio,
    periodicity,
    spectralFlatness,
    ambiguityRatio,
    aggregateF0,
    estimatedF0,
    usefulSamples,
    usefulEnergy,
    nonSilentEnergy,
  });
  return {
    ...gate,
    linkedRms,
    midToLinkedEnergyRatio,
    periodicity,
    spectralFlatness,
    ambiguityRatio,
    estimatedF0,
    usefulSamples,
    frames,
  };
}

function expectProductionAnalysisToMatchReference(
  channels: readonly Float32Array[],
  sampleRate: number,
  label: string,
): ReferenceFormantAnalysis {
  const reference = analyzeFormantsReference(channels, sampleRate);
  const production = analyzeAudioWarpFormants(channels, sampleRate);
  expect(production.active, `${label}:active`).toBe(reference.active);
  expect(production.reason, `${label}:reason`).toBe(reference.reason);
  expect(production.linkedRms, `${label}:linked-rms`)
    .toBeCloseTo(reference.linkedRms, 12);
  expect(production.midToLinkedEnergyRatio, `${label}:mid-linked-ratio`)
    .toBeCloseTo(reference.midToLinkedEnergyRatio, 12);
  expect(production.periodicity, `${label}:periodicity`)
    .toBeCloseTo(reference.periodicity, 12);
  expect(production.spectralFlatness, `${label}:flatness`)
    .toBeCloseTo(reference.spectralFlatness, 12);
  expect(production.ambiguityRatio, `${label}:ambiguity`)
    .toBeCloseTo(reference.ambiguityRatio, 12);
  expect(production.estimatedF0, `${label}:estimated-f0`)
    .toEqual(reference.estimatedF0);
  expect(production.usefulSamples, `${label}:useful-samples`)
    .toBe(reference.usefulSamples);
  expect(production.usefulPeriodCount, `${label}:useful-periods`)
    .toBeCloseTo(reference.usefulPeriodCount, 12);
  return reference;
}

type PreserveReferenceCheckpoint = Readonly<{
  start: number;
  bin: number;
  dryMagnitude: number;
  wetMagnitude: number;
  dryLogMagnitude: number;
  wetLogMagnitude: number;
  dryEnvelope: number;
  wetEnvelope: number;
  gain: number;
}>;

function preserveFrameStartsReference(length: number): number[] {
  const starts: number[] = [];
  for (
    let start = -REFERENCE_FORMANT_FFT_SIZE / 2;
    start < length + REFERENCE_FORMANT_FFT_SIZE / 2;
    start += REFERENCE_FORMANT_HOP_SIZE
  ) starts.push(start);
  return starts;
}

function sqrtHannReference(): Float32Array {
  return Float32Array.from(
    { length: REFERENCE_FORMANT_FFT_SIZE },
    (_, index) => Math.sqrt(
      0.5 - 0.5 * Math.cos(
        2 * Math.PI * (index + 0.5) / REFERENCE_FORMANT_FFT_SIZE,
      ),
    ),
  );
}

function linkedMagnitudeReference(
  channels: readonly Float32Array[],
  start: number,
  window: Float32Array,
): Float64Array {
  const magnitude = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
  for (const channel of channels) {
    const real = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
    const imaginary = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
    for (let local = 0; local < REFERENCE_FORMANT_FFT_SIZE; local += 1) {
      const sourceFrame = start + local;
      if (sourceFrame >= 0 && sourceFrame < channel.length) {
        real[local] = channel[sourceFrame]! * window[local]!;
      }
    }
    fftTestOwned(real, imaginary, false);
    for (let bin = 0; bin < REFERENCE_FORMANT_FFT_SIZE; bin += 1) {
      magnitude[bin] = magnitude[bin]!
        + (real[bin]! ** 2 + imaginary[bin]! ** 2) / channels.length;
    }
  }
  for (let bin = 0; bin < REFERENCE_FORMANT_FFT_SIZE; bin += 1) {
    magnitude[bin] = Math.sqrt(magnitude[bin]!);
  }
  return magnitude;
}

function cepstralEnvelopeReference(
  magnitude: Float64Array,
  sampleRate: number,
): {
  logMagnitude: Float64Array;
  cepstrum: Float64Array;
  lifteredCepstrum: Float64Array;
  envelope: Float64Array;
} {
  const logMagnitude = Float64Array.from(
    magnitude,
    (value) => Math.log(Math.max(value, 1e-7)),
  );
  const cepstrum = logMagnitude.slice();
  const imaginary = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
  fftTestOwned(cepstrum, imaginary, true);
  const lifteredCepstrum = cepstrum.slice();
  const q = Math.round(0.0015 * sampleRate);
  for (
    let index = q + 1;
    index < REFERENCE_FORMANT_FFT_SIZE - q;
    index += 1
  ) lifteredCepstrum[index] = 0;
  const envelope = lifteredCepstrum.slice();
  fftTestOwned(envelope, new Float64Array(REFERENCE_FORMANT_FFT_SIZE), false);
  return { logMagnitude, cepstrum, lifteredCepstrum, envelope };
}

function normalizedWetSampleReference(
  accumulated: number,
  denominator: number,
  wet: number,
): number {
  return denominator < 1e-12 ? wet : accumulated / denominator;
}

function preserveFormantsReference(
  dry: readonly Float32Array[],
  sourceWet: readonly Float32Array[],
  sampleRate: number,
): Readonly<{
  output: readonly Float32Array[];
  starts: readonly number[];
  normalization: Float32Array;
  checkpoint: PreserveReferenceCheckpoint;
}> {
  const wet = sourceWet.map((channel) => channel.slice());
  const length = wet[0]?.length ?? 0;
  const starts = preserveFrameStartsReference(length);
  const window = sqrtHannReference();
  const accumulated = wet.map(() => new Float32Array(length));
  const normalization = new Float32Array(length);
  const clampLog = 12 * Math.LN10 / 20;
  let checkpoint: PreserveReferenceCheckpoint | undefined;
  for (const start of starts) {
    const dryMagnitude = linkedMagnitudeReference(dry, start, window);
    const wetMagnitude = linkedMagnitudeReference(wet, start, window);
    const dryCepstrum = cepstralEnvelopeReference(dryMagnitude, sampleRate);
    const wetCepstrum = cepstralEnvelopeReference(wetMagnitude, sampleRate);
    const gain = Float32Array.from(
      dryCepstrum.envelope,
      (dryEnvelope, bin) => Math.exp(Math.max(
        -clampLog,
        Math.min(clampLog, dryEnvelope - wetCepstrum.envelope[bin]!),
      )),
    );
    const checkpointBin = 37;
    if (start === 0) {
      checkpoint = {
        start,
        bin: checkpointBin,
        dryMagnitude: dryMagnitude[checkpointBin]!,
        wetMagnitude: wetMagnitude[checkpointBin]!,
        dryLogMagnitude: dryCepstrum.logMagnitude[checkpointBin]!,
        wetLogMagnitude: wetCepstrum.logMagnitude[checkpointBin]!,
        dryEnvelope: dryCepstrum.envelope[checkpointBin]!,
        wetEnvelope: wetCepstrum.envelope[checkpointBin]!,
        gain: gain[checkpointBin]!,
      };
    }
    for (let channel = 0; channel < wet.length; channel += 1) {
      const real = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
      const imaginary = new Float64Array(REFERENCE_FORMANT_FFT_SIZE);
      for (let local = 0; local < REFERENCE_FORMANT_FFT_SIZE; local += 1) {
        const sourceFrame = start + local;
        if (sourceFrame >= 0 && sourceFrame < length) {
          real[local] = wet[channel]![sourceFrame]! * window[local]!;
        }
      }
      fftTestOwned(real, imaginary, false);
      for (let bin = 0; bin < REFERENCE_FORMANT_FFT_SIZE; bin += 1) {
        real[bin] = real[bin]! * gain[bin]!;
        imaginary[bin] = imaginary[bin]! * gain[bin]!;
      }
      fftTestOwned(real, imaginary, true);
      for (let local = 0; local < REFERENCE_FORMANT_FFT_SIZE; local += 1) {
        const destination = start + local;
        if (destination < 0 || destination >= length) continue;
        accumulated[channel]![destination] = accumulated[channel]![destination]!
          + real[local]! * window[local]!;
        if (channel === 0) {
          normalization[destination] = normalization[destination]! + window[local]! ** 2;
        }
      }
    }
  }
  for (let channel = 0; channel < wet.length; channel += 1) {
    for (let frame = 0; frame < length; frame += 1) {
      wet[channel]![frame] = normalizedWetSampleReference(
        accumulated[channel]![frame]!,
        normalization[frame]!,
        wet[channel]![frame]!,
      );
    }
  }
  if (checkpoint === undefined) throw new Error('reference checkpoint was not visited');
  return { output: wet, starts, normalization, checkpoint };
}

function abortAtStructuralBoundary(
  functionName: string,
  targetHit = 1,
): AbortSignal {
  let hits = 0;
  return {
    get aborted() {
      const stack = new Error().stack ?? '';
      const lines = stack.split('\n');
      const cancellationCheck = lines.findIndex((line) => line.includes('throwIfCancelled'));
      const pollingCaller = cancellationCheck < 0 ? '' : lines[cancellationCheck + 1] ?? '';
      if (pollingCaller.includes(functionName)) {
        hits += 1;
        return hits >= targetHit;
      }
      return false;
    },
  } as AbortSignal;
}

function expectSubsequentPreserveCallToBeDeterministic(
  dry: readonly Float32Array[],
  sourceWet: readonly Float32Array[],
): void {
  const first = sourceWet.map((channel) => channel.slice());
  const second = sourceWet.map((channel) => channel.slice());
  preserveFormants(dry, first, 48_000);
  preserveFormants(dry, second, 48_000);
  for (let channel = 0; channel < first.length; channel += 1) {
    expect([...first[channel]!]).toEqual([...second[channel]!]);
  }
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

  it('pins the origin/main legacy fixture for off, zero cents, and zero correction', () => {
    const pcm = {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 1 as const,
      channels: [sine(4_800, 440, 0.75)],
    };
    const legacy = renderAudioWarp(request(), pcm).channels[0]!;
    const off = renderAudioWarp({ ...request(), formantMode: 'off' }, pcm).channels[0]!;
    const zeroCent = renderAudioWarp({ ...request(), formantMode: 'preserve' }, pcm).channels[0]!;
    const corrected = request(6_000, 300);
    const zeroCorrectionRequest: AudioWarpRenderRequest = {
      ...corrected,
      pitchRegions: corrected.pitchRegions.map((region) => ({
        ...region,
        correctionAmount: 0,
        cents: 0,
      })),
      cacheKey: `${corrected.cacheKey}:zero-correction`,
    };
    const zeroCorrection = renderAudioWarp(zeroCorrectionRequest, pcm).channels[0]!;
    expect([...off]).toEqual([...legacy]);
    expect([...zeroCent]).toEqual([...legacy]);
    expect([...zeroCorrection]).toEqual([...legacy]);
    // Captured from commit 82b548d's wsola-v1 implementation using this
    // documented deterministic Float32 fixture.
    expect(checksum(legacy)).toBe(
      '68d870bb40f57eda0fdc9ddbef0ce69e9e44c6bb8565ef86e65c167136e6ab3d',
    );
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

  it('keeps preserve deterministic, finite, bounded, and stereo-linked', () => {
    const left = sine(4_800, 140);
    const right = Float32Array.from(left, (sample) => sample * 0.5);
    const preserveRequest = {
      ...request(6_000, 300, 2),
      formantMode: 'preserve' as const,
    };
    const input = {
      sampleRate: 48_000,
      frameCount: 4_800,
      channelCount: 2 as const,
      channels: [left, right],
    };
    const first = renderAudioWarp(preserveRequest, input);
    const second = renderAudioWarp(preserveRequest, input);
    expect([...first.channels[0]!]).toEqual([...second.channels[0]!]);
    expect(first.channels.flatMap((channel) => [...channel]).every(Number.isFinite)).toBe(true);
    expect(Math.max(...first.channels.flatMap((channel) => [...channel].map(Math.abs))))
      .toBeLessThanOrEqual(1);
    expect(Math.max(...first.channels[0]!.map((sample, index) =>
      Math.abs(first.channels[1]![index]! - sample * 0.5)))).toBeLessThan(1e-5);
  });

  it('does not synthesize into leading silence or flatten a voiced attack', () => {
    const frames = 24_000;
    const silenceEnd = 6_000;
    const source = canonicalVoice(VOICE_SPECS[0]!, 0, frames);
    for (let frame = 0; frame < frames; frame += 1) {
      source[frame] = frame < silenceEnd
        ? 0
        : source[frame]! * (frame - silenceEnd) / (frames - silenceEnd - 1);
    }
    const preserve = renderAudioWarp(
      exactRequest(frames, 48_000, 100, 'preserve'),
      {
        sampleRate: 48_000,
        frameCount: frames,
        channelCount: 1,
        channels: [source],
      },
    ).channels[0]!;
    const inputRatio = intervalRms(source, 18_000, 23_000)
      / intervalRms(source, 6_000, 12_000);
    const outputRatio = intervalRms(preserve, 18_000, 23_000)
      / intervalRms(preserve, 6_000, 12_000);

    expect(intervalRms(source, 0, silenceEnd)).toBe(0);
    expect(intervalRms(preserve, 0, silenceEnd)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(preserve[0]!)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(20 * Math.log10(outputRatio / inputRatio)))
      .toBeLessThanOrEqual(0.5);
  });

  it('uses the local legacy transfer for non-Lorentzian and model-mismatch voices', () => {
    const sampleRate = 48_000;
    const frames = 12_000;
    const f0 = 140;
    const lorentzian = (
      frequency: number,
      formants: readonly number[],
      bandwidths: readonly number[],
    ) => formants.reduce((sum, formant, index) =>
      sum + 1 / (1 + ((frequency - formant) / (bandwidths[index]! / 2)) ** 2), 0.2);
    const fixtures = [
      ['two-formant', generatedEnvelopeVoice(
        f0, 0, sampleRate, frames,
        (frequency, harmonic) =>
          lorentzian(frequency, [650, 2_100], [75, 160]) / harmonic,
      )],
      ['four-formant', generatedEnvelopeVoice(
        f0, 0, sampleRate, frames,
        (frequency, harmonic) =>
          lorentzian(frequency, [500, 1_300, 2_450, 3_700], [65, 90, 130, 180])
          / harmonic,
      )],
      ['five-formant', generatedEnvelopeVoice(
        f0, 0, sampleRate, frames,
        (frequency, harmonic) =>
          lorentzian(
            frequency,
            [450, 1_050, 1_850, 2_900, 4_100],
            [60, 80, 100, 150, 190],
          ) / harmonic,
      )],
      ['tilt-0.7', generatedEnvelopeVoice(
        f0, 0, sampleRate, frames,
        (frequency, harmonic) =>
          lorentzian(frequency, [700, 1_220, 2_500], [90, 120, 180])
          / harmonic ** 0.7,
      )],
      ['tilt-1.3', generatedEnvelopeVoice(
        f0, 0, sampleRate, frames,
        (frequency, harmonic) =>
          lorentzian(frequency, [700, 1_220, 2_500], [90, 120, 180])
          / harmonic ** 1.3,
      )],
      ['all-pole', generatedEnvelopeVoice(
        f0,
        0,
        sampleRate,
        frames,
        (frequency, harmonic) => {
          const omega = 2 * Math.PI * frequency / sampleRate;
          const envelope = [
            [620, 85],
            [1_750, 135],
            [3_100, 210],
          ].reduce((value, [center, bandwidth]) => {
            const radius = Math.exp(-Math.PI * bandwidth! / sampleRate);
            const angle = 2 * Math.PI * center! / sampleRate;
            const first = 1 + radius ** 2
              - 2 * radius * Math.cos(omega - angle);
            const second = 1 + radius ** 2
              - 2 * radius * Math.cos(omega + angle);
            return value / Math.sqrt(first * second);
          }, 1);
          return envelope / harmonic;
        },
      )],
    ] as const;

    for (const [name, source] of fixtures) {
      const preserveRequest = exactRequest(frames, sampleRate, 100, 'preserve');
      const off = renderAudioWarp(
        { ...preserveRequest, formantMode: 'off', cacheKey: `${name}:off` },
        {
          sampleRate,
          frameCount: frames,
          channelCount: 1,
          channels: [source],
        },
      ).channels[0]!;
      const expected = [off.slice()];
      preserveFormants([source], expected, sampleRate);
      matchFormantLevelReference([source], expected);
      const preserve = renderAudioWarp(
        { ...preserveRequest, cacheKey: `${name}:preserve` },
        {
          sampleRate,
          frameCount: frames,
          channelCount: 1,
          channels: [source],
        },
      ).channels[0]!;
      expect([...preserve], name).toEqual([...expected[0]!]);
    }
  }, 15_000);

  it('keeps the fundamental when a modeled voice has a stronger second harmonic', () => {
    const sampleRate = 48_000;
    const frames = 24_000;
    const f0 = 140;
    const cents = 100;
    const source = generatedEnvelopeVoice(
      f0,
      0,
      sampleRate,
      frames,
      (frequency, harmonic) => {
        const resonance = [
          [280, 60],
          [1_400, 120],
          [2_800, 180],
        ].reduce((sum, [formant, bandwidth]) =>
          sum + 1 / (1 + ((frequency - formant!) / (bandwidth! / 2)) ** 2), 0.2);
        return resonance / harmonic;
      },
    );
    const rendered = renderAudioWarp(
      exactRequest(frames, sampleRate, cents, 'preserve'),
      {
        sampleRate,
        frameCount: frames,
        channelCount: 1,
        channels: [source],
      },
    ).channels[0]!;
    const off = renderAudioWarp(
      exactRequest(frames, sampleRate, cents, 'off'),
      {
        sampleRate,
        frameCount: frames,
        channelCount: 1,
        channels: [source],
      },
    ).channels[0]!;
    const legacy = [off.slice()];
    preserveFormants([source], legacy, sampleRate);
    matchFormantLevelReference([source], legacy);
    const expectedF0 = f0 * 2 ** (cents / 1200);
    const measuredF0 = estimateF0TestOwned(rendered, sampleRate, expectedF0);
    expect(checksum(rendered)).not.toBe(checksum(legacy[0]!));
    expect(centsBetween(measuredF0, expectedF0)).toBeLessThanOrEqual(20);
    expect(centsBetween(measuredF0, expectedF0 * 2)).toBeGreaterThan(1_000);
  });

  it('distinguishes a missing fundamental from weak real odd harmonics', () => {
    const evidenceThreshold = 5e-4;
    const frames = 24_000;
    const sourceF0 = 105;
    const cents = 100;
    const fixtures = [
      [0, false],
      [0.0002, false],
      [0.002, true],
      [0.005, true],
      [0.02, true],
    ] as const;
    for (const [oddScale, retainsAnalyzedF0] of fixtures) {
      const source = generatedEnvelopeVoice(
        sourceF0,
        0,
        48_000,
        frames,
        (frequency, harmonic) => {
          const resonance = [
            [630, 55],
            [1_680, 100],
            [2_940, 160],
          ].reduce((sum, [formant, bandwidth]) =>
            sum + 1 / (
              1 + ((frequency - formant!) / (bandwidth! / 2)) ** 2
            ), 0.2);
          return resonance / harmonic * (harmonic % 2 === 0 ? 1 : oddScale);
        },
      );
      const sourceEvidence = oddHarmonicEvidenceTestOwned(source, 48_000, sourceF0);
      expect(
        sourceEvidence >= evidenceThreshold,
        `odd=${oddScale}:evidence=${sourceEvidence}`,
      ).toBe(retainsAnalyzedF0);
      expect(
        retainsAnalyzedF0
          ? sourceEvidence / evidenceThreshold
          : evidenceThreshold / Math.max(1e-12, sourceEvidence),
        `odd=${oddScale}:classification-margin`,
      ).toBeGreaterThanOrEqual(2);
      for (const sampleRate of [44_100, 48_000]) {
        const pcm = {
          sampleRate: 48_000,
          frameCount: frames,
          channelCount: 1 as const,
          channels: [source],
        };
        const dryAtRate = bandLimitedResample(
          [source],
          Math.round(frames * sampleRate / 48_000),
        )[0]!;
        const rateEvidence = oddHarmonicEvidenceTestOwned(
          dryAtRate,
          sampleRate,
          sourceF0,
        );
        expect(
          rateEvidence >= evidenceThreshold,
          `${sampleRate}/${oddScale}:source-evidence=${rateEvidence}`,
        ).toBe(retainsAnalyzedF0);
        const rendered = renderAudioWarp(
          exactRequest(frames, sampleRate, cents, 'preserve'),
          pcm,
        ).channels[0]!;
        const expectedF0 = sourceF0
          * (retainsAnalyzedF0 ? 1 : 2)
          * 2 ** (cents / 1200);
        const measuredF0 = estimateF0TestOwned(rendered, sampleRate, expectedF0);
        const outputEvidence = oddHarmonicEvidenceTestOwned(
          rendered,
          sampleRate,
          sourceF0 * 2 ** (cents / 1200),
        );
        expect(centsBetween(measuredF0, expectedF0), `${sampleRate}/${oddScale}:F0`)
          .toBeLessThanOrEqual(20);
        if (retainsAnalyzedF0) {
          expect(
            outputEvidence / sourceEvidence,
            `${sampleRate}/${oddScale}:odd-retention`,
          ).toBeGreaterThanOrEqual(0.1);
          if (oddScale === 0.02) {
            const fundamentalAmplitude = directComplexDftTestOwned(
              rendered,
              sampleRate,
              sourceF0 * 2 ** (cents / 1200),
            ).amplitude;
            const secondAmplitude = directComplexDftTestOwned(
              rendered,
              sampleRate,
              sourceF0 * 2 * 2 ** (cents / 1200),
            ).amplitude;
            expect(fundamentalAmplitude / secondAmplitude)
              .toBeGreaterThanOrEqual(0.01);
          }
        } else {
          expect(
            outputEvidence >= evidenceThreshold,
            `${sampleRate}/${oddScale}:output-evidence=${outputEvidence}`,
          ).toBe(false);
        }
      }
    }
  }, 15_000);

  it('preserves odd/even excitation when pitch-down creates new harmonics', () => {
    const frames = 24_000;
    const sourceF0 = 105;
    const cents = -300;
    const source = generatedEnvelopeVoice(
      sourceF0,
      0,
      48_000,
      frames,
      (frequency, harmonic) => {
        const resonance = [
          [700, 90],
          [1_220, 120],
          [2_500, 180],
        ].reduce((sum, [formant, bandwidth]) =>
          sum + 1 / (
            1 + ((frequency - formant!) / (bandwidth! / 2)) ** 2
          ), 0.2);
        return resonance / harmonic * (harmonic % 2 === 0 ? 1 : 0.02);
      },
    );
    const targetF0 = sourceF0 * 2 ** (cents / 1200);
    for (const sampleRate of [44_100, 48_000]) {
      const rendered = renderAudioWarp(
        exactRequest(frames, sampleRate, cents, 'preserve'),
        {
          sampleRate: 48_000,
          frameCount: frames,
          channelCount: 1,
          channels: [source],
        },
      ).channels[0]!;
      const amplitudes = new Map(directTargetHarmonicDft(
        rendered,
        sampleRate,
        targetF0,
      ).map((point) => [point.harmonic, point.amplitude]));
      expect(
        amplitudes.get(48)! / amplitudes.get(46)!,
        `${sampleRate}:h48/h46`,
      ).toBeGreaterThanOrEqual(0.1);
      expect(
        (amplitudes.get(48)! + amplitudes.get(50)!)
          / (amplitudes.get(47)! + amplitudes.get(49)!),
        `${sampleRate}:extra-even/odd`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses linked channel evidence when stereo phase cancels odd harmonics in mid', () => {
    const frames = 24_000;
    const sourceF0 = 105;
    const cents = 100;
    const envelopeAt = (frequency: number, harmonic: number) => {
      const resonance = [
        [700, 90],
        [1_220, 120],
        [2_500, 180],
      ].reduce((sum, [formant, bandwidth]) =>
        sum + 1 / (
          1 + ((frequency - formant!) / (bandwidth! / 2)) ** 2
        ), 0.2);
      return resonance / harmonic;
    };
    const left = generatedEnvelopeVoice(
      sourceF0,
      0,
      48_000,
      frames,
      envelopeAt,
    );
    const right = generatedEnvelopeVoice(
      sourceF0,
      0,
      48_000,
      frames,
      envelopeAt,
      (harmonic) => Math.PI * harmonic,
    );
    expect(analyzeAudioWarpFormants([left, right], 48_000)).toMatchObject({
      active: true,
      estimatedF0: expect.closeTo(sourceF0, 1),
    });
    for (const sampleRate of [44_100, 48_000]) {
      const rendered = renderAudioWarp(
        exactRequest(frames, sampleRate, cents, 'preserve', 2),
        {
          sampleRate: 48_000,
          frameCount: frames,
          channelCount: 2,
          channels: [left, right],
        },
      ).channels;
      const targetF0 = sourceF0 * 2 ** (cents / 1200);
      for (let channel = 0; channel < 2; channel += 1) {
        const sourceFundamental = directComplexDftTestOwned(
          [left, right][channel]!,
          48_000,
          sourceF0,
        ).amplitude;
        const sourceSecond = directComplexDftTestOwned(
          [left, right][channel]!,
          48_000,
          sourceF0 * 2,
        ).amplitude;
        const outputFundamental = directComplexDftTestOwned(
          rendered[channel]!,
          sampleRate,
          targetF0,
        ).amplitude;
        const outputSecond = directComplexDftTestOwned(
          rendered[channel]!,
          sampleRate,
          targetF0 * 2,
        ).amplitude;
        expect(
          outputFundamental / outputSecond,
          `${sampleRate}/channel-${channel}:A1/A2`,
        ).toBeGreaterThanOrEqual(sourceFundamental / sourceSecond * 0.5);
        const measuredF0 = estimateF0TestOwned(
          rendered[channel]!,
          sampleRate,
          targetF0,
        );
        expect(
          centsBetween(measuredF0, targetF0),
          `${sampleRate}/channel-${channel}:F0`,
        ).toBeLessThanOrEqual(20);
      }
      const sourcePhase = wrappedPhaseDifference(
        directComplexDftTestOwned(right, 48_000, sourceF0).phase,
        directComplexDftTestOwned(left, 48_000, sourceF0).phase,
      );
      const outputPhase = wrappedPhaseDifference(
        directComplexDftTestOwned(rendered[1]!, sampleRate, targetF0).phase,
        directComplexDftTestOwned(rendered[0]!, sampleRate, targetF0).phase,
      );
      expect(
        Math.abs(wrappedPhaseDifference(outputPhase, sourcePhase)),
        `${sampleRate}:interchannel-phase`,
      ).toBeLessThanOrEqual(0.02);
    }
  }, 15_000);

  it.each([
    [0.7, 0],
    [-0.7, 1],
    [0.7, 2],
  ] as const)('preserves a stationary stereo phase offset of %s radians (seed %s)', (
    phaseOffset,
    seed,
  ) => {
    const sampleRate = 48_000;
    const frames = 24_000;
    const spec = VOICE_SPECS[0]!;
    const left = generatedVoice(spec, spec.f0, seed, sampleRate, frames);
    const right = generatedVoice(
      spec,
      spec.f0,
      seed + phaseOffset * 64 / Math.PI,
      sampleRate,
      frames,
    );
    const cents = 100;
    const rendered = renderAudioWarp(
      exactRequest(frames, sampleRate, cents, 'preserve', 2),
      {
        sampleRate,
        frameCount: frames,
        channelCount: 2,
        channels: [left, right],
      },
    ).channels;
    const targetF0 = spec.f0 * 2 ** (cents / 1200);
    for (const harmonic of [3, 5, 9]) {
      const sourcePhase = wrappedPhaseDifference(
        directComplexDftTestOwned(right, sampleRate, harmonic * spec.f0).phase,
        directComplexDftTestOwned(left, sampleRate, harmonic * spec.f0).phase,
      );
      for (const start of [4_096, 14_000]) {
        const outputPhase = wrappedPhaseDifference(
          directComplexDftTestOwned(
            rendered[1]!,
            sampleRate,
            harmonic * targetF0,
            start,
            4_096,
          ).phase,
          directComplexDftTestOwned(
            rendered[0]!,
            sampleRate,
            harmonic * targetF0,
            start,
            4_096,
          ).phase,
        );
        expect(
          Math.abs(wrappedPhaseDifference(outputPhase, sourcePhase)),
          `${phaseOffset}/${seed}/h${harmonic}/start${start}`,
        ).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it('preserves attack and decay dynamics without pre-echo', () => {
    const frames = 24_000;
    const source = canonicalVoice(VOICE_SPECS[0]!, 1, frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const envelope = frame < 2_000
        ? 0
        : frame < 8_000
          ? (frame - 2_000) / 6_000
          : frame < 16_000
            ? 1
            : (frames - 1 - frame) / 8_000;
      source[frame] = source[frame]! * Math.max(0, envelope);
    }
    const rendered = renderAudioWarp(
      exactRequest(frames, 48_000, -100, 'preserve'),
      {
        sampleRate: 48_000,
        frameCount: frames,
        channelCount: 1,
        channels: [source],
      },
    ).channels[0]!;
    expect(intervalRms(rendered, 0, 2_000)).toBeLessThanOrEqual(1e-5);
    for (const [start, end] of [[3_000, 7_000], [9_000, 15_000], [18_000, 23_000]]) {
      const inputRelative = intervalRms(source, start!, end!)
        / intervalRms(source, 9_000, 15_000);
      const outputRelative = intervalRms(rendered, start!, end!)
        / intervalRms(rendered, 9_000, 15_000);
      expect(Math.abs(20 * Math.log10(outputRelative / inputRelative)))
        .toBeLessThanOrEqual(0.7);
    }
  });

  it('keeps vowel changes, noise bursts, vibrato, and stereo phase changes local', () => {
    const sampleRate = 48_000;
    const frames = 24_000;
    const firstVowel = canonicalVoice(VOICE_SPECS[0]!, 0, frames);
    const secondVowel = generatedEnvelopeVoice(
      140,
      0,
      sampleRate,
      frames,
      (frequency, harmonic) => {
        const resonance = [
          [480, 70],
          [1_700, 130],
          [3_200, 220],
        ].reduce((sum, [formant, bandwidth]) =>
          sum + 1 / (1 + ((frequency - formant!) / (bandwidth! / 2)) ** 2), 0.2);
        return resonance / harmonic;
      },
    );
    const changingVowel = firstVowel.slice();
    for (let frame = frames / 2; frame < frames; frame += 1) {
      changingVowel[frame] = secondVowel[frame]!;
    }

    const noiseBurst = firstVowel.slice();
    const noise = deterministicNoise(2_048, 0.25);
    for (let frame = 0; frame < noise.length; frame += 1) {
      noiseBurst[4_096 + frame] = Math.max(
        -0.95,
        Math.min(0.95, noiseBurst[4_096 + frame]! + noise[frame]!),
      );
    }

    const vibrato = new Float32Array(frames);
    const phases = new Float64Array(Math.floor(5_000 / 140));
    for (let harmonic = 1; harmonic <= phases.length; harmonic += 1) {
      phases[harmonic - 1] = 2 * Math.PI * (
        Math.sin((harmonic + 17) * 12.9898) * 43_758.5453 % 1
      );
    }
    for (let frame = 0; frame < frames; frame += 1) {
      const instantaneousF0 = 140 * 2 ** (
        35 * Math.sin(2 * Math.PI * 5 * frame / sampleRate) / 1200
      );
      for (let harmonic = 1; harmonic <= phases.length; harmonic += 1) {
        const frequency = harmonic * 140;
        const spec = VOICE_SPECS[0]!;
        const resonance = spec.formants.reduce((sum, formant, index) =>
          sum + 1 / (
            1 + ((frequency - formant) / (spec.bandwidths[index]! / 2)) ** 2
          ), 0.2);
        vibrato[frame] = vibrato[frame]!
          + resonance / harmonic * Math.sin(phases[harmonic - 1]!);
        phases[harmonic - 1] = phases[harmonic - 1]!
          + 2 * Math.PI * harmonic * instantaneousF0 / sampleRate;
      }
    }
    let vibratoPeak = 0;
    for (const sample of vibrato) vibratoPeak = Math.max(vibratoPeak, Math.abs(sample));
    for (let frame = 0; frame < frames; frame += 1) {
      vibrato[frame] = vibrato[frame]! / vibratoPeak * 0.7;
    }

    const phaseChangingRight = firstVowel.slice();
    for (let frame = frames / 2; frame < frames; frame += 1) {
      phaseChangingRight[frame] = -phaseChangingRight[frame]!;
    }
    const fixtures = [
      ['two-vowel', [changingVowel]],
      ['noise-burst', [noiseBurst]],
      ['vibrato', [vibrato]],
      ['stereo-phase-change', [firstVowel, phaseChangingRight]],
    ] as const;
    for (const [name, channels] of fixtures) {
      const channelCount = channels.length as 1 | 2;
      const preserveRequest = exactRequest(
        frames,
        sampleRate,
        100,
        'preserve',
        channelCount,
      );
      const pcm = {
        sampleRate,
        frameCount: frames,
        channelCount,
        channels,
      };
      const off = renderAudioWarp(
        { ...preserveRequest, formantMode: 'off', cacheKey: `${name}:off` },
        pcm,
      ).channels.map((channel) => channel.slice());
      const expected = off.map((channel) => channel.slice());
      if (analyzeAudioWarpFormants(channels, sampleRate).active) {
        preserveFormants(channels, expected, sampleRate);
        matchFormantLevelReference(channels, expected);
      }
      const preserve = renderAudioWarp(
        { ...preserveRequest, cacheKey: `${name}:preserve` },
        pcm,
      ).channels;
      for (let channel = 0; channel < channelCount; channel += 1) {
        expect([...preserve[channel]!], `${name}:channel-${channel}`)
          .toEqual([...expected[channel]!]);
      }
    }
  }, 15_000);

  it('classifies supported voiced and unsupported-rate formant analysis', () => {
    for (const frequency of [140, 210]) {
      expect(
        expectProductionAnalysisToMatchReference(
          [sine(9_600, frequency)],
          48_000,
          `supported-voiced-${frequency}`,
        ),
      ).toMatchObject({ active: true, reason: null });
    }
    expectProductionAnalysisToMatchReference(
      [sine(9_600, 140)],
      32_000,
      'unsupported-rate',
    );
    expectProductionAnalysisToMatchReference(
      [new Float32Array(9_600)],
      48_000,
      'silence',
    );
  });

  it('independently recomputes every deterministic fallback fixture and priority reason', () => {
    const frames = 9_600;
    const impulse = new Float32Array(frames);
    impulse[Math.floor(frames / 2)] = 0.8;
    const twoF0 = Float32Array.from({ length: frames }, (_, frame) =>
      0.2 * Math.sin(2 * Math.PI * 137 * frame / 48_000)
      + 0.4 * Math.sin(2 * Math.PI * 223 * frame / 48_000));
    const anti = sine(frames, 140, 0.4);
    const fixtures = [
      ['silence', [new Float32Array(frames)], 48_000, 'insufficient-energy'],
      ['noise', [deterministicNoise(frames)], 48_000, 'flat/unvoiced'],
      ['impulse', [impulse], 48_000, 'flat/unvoiced'],
      ['two-F0', [twoF0], 48_000, 'ambiguous'],
      ['very-short voiced', [sine(1_500, 210, 0.4)], 48_000, 'too-short/too-few-periods'],
      [
        'reverse-polarity stereo',
        [anti, Float32Array.from(anti, (sample) => -sample)],
        48_000,
        'anti-phase',
      ],
      ['unsupported rate', [sine(frames, 140, 0.4)], 32_000, 'unsupported-rate'],
    ] as const;
    for (const [name, channels, rate, reason] of fixtures) {
      const reference = expectProductionAnalysisToMatchReference(channels, rate, name);
      expect(reference.reason, name).toBe(reason);
      expect(reference.active, name).toBe(false);
    }
    const antiAnalysis = analyzeFormantsReference(fixtures[5][1], 48_000);
    expect(antiAnalysis.linkedRms).toBeGreaterThanOrEqual(1e-4);
    expect(antiAnalysis.midToLinkedEnergyRatio).toBeLessThan(1e-4);
    expect(antiAnalysis.stableVoiced).toBe(false);
    const noiseAnalysis = analyzeFormantsReference(fixtures[1][1], 48_000);
    expect(
      noiseAnalysis.periodicity < 0.60 || noiseAnalysis.spectralFlatness > 0.35,
    ).toBe(true);
    const impulseAnalysis = analyzeFormantsReference(fixtures[2][1], 48_000);
    expect(impulseAnalysis.periodicity).toBeLessThan(0.60);
    expect(impulseAnalysis.spectralFlatness).toBeGreaterThan(0.35);
  });

  it('independently recomputes weighted medians and useful-hop unions across tails', () => {
    const length = 4_429;
    const changingF0 = Float32Array.from({ length }, (_, frame) => {
      const frequency = frame < 2_048 ? 140 : 210;
      return Math.sin(2 * Math.PI * frequency * frame / 48_000) * 0.4;
    });
    const reference = expectProductionAnalysisToMatchReference(
      [changingF0],
      48_000,
      'changing-f0-tail',
    );
    expect(reference.frames.map((frame) => frame.start))
      .toEqual([0, 1_024, 2_048, 2_381]);
    const usefulNearMedian = reference.frames.filter((frame) =>
      frame.useful
      && frame.f0 !== null
      && reference.estimatedF0 !== null
      && centsBetween(frame.f0, reference.estimatedF0) <= 50);
    expect(reference.usefulSamples).toBe(
      usefulHopUnionReference(usefulNearMedian, length),
    );
  });

  it.each([
    [2_048, [0]],
    [3_072, [0, 1_024]],
    [4_096, [0, 1_024, 2_048]],
  ] as const)('uses independent one/two/three-frame aggregation for %s samples', (
    length,
    expectedStarts,
  ) => {
    const reference = expectProductionAnalysisToMatchReference(
      [sine(length, 140, 0.4)],
      48_000,
      `frame-count-${expectedStarts.length}`,
    );
    expect(reference.frames.map((frame) => frame.start)).toEqual(expectedStarts);
  });

  it('pins every fallback threshold at nextDown, exact, and nextUp with priority', () => {
    const base = {
      supported: true,
      availableSamples: 9_600,
      sampleRate: 48_000,
      linkedRms: 1e-4,
      midToLinkedEnergyRatio: 1e-4,
      periodicity: 0.60,
      spectralFlatness: 0.35,
      ambiguityRatio: 0.85,
      aggregateF0: 200,
      estimatedF0: 200,
      usefulSamples: 2_048,
      usefulEnergy: 60,
      nonSilentEnergy: 100,
    } as const;
    expect(expectProductionGateToMatchReference(base)).toMatchObject({
      active: true,
      reason: null,
      stableVoiced: true,
    });
    expect(expectProductionGateToMatchReference({
      ...base,
      linkedRms: nextPositiveFloat(1e-4, -1),
    }).reason).toBe('insufficient-energy');
    expect(expectProductionGateToMatchReference({
      ...base,
      linkedRms: nextPositiveFloat(1e-4, 1),
    }).active).toBe(true);
    expect(expectProductionGateToMatchReference({
      ...base,
      midToLinkedEnergyRatio: nextPositiveFloat(1e-4, -1),
    }).reason).toBe('anti-phase');
    expect(expectProductionGateToMatchReference({
      ...base,
      midToLinkedEnergyRatio: nextPositiveFloat(1e-4, 1),
    }).active).toBe(true);
    expect(expectProductionGateToMatchReference({
      ...base,
      periodicity: nextPositiveFloat(0.60, -1),
    }).reason).toBe('flat/unvoiced');
    expect(expectProductionGateToMatchReference({
      ...base,
      periodicity: nextPositiveFloat(0.60, 1),
    }).active).toBe(true);
    expect(expectProductionGateToMatchReference({
      ...base,
      spectralFlatness: nextPositiveFloat(0.35, 1),
    }).reason).toBe('flat/unvoiced');
    expect(expectProductionGateToMatchReference({
      ...base,
      spectralFlatness: nextPositiveFloat(0.35, -1),
    }).active).toBe(true);
    expect(expectProductionGateToMatchReference({
      ...base,
      ambiguityRatio: nextPositiveFloat(0.85, 1),
    }).reason).toBe('ambiguous');
    expect(expectProductionGateToMatchReference({
      ...base,
      ambiguityRatio: nextPositiveFloat(0.85, -1),
    }).active).toBe(true);

    expect(expectProductionGateToMatchReference({
      ...base,
      supported: false,
      availableSamples: 1,
      linkedRms: 0,
    }).reason).toBe('unsupported-rate');
    expect(expectProductionGateToMatchReference({
      ...base,
      availableSamples: 2_047,
      linkedRms: 0,
    }).reason).toBe('insufficient-energy');
    expect(expectProductionGateToMatchReference({
      ...base,
      availableSamples: 2_047,
    }).reason).toBe('too-short/too-few-periods');
  });

  it.each([
    [44_100, 210],
    [48_000, 200],
  ])('uses deduplicated useful samples at the exact eight-period boundary (%s Hz)', (
    sampleRate,
    f0,
  ) => {
    const exactSamples = 8 * sampleRate / f0;
    expect(Number.isSafeInteger(exactSamples)).toBe(true);
    const base = {
      supported: true,
      availableSamples: 9_600,
      sampleRate,
      linkedRms: 1e-4,
      midToLinkedEnergyRatio: 1e-4,
      periodicity: 0.60,
      spectralFlatness: 0.35,
      ambiguityRatio: 0.85,
      aggregateF0: f0,
      estimatedF0: f0,
      usefulEnergy: 60,
      nonSilentEnergy: 100,
    } as const;
    expect(expectProductionGateToMatchReference({
      ...base,
      usefulSamples: exactSamples - 1,
    }).reason).toBe('too-short/too-few-periods');
    expect(expectProductionGateToMatchReference({
      ...base,
      usefulSamples: exactSamples,
    }).active).toBe(true);
    expect(expectProductionGateToMatchReference({
      ...base,
      usefulSamples: exactSamples + 1,
    }).active).toBe(true);
  });

  it('falls back sample-exactly to off for every inactive preserve analysis', () => {
    const impulse = new Float32Array(9_600);
    impulse[4_800] = 0.8;
    const twoF0 = Float32Array.from({ length: 9_600 }, (_, frame) =>
      0.2 * Math.sin(2 * Math.PI * 137 * frame / 48_000)
      + 0.4 * Math.sin(2 * Math.PI * 223 * frame / 48_000));
    const anti = sine(9_600, 140, 0.4);
    const fixtures = [
      { channels: [new Float32Array(9_600)], rate: 48_000 },
      { channels: [deterministicNoise(9_600)], rate: 48_000 },
      { channels: [impulse], rate: 48_000 },
      { channels: [twoF0], rate: 48_000 },
      { channels: [sine(2_047, 210, 0.4)], rate: 48_000 },
      {
        channels: [anti, Float32Array.from(anti, (sample) => -sample)],
        rate: 48_000,
      },
      { channels: [sine(9_600, 140, 0.4)], rate: 32_000 },
    ] as const;
    for (const fixture of fixtures) {
      const channels = fixture.channels.map((channel) => channel.slice());
      expect(analyzeFormantsReference(channels, fixture.rate).active).toBe(false);
      const channelCount = channels.length as 1 | 2;
      const preserve = exactRequest(
        channels[0]!.length,
        fixture.rate,
        100,
        'preserve',
        channelCount,
      );
      const off = { ...preserve, formantMode: 'off' as const, cacheKey: `${preserve.cacheKey}:off` };
      const pcm = {
        sampleRate: 48_000,
        frameCount: channels[0]!.length,
        channelCount,
        channels,
      };
      const preservePcm = renderAudioWarp(preserve, pcm);
      const offPcm = renderAudioWarp(off, pcm);
      for (let channel = 0; channel < channelCount; channel += 1) {
        expect([...preservePcm.channels[channel]!])
          .toEqual([...offPcm.channels[channel]!]);
      }
    }
  });

  it('aborts before fixed scratch allocation with an already-aborted real signal', () => {
    const dry = [sine(4_096, 140, 0.4)];
    const sourceWet = [sine(4_096, 166, 0.4)];
    const wet = sourceWet.map((channel) => channel.slice());
    const before = wet.map((channel) => channel.slice());
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Float64Array')!;
    let allocations = 0;
    const countingFloat64Array = new Proxy(Float64Array, {
      construct(target, argumentsList) {
        allocations += 1;
        return Reflect.construct(target, argumentsList);
      },
    });
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(globalThis, 'Float64Array', {
      ...originalDescriptor,
      value: countingFloat64Array,
    });
    try {
      expect(() => preserveFormants(dry, wet, 48_000, controller.signal))
        .toThrowError(expect.objectContaining({ name: 'AbortError', code: 'cancelled' }));
    } finally {
      Object.defineProperty(globalThis, 'Float64Array', originalDescriptor);
    }
    expect(allocations).toBe(0);
    expect(wet.map((channel) => [...channel])).toEqual(before.map((channel) => [...channel]));
    expectSubsequentPreserveCallToBeDeterministic(dry, sourceWet);
  });

  it('aborts at the formant frame-loop boundary without returning partial PCM', () => {
    const dry = [sine(4_096, 140, 0.4)];
    const sourceWet = [sine(4_096, 166, 0.4)];
    const wet = sourceWet.map((channel) => channel.slice());
    const before = wet.map((channel) => channel.slice());
    expect(() => preserveFormants(
      dry,
      wet,
      48_000,
      abortAtStructuralBoundary('preserveFormants', 2),
    )).toThrowError(expect.objectContaining({ name: 'AbortError', code: 'cancelled' }));
    expect(wet.map((channel) => [...channel])).toEqual(before.map((channel) => [...channel]));
    expectSubsequentPreserveCallToBeDeterministic(dry, sourceWet);
  });

  it('aborts inside a radix-2 FFT stage without returning partial PCM', () => {
    const dry = [sine(4_096, 140, 0.4)];
    const sourceWet = [sine(4_096, 166, 0.4)];
    const wet = sourceWet.map((channel) => channel.slice());
    const before = wet.map((channel) => channel.slice());
    expect(() => preserveFormants(
      dry,
      wet,
      48_000,
      abortAtStructuralBoundary('fftRadix2', 4),
    )).toThrowError(expect.objectContaining({ name: 'AbortError', code: 'cancelled' }));
    expect(wet.map((channel) => [...channel])).toEqual(before.map((channel) => [...channel]));
    expectSubsequentPreserveCallToBeDeterministic(dry, sourceWet);
  });

  it('aborts inside WOLA synthesis without returning partial PCM', () => {
    const dry = [sine(4_096, 140, 0.4)];
    const sourceWet = [sine(4_096, 166, 0.4)];
    const wet = sourceWet.map((channel) => channel.slice());
    const before = wet.map((channel) => channel.slice());
    expect(() => preserveFormants(
      dry,
      wet,
      48_000,
      abortAtStructuralBoundary('synthesizeFormantFrame', 32),
    )).toThrowError(expect.objectContaining({ name: 'AbortError', code: 'cancelled' }));
    expect(wet.map((channel) => [...channel])).toEqual(before.map((channel) => [...channel]));
    expectSubsequentPreserveCallToBeDeterministic(dry, sourceWet);
  });

  it.each([
    ['F0 search', 'estimateResynthesisFundamental', 2],
    ['resonance fit', 'fitResonantEnvelope', 2],
    ['oscillator synthesis', 'renderResonantVoicedPitch', 2],
  ] as const)('aborts inside new-path %s without mutating source PCM', (
    _stage,
    functionName,
    targetHit,
  ) => {
    const source = canonicalVoice(VOICE_SPECS[0]!, 0);
    const before = source.slice();
    const preserveRequest = exactRequest(source.length, 48_000, 100, 'preserve');
    expect(() => renderAudioWarp(
      preserveRequest,
      {
        sampleRate: 48_000,
        frameCount: source.length,
        channelCount: 1,
        channels: [source],
      },
      abortAtStructuralBoundary(functionName, targetHit),
    )).toThrowError(expect.objectContaining({ name: 'AbortError', code: 'cancelled' }));
    expect([...source]).toEqual([...before]);
    const first = renderAudioWarp(
      preserveRequest,
      {
        sampleRate: 48_000,
        frameCount: source.length,
        channelCount: 1,
        channels: [source],
      },
    );
    const second = renderAudioWarp(
      preserveRequest,
      {
        sampleRate: 48_000,
        frameCount: source.length,
        channelCount: 1,
        channels: [source],
      },
    );
    expect([...first.channels[0]!]).toEqual([...second.channels[0]!]);
  });

  it('matches a test-owned ln/cepstrum/gain/WOLA reference and scratch contract', () => {
    expect(8 * 2_048 * Float64Array.BYTES_PER_ELEMENT
      + 2 * 2_048 * Float32Array.BYTES_PER_ELEMENT).toBe(147_456);
    expect(FORMANT_RELEASE_LIMITATION).toContain('licensed-voice blind A/B or MUSHRA');
    const length = 3_072;
    const dryLeft = Float32Array.from({ length }, (_, frame) =>
      0.28 * Math.sin(2 * Math.PI * 140 * frame / 48_000)
      + 0.10 * Math.sin(2 * Math.PI * 700 * frame / 48_000)
      + 0.06 * Math.sin(2 * Math.PI * 1_220 * frame / 48_000));
    const wetLeft = Float32Array.from({ length }, (_, frame) =>
      0.28 * Math.sin(2 * Math.PI * 166.49 * frame / 48_000)
      + 0.10 * Math.sin(2 * Math.PI * 832.45 * frame / 48_000)
      + 0.06 * Math.sin(2 * Math.PI * 1_450.8 * frame / 48_000));
    const dry = [dryLeft, Float32Array.from(dryLeft, (sample) => sample * 0.5)];
    const sourceWet = [wetLeft, Float32Array.from(wetLeft, (sample) => sample * 0.5)];
    const reference = preserveFormantsReference(dry, sourceWet, 48_000);
    expect(reference.starts).toEqual([-1_024, 0, 1_024, 2_048, 3_072]);

    const window = sqrtHannReference();
    const dryMagnitude = linkedMagnitudeReference(dry, 0, window);
    const dryCepstrum = cepstralEnvelopeReference(dryMagnitude, 48_000);
    const q = Math.round(0.0015 * 48_000);
    expect(q).toBe(72);
    expect(dryCepstrum.lifteredCepstrum[0]).toBe(dryCepstrum.cepstrum[0]);
    expect(dryCepstrum.lifteredCepstrum[q]).toBe(dryCepstrum.cepstrum[q]);
    expect(dryCepstrum.lifteredCepstrum[q + 1]).toBe(0);
    expect(dryCepstrum.lifteredCepstrum[REFERENCE_FORMANT_FFT_SIZE - q - 1]).toBe(0);
    expect(dryCepstrum.lifteredCepstrum[REFERENCE_FORMANT_FFT_SIZE - q])
      .toBe(dryCepstrum.cepstrum[REFERENCE_FORMANT_FFT_SIZE - q]);
    expect(reference.checkpoint.dryMagnitude)
      .toBeCloseTo(dryMagnitude[reference.checkpoint.bin]!, 12);
    expect(reference.checkpoint.dryLogMagnitude).toBeCloseTo(
      Math.log(Math.max(reference.checkpoint.dryMagnitude, 1e-7)),
      12,
    );
    expect(reference.checkpoint.wetLogMagnitude).toBeCloseTo(
      Math.log(Math.max(reference.checkpoint.wetMagnitude, 1e-7)),
      12,
    );
    const expectedGain = Math.exp(Math.max(
      -12 * Math.LN10 / 20,
      Math.min(
        12 * Math.LN10 / 20,
        reference.checkpoint.dryEnvelope - reference.checkpoint.wetEnvelope,
      ),
    ));
    expect(reference.checkpoint.gain).toBeCloseTo(expectedGain, 6);

    const expectedNormalization = new Float32Array(length);
    for (const start of reference.starts) {
      for (let local = 0; local < REFERENCE_FORMANT_FFT_SIZE; local += 1) {
        const destination = start + local;
        if (destination >= 0 && destination < length) {
          expectedNormalization[destination] = expectedNormalization[destination]!
            + window[local]! ** 2;
        }
      }
    }
    expect([...reference.normalization]).toEqual([...expectedNormalization]);
    expect(reference.normalization.every((value) => value >= 1e-12)).toBe(true);
    expect(normalizedWetSampleReference(123, 0, 0.25)).toBe(0.25);
    expect(normalizedWetSampleReference(1, 1e-12, 0.25)).toBe(1e12);

    const production = sourceWet.map((channel) => channel.slice());
    preserveFormants(dry, production, 48_000);
    for (let channel = 0; channel < production.length; channel += 1) {
      for (let frame = 0; frame < length; frame += 1) {
        expect(production[channel]![frame])
          .toBeCloseTo(reference.output[channel]![frame]!, 5);
      }
    }
    const stereoError = Math.max(...production[0]!.map((sample, frame) =>
      Math.abs(production[1]![frame]! - 0.5 * sample)));
    expect(stereoError).toBeLessThan(1e-5);

    // Valid sqrt-Hann coverage keeps every cropped denominator non-zero. Force
    // the otherwise defensive branch structurally, without a production hook,
    // and require its result to match the test-owned wet-sample reference.
    const fallbackWet = sourceWet.map((channel) => channel.slice());
    const originalSqrt = Math.sqrt;
    let windowSamples = 0;
    Math.sqrt = (value: number): number => {
      if (windowSamples < REFERENCE_FORMANT_FFT_SIZE) {
        windowSamples += 1;
        return 0;
      }
      return originalSqrt(value);
    };
    try {
      preserveFormants(dry, fallbackWet, 48_000);
    } finally {
      Math.sqrt = originalSqrt;
    }
    expect(windowSamples).toBe(REFERENCE_FORMANT_FFT_SIZE);
    expect(fallbackWet.map((channel) => [...channel]))
      .toEqual(sourceWet.map((channel) => [...channel]));
  });

  it('checks canonical 48 kHz generated voices at 44.1 and 48 kHz', () => {
    for (const sampleRate of [44_100, 48_000]) {
      for (const spec of VOICE_SPECS) {
        for (const cents of [-300, -100, 100, 300]) {
          for (const seed of [0, 1]) {
            const input = canonicalVoice(spec, seed);
            const pcm = {
              sampleRate: 48_000,
              frameCount: input.length,
              channelCount: 1 as const,
              channels: [input],
            };
            const outputLength = Math.round(input.length * sampleRate / 48_000);
            const dry = bandLimitedResample([input], outputLength)[0]!;
            expect(
              expectProductionAnalysisToMatchReference(
                [dry],
                sampleRate,
                `${sampleRate}/${spec.f0}/${cents}/${seed}:analysis-reference`,
              ),
              `${sampleRate}/${spec.f0}/${cents}/${seed}:analysis`,
            ).toMatchObject({ active: true, reason: null });
            const off = renderAudioWarp(exactRequest(
              input.length,
              sampleRate,
              cents,
              'off',
            ), pcm).channels[0]!;
            const preserveRequest = exactRequest(
              input.length,
              sampleRate,
              cents,
              'preserve',
            );
            const preserve = renderAudioWarp(preserveRequest, pcm).channels[0]!;
            const repeated = renderAudioWarp(preserveRequest, pcm).channels[0]!;
            const label = `${sampleRate}/${spec.f0}/${cents}/${seed}`;

            expect([...preserve], label).toEqual([...repeated]);
            expect(preserve.every(Number.isFinite), label).toBe(true);
            let peak = 0;
            let delta = 0;
            for (let index = 0; index < preserve.length; index += 1) {
              peak = Math.max(peak, Math.abs(preserve[index]!));
              if (index > 0) {
                delta = Math.max(delta, Math.abs(preserve[index]! - preserve[index - 1]!));
              }
            }
            expect(peak, label).toBeLessThanOrEqual(1);
            expect(delta, label).toBeLessThan(0.35);

            const expectedF0 = spec.f0 * 2 ** (cents / 1200);
            const measuredF0 = estimateF0TestOwned(preserve, sampleRate, expectedF0);
            expect(
              centsBetween(
                measuredF0,
                expectedF0,
              ),
              `${label}:F0=${measuredF0}`,
            ).toBeLessThanOrEqual(20);

            const ideal = generatedVoice(
              spec,
              expectedF0,
              seed,
              sampleRate,
              outputLength,
            );
            const idealHarmonics = directTargetHarmonicDft(
              ideal,
              sampleRate,
              expectedF0,
            );
            const offHarmonics = directTargetHarmonicDft(
              off,
              sampleRate,
              expectedF0,
            );
            const preserveHarmonics = directTargetHarmonicDft(
              preserve,
              sampleRate,
              expectedF0,
            );
            expect(centeredHarmonicEnvelopeRms(idealHarmonics, idealHarmonics))
              .toBe(0);
            const formantErrors = spec.formants.map((formant) => {
              const idealCenter = formantEnergyCentroid(idealHarmonics, formant);
              expect(centsBetween(idealCenter, idealCenter)).toBe(0);
              const preserveCenter = formantEnergyCentroid(
                preserveHarmonics,
                formant,
              );
              return centsBetween(preserveCenter, idealCenter);
            });
            expect.soft(
              Math.max(...formantErrors),
              `${label}:ideal-centroid-errors=${formantErrors.join(',')}`,
            ).toBeLessThanOrEqual(70);

            const offRms = centeredHarmonicEnvelopeRms(
              idealHarmonics,
              offHarmonics,
            );
            const preserveRms = centeredHarmonicEnvelopeRms(
              idealHarmonics,
              preserveHarmonics,
            );
            expect.soft(offRms, label).toBeGreaterThanOrEqual(0.1);
            expect.soft(preserveRms, `${label}:absolute-envelope`)
              .toBeLessThanOrEqual(2.5);
            if (Math.abs(cents) === 300) {
              expect.soft(preserveRms, `${label}:relative-envelope`)
                .toBeLessThanOrEqual(offRms * 0.5);
            } else {
              expect.soft(preserveRms, `${label}:small-shift-envelope`)
                .toBeLessThanOrEqual(offRms * 0.7);
            }
            const dryRms = centerRms(dry);
            const wetRms = centerRms(preserve);
            const levelDifference = Math.abs(20 * Math.log10(
              Math.max(1e-12, wetRms) / Math.max(1e-12, dryRms),
            ));
            expect(levelDifference, `${label}:level`).toBeLessThanOrEqual(2);
          }
        }
      }
    }
  }, 30_000);
});
