import {
  beatToSecondsAt,
  secondsToBeatAt,
  type MusicalTimeIndex,
} from '@cts/project-model';

const BEAT_ROUNDING_FACTOR = 1_000_000_000_000;
const INTEGER_ROUNDING_ULPS = 8;

export type RecordingAlignmentErrorCode =
  | 'invalid-anchor'
  | 'invalid-capture-range'
  | 'invalid-sample-rate'
  | 'invalid-canonical-range'
  | 'invalid-latency'
  | 'invalid-musical-time'
  | 'all-frames-trimmed';

export type RecordingAlignmentError = Readonly<{
  code: RecordingAlignmentErrorCode;
  message: string;
}>;

export type SynchronizedRecordingPlacementInput = Readonly<{
  /** Project beat scheduled at `playbackAnchorFrame` on the shared audio clock. */
  musicalTime: MusicalTimeIndex;
  playbackAnchorBeat: number;
  playbackAnchorFrame: number;
  /** First retained capture frame on the same shared audio clock. */
  captureFirstFrame: number;
  captureFrameCount: number;
  captureSampleRate: number;
  /** Final persisted asset shape after canonicalization/resampling. */
  canonicalFrameCount: number;
  canonicalSampleRate: number;
  /** Non-negative host/input estimate. Positive compensation places audio earlier. */
  automaticEstimatedLatencySeconds?: number | null;
  /** Positive values place audio earlier; negative values deliberately place it later. */
  manualOffsetMilliseconds?: number;
}>;

export type SynchronizedRecordingPlacement = Readonly<{
  /** Values passed directly to createAudioTrackClip/appendAudioTrackClip. */
  startBeat: number;
  sourceStartFrame: number;
  sourceFrameCount: number;
  /** Capture-clock offset from the scheduled playback anchor. */
  captureStartOffsetSeconds: number;
  /** Automatic estimate plus the signed manual offset. */
  latencyCompensationSeconds: number;
  /** Timeline start before latency compensation. */
  uncompensatedStartSeconds: number;
  /** Requested timeline start before the project-start clamp. */
  compensatedStartSeconds: number;
  /** Actual non-negative timeline start represented by `startBeat`. */
  placedStartSeconds: number;
  clampedAtProjectStart: boolean;
}>;

export type SynchronizedRecordingPlacementResult =
  | Readonly<{ ok: true; placement: SynchronizedRecordingPlacement }>
  | Readonly<{ ok: false; error: RecordingAlignmentError }>;

