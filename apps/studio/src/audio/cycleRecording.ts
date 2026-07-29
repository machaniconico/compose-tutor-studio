import {
  MAX_AUDIO_TAKES_PER_FOLDER,
  secondsBetweenBeats,
  type MusicalTimeIndex,
} from '@cts/project-model';

export const MIN_CYCLE_RECORDING_TAKES = 2;
export const MAX_CYCLE_RECORDING_TAKES = MAX_AUDIO_TAKES_PER_FOLDER;
/** Mirrors the microphone capture settle contract for a usable final capture. */
export const MIN_CYCLE_RECORDING_SECONDS = 0.5;
export const MAX_CYCLE_RECORDING_SECONDS = 60;
export const MIN_CYCLE_RECORDING_SAMPLE_RATE = 8_000;
export const MAX_CYCLE_RECORDING_SAMPLE_RATE = 192_000;

export type CycleRecordingPlanErrorCode =
  | 'invalid-musical-time'
  | 'invalid-loop'
  | 'invalid-pass-count'
  | 'invalid-sample-rate'
  | 'invalid-latency'
  | 'duration-limit';

export type CycleRecordingPlanError = Readonly<{
  code: CycleRecordingPlanErrorCode;
  message: string;
}>;

export type CycleRecordingPassWindow = Readonly<{
  /** Zero-based capture order. */
  passIndex: number;
  /** Nominal finite-loop playback window, relative to the shared capture anchor. */
  cycleStartFrame: number;
  cycleEndFrameExclusive: number;
  /**
   * Half-open source window retained from the one continuous microphone capture.
   * Windows remain ordered and disjoint after latency compensation.
   */
  captureSourceStartFrame: number;
  captureSourceEndFrameExclusive: number;
  captureSourceFrameCount: number;
  /** Zero-valued frames to prepend before canonicalizing a negative-latency pass. */
  leadingSilenceFrames: number;
  /** Canonical per-take length after optional leading-silence padding. */
  outputFrameCount: number;
}>;

export type CycleRecordingPlan = Readonly<{
  loopStartBeat: number;
  loopEndBeat: number;
  loopDurationSeconds: number;
  passCount: number;
  sampleRate: number;
  /** Positive values trim later; negative values delay audio with leading silence. */
  latencyCompensationFrames: number;
  /** Playback stops at this frame after the requested finite number of passes. */
  cycleFrameCount: number;
  /** Capture continues past playback only for a positive latency tail. */
  effectiveCaptureFrameCount: number;
  /** Cumulatively rounded nominal pass boundaries, including 0 and the final end. */
  passBoundariesFrames: readonly number[];
  passes: readonly CycleRecordingPassWindow[];
}>;

export type CycleRecordingPlanInput = Readonly<{
  musicalTime: MusicalTimeIndex;
  loopStartBeat: number;
  loopEndBeat: number;
  passCount: number;
  sampleRate: number;
  /** Net automatic + manual compensation. Positive values place input earlier. */
  latencyCompensationSeconds: number;
}>;

export type CycleRecordingPlanResult =
  | Readonly<{ ok: true; plan: CycleRecordingPlan }>
  | Readonly<{ ok: false; error: CycleRecordingPlanError }>;

