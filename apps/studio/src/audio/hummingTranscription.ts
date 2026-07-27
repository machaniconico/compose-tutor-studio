/**
 * Deterministic, local-only monophonic humming transcription.
 *
 * The analyzer never mutates its input. It validates every source sample,
 * polarity-aligns strongly anti-correlated channels before mixing, and then
 * runs normalized autocorrelation on a bounded 8 kHz analysis signal.
 */

export const MAX_HUMMING_TRANSCRIPTION_SECONDS = 5 * 60;
export const MIN_HUMMING_SAMPLE_RATE = 8_000;
export const MAX_HUMMING_SAMPLE_RATE = 192_000;
export const MAX_HUMMING_CHANNELS = 32;
export const MAX_HUMMING_PCM_BYTES = 256 * 1024 * 1024;
export const MIN_HUMMING_FREQUENCY_HZ = 50;
export const MAX_HUMMING_FREQUENCY_HZ = 1_000;
export const MAX_HUMMING_WAVEFORM_BINS = 512;
export const MAX_HUMMING_PUBLIC_PITCH_FRAMES = 3_000;

const ANALYSIS_SAMPLE_RATE = 8_000;
const ANALYSIS_WINDOW_SECONDS = 0.05;
const ANALYSIS_HOP_SECONDS = 0.02;
const MIN_FRAME_RMS = 0.005;
const MIN_PERIODICITY = 0.72;
const MIN_NOTE_SECONDS = 0.06;
const NOTE_CHANGE_CONFIRMATION_FRAMES = 4;
const NOTE_HYSTERESIS_SEMITONES = 0.8;
const DEFAULT_CHUNK_SAMPLES = 65_536;
const MAX_CHUNK_SAMPLES = 1_048_576;
const POLARITY_CORRELATION_RATE = 8_000;
const MIN_ANTI_CORRELATION = -0.2;
const ANTI_ALIAS_CUTOFF_HZ = 1_400;
const ANTI_ALIAS_POLES = 8;

export type HummingAudioBufferShape = Readonly<{
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
}>;

export type HummingTranscriptionErrorCode =
  | 'invalid-audio'
  | 'sample-rate-out-of-range'
  | 'channel-limit-exceeded'
  | 'duration-limit-exceeded'
  | 'resource-limit-exceeded'
  | 'non-finite-sample'
  | 'cancelled';

export class HummingTranscriptionError extends Error {
  constructor(
    readonly code: HummingTranscriptionErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'HummingTranscriptionError';
  }
}

export type HummingMelodyNote = Readonly<{
  startSeconds: number;
  durationSeconds: number;
  midi: number;
  confidence: number;
}>;

export type HummingWaveformBin = Readonly<{
  startSeconds: number;
  endSeconds: number;
  min: number;
  max: number;
}>;

export type HummingPitchFrame = Readonly<{
  startSeconds: number;
  endSeconds: number;
  /** Fractional MIDI pitch for a voiced frame; null represents an unvoiced frame. */
  midi: number | null;
  confidence: number;
}>;

export type HummingTranscriptionResult = Readonly<{
  durationSeconds: number;
  waveform: readonly HummingWaveformBin[];
  pitchFrames: readonly HummingPitchFrame[];
  notes: readonly HummingMelodyNote[];
}>;

export type HummingTranscriptionProgress = Readonly<{
  phase: 'validating' | 'aligning' | 'mixing' | 'analyzing';
  fraction: number;
}>;

export type HummingTranscriptionOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: HummingTranscriptionProgress) => void;
  /** Test seam and host scheduling hook. */
  yieldControl?: () => Promise<void>;
  /** Maximum source sample values handled between event-loop yields. */
  chunkSamples?: number;
}>;

type ValidatedInput = Readonly<{
  channels: readonly Float32Array[];
  channelRms: readonly number[];
  referenceChannel: number;
  durationSeconds: number;
}>;

type PitchFrame = Readonly<{
  startSeconds: number;
  endSeconds: number;
  midiFloat: number | null;
  confidence: number;
}>;

type PitchEstimate = Readonly<{
  frequencyHz: number;
  confidence: number;
}>;

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HummingTranscriptionError('cancelled');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validatedChunkSamples(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHUNK_SAMPLES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CHUNK_SAMPLES) {
    throw new HummingTranscriptionError('invalid-audio');
  }
  return value;
}

