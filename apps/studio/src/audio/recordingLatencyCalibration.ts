import { getAudioEngine } from './engine';
import {
  MicrophoneCaptureError,
  startMicrophoneCapture,
  type MicrophoneCaptureSession,
  type StartMicrophoneCaptureOptions,
} from './microphoneCapture';
import {
  MAX_RECORDING_LATENCY_SECONDS,
  analyzeRecordingLatency,
  createRecordingLatencyProbe,
  type RecordingLatencyMeasurementFailureCode,
  type RecordingLatencyProbe,
} from './recordingLatencyMeasurement';
import { applyAudioParam } from './mixState';

const CALIBRATION_COUNTDOWN_SECONDS = 3;
const CALIBRATION_CAPTURE_TAIL_SECONDS = 0.2;
const MIN_CALIBRATION_CAPTURE_SECONDS = 0.75;
const CALIBRATION_MASTER_GAIN = 1;
export const MAX_RECORDING_LATENCY_CALIBRATION_CAPTURE_SECONDS = 1.95;

export const RECORDING_LATENCY_CALIBRATION_ERROR_CODES = [
  'cancelled',
  'unsupported',
  'insecure-context',
  'permission-denied',
  'device-not-found',
  'device-busy',
  'device-ended',
  'busy',
  'audio-context-failed',
  'synchronization-failed',
  'context-changed',
  'stale-operation',
  'probe-scheduling-failed',
  'capture-failed',
  'invalid-sample-rate',
  'invalid-probe',
  'invalid-pcm',
  'non-finite-pcm',
  'empty-channel',
  'channel-length-mismatch',
  'silence',
  'clipped',
  'ambiguous',
  'low-confidence',
  'out-of-range',
] as const;

export type RecordingLatencyCalibrationErrorCode =
  (typeof RECORDING_LATENCY_CALIBRATION_ERROR_CODES)[number];

export class RecordingLatencyCalibrationError extends Error {
  constructor(readonly code: RecordingLatencyCalibrationErrorCode) {
    super(code);
    this.name = 'RecordingLatencyCalibrationError';
  }
}

export type RecordingLatencyCalibrationOptions = Readonly<{
  signal?: AbortSignal;
  inputDeviceId?: string;
  onCountdown?: (secondsRemaining: number) => void;
  onPreparing?: () => void;
  onLevel?: (peak: number) => void;
}>;

export type RecordingLatencyCalibrationResult = Readonly<{
  latencyFrames: number;
  roundTripLatencySeconds: number;
  confidence: number;
  sampleRate: number;
  contextGeneration: number;
}>;

export type RecordingLatencyCalibrationAudioActivation = Readonly<{
  context: AudioContext;
  master: GainNode;
  contextGeneration: number;
}>;

export type RecordingLatencyCalibrationDependencies = Readonly<{
  /**
   * Must synchronously begin AudioContext activation when called. The returned
   * promise may settle later.
   */
  ensureContext: () => Promise<RecordingLatencyCalibrationAudioActivation>;
  startCapture: (
    options: StartMicrophoneCaptureOptions,
  ) => Promise<MicrophoneCaptureSession>;
  isContextCurrent: (context: AudioContext, contextGeneration: number) => boolean;
}>;

function calibrationError(
  code: RecordingLatencyCalibrationErrorCode,
): RecordingLatencyCalibrationError {
  return new RecordingLatencyCalibrationError(code);
}

function mapMicrophoneError(
  code: MicrophoneCaptureError['code'],
): RecordingLatencyCalibrationErrorCode {
  switch (code) {
    case 'cancelled':
    case 'unsupported':
    case 'insecure-context':
    case 'permission-denied':
    case 'device-not-found':
    case 'device-busy':
    case 'device-ended':
    case 'busy':
      return code;
    case 'synchronization-failed':
    case 'clock-discontinuity':
      return 'synchronization-failed';
    case 'sample-rate-out-of-range':
      return 'invalid-sample-rate';
    case 'too-short':
    case 'channel-limit-exceeded':
    case 'resource-limit-exceeded':
    case 'worklet-failed':
    case 'capture-failed':
      return 'capture-failed';
  }
}

