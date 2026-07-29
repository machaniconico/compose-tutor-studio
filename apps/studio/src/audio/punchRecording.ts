import {
  secondsBetweenBeats,
  type MusicalTimeIndex,
} from '@cts/project-model';

export const MIN_PUNCH_RECORDING_SECONDS = 0.5;
export const MAX_PUNCH_RECORDING_SECONDS = 60;
export const MIN_PUNCH_RECORDING_SAMPLE_RATE = 8_000;
export const MAX_PUNCH_RECORDING_SAMPLE_RATE = 192_000;

export type PunchRecordingPlanErrorCode =
  | 'invalid-musical-time'
  | 'invalid-range'
  | 'invalid-order'
  | 'project-bounds'
  | 'invalid-sample-rate'
  | 'invalid-latency'
  | 'duration-limit';

export type PunchRecordingPlanError = Readonly<{
  code: PunchRecordingPlanErrorCode;
  message: string;
}>;

export type PunchRecordingPlanInput = Readonly<{
  musicalTime: MusicalTimeIndex;
  /** Playback anchor. May equal punch-in when no pre-roll is requested. */
  playbackStartBeat: number;
  punchInBeat: number;
  punchOutBeat: number;
  /** Natural playback end. May equal punch-out when no post-roll is requested. */
  playbackEndBeat: number;
  sampleRate: number;
  /** Net automatic + manual compensation. Positive values place input earlier. */
  latencyCompensationSeconds: number;
}>;

export type PunchRecordingPlan = Readonly<{
  playbackStartBeat: number;
  punchInBeat: number;
  punchOutBeat: number;
  playbackEndBeat: number;
  sampleRate: number;
  punchDurationSeconds: number;
  playbackDurationSeconds: number;
  /** Capture arm offset from the shared playback anchor. */
  captureStartOffsetFrames: number;
  /** Punch-out offset from the shared playback anchor. */
  punchEndOffsetFrames: number;
  /** Natural post-roll completion offset from the shared playback anchor. */
  playbackEndOffsetFrames: number;
  /** Exact half-open punch window after cumulative boundary rounding. */
  punchFrameCount: number;
  /** Canonical output length. Always identical to `punchFrameCount`. */
  outputFrameCount: number;
  /** Positive values trim later; negative values delay audio with leading silence. */
  latencyFrames: number;
  /** First retained source frame relative to the punch capture arm. */
  captureSourceStartFrame: number;
  captureSourceEndFrameExclusive: number;
  captureSourceFrameCount: number;
  /** Zero-valued frames prepended for negative latency compensation. */
  leadingSilenceFrames: number;
  /** Capture length, including only the tail needed by positive compensation. */
  effectiveCaptureFrameCount: number;
}>;

export type PunchRecordingPlanResult =
  | Readonly<{ ok: true; plan: PunchRecordingPlan }>
  | Readonly<{ ok: false; error: PunchRecordingPlanError }>;

export type PunchRecordingExtractionErrorCode =
  | 'invalid-plan'
  | 'invalid-capture';

export type PunchRecordingExtractionError = Readonly<{
  code: PunchRecordingExtractionErrorCode;
  message: string;
}>;

export type PunchRecordingExtraction = Readonly<{
  channels: readonly Float32Array[];
  frameCount: number;
  sampleRate: number;
  durationSeconds: number;
}>;

export type PunchRecordingExtractionResult =
  | Readonly<{ ok: true; output: PunchRecordingExtraction }>
  | Readonly<{ ok: false; error: PunchRecordingExtractionError }>;

function planFailure(
  code: PunchRecordingPlanErrorCode,
  message: string,
): PunchRecordingPlanResult {
  return { ok: false, error: { code, message } };
}