function validateShape(buffer: HummingAudioBufferShape): number {
  if (
    !Number.isSafeInteger(buffer.numberOfChannels) ||
    buffer.numberOfChannels <= 0
  ) {
    throw new HummingTranscriptionError('invalid-audio');
  }
  if (buffer.numberOfChannels > MAX_HUMMING_CHANNELS) {
    throw new HummingTranscriptionError('channel-limit-exceeded');
  }
  if (
    !Number.isFinite(buffer.sampleRate) ||
    !Number.isInteger(buffer.sampleRate) ||
    buffer.sampleRate < MIN_HUMMING_SAMPLE_RATE ||
    buffer.sampleRate > MAX_HUMMING_SAMPLE_RATE
  ) {
    throw new HummingTranscriptionError('sample-rate-out-of-range');
  }
  if (!Number.isSafeInteger(buffer.length) || buffer.length <= 0) {
    throw new HummingTranscriptionError('invalid-audio');
  }
  const durationSeconds = buffer.length / buffer.sampleRate;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds > MAX_HUMMING_TRANSCRIPTION_SECONDS
  ) {
    throw new HummingTranscriptionError('duration-limit-exceeded');
  }
  const sampleValues = buffer.length * buffer.numberOfChannels;
  const pcmBytes = sampleValues * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(sampleValues) ||
    !Number.isSafeInteger(pcmBytes) ||
    pcmBytes > MAX_HUMMING_PCM_BYTES
  ) {
    throw new HummingTranscriptionError('resource-limit-exceeded');
  }
  return durationSeconds;
}

async function validateInput(
  buffer: HummingAudioBufferShape,
  chunkSamples: number,
  signal: AbortSignal | undefined,
  yieldControl: () => Promise<void>,
  onProgress: HummingTranscriptionOptions['onProgress'],
): Promise<ValidatedInput> {
  const durationSeconds = validateShape(buffer);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    let samples: Float32Array;
    try {
      samples = buffer.getChannelData(channel);
    } catch {
      throw new HummingTranscriptionError('invalid-audio');
    }
    if (!(samples instanceof Float32Array) || samples.length < buffer.length) {
      throw new HummingTranscriptionError('invalid-audio');
    }
    channels.push(samples);
  }

  const channelPower = Array.from({ length: channels.length }, () => 0);
  const totalValues = buffer.length * channels.length;
  let completedValues = 0;
  onProgress?.({ phase: 'validating', fraction: 0 });
  for (let channel = 0; channel < channels.length; channel += 1) {
    const samples = channels[channel];
    if (!samples) throw new HummingTranscriptionError('invalid-audio');
    for (let start = 0; start < buffer.length; start += chunkSamples) {
      throwIfCancelled(signal);
      const end = Math.min(buffer.length, start + chunkSamples);
      let power = channelPower[channel] ?? 0;
      for (let frame = start; frame < end; frame += 1) {
        const sample = samples[frame];
        if (sample === undefined || !Number.isFinite(sample)) {
          throw new HummingTranscriptionError('non-finite-sample');
        }
        power += sample * sample;
      }
      channelPower[channel] = power;
      completedValues += end - start;
      onProgress?.({
        phase: 'validating',
        fraction: clampUnit(completedValues / totalValues),
      });
      if (completedValues < totalValues) {
        await yieldControl();
        throwIfCancelled(signal);
      }
    }
  }

  const channelRms = channelPower.map((power) =>
    Math.sqrt(power / buffer.length),
  );
  let referenceChannel = 0;
  for (let channel = 1; channel < channelRms.length; channel += 1) {
    if ((channelRms[channel] ?? 0) > (channelRms[referenceChannel] ?? 0)) {
      referenceChannel = channel;
    }
  }
  return { channels, channelRms, referenceChannel, durationSeconds };
}