function mapCalibrationError(error: unknown): RecordingLatencyCalibrationError {
  if (error instanceof RecordingLatencyCalibrationError) return error;
  if (error instanceof MicrophoneCaptureError) {
    return calibrationError(mapMicrophoneError(error.code));
  }
  return calibrationError('capture-failed');
}

function isMeasurementFailureCode(
  code: RecordingLatencyMeasurementFailureCode,
): code is Extract<
  RecordingLatencyCalibrationErrorCode,
  RecordingLatencyMeasurementFailureCode
> {
  switch (code) {
    case 'invalid-sample-rate':
    case 'invalid-probe':
    case 'invalid-pcm':
    case 'non-finite-pcm':
    case 'empty-channel':
    case 'channel-length-mismatch':
    case 'silence':
    case 'clipped':
    case 'ambiguous':
    case 'low-confidence':
    case 'out-of-range':
      return true;
  }
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function contextIsCurrent(
  dependencies: RecordingLatencyCalibrationDependencies,
  context: AudioContext,
  contextGeneration: number,
): boolean {
  try {
    return dependencies.isContextCurrent(context, contextGeneration);
  } catch {
    return false;
  }
}

function captureDurationSeconds(probe: RecordingLatencyProbe): number {
  return Math.min(
    MAX_RECORDING_LATENCY_CALIBRATION_CAPTURE_SECONDS,
    Math.max(
      MIN_CALIBRATION_CAPTURE_SECONDS,
      probe.durationSeconds
        + MAX_RECORDING_LATENCY_SECONDS
        + CALIBRATION_CAPTURE_TAIL_SECONDS,
    ),
  );
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw calibrationError('cancelled');
}

async function awaitActivationOrCancel(
  activation: Promise<RecordingLatencyCalibrationAudioActivation>,
  signal: AbortSignal | undefined,
): Promise<RecordingLatencyCalibrationAudioActivation> {
  throwIfCancelled(signal);
  if (!signal) return activation;

  let removeAbortListener = (): void => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(calibrationError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([activation, cancelled]);
  } finally {
    removeAbortListener();
  }
}

function stopAndDisconnectSource(source: AudioBufferSourceNode | null): void {
  if (!source) return;
  try {
    source.stop();
  } catch {
    // A source that failed before start, or already ended, can reject stop().
  }
  try {
    source.disconnect();
  } catch {
    // Context shutdown may already have disconnected the source.
  }
}

function normalizeCalibrationMasterGain(
  context: AudioContext,
  master: GainNode,
): () => void {
  const originalGain = master.gain.value;
  if (
    !Number.isFinite(originalGain)
    || originalGain < 0
    || originalGain > 2
    || !Number.isFinite(context.currentTime)
    || context.currentTime < 0
  ) {
    throw calibrationError('probe-scheduling-failed');
  }
  try {
    applyAudioParam(
      master.gain,
      CALIBRATION_MASTER_GAIN,
      context.currentTime,
      'immediate',
    );
  } catch {
    throw calibrationError('probe-scheduling-failed');
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      applyAudioParam(master.gain, originalGain, context.currentTime, 'immediate');
    } catch {
      try {
        master.gain.value = originalGain;
      } catch {
        // A torn-down context can reject both scheduled and direct restoration.
      }
    }
  };
}

function copyProbeToBuffer(
  context: AudioContext,
  probe: RecordingLatencyProbe,
): AudioBuffer {
  const buffer = context.createBuffer(1, probe.samples.length, probe.sampleRate);
  if (
    buffer.numberOfChannels !== 1
    || buffer.length !== probe.samples.length
    || buffer.sampleRate !== probe.sampleRate
  ) {
    throw calibrationError('probe-scheduling-failed');
  }
  try {
    buffer.getChannelData(0).set(probe.samples);
  } catch {
    try {
      const copy = new Float32Array(probe.samples);
      buffer.copyToChannel(copy, 0);
    } catch {
      throw calibrationError('probe-scheduling-failed');
    }
  }
  return buffer;
}

