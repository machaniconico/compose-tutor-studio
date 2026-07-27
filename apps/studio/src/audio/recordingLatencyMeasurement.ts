export const MAX_RECORDING_LATENCY_SECONDS = 0.5;
export const RECORDING_LATENCY_PROBE_AMPLITUDE = 0.08;
export const MAX_RECORDING_LATENCY_ANALYSIS_SECONDS = 2;

const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;
const PROBE_CHIP_RATE_HZ = 12_000;
const PROBE_CHIP_COUNT = 127;
const PROBE_BURST_START_SECONDS = [0.025, 0.105, 0.215] as const;
const PROBE_BURST_SEEDS = [0x6d2b79f5, 0x1b873593, 0x85ebca6b] as const;
const PROBE_TAIL_FRAMES = 64;
const CLIPPED_SAMPLE_MAGNITUDE = 0.999;
const SILENCE_PEAK_MAGNITUDE = 1e-5;
const MIN_CORRELATION = 0.7;
const MIN_BURST_CORRELATION = 0.62;
const AMBIGUOUS_PEAK_RATIO = 0.9;
const AMBIGUOUS_PEAK_DIFFERENCE = 0.08;
const PEAK_EXCLUSION_FRAMES = 2;
const MAX_REFINEMENT_PEAKS = 16;

export type RecordingLatencyMeasurementFailureCode =
  | 'invalid-sample-rate'
  | 'invalid-probe'
  | 'invalid-pcm'
  | 'non-finite-pcm'
  | 'empty-channel'
  | 'channel-length-mismatch'
  | 'silence'
  | 'clipped'
  | 'ambiguous'
  | 'low-confidence'
  | 'out-of-range';

export type RecordingLatencyMeasurementFailure = Readonly<{
  code: RecordingLatencyMeasurementFailureCode;
  message: string;
}>;

export type RecordingLatencyProbeBurst = Readonly<{
  startFrame: number;
  length: number;
}>;

export type RecordingLatencyProbe = Readonly<{
  sampleRate: number;
  samples: Float32Array;
  bursts: readonly RecordingLatencyProbeBurst[];
  /** Repeated frames per PRBS chip; keeps useful energy below analog I/O cutoffs. */
  chipFrames: number;
  durationSeconds: number;
}>;

export type AnalyzeRecordingLatencyInput = Readonly<{
  sampleRate: number;
  channels: readonly Float32Array[];
  /** Shared-context frame corresponding to channels[*][0]. */
  captureFirstContextFrame?: number;
  /** Shared-context frame at which the probe AudioBufferSourceNode was started. */
  probeStartContextFrame?: number;
  /** Omit to recreate the deterministic probe for sampleRate. */
  probe?: RecordingLatencyProbe;
  /** May narrow the accepted range, but may never exceed 500 ms. */
  maxLatencySeconds?: number;
}>;

export type RecordingLatencyMeasurementSuccess = Readonly<{
  ok: true;
  latencyFrames: number;
  roundTripLatencySeconds: number;
  confidence: number;
  sampleRate: number;
  channelIndex: number;
  peakCorrelation: number;
  secondPeakCorrelation: number;
}>;

export type RecordingLatencyMeasurementResult =
  | RecordingLatencyMeasurementSuccess
  | Readonly<{ ok: false; error: RecordingLatencyMeasurementFailure }>;

type Candidate = Readonly<{
  offset: number;
  score: number;
  channelIndex: number;
}>;

function failure(
  code: RecordingLatencyMeasurementFailureCode,
  message: string,
): RecordingLatencyMeasurementResult {
  return { ok: false, error: { code, message } };
}

function validSampleRate(sampleRate: number): boolean {
  return Number.isSafeInteger(sampleRate)
    && sampleRate >= MIN_SAMPLE_RATE
    && sampleRate <= MAX_SAMPLE_RATE;
}