async function determineChannelPolarities(
  input: ValidatedInput,
  sourceFrames: number,
  sourceSampleRate: number,
  chunkSamples: number,
  signal: AbortSignal | undefined,
  yieldControl: () => Promise<void>,
  onProgress: HummingTranscriptionOptions['onProgress'],
): Promise<readonly number[]> {
  const reference = input.channels[input.referenceChannel];
  if (!reference) throw new HummingTranscriptionError('invalid-audio');
  const referenceRms = input.channelRms[input.referenceChannel] ?? 0;
  if (referenceRms === 0) {
    onProgress?.({ phase: 'aligning', fraction: 1 });
    return input.channels.map(() => 1);
  }

  const stride = Math.max(
    1,
    Math.floor(sourceSampleRate / POLARITY_CORRELATION_RATE),
  );
  const correlationSamples = Math.ceil(sourceFrames / stride);
  const polarities: number[] = [];
  onProgress?.({ phase: 'aligning', fraction: 0 });
  for (let channel = 0; channel < input.channels.length; channel += 1) {
    if (channel === input.referenceChannel) {
      polarities.push(1);
      onProgress?.({
        phase: 'aligning',
        fraction: clampUnit((channel + 1) / input.channels.length),
      });
      continue;
    }
    const samples = input.channels[channel];
    if (!samples) throw new HummingTranscriptionError('invalid-audio');
    let dot = 0;
    let referencePower = 0;
    let channelPower = 0;
    let visited = 0;
    for (let frame = 0; frame < sourceFrames; frame += stride) {
      const referenceSample = reference[frame] ?? 0;
      const channelSample = samples[frame] ?? 0;
      dot += referenceSample * channelSample;
      referencePower += referenceSample * referenceSample;
      channelPower += channelSample * channelSample;
      visited += 1;
      if (visited % chunkSamples === 0 && visited < correlationSamples) {
        throwIfCancelled(signal);
        await yieldControl();
        throwIfCancelled(signal);
      }
    }
    const denominator = Math.sqrt(referencePower * channelPower);
    const correlation = denominator > 0 ? dot / denominator : 0;
    polarities.push(correlation < MIN_ANTI_CORRELATION ? -1 : 1);
    onProgress?.({
      phase: 'aligning',
      fraction: clampUnit((channel + 1) / input.channels.length),
    });
  }
  return polarities;
}

async function createAnalysisSignal(
  input: ValidatedInput,
  sourceFrames: number,
  sourceSampleRate: number,
  polarities: readonly number[],
  chunkSamples: number,
  signal: AbortSignal | undefined,
  yieldControl: () => Promise<void>,
  onProgress: HummingTranscriptionOptions['onProgress'],
): Promise<Float64Array> {
  throwIfCancelled(signal);
  const outputFrames = Math.max(
    1,
    Math.floor((sourceFrames * ANALYSIS_SAMPLE_RATE) / sourceSampleRate),
  );
  const output = new Float64Array(outputFrames);
  const referenceRms = input.channelRms[input.referenceChannel] ?? 0;
  const weights = input.channelRms.map((rms) =>
    referenceRms > 0 && rms > referenceRms * 1e-6
      ? Math.min(1, rms / referenceRms)
      : 0,
  );
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum === 0) {
    onProgress?.({ phase: 'mixing', fraction: 1 });
    return output;
  }

  const sourceFramesPerOutput = sourceSampleRate / ANALYSIS_SAMPLE_RATE;
  const estimatedValuesPerOutput =
    Math.ceil(sourceFramesPerOutput) * input.channels.length;
  const outputChunkFrames = Math.max(
    1,
    Math.floor(chunkSamples / Math.max(1, estimatedValuesPerOutput)),
  );
  const highPassCoefficient = Math.exp(
    (-2 * Math.PI * 20) / ANALYSIS_SAMPLE_RATE,
  );
  const lowPassCoefficient =
    1 - Math.exp((-2 * Math.PI * ANTI_ALIAS_CUTOFF_HZ) / sourceSampleRate);
  const lowPassState = new Float64Array(ANTI_ALIAS_POLES);
  let previousInput = 0;
  let previousOutput = 0;
  onProgress?.({ phase: 'mixing', fraction: 0 });
  for (let outputStart = 0; outputStart < outputFrames; outputStart += outputChunkFrames) {
    throwIfCancelled(signal);
    const outputEnd = Math.min(outputFrames, outputStart + outputChunkFrames);
    for (let outputFrame = outputStart; outputFrame < outputEnd; outputFrame += 1) {
      const sourceStart = Math.floor(outputFrame * sourceFramesPerOutput);
      const sourceEnd = Math.min(
        sourceFrames,
        Math.max(sourceStart + 1, Math.floor((outputFrame + 1) * sourceFramesPerOutput)),
      );
      let filteredSum = 0;
      for (let sourceFrame = sourceStart; sourceFrame < sourceEnd; sourceFrame += 1) {
        let mixed = 0;
        for (let channel = 0; channel < input.channels.length; channel += 1) {
          const weight = weights[channel] ?? 0;
          if (weight === 0) continue;
          const channelSamples = input.channels[channel];
          if (!channelSamples) throw new HummingTranscriptionError('invalid-audio');
          const polarity = polarities[channel] ?? 1;
          mixed += (channelSamples[sourceFrame] ?? 0) * polarity * weight;
        }
        mixed /= weightSum;
        let filtered = mixed;
        for (let pole = 0; pole < lowPassState.length; pole += 1) {
          const state = lowPassState[pole] ?? 0;
          const next = state + lowPassCoefficient * (filtered - state);
          lowPassState[pole] = next;
          filtered = next;
        }
        filteredSum += filtered;
      }
      const sourceCount = Math.max(1, sourceEnd - sourceStart);
      const mixed = filteredSum / sourceCount;
      const highPassed = mixed - previousInput + highPassCoefficient * previousOutput;
      output[outputFrame] = highPassed;
      previousInput = mixed;
      previousOutput = highPassed;
    }
    onProgress?.({
      phase: 'mixing',
      fraction: clampUnit(outputEnd / outputFrames),
    });
    if (outputEnd < outputFrames) {
      await yieldControl();
      throwIfCancelled(signal);
    }
  }
  return output;
}