function chooseFutureStartFrame(
  context: AudioContext,
  sampleRate: number,
  renderQuantumSize: number,
  earliestStartFrame: number,
): number {
  if (
    !Number.isSafeInteger(renderQuantumSize)
    || renderQuantumSize <= 0
    || !Number.isSafeInteger(earliestStartFrame)
    || earliestStartFrame < 0
    || !Number.isFinite(context.currentTime)
    || context.currentTime < 0
  ) {
    throw calibrationError('synchronization-failed');
  }
  const currentFrame = Math.ceil(context.currentTime * sampleRate);
  const freshLeadFrames = Math.max(
    renderQuantumSize * 2,
    Math.ceil(sampleRate * 0.05),
  );
  const unalignedStart = Math.max(
    earliestStartFrame,
    currentFrame + freshLeadFrames,
  );
  const startFrame =
    Math.ceil(unalignedStart / renderQuantumSize) * renderQuantumSize;
  if (!Number.isSafeInteger(startFrame) || startFrame < earliestStartFrame) {
    throw calibrationError('synchronization-failed');
  }
  return startFrame;
}

async function completeRecordingLatencyCalibration(
  options: RecordingLatencyCalibrationOptions,
  dependencies: RecordingLatencyCalibrationDependencies,
  activationPromise: Promise<RecordingLatencyCalibrationAudioActivation>,
): Promise<RecordingLatencyCalibrationResult> {
  let activated: RecordingLatencyCalibrationAudioActivation | null = null;
  let source: AudioBufferSourceNode | null = null;
  let restoreMasterGain: (() => void) | null = null;
  let probeStartContextFrame: number | null = null;
  let synchronizationFailure: RecordingLatencyCalibrationError | null = null;

  try {
    try {
      activated = await awaitActivationOrCancel(activationPromise, options.signal);
    } catch (error) {
      if (error instanceof RecordingLatencyCalibrationError) throw error;
      throw calibrationError('audio-context-failed');
    }
    throwIfCancelled(options.signal);
    if (
      !validGeneration(activated.contextGeneration)
      || !contextIsCurrent(
        dependencies,
        activated.context,
        activated.contextGeneration,
      )
    ) {
      throw calibrationError('context-changed');
    }
    restoreMasterGain = normalizeCalibrationMasterGain(
      activated.context,
      activated.master,
    );

    let probe: RecordingLatencyProbe;
    try {
      probe = createRecordingLatencyProbe(activated.context.sampleRate);
    } catch {
      throw calibrationError('invalid-sample-rate');
    }

    const session = await dependencies.startCapture({
      signal: options.signal,
      countdownSeconds: CALIBRATION_COUNTDOWN_SECONDS,
      maxDurationSeconds: captureDurationSeconds(probe),
      ...(options.inputDeviceId === undefined
        ? {}
        : { inputDeviceId: options.inputDeviceId }),
      monitorInput: false,
      borrowedAudioContext: {
        context: activated.context,
        contextGeneration: activated.contextGeneration,
      },
      onCountdown: options.onCountdown,
      onPreparing: options.onPreparing,
      onLevel: options.onLevel,
      synchronize: async (synchronization) => {
        if (
          !activated
          || synchronization.context !== activated.context
          || synchronization.contextGeneration !== activated.contextGeneration
          || synchronization.sampleRate !== activated.context.sampleRate
          || !contextIsCurrent(
            dependencies,
            activated.context,
            activated.contextGeneration,
          )
        ) {
          synchronizationFailure = calibrationError('context-changed');
          throw synchronizationFailure;
        }
        try {
          const buffer = copyProbeToBuffer(activated.context, probe);
          source = activated.context.createBufferSource();
          source.buffer = buffer;
          source.connect(activated.master);
        } catch (error) {
          if (error instanceof RecordingLatencyCalibrationError) throw error;
          synchronizationFailure = calibrationError('probe-scheduling-failed');
          throw synchronizationFailure;
        }

        const startFrame = chooseFutureStartFrame(
          activated.context,
          synchronization.sampleRate,
          synchronization.renderQuantumSize,
          synchronization.earliestStartFrame,
        );
        const armAttempt = synchronization.armAtFrame(startFrame);
        try {
          source.start(startFrame / synchronization.sampleRate);
          probeStartContextFrame = startFrame;
        } catch {
          void armAttempt.catch(() => undefined);
          synchronizationFailure = calibrationError('probe-scheduling-failed');
          throw synchronizationFailure;
        }
        await armAttempt;
      },
    });

    const capture = await session.result;
    throwIfCancelled(options.signal);
    if (
      probeStartContextFrame === null
      || capture.contextGeneration !== activated.contextGeneration
      || capture.sampleRate !== activated.context.sampleRate
      || !contextIsCurrent(
        dependencies,
        activated.context,
        activated.contextGeneration,
      )
    ) {
      throw calibrationError('context-changed');
    }

    const channels = Array.from(
      { length: capture.numberOfChannels },
      (_unused, channelIndex) => capture.getChannelData(channelIndex),
    );
    const measurement = analyzeRecordingLatency({
      sampleRate: capture.sampleRate,
      channels,
      captureFirstContextFrame: capture.firstContextFrame,
      probeStartContextFrame,
      probe,
    });
    if (!measurement.ok) {
      const code = measurement.error.code;
      if (isMeasurementFailureCode(code)) throw calibrationError(code);
      throw calibrationError('capture-failed');
    }

    return {
      latencyFrames: measurement.latencyFrames,
      roundTripLatencySeconds: measurement.roundTripLatencySeconds,
      confidence: measurement.confidence,
      sampleRate: measurement.sampleRate,
      contextGeneration: activated.contextGeneration,
    };
  } catch (error) {
    if (synchronizationFailure) throw synchronizationFailure;
    if (
      options.signal?.aborted
      && !(error instanceof RecordingLatencyCalibrationError
        && error.code === 'context-changed')
    ) {
      throw calibrationError('cancelled');
    }
    if (
      activated
      && !contextIsCurrent(
        dependencies,
        activated.context,
        activated.contextGeneration,
      )
    ) {
      throw calibrationError('context-changed');
    }
    throw mapCalibrationError(error);
  } finally {
    stopAndDisconnectSource(source);
    restoreMasterGain?.();
  }
}