function extractionFailure(
  code: PunchRecordingExtractionErrorCode,
  message: string,
): PunchRecordingExtractionResult {
  return { ok: false, error: { code, message } };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Plan one bounded automatic-punch capture without reading a clock or PCM.
 *
 * Every boundary is rounded from cumulative elapsed time relative to the same
 * playback anchor. The punch length is then the difference between the rounded
 * boundaries, so a variable-tempo map cannot introduce a one-frame disagreement
 * between transport scheduling and capture extraction.
 */
export function planPunchRecording(
  input: PunchRecordingPlanInput,
): PunchRecordingPlanResult {
  if (
    !Number.isFinite(input.musicalTime.lengthBeats)
    || input.musicalTime.lengthBeats <= 0
    || input.musicalTime.tempoSegments.length === 0
  ) {
    return planFailure(
      'invalid-musical-time',
      'Punch recording requires a valid musical-time index.',
    );
  }

  const boundaries = [
    input.playbackStartBeat,
    input.punchInBeat,
    input.punchOutBeat,
    input.playbackEndBeat,
  ];
  if (boundaries.some((beat) => !Number.isFinite(beat))) {
    return planFailure(
      'invalid-range',
      'Punch and playback boundaries must be finite beats.',
    );
  }
  if (boundaries.some((beat) => (
    beat < 0 || beat > input.musicalTime.lengthBeats
  ))) {
    return planFailure(
      'project-bounds',
      'Punch and playback boundaries must stay inside the project timeline.',
    );
  }
  if (
    input.playbackStartBeat > input.punchInBeat
    || input.punchInBeat >= input.punchOutBeat
    || input.punchOutBeat > input.playbackEndBeat
  ) {
    return planFailure(
      'invalid-order',
      'Expected playback start ≤ punch-in < punch-out ≤ playback end.',
    );
  }
  if (
    !isPositiveSafeInteger(input.sampleRate)
    || input.sampleRate < MIN_PUNCH_RECORDING_SAMPLE_RATE
    || input.sampleRate > MAX_PUNCH_RECORDING_SAMPLE_RATE
  ) {
    return planFailure(
      'invalid-sample-rate',
      `Punch recording sample rate must be an integer between ${MIN_PUNCH_RECORDING_SAMPLE_RATE} and ${MAX_PUNCH_RECORDING_SAMPLE_RATE}.`,
    );
  }
  if (!Number.isFinite(input.latencyCompensationSeconds)) {
    return planFailure(
      'invalid-latency',
      'Punch recording latency compensation must be finite.',
    );
  }

  let punchInOffsetSeconds: number;
  let punchOutOffsetSeconds: number;
  let playbackDurationSeconds: number;
  let punchDurationSeconds: number;
  try {
    punchInOffsetSeconds = secondsBetweenBeats(
      input.musicalTime,
      input.playbackStartBeat,
      input.punchInBeat,
    );
    punchOutOffsetSeconds = secondsBetweenBeats(
      input.musicalTime,
      input.playbackStartBeat,
      input.punchOutBeat,
    );
    playbackDurationSeconds = secondsBetweenBeats(
      input.musicalTime,
      input.playbackStartBeat,
      input.playbackEndBeat,
    );
    punchDurationSeconds = secondsBetweenBeats(
      input.musicalTime,
      input.punchInBeat,
      input.punchOutBeat,
    );
  } catch {
    return planFailure(
      'invalid-musical-time',
      'The punch range could not be mapped through the tempo map.',
    );
  }
  if (
    !Number.isFinite(punchInOffsetSeconds)
    || punchInOffsetSeconds < 0
    || !Number.isFinite(punchOutOffsetSeconds)
    || punchOutOffsetSeconds <= punchInOffsetSeconds
    || !Number.isFinite(playbackDurationSeconds)
    || playbackDurationSeconds < punchOutOffsetSeconds
    || !Number.isFinite(punchDurationSeconds)
    || punchDurationSeconds <= 0
  ) {
    return planFailure(
      'invalid-musical-time',
      'The tempo map produced invalid punch or playback durations.',
    );
  }

  const captureStartOffsetFrames = Math.round(
    punchInOffsetSeconds * input.sampleRate,
  );
  const punchEndOffsetFrames = Math.round(
    punchOutOffsetSeconds * input.sampleRate,
  );
  const playbackEndOffsetFrames = Math.round(
    playbackDurationSeconds * input.sampleRate,
  );
  const punchFrameCount = punchEndOffsetFrames - captureStartOffsetFrames;
  const latencyFrames = Math.round(
    input.latencyCompensationSeconds * input.sampleRate,
  );
  if (
    !isNonNegativeSafeInteger(captureStartOffsetFrames)
    || !isPositiveSafeInteger(punchEndOffsetFrames)
    || !isNonNegativeSafeInteger(playbackEndOffsetFrames)
    || punchEndOffsetFrames > playbackEndOffsetFrames
    || !isPositiveSafeInteger(punchFrameCount)
  ) {
    return planFailure(
      'duration-limit',
      'Punch or playback duration cannot be represented safely in frames.',
    );
  }
  if (!Number.isSafeInteger(latencyFrames)) {
    return planFailure(
      'invalid-latency',
      'Punch recording latency cannot be represented safely in frames.',
    );
  }

  const leadingSilenceFrames = Math.max(0, -latencyFrames);
  if (
    !isNonNegativeSafeInteger(leadingSilenceFrames)
    || leadingSilenceFrames >= punchFrameCount
  ) {
    return planFailure(
      'invalid-latency',
      'Negative latency compensation must leave source audio in the punch window.',
    );
  }
  const captureSourceStartFrame = Math.max(0, latencyFrames);
  const captureSourceFrameCount = punchFrameCount - leadingSilenceFrames;
  const captureSourceEndFrameExclusive =
    captureSourceStartFrame + captureSourceFrameCount;
  const effectiveCaptureFrameCount =
    punchFrameCount + Math.max(0, latencyFrames);
  if (
    !isNonNegativeSafeInteger(captureSourceStartFrame)
    || !isPositiveSafeInteger(captureSourceFrameCount)
    || !isPositiveSafeInteger(captureSourceEndFrameExclusive)
    || !isPositiveSafeInteger(effectiveCaptureFrameCount)
    || captureSourceEndFrameExclusive > effectiveCaptureFrameCount
  ) {
    return planFailure(
      'invalid-latency',
      'Latency compensation produced an unsafe punch source window.',
    );
  }

  const minimumCaptureFrames = Math.ceil(
    MIN_PUNCH_RECORDING_SECONDS * input.sampleRate,
  );
  const maximumCaptureFrames = Math.floor(
    MAX_PUNCH_RECORDING_SECONDS * input.sampleRate,
  );
  if (
    effectiveCaptureFrameCount < minimumCaptureFrames
    || effectiveCaptureFrameCount > maximumCaptureFrames
  ) {
    return planFailure(
      'duration-limit',
      `Punch capture, including a positive latency tail, must be between ${MIN_PUNCH_RECORDING_SECONDS} and ${MAX_PUNCH_RECORDING_SECONDS} seconds.`,
    );
  }

  return {
    ok: true,
    plan: Object.freeze({
      playbackStartBeat: input.playbackStartBeat,
      punchInBeat: input.punchInBeat,
      punchOutBeat: input.punchOutBeat,
      playbackEndBeat: input.playbackEndBeat,
      sampleRate: input.sampleRate,
      punchDurationSeconds,
      playbackDurationSeconds,
      captureStartOffsetFrames,
      punchEndOffsetFrames,
      playbackEndOffsetFrames,
      punchFrameCount,
      outputFrameCount: punchFrameCount,
      latencyFrames,
      captureSourceStartFrame,
      captureSourceEndFrameExclusive,
      captureSourceFrameCount,
      leadingSilenceFrames,
      effectiveCaptureFrameCount,
    }),
  };
}

/**
 * Extract canonical, exact-length punch PCM from a completed bounded capture.
 *
 * The input buffers are never mutated or retained. Negative compensation leaves
 * zeroes at the start; positive compensation selects later input frames.
 */
export function extractPunchRecording(
  plan: PunchRecordingPlan,
  captureChannels: readonly Float32Array[],
): PunchRecordingExtractionResult {
  if (
    !isPositiveSafeInteger(plan.sampleRate)
    || !isPositiveSafeInteger(plan.outputFrameCount)
    || plan.outputFrameCount !== plan.punchFrameCount
    || !isNonNegativeSafeInteger(plan.leadingSilenceFrames)
    || !isNonNegativeSafeInteger(plan.captureSourceStartFrame)
    || !isPositiveSafeInteger(plan.captureSourceFrameCount)
    || !isPositiveSafeInteger(plan.captureSourceEndFrameExclusive)
    || plan.captureSourceEndFrameExclusive
      !== plan.captureSourceStartFrame + plan.captureSourceFrameCount
    || plan.outputFrameCount
      !== plan.leadingSilenceFrames + plan.captureSourceFrameCount
    || !isPositiveSafeInteger(plan.effectiveCaptureFrameCount)
    || plan.captureSourceEndFrameExclusive > plan.effectiveCaptureFrameCount
  ) {
    return extractionFailure(
      'invalid-plan',
      'The punch extraction plan is internally inconsistent.',
    );
  }
  if (
    captureChannels.length === 0
    || captureChannels.some((channel) => (
      !(channel instanceof Float32Array)
      || channel.length !== plan.effectiveCaptureFrameCount
    ))
  ) {
    return extractionFailure(
      'invalid-capture',
      'Every capture channel must exactly match the planned bounded capture length.',
    );
  }

  const channels = captureChannels.map((channel) => {
    const output = new Float32Array(plan.outputFrameCount);
    output.set(
      channel.subarray(
        plan.captureSourceStartFrame,
        plan.captureSourceEndFrameExclusive,
      ),
      plan.leadingSilenceFrames,
    );
    return output;
  });

  return {
    ok: true,
    output: Object.freeze({
      channels: Object.freeze(channels),
      frameCount: plan.outputFrameCount,
      sampleRate: plan.sampleRate,
      durationSeconds: plan.outputFrameCount / plan.sampleRate,
    }),
  };
}