function createWaveformBins(
  samples: Float64Array,
  durationSeconds: number,
): readonly HummingWaveformBin[] {
  if (samples.length === 0) return [];
  const binCount = Math.min(MAX_HUMMING_WAVEFORM_BINS, samples.length);
  const bins: HummingWaveformBin[] = [];
  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    const startFrame = Math.floor((binIndex * samples.length) / binCount);
    const endFrame = Math.max(
      startFrame + 1,
      Math.floor(((binIndex + 1) * samples.length) / binCount),
    );
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const sample = samples[frame] ?? 0;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    bins.push({
      startSeconds: (startFrame / samples.length) * durationSeconds,
      endSeconds:
        binIndex === binCount - 1
          ? durationSeconds
          : (endFrame / samples.length) * durationSeconds,
      min,
      max,
    });
  }
  return bins;
}

function rangeRms(samples: Float64Array, start: number, end: number): number {
  let power = 0;
  for (let index = start; index < end; index += 1) {
    const sample = samples[index] ?? 0;
    power += sample * sample;
  }
  return Math.sqrt(power / Math.max(1, end - start));
}

function sinusoidMagnitude(
  samples: Float64Array,
  start: number,
  frames: number,
  frequencyHz: number,
): number {
  const radiansPerFrame = (2 * Math.PI * frequencyHz) / ANALYSIS_SAMPLE_RATE;
  let sine = 0;
  let cosine = 0;
  for (let offset = 0; offset < frames; offset += 1) {
    const sample = samples[start + offset] ?? 0;
    const phase = radiansPerFrame * offset;
    const window =
      frames <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / (frames - 1));
    sine += sample * window * Math.sin(phase);
    cosine += sample * window * Math.cos(phase);
  }
  return Math.hypot(sine, cosine);
}