/**
 * Injectable entry point. `ensureContext()` is invoked before this function
 * returns so production callers preserve browser user-gesture authorization.
 */
export function startRecordingLatencyCalibrationWithDependencies(
  options: RecordingLatencyCalibrationOptions,
  dependencies: RecordingLatencyCalibrationDependencies,
): Promise<RecordingLatencyCalibrationResult> {
  let activation: Promise<RecordingLatencyCalibrationAudioActivation>;
  try {
    activation = dependencies.ensureContext();
  } catch {
    activation = Promise.reject(calibrationError('audio-context-failed'));
  }
  void activation.catch(() => undefined);
  return completeRecordingLatencyCalibration(options, dependencies, activation);
}

/**
 * Start physical output-to-input latency calibration from a user click.
 *
 * AudioContext activation begins synchronously in this call stack. The probe is
 * always routed through Master, while microphone monitoring is always disabled.
 */
export function startRecordingLatencyCalibration(
  options: RecordingLatencyCalibrationOptions = {},
): Promise<RecordingLatencyCalibrationResult> {
  const engine = getAudioEngine();
  return startRecordingLatencyCalibrationWithDependencies(options, {
    ensureContext: () => engine.ensureContext(),
    startCapture: startMicrophoneCapture,
    isContextCurrent: (context, contextGeneration) =>
      engine.audioContext === context
      && engine.contextGeneration === contextGeneration,
  });
}