function failure(
  code: RecordingAlignmentErrorCode,
  message: string,
): SynchronizedRecordingPlacementResult {
  return { ok: false, error: { code, message } };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function roundedComputedBeat(value: number): number {
  const rounded = Math.round(value * BEAT_ROUNDING_FACTOR) / BEAT_ROUNDING_FACTOR;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Ceil a positive frame position while treating machine-error-sized distances
 * from an integer as that integer. This makes project-start trimming stable
 * across engines without retaining a genuinely pre-zero source sample.
 */
function deterministicFrameCeil(value: number): number {
  const nearest = Math.round(value);
  const tolerance = Number.EPSILON
    * Math.max(1, Math.abs(value))
    * INTEGER_ROUNDING_ULPS;
  return Math.abs(value - nearest) <= tolerance ? nearest : Math.ceil(value);
}

/**
 * Convert a shared playback/capture clock snapshot into an atomic Audio Clip
 * placement. No clock is read here: callers must snapshot every input from the
 * same AudioContext generation before canonicalizing the recorded PCM.
 */
export function planSynchronizedRecordingPlacement(
  input: SynchronizedRecordingPlacementInput,
): SynchronizedRecordingPlacementResult {
  if (
    !Number.isFinite(input.musicalTime.lengthBeats)
    || input.musicalTime.lengthBeats < 0
  ) {
    return failure('invalid-musical-time', 'The project musical-time index is invalid.');
  }
  if (
    !Number.isFinite(input.playbackAnchorBeat)
    || input.playbackAnchorBeat < 0
    || input.playbackAnchorBeat > input.musicalTime.lengthBeats
    || !isNonNegativeSafeInteger(input.playbackAnchorFrame)
  ) {
    return failure(
      'invalid-anchor',
      'The playback anchor requires an in-project beat and a non-negative safe frame.',
    );
  }
  if (
    !isNonNegativeSafeInteger(input.captureFirstFrame)
    || !Number.isSafeInteger(input.captureFrameCount)
    || input.captureFrameCount <= 0
    || !Number.isSafeInteger(input.captureFirstFrame + input.captureFrameCount)
  ) {
    return failure(
      'invalid-capture-range',
      'The capture requires a non-empty safe frame range on the shared audio clock.',
    );
  }
  if (
    !Number.isSafeInteger(input.captureSampleRate)
    || input.captureSampleRate <= 0
    || !Number.isSafeInteger(input.canonicalSampleRate)
    || input.canonicalSampleRate <= 0
  ) {
    return failure(
      'invalid-sample-rate',
      'Capture and canonical sample rates must be positive safe integers.',
    );
  }
  if (
    !Number.isSafeInteger(input.canonicalFrameCount)
    || input.canonicalFrameCount <= 0
  ) {
    return failure(
      'invalid-canonical-range',
      'The canonical asset requires a non-empty safe frame range.',
    );
  }

  const automaticEstimatedLatencySeconds =
    input.automaticEstimatedLatencySeconds ?? 0;
  const manualOffsetMilliseconds = input.manualOffsetMilliseconds ?? 0;
  if (
    !Number.isFinite(automaticEstimatedLatencySeconds)
    || automaticEstimatedLatencySeconds < 0
    || !Number.isFinite(manualOffsetMilliseconds)
  ) {
    return failure(
      'invalid-latency',
      'Automatic latency must be non-negative and the manual offset must be finite.',
    );
  }
  const latencyCompensationSeconds = automaticEstimatedLatencySeconds
    + manualOffsetMilliseconds / 1_000;
  if (!Number.isFinite(latencyCompensationSeconds)) {
    return failure('invalid-latency', 'The combined latency compensation is out of range.');
  }

  let anchorSeconds: number;
  try {
    anchorSeconds = beatToSecondsAt(input.musicalTime, input.playbackAnchorBeat);
  } catch {
    return failure('invalid-musical-time', 'The playback anchor could not be mapped to time.');
  }
  const captureStartOffsetSeconds = (
    input.captureFirstFrame - input.playbackAnchorFrame
  ) / input.captureSampleRate;
  const uncompensatedStartSeconds = anchorSeconds + captureStartOffsetSeconds;
  const compensatedStartSeconds = uncompensatedStartSeconds
    - latencyCompensationSeconds;
  if (
    !Number.isFinite(anchorSeconds)
    || !Number.isFinite(captureStartOffsetSeconds)
    || !Number.isFinite(uncompensatedStartSeconds)
    || !Number.isFinite(compensatedStartSeconds)
  ) {
    return failure('invalid-musical-time', 'The recording placement is outside the time domain.');
  }

  const clampedAtProjectStart = compensatedStartSeconds < 0;
  const placedStartSeconds = clampedAtProjectStart ? 0 : compensatedStartSeconds;
  let startBeat: number;
  try {
    startBeat = roundedComputedBeat(secondsToBeatAt(input.musicalTime, placedStartSeconds));
  } catch {
    return failure('invalid-musical-time', 'The recording start could not be mapped to a beat.');
  }
  if (!Number.isFinite(startBeat) || startBeat < 0) {
    return failure('invalid-musical-time', 'The recording start produced an invalid beat.');
  }

  let sourceStartFrame = 0;
  if (clampedAtProjectStart) {
    const exactTrimFrames = -compensatedStartSeconds * input.canonicalSampleRate;
    sourceStartFrame = deterministicFrameCeil(exactTrimFrames);
    if (!Number.isSafeInteger(sourceStartFrame) || sourceStartFrame < 0) {
      return failure('invalid-canonical-range', 'The compensated source trim is out of range.');
    }
  }
  if (sourceStartFrame >= input.canonicalFrameCount) {
    return failure(
      'all-frames-trimmed',
      'Latency compensation would trim every frame from the recorded asset.',
    );
  }

  return {
    ok: true,
    placement: {
      startBeat,
      sourceStartFrame,
      sourceFrameCount: input.canonicalFrameCount - sourceStartFrame,
      captureStartOffsetSeconds,
      latencyCompensationSeconds,
      uncompensatedStartSeconds,
      compensatedStartSeconds,
      placedStartSeconds,
      clampedAtProjectStart,
    },
  };
}