function estimatePitch(
  samples: Float64Array,
  start: number,
  windowFrames: number,
  minimumLag: number,
  maximumLag: number,
  scores: Float64Array,
): PitchEstimate | null {
  const scoreStartLag = Math.max(1, minimumLag - 1);
  const scoreEndLag = maximumLag + 1;
  const correlationFrames = windowFrames - scoreEndLag;
  if (correlationFrames <= 0) return null;
  let bestLag = minimumLag;
  let bestScore = -1;
  for (let lag = scoreStartLag; lag <= scoreEndLag; lag += 1) {
    let cross = 0;
    let firstPower = 0;
    let secondPower = 0;
    for (let offset = 0; offset < correlationFrames; offset += 1) {
      const first = samples[start + offset] ?? 0;
      const second = samples[start + offset + lag] ?? 0;
      cross += first * second;
      firstPower += first * first;
      secondPower += second * second;
    }
    const denominator = firstPower + secondPower;
    const score = denominator > Number.EPSILON ? (2 * cross) / denominator : 0;
    scores[lag] = score;
    if (lag >= minimumLag && lag <= maximumLag && score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore < MIN_PERIODICITY) return null;

  const acceptableScore = Math.max(MIN_PERIODICITY, bestScore * 0.9);
  let selectedLag = bestLag;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const score = scores[lag] ?? -1;
    const left = scores[lag - 1] ?? -1;
    const right = scores[lag + 1] ?? -1;
    if (score >= acceptableScore && score >= left && score >= right) {
      selectedLag = lag;
      break;
    }
  }

  // A breathy voice can carry a much stronger second harmonic than its
  // fundamental. Prefer the octave-lower period only when that fundamental is
  // actually present; a pure sine keeps the shorter, correct period.
  const octaveLag = selectedLag * 2;
  if (octaveLag <= maximumLag) {
    let octavePeakLag = octaveLag;
    for (
      let lag = Math.max(minimumLag, octaveLag - 1);
      lag <= Math.min(maximumLag, octaveLag + 1);
      lag += 1
    ) {
      if ((scores[lag] ?? -1) > (scores[octavePeakLag] ?? -1)) octavePeakLag = lag;
    }
    const selectedScore = scores[selectedLag] ?? 0;
    const octaveScore = scores[octavePeakLag] ?? 0;
    const selectedMagnitude = sinusoidMagnitude(
      samples,
      start,
      windowFrames,
      ANALYSIS_SAMPLE_RATE / selectedLag,
    );
    const fundamentalMagnitude = sinusoidMagnitude(
      samples,
      start,
      windowFrames,
      ANALYSIS_SAMPLE_RATE / octavePeakLag,
    );
    if (
      octaveScore >= Math.max(MIN_PERIODICITY, selectedScore + 0.01) &&
      fundamentalMagnitude >= selectedMagnitude * 0.08
    ) {
      selectedLag = octavePeakLag;
    }
  }

  let refinedLag = selectedLag;
  if (selectedLag > scoreStartLag && selectedLag < scoreEndLag) {
    const left = scores[selectedLag - 1] ?? 0;
    const center = scores[selectedLag] ?? 0;
    const right = scores[selectedLag + 1] ?? 0;
    const curvature = left - 2 * center + right;
    if (Math.abs(curvature) > 1e-12) {
      const offset = 0.5 * (left - right) / curvature;
      refinedLag += Math.max(-0.5, Math.min(0.5, offset));
    }
  }
  refinedLag = Math.max(
    ANALYSIS_SAMPLE_RATE / MAX_HUMMING_FREQUENCY_HZ,
    Math.min(ANALYSIS_SAMPLE_RATE / MIN_HUMMING_FREQUENCY_HZ, refinedLag),
  );
  const frequencyHz = ANALYSIS_SAMPLE_RATE / refinedLag;
  if (
    !Number.isFinite(frequencyHz) ||
    frequencyHz < MIN_HUMMING_FREQUENCY_HZ ||
    frequencyHz > MAX_HUMMING_FREQUENCY_HZ
  ) {
    return null;
  }
  return {
    frequencyHz,
    confidence: clampUnit(scores[selectedLag] ?? 0),
  };
}