function nextPrbsState(state: number): number {
  let next = state | 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

/**
 * Create the low-level, fixed-seed multi-burst probe used by both playback and
 * analysis. The three independently-seeded bursts make repeated echoes and a
 * single accidental peak distinguishable without any nondeterministic input.
 */
export function createRecordingLatencyProbe(sampleRate: number): RecordingLatencyProbe {
  if (!validSampleRate(sampleRate)) {
    throw new RangeError('Recording latency probe sample rate is invalid.');
  }

  const bursts = PROBE_BURST_START_SECONDS.map((seconds) => ({
    startFrame: Math.round(seconds * sampleRate),
    length: PROBE_CHIP_COUNT * Math.max(1, Math.round(sampleRate / PROBE_CHIP_RATE_HZ)),
  }));
  const chipFrames = Math.max(1, Math.round(sampleRate / PROBE_CHIP_RATE_HZ));
  const finalBurst = bursts[bursts.length - 1];
  if (!finalBurst) {
    throw new Error('Recording latency probe has no bursts.');
  }
  const samples = new Float32Array(
    finalBurst.startFrame + finalBurst.length + PROBE_TAIL_FRAMES,
  );

  for (let burstIndex = 0; burstIndex < bursts.length; burstIndex += 1) {
    const burst = bursts[burstIndex];
    if (!burst) continue;
    let state = PROBE_BURST_SEEDS[burstIndex] ?? 1;
    let previousValue = 0;
    for (let chip = 0; chip < PROBE_CHIP_COUNT; chip += 1) {
      state = nextPrbsState(state);
      const polarity = (state & 1) === 0 ? -1 : 1;
      const edgeEnvelope = Math.min(
        1,
        chip / 4,
        (PROBE_CHIP_COUNT - 1 - chip) / 4,
      );
      const value = polarity * RECORDING_LATENCY_PROBE_AMPLITUDE * edgeEnvelope;
      const transitionFrames = Math.max(1, Math.ceil(chipFrames / 2));
      for (let frame = 0; frame < chipFrames; frame += 1) {
        const progress = Math.min(1, (frame + 1) / transitionFrames);
        const smoothedProgress = progress * progress * (3 - 2 * progress);
        samples[burst.startFrame + chip * chipFrames + frame] =
          previousValue + (value - previousValue) * smoothedProgress;
      }
      previousValue = value;
    }
  }

  return {
    sampleRate,
    samples,
    bursts,
    chipFrames,
    durationSeconds: samples.length / sampleRate,
  };
}

function validContextFrame(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateProbe(
  probe: RecordingLatencyProbe,
  sampleRate: number,
): RecordingLatencyMeasurementFailure | null {
  if (
    probe.sampleRate !== sampleRate
    || !(probe.samples instanceof Float32Array)
    || probe.samples.length <= 0
    || probe.bursts.length < 2
    || !Number.isSafeInteger(probe.chipFrames)
    || probe.chipFrames <= 0
    || probe.chipFrames > Math.ceil(sampleRate / 4_000)
    || !Number.isFinite(probe.durationSeconds)
    || Math.abs(probe.durationSeconds - probe.samples.length / sampleRate) > 1 / sampleRate
  ) {
    return { code: 'invalid-probe', message: 'The reference probe is invalid.' };
  }

  let previousEnd = -1;
  for (const burst of probe.bursts) {
    if (
      !Number.isSafeInteger(burst.startFrame)
      || !Number.isSafeInteger(burst.length)
      || burst.startFrame < 0
      || burst.length <= 0
      || burst.length % probe.chipFrames !== 0
      || burst.startFrame < previousEnd
      || burst.startFrame + burst.length > probe.samples.length
    ) {
      return { code: 'invalid-probe', message: 'The reference probe layout is invalid.' };
    }
    previousEnd = burst.startFrame + burst.length;
  }

  for (const sample of probe.samples) {
    if (!Number.isFinite(sample)) {
      return { code: 'invalid-probe', message: 'The reference probe contains invalid PCM.' };
    }
  }
  return null;
}

function scoreBurst(
  reference: Float32Array,
  burst: RecordingLatencyProbeBurst,
  chipFrames: number,
  channel: Float32Array,
  candidateOffset: number,
): number {
  let dot = 0;
  let referenceEnergy = 0;
  let capturedEnergy = 0;
  const referenceStart = burst.startFrame;
  const capturedStart = candidateOffset + referenceStart;
  const chipCount = burst.length / chipFrames;
  const transitionFrames = Math.max(1, Math.ceil(chipFrames / 2));
  const middleTap = Math.floor((transitionFrames - 1) / 2);
  const lastTap = chipFrames - 1;
  for (let chip = 0; chip < chipCount; chip += 1) {
    for (let tap = 0; tap < 3; tap += 1) {
      const frameWithinChip = tap === 0 ? 0 : tap === 1 ? middleTap : lastTap;
      if (
        (tap === 1 && middleTap === 0)
        || (tap === 2 && (lastTap === 0 || lastTap === middleTap))
      ) {
        continue;
      }
      const frame = chip * chipFrames + frameWithinChip;
      const referenceSample = reference[referenceStart + frame] ?? 0;
      const capturedSample = channel[capturedStart + frame] ?? 0;
      dot += referenceSample * capturedSample;
      referenceEnergy += referenceSample * referenceSample;
      capturedEnergy += capturedSample * capturedSample;
    }
  }
  if (!(referenceEnergy > 0) || !(capturedEnergy > 0)) return 0;
  return Math.min(1, Math.abs(dot) / Math.sqrt(referenceEnergy * capturedEnergy));
}

function scoreAllBursts(
  probe: RecordingLatencyProbe,
  channel: Float32Array,
  candidateOffset: number,
): number {
  let dot = 0;
  let referenceEnergy = 0;
  let capturedEnergy = 0;
  for (const burst of probe.bursts) {
    const referenceStart = burst.startFrame;
    const capturedStart = candidateOffset + referenceStart;
    const chipCount = burst.length / probe.chipFrames;
    const transitionFrames = Math.max(1, Math.ceil(probe.chipFrames / 2));
    const middleTap = Math.floor((transitionFrames - 1) / 2);
    const lastTap = probe.chipFrames - 1;
    for (let chip = 0; chip < chipCount; chip += 1) {
      for (let tap = 0; tap < 3; tap += 1) {
        const frameWithinChip = tap === 0 ? 0 : tap === 1 ? middleTap : lastTap;
        if (
          (tap === 1 && middleTap === 0)
          || (tap === 2 && (lastTap === 0 || lastTap === middleTap))
        ) {
          continue;
        }
        const frame = chip * probe.chipFrames + frameWithinChip;
        const referenceSample = probe.samples[referenceStart + frame] ?? 0;
        const capturedSample = channel[capturedStart + frame] ?? 0;
        dot += referenceSample * capturedSample;
        referenceEnergy += referenceSample * referenceSample;
        capturedEnergy += capturedSample * capturedSample;
      }
    }
  }
  if (!(referenceEnergy > 0) || !(capturedEnergy > 0)) return 0;
  return Math.min(1, Math.abs(dot) / Math.sqrt(referenceEnergy * capturedEnergy));
}

function scoreCandidateAtOffset(
  probe: RecordingLatencyProbe,
  channels: readonly Float32Array[],
  offset: number,
): Candidate {
  let bestChannelScore = 0;
  let bestChannelIndex = 0;
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const channel = channels[channelIndex];
    if (!channel) continue;
    const score = scoreAllBursts(probe, channel, offset);
    if (score > bestChannelScore) {
      bestChannelScore = score;
      bestChannelIndex = channelIndex;
    }
  }
  return { offset, score: bestChannelScore, channelIndex: bestChannelIndex };
}

function bestCandidateInRange(
  probe: RecordingLatencyProbe,
  channels: readonly Float32Array[],
  firstOffset: number,
  lastOffset: number,
): Readonly<{
  best: Candidate | null;
  scores: Float64Array;
}> {
  if (lastOffset < firstOffset) {
    return {
      best: null,
      scores: new Float64Array(0),
    };
  }
  const candidateCount = lastOffset - firstOffset + 1;
  const scores = new Float64Array(candidateCount);
  const coarseStep = Math.max(1, Math.floor(probe.chipFrames / 2));
  const coarseCandidates: Candidate[] = [];
  let best: Candidate | null = null;

  for (let offset = firstOffset; offset <= lastOffset; offset += coarseStep) {
    coarseCandidates.push(scoreCandidateAtOffset(probe, channels, offset));
  }
  if (coarseCandidates[coarseCandidates.length - 1]?.offset !== lastOffset) {
    coarseCandidates.push(scoreCandidateAtOffset(probe, channels, lastOffset));
  }

  const localPeaks = coarseCandidates.filter((candidate, index) =>
    candidate.score >= (coarseCandidates[index - 1]?.score ?? -1)
    && candidate.score >= (coarseCandidates[index + 1]?.score ?? -1)
  );
  localPeaks.sort((left, right) =>
    right.score === left.score ? left.offset - right.offset : right.score - left.score
  );
  const refinementPeaks = localPeaks.slice(0, MAX_REFINEMENT_PEAKS);
  if (refinementPeaks.length === 0 && coarseCandidates[0]) {
    refinementPeaks.push(coarseCandidates[0]);
  }

  for (const peak of refinementPeaks) {
    const refineFirst = Math.max(firstOffset, peak.offset - coarseStep);
    const refineLast = Math.min(lastOffset, peak.offset + coarseStep);
    for (let offset = refineFirst; offset <= refineLast; offset += 1) {
      const candidateIndex = offset - firstOffset;
      const candidate = scoreCandidateAtOffset(probe, channels, offset);
      scores[candidateIndex] = Math.max(scores[candidateIndex] ?? 0, candidate.score);
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
  }

  return { best, scores };
}

function secondPeak(
  scores: Float64Array,
  firstOffset: number,
  bestOffset: number,
  exclusionFrames: number,
): number {
  let second = 0;
  for (let index = 0; index < scores.length; index += 1) {
    const offset = firstOffset + index;
    if (Math.abs(offset - bestOffset) <= exclusionFrames) continue;
    second = Math.max(second, scores[index] ?? 0);
  }
  return second;
}

function findStrongOutsideCandidate(
  probe: RecordingLatencyProbe,
  channels: readonly Float32Array[],
  maximumOffset: number,
  acceptedFirstOffset: number,
  acceptedLastOffset: number,
): Candidate | null {
  const firstBurst = probe.bursts[0];
  if (!firstBurst) return null;
  const firstBurstCandidates: Candidate[] = [];

  const considerRange = (first: number, last: number): void => {
    const boundedFirst = Math.max(0, first);
    const boundedLast = Math.min(maximumOffset, last);
    for (let offset = boundedFirst; offset <= boundedLast; offset += 1) {
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        const channel = channels[channelIndex];
        if (!channel) continue;
        const score = scoreBurst(
          probe.samples,
          firstBurst,
          probe.chipFrames,
          channel,
          offset,
        );
        if (score >= MIN_BURST_CORRELATION) {
          firstBurstCandidates.push({ offset, score, channelIndex });
        }
      }
    }
  };

  if (acceptedFirstOffset > 0) considerRange(0, acceptedFirstOffset - 1);
  if (acceptedLastOffset < maximumOffset) {
    considerRange(acceptedLastOffset + 1, maximumOffset);
  }
  firstBurstCandidates.sort((left, right) =>
    right.score === left.score ? left.offset - right.offset : right.score - left.score
  );
  const diverseCandidates: Candidate[] = [];
  const separationFrames = Math.max(PEAK_EXCLUSION_FRAMES, probe.chipFrames);
  for (const candidate of firstBurstCandidates) {
    if (
      diverseCandidates.some((selected) =>
        selected.channelIndex === candidate.channelIndex
        && Math.abs(selected.offset - candidate.offset) <= separationFrames
      )
    ) {
      continue;
    }
    diverseCandidates.push(candidate);
    if (diverseCandidates.length >= MAX_REFINEMENT_PEAKS) break;
  }

  let bestFullCandidate: Candidate | null = null;
  for (const candidate of diverseCandidates) {
    const channel = channels[candidate.channelIndex];
    if (!channel) continue;
    const fullScore = scoreAllBursts(probe, channel, candidate.offset);
    if (!bestFullCandidate || fullScore > bestFullCandidate.score) {
      bestFullCandidate = { ...candidate, score: fullScore };
    }
  }
  return bestFullCandidate;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Find the physical output-to-input round trip in captured PCM.
 *
 * Correlation is polarity-independent and normalized per candidate, while all
 * independent PRBS bursts must agree. No project, device, or Web Audio state is
 * read by this function.
 */
export function analyzeRecordingLatency(
  input: AnalyzeRecordingLatencyInput,
): RecordingLatencyMeasurementResult {
  const sampleRate = input.sampleRate;
  if (!validSampleRate(sampleRate)) {
    return failure('invalid-sample-rate', 'The captured sample rate is invalid.');
  }
  const captureFirstContextFrame = input.captureFirstContextFrame ?? 0;
  const probeStartContextFrame = input.probeStartContextFrame ?? 0;
  if (
    !validContextFrame(captureFirstContextFrame)
    || !validContextFrame(probeStartContextFrame)
  ) {
    return failure('invalid-pcm', 'The capture clock coordinates are invalid.');
  }
  const maxLatencySeconds = input.maxLatencySeconds ?? MAX_RECORDING_LATENCY_SECONDS;
  if (
    !Number.isFinite(maxLatencySeconds)
    || maxLatencySeconds <= 0
    || maxLatencySeconds > MAX_RECORDING_LATENCY_SECONDS
  ) {
    return failure('invalid-pcm', 'The latency measurement range is invalid.');
  }

  let probe: RecordingLatencyProbe;
  try {
    probe = input.probe ?? createRecordingLatencyProbe(sampleRate);
  } catch {
    return failure('invalid-probe', 'The reference probe could not be created.');
  }
  const probeFailure = validateProbe(probe, sampleRate);
  if (probeFailure) return { ok: false, error: probeFailure };

  const channels = input.channels;
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    return failure('invalid-pcm', 'The capture must contain one or two channels.');
  }
  const firstChannel = channels[0];
  if (!(firstChannel instanceof Float32Array) || firstChannel.length <= 0) {
    return failure('empty-channel', 'The capture contains an empty channel.');
  }
  if (firstChannel.length > Math.ceil(sampleRate * MAX_RECORDING_LATENCY_ANALYSIS_SECONDS)) {
    return failure('invalid-pcm', 'The latency capture exceeds the bounded analysis window.');
  }
  let overallPeak = 0;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length <= 0) {
      return failure('empty-channel', 'The capture contains an empty channel.');
    }
    if (channel.length !== firstChannel.length) {
      return failure('channel-length-mismatch', 'The capture channels have different lengths.');
    }
    for (const sample of channel) {
      if (!Number.isFinite(sample)) {
        return failure('non-finite-pcm', 'The capture contains non-finite PCM.');
      }
      const magnitude = Math.abs(sample);
      overallPeak = Math.max(overallPeak, magnitude);
      if (magnitude >= CLIPPED_SAMPLE_MAGNITUDE) {
        return failure('clipped', 'The captured signal is clipped.');
      }
    }
  }
  if (overallPeak < SILENCE_PEAK_MAGNITUDE) {
    return failure('silence', 'No usable loopback signal was captured.');
  }

  const maximumCandidateOffset = firstChannel.length - probe.samples.length;
  if (maximumCandidateOffset < 0) {
    return failure('invalid-pcm', 'The capture is shorter than the reference probe.');
  }
  const relativeClockOffset = probeStartContextFrame - captureFirstContextFrame;
  const maxLatencyFrames = Math.floor(maxLatencySeconds * sampleRate);
  const acceptedFirstOffset = Math.max(0, relativeClockOffset);
  const acceptedLastOffset = Math.min(
    maximumCandidateOffset,
    relativeClockOffset + maxLatencyFrames,
  );
  if (
    !Number.isSafeInteger(relativeClockOffset)
    || !Number.isSafeInteger(acceptedFirstOffset)
    || !Number.isSafeInteger(acceptedLastOffset)
  ) {
    return failure('invalid-pcm', 'The capture clock range is invalid.');
  }

  const candidates = bestCandidateInRange(
    probe,
    channels,
    acceptedFirstOffset,
    acceptedLastOffset,
  );
  const best = candidates.best;
  const outside = findStrongOutsideCandidate(
    probe,
    channels,
    maximumCandidateOffset,
    acceptedFirstOffset,
    acceptedLastOffset,
  );
  if (!best) {
    if (outside && outside.score >= MIN_CORRELATION) {
      return failure('out-of-range', 'The measured latency exceeds 500 ms.');
    }
    return failure('low-confidence', 'No reliable loopback match was found.');
  }

  const bestChannel = channels[best.channelIndex];
  if (!bestChannel) {
    return failure('invalid-pcm', 'The selected capture channel is unavailable.');
  }
  const burstScores = probe.bursts.map((burst) =>
    scoreBurst(probe.samples, burst, probe.chipFrames, bestChannel, best.offset)
  );
  const minimumBurstScore = Math.min(...burstScores);
  const second = secondPeak(
    candidates.scores,
    acceptedFirstOffset,
    best.offset,
    Math.max(PEAK_EXCLUSION_FRAMES, Math.ceil(probe.chipFrames / 2)),
  );
  const outsideFullScore = outside?.score ?? 0;
  const competingPeak = Math.max(second, outsideFullScore);

  if (best.score < MIN_CORRELATION || minimumBurstScore < MIN_BURST_CORRELATION) {
    if (outsideFullScore >= MIN_CORRELATION) {
      return failure('out-of-range', 'The measured latency exceeds 500 ms.');
    }
    return failure('low-confidence', 'The loopback match is not reliable enough.');
  }
  if (
    competingPeak >= best.score * AMBIGUOUS_PEAK_RATIO
    && best.score - competingPeak <= AMBIGUOUS_PEAK_DIFFERENCE
  ) {
    return failure('ambiguous', 'More than one loopback delay matched the probe.');
  }

  const latencyFrames =
    captureFirstContextFrame + best.offset - probeStartContextFrame;
  if (
    !Number.isSafeInteger(latencyFrames)
    || latencyFrames < 0
    || latencyFrames > maxLatencyFrames
  ) {
    return failure('out-of-range', 'The measured latency exceeds 500 ms.');
  }
  const peakSeparationConfidence = competingPeak <= 0
    ? 1
    : (best.score - competingPeak) / AMBIGUOUS_PEAK_DIFFERENCE;
  const confidence = clampConfidence(
    Math.min(best.score, minimumBurstScore, peakSeparationConfidence),
  );

  return {
    ok: true,
    latencyFrames,
    roundTripLatencySeconds: latencyFrames / sampleRate,
    confidence,
    sampleRate,
    channelIndex: best.channelIndex,
    peakCorrelation: best.score,
    secondPeakCorrelation: competingPeak,
  };
}