function failure(
  code: CycleRecordingPlanErrorCode,
  message: string,
): CycleRecordingPlanResult {
  return { ok: false, error: { code, message } };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Plan one bounded, fixed-pass cycle capture without reading a clock or PCM.
 *
 * Pass boundaries are rounded from cumulative elapsed time instead of
 * multiplying one rounded pass length. This prevents one sub-frame rounding
 * error from accumulating on every lap.
 */
export function planCycleRecording(
  input: CycleRecordingPlanInput,
): CycleRecordingPlanResult {
  if (
    !Number.isFinite(input.musicalTime.lengthBeats)
    || input.musicalTime.lengthBeats <= 0
    || input.musicalTime.tempoSegments.length === 0
  ) {
    return failure(
      'invalid-musical-time',
      'Cycle recording requires a valid musical-time index.',
    );
  }
  if (
    !Number.isFinite(input.loopStartBeat)
    || !Number.isFinite(input.loopEndBeat)
    || input.loopStartBeat < 0
    || input.loopEndBeat <= input.loopStartBeat
    || input.loopEndBeat > input.musicalTime.lengthBeats
  ) {
    return failure(
      'invalid-loop',
      'The cycle range must be a non-empty window inside the project timeline.',
    );
  }
  if (
    !Number.isSafeInteger(input.passCount)
    || input.passCount < MIN_CYCLE_RECORDING_TAKES
    || input.passCount > MAX_CYCLE_RECORDING_TAKES
  ) {
    return failure(
      'invalid-pass-count',
      `Cycle recording requires between ${MIN_CYCLE_RECORDING_TAKES} and ${MAX_CYCLE_RECORDING_TAKES} passes.`,
    );
  }
  if (
    !isPositiveSafeInteger(input.sampleRate)
    || input.sampleRate < MIN_CYCLE_RECORDING_SAMPLE_RATE
    || input.sampleRate > MAX_CYCLE_RECORDING_SAMPLE_RATE
  ) {
    return failure(
      'invalid-sample-rate',
      `Cycle recording sample rate must be an integer between ${MIN_CYCLE_RECORDING_SAMPLE_RATE} and ${MAX_CYCLE_RECORDING_SAMPLE_RATE}.`,
    );
  }
  if (!Number.isFinite(input.latencyCompensationSeconds)) {
    return failure(
      'invalid-latency',
      'Cycle recording latency compensation must be finite.',
    );
  }

  let loopDurationSeconds: number;
  try {
    loopDurationSeconds = secondsBetweenBeats(
      input.musicalTime,
      input.loopStartBeat,
      input.loopEndBeat,
    );
  } catch {
    return failure(
      'invalid-musical-time',
      'The cycle range could not be mapped through the tempo map.',
    );
  }
  if (!Number.isFinite(loopDurationSeconds) || loopDurationSeconds <= 0) {
    return failure(
      'invalid-loop',
      'The cycle range must have a positive finite duration.',
    );
  }

  const exactPassFrames = loopDurationSeconds * input.sampleRate;
  const exactCycleFrames = exactPassFrames * input.passCount;
  const latencyCompensationFrames = Math.round(
    input.latencyCompensationSeconds * input.sampleRate,
  );
  if (
    !Number.isFinite(exactPassFrames)
    || exactPassFrames <= 0
    || !Number.isFinite(exactCycleFrames)
    || !Number.isSafeInteger(Math.round(exactCycleFrames))
    || !Number.isSafeInteger(latencyCompensationFrames)
  ) {
    return failure(
      'invalid-latency',
      'The cycle duration or latency cannot be represented safely in frames.',
    );
  }

  const passBoundariesFrames = Array.from(
    { length: input.passCount + 1 },
    (_, index) => Math.round(exactPassFrames * index),
  );
  if (
    passBoundariesFrames.some((boundary) => (
      !Number.isSafeInteger(boundary) || boundary < 0
    ))
  ) {
    return failure(
      'duration-limit',
      'The cumulative cycle boundaries exceed the safe frame range.',
    );
  }

  const leadingSilenceFrames = Math.max(0, -latencyCompensationFrames);
  const passes: CycleRecordingPassWindow[] = [];
  for (let passIndex = 0; passIndex < input.passCount; passIndex += 1) {
    const cycleStartFrame = passBoundariesFrames[passIndex];
    const cycleEndFrameExclusive = passBoundariesFrames[passIndex + 1];
    if (cycleStartFrame === undefined || cycleEndFrameExclusive === undefined) {
      return failure('duration-limit', 'The cumulative cycle boundaries are incomplete.');
    }
    const outputFrameCount = cycleEndFrameExclusive - cycleStartFrame;
    if (
      outputFrameCount <= 0
      || leadingSilenceFrames >= outputFrameCount
    ) {
      return failure(
        leadingSilenceFrames > 0 ? 'invalid-latency' : 'invalid-loop',
        leadingSilenceFrames > 0
          ? 'Negative latency compensation must leave source audio in every pass.'
          : 'Every cycle pass must contain at least one frame.',
      );
    }

    const captureSourceStartFrame = latencyCompensationFrames > 0
      ? cycleStartFrame + latencyCompensationFrames
      : cycleStartFrame;
    const captureSourceFrameCount = outputFrameCount - leadingSilenceFrames;
    const captureSourceEndFrameExclusive =
      captureSourceStartFrame + captureSourceFrameCount;
    if (
      !Number.isSafeInteger(captureSourceStartFrame)
      || !Number.isSafeInteger(captureSourceEndFrameExclusive)
      || captureSourceStartFrame < 0
      || captureSourceEndFrameExclusive <= captureSourceStartFrame
    ) {
      return failure(
        'invalid-latency',
        'Latency compensation produced an invalid pass source window.',
      );
    }
    passes.push(Object.freeze({
      passIndex,
      cycleStartFrame,
      cycleEndFrameExclusive,
      captureSourceStartFrame,
      captureSourceEndFrameExclusive,
      captureSourceFrameCount,
      leadingSilenceFrames,
      outputFrameCount,
    }));
  }

  const cycleFrameCount = passBoundariesFrames.at(-1) ?? 0;
  const effectiveCaptureFrameCount = cycleFrameCount
    + Math.max(0, latencyCompensationFrames);
  const maximumCaptureFrames = Math.floor(
    MAX_CYCLE_RECORDING_SECONDS * input.sampleRate,
  );
  const minimumCaptureFrames = Math.ceil(
    MIN_CYCLE_RECORDING_SECONDS * input.sampleRate,
  );
  if (
    !isPositiveSafeInteger(cycleFrameCount)
    || !isPositiveSafeInteger(effectiveCaptureFrameCount)
    || effectiveCaptureFrameCount < minimumCaptureFrames
    || effectiveCaptureFrameCount > maximumCaptureFrames
  ) {
    return failure(
      'duration-limit',
      `Cycle capture, including positive latency tail, must be between ${MIN_CYCLE_RECORDING_SECONDS} and ${MAX_CYCLE_RECORDING_SECONDS} seconds.`,
    );
  }
  if (passes.some((pass) => (
    pass.captureSourceEndFrameExclusive > effectiveCaptureFrameCount
  ))) {
    return failure(
      'invalid-latency',
      'A compensated pass source window exceeds the bounded capture.',
    );
  }

  return {
    ok: true,
    plan: Object.freeze({
      loopStartBeat: input.loopStartBeat,
      loopEndBeat: input.loopEndBeat,
      loopDurationSeconds,
      passCount: input.passCount,
      sampleRate: input.sampleRate,
      latencyCompensationFrames,
      cycleFrameCount,
      effectiveCaptureFrameCount,
      passBoundariesFrames: Object.freeze(passBoundariesFrames),
      passes: Object.freeze(passes),
    }),
  };
}