async function analyzePitchFrames(
  samples: Float64Array,
  durationSeconds: number,
  signal: AbortSignal | undefined,
  yieldControl: () => Promise<void>,
  onProgress: HummingTranscriptionOptions['onProgress'],
): Promise<readonly PitchFrame[]> {
  const windowFrames = Math.round(ANALYSIS_WINDOW_SECONDS * ANALYSIS_SAMPLE_RATE);
  const hopFrames = Math.round(ANALYSIS_HOP_SECONDS * ANALYSIS_SAMPLE_RATE);
  const minimumLag = Math.floor(ANALYSIS_SAMPLE_RATE / MAX_HUMMING_FREQUENCY_HZ);
  const maximumLag = Math.ceil(ANALYSIS_SAMPLE_RATE / MIN_HUMMING_FREQUENCY_HZ);
  if (samples.length < windowFrames) {
    onProgress?.({ phase: 'analyzing', fraction: 1 });
    return [];
  }
  const frameCount = Math.floor((samples.length - windowFrames) / hopFrames) + 1;
  const frames: PitchFrame[] = [];
  const scores = new Float64Array(maximumLag + 2);
  const gateOffset = Math.floor((windowFrames - hopFrames) / 2);
  onProgress?.({ phase: 'analyzing', fraction: 0 });
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    throwIfCancelled(signal);
    const start = frameIndex * hopFrames;
    const gateStart = start + gateOffset;
    const gateEnd = gateStart + hopFrames;
    const rms = rangeRms(samples, gateStart, gateEnd);
    const pitch =
      rms >= MIN_FRAME_RMS
        ? estimatePitch(
            samples,
            start,
            windowFrames,
            minimumLag,
            maximumLag,
            scores,
          )
        : null;
    const midiFloat = pitch
      ? 69 + 12 * Math.log2(pitch.frequencyHz / 440)
      : null;
    frames.push({
      startSeconds: frameIndex === 0 ? 0 : gateStart / ANALYSIS_SAMPLE_RATE,
      endSeconds:
        frameIndex === frameCount - 1
          ? durationSeconds
          : gateEnd / ANALYSIS_SAMPLE_RATE,
      midiFloat,
      confidence: pitch?.confidence ?? 0,
    });
    if ((frameIndex + 1) % 8 === 0 || frameIndex + 1 === frameCount) {
      onProgress?.({
        phase: 'analyzing',
        fraction: clampUnit((frameIndex + 1) / frameCount),
      });
      if (frameIndex + 1 < frameCount) {
        await yieldControl();
        throwIfCancelled(signal);
      }
    }
  }
  return frames;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function createPublicPitchFrames(
  frames: readonly PitchFrame[],
): readonly HummingPitchFrame[] {
  if (frames.length === 0) return [];
  const outputCount = Math.min(MAX_HUMMING_PUBLIC_PITCH_FRAMES, frames.length);
  const result: HummingPitchFrame[] = [];
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
    const startIndex = Math.floor((outputIndex * frames.length) / outputCount);
    const endIndex = Math.max(
      startIndex + 1,
      Math.floor(((outputIndex + 1) * frames.length) / outputCount),
    );
    const first = frames[startIndex];
    const last = frames[endIndex - 1];
    if (!first || !last) continue;
    const voicedMidi: number[] = [];
    let confidence = 0;
    for (let frameIndex = startIndex; frameIndex < endIndex; frameIndex += 1) {
      const frame = frames[frameIndex];
      if (!frame) continue;
      confidence += frame.confidence;
      if (frame.midiFloat !== null) voicedMidi.push(frame.midiFloat);
    }
    result.push({
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      midi: voicedMidi.length > 0 ? median(voicedMidi) : null,
      // Averaging across the whole represented range also communicates how
      // much of a compacted frame was actually voiced.
      confidence: clampUnit(confidence / (endIndex - startIndex)),
    });
  }
  return result;
}

function smoothVoicedMidi(frames: readonly PitchFrame[]): readonly (number | null)[] {
  return frames.map((frame, index) => {
    if (frame.midiFloat === null) return null;
    const values: number[] = [frame.midiFloat];
    const previous = frames[index - 1];
    const next = frames[index + 1];
    if (previous?.midiFloat !== null && previous?.midiFloat !== undefined) {
      values.push(previous.midiFloat);
    }
    if (next?.midiFloat !== null && next?.midiFloat !== undefined) {
      values.push(next.midiFloat);
    }
    return median(values);
  });
}

function quantizeWithHysteresis(
  smoothedMidi: readonly (number | null)[],
): readonly (number | null)[] {
  const quantized: (number | null)[] = Array.from(
    { length: smoothedMidi.length },
    () => null,
  );
  let stableMidi: number | null = null;
  let pendingMidi: number | null = null;
  let pendingIndices: number[] = [];
  for (let index = 0; index < smoothedMidi.length; index += 1) {
    const midiFloat = smoothedMidi[index];
    if (midiFloat === null || midiFloat === undefined) {
      stableMidi = null;
      pendingMidi = null;
      pendingIndices = [];
      continue;
    }
    if (stableMidi === null) {
      stableMidi = Math.round(midiFloat);
      quantized[index] = stableMidi;
      continue;
    }
    if (Math.abs(midiFloat - stableMidi) <= NOTE_HYSTERESIS_SEMITONES) {
      quantized[index] = stableMidi;
      pendingMidi = null;
      pendingIndices = [];
      continue;
    }

    const candidate = Math.round(midiFloat);
    quantized[index] = stableMidi;
    if (candidate !== pendingMidi) {
      pendingMidi = candidate;
      pendingIndices = [index];
    } else {
      pendingIndices.push(index);
    }
    if (pendingIndices.length >= NOTE_CHANGE_CONFIRMATION_FRAMES) {
      for (const pendingIndex of pendingIndices) quantized[pendingIndex] = candidate;
      stableMidi = candidate;
      pendingMidi = null;
      pendingIndices = [];
    }
  }
  return quantized;
}

function framesToNotes(frames: readonly PitchFrame[]): readonly HummingMelodyNote[] {
  const quantized = quantizeWithHysteresis(smoothVoicedMidi(frames));
  const notes: HummingMelodyNote[] = [];
  let startIndex = -1;
  let midi: number | null = null;

  const finishNote = (endIndex: number): void => {
    if (startIndex < 0 || midi === null || endIndex < startIndex) return;
    const first = frames[startIndex];
    const last = frames[endIndex];
    if (!first || !last) return;
    const durationSeconds = Math.max(0, last.endSeconds - first.startSeconds);
    if (durationSeconds + Number.EPSILON < MIN_NOTE_SECONDS) return;
    let confidence = 0;
    const pitches: number[] = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const frame = frames[index];
      confidence += frame?.confidence ?? 0;
      if (frame?.midiFloat !== null && frame?.midiFloat !== undefined) {
        pitches.push(frame.midiFloat);
      }
    }
    notes.push({
      startSeconds: first.startSeconds,
      durationSeconds,
      // A whole-note median prevents the first phase of vibrato from deciding
      // which side of a semitone boundary represents the sung note.
      midi: Math.round(median(pitches)),
      confidence: clampUnit(confidence / (endIndex - startIndex + 1)),
    });
  };

  for (let index = 0; index < quantized.length; index += 1) {
    const frameMidi = quantized[index];
    if (frameMidi === null || frameMidi === undefined) {
      finishNote(index - 1);
      startIndex = -1;
      midi = null;
    } else if (midi === null) {
      startIndex = index;
      midi = frameMidi;
    } else if (frameMidi !== midi) {
      finishNote(index - 1);
      startIndex = index;
      midi = frameMidi;
    }
  }
  finishNote(quantized.length - 1);
  return notes;
}

/**
 * Analyze decoded monophonic humming once and return only bounded scalar
 * projections. Source PCM, the 8 kHz analysis signal, and AudioBuffer-like
 * objects never escape this call.
 */
export async function transcribeHummingToMelodyResult(
  buffer: HummingAudioBufferShape,
  options: HummingTranscriptionOptions = {},
): Promise<HummingTranscriptionResult> {
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const chunkSamples = validatedChunkSamples(options.chunkSamples);
  try {
    throwIfCancelled(options.signal);
    const input = await validateInput(
      buffer,
      chunkSamples,
      options.signal,
      yieldControl,
      options.onProgress,
    );
    throwIfCancelled(options.signal);
    const polarities = await determineChannelPolarities(
      input,
      buffer.length,
      buffer.sampleRate,
      chunkSamples,
      options.signal,
      yieldControl,
      options.onProgress,
    );
    throwIfCancelled(options.signal);
    const analysisSignal = await createAnalysisSignal(
      input,
      buffer.length,
      buffer.sampleRate,
      polarities,
      chunkSamples,
      options.signal,
      yieldControl,
      options.onProgress,
    );
    const pitchFrames = await analyzePitchFrames(
      analysisSignal,
      input.durationSeconds,
      options.signal,
      yieldControl,
      options.onProgress,
    );
    throwIfCancelled(options.signal);
    const notes = framesToNotes(pitchFrames);
    return {
      durationSeconds: input.durationSeconds,
      waveform: createWaveformBins(analysisSignal, input.durationSeconds),
      pitchFrames: createPublicPitchFrames(pitchFrames),
      notes,
    };
  } catch (error) {
    if (error instanceof HummingTranscriptionError) throw error;
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new HummingTranscriptionError('cancelled');
    }
    throw error;
  }
}

/**
 * Backward-compatible note-only projection of the rich transcription result.
 * The asynchronous chunks keep long recordings from monopolizing the UI
 * thread; all scheduling choices leave the returned notes unchanged.
 */
export async function transcribeHummingToMelody(
  buffer: HummingAudioBufferShape,
  options: HummingTranscriptionOptions = {},
): Promise<readonly HummingMelodyNote[]> {
  return (await transcribeHummingToMelodyResult(buffer, options)).notes;
}
