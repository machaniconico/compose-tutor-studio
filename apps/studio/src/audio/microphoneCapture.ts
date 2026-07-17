import microphoneCaptureWorkletUrl from './microphoneCapture.worklet.ts?worker&url';
import { MAX_MICROPHONE_INPUT_DEVICE_ID_LENGTH } from './microphoneInputDevices';

export const MAX_MICROPHONE_CAPTURE_SECONDS = 60;
export const MAX_MICROPHONE_CAPTURE_CHANNELS = 2;
export const MAX_MICROPHONE_CAPTURE_SAMPLE_RATE = 192_000;
export const MAX_MICROPHONE_CAPTURE_PCM_BYTES = 96 * 1024 * 1024;
/** Chunk storage + final contiguous PCM + bounded capture/runtime overhead. */
export const MICROPHONE_CAPTURE_RESERVATION_BYTES =
  MAX_MICROPHONE_CAPTURE_PCM_BYTES * 2 + 16 * 1024 * 1024;
export const MIN_MICROPHONE_CAPTURE_SECONDS = 0.5;

const PROCESSOR_NAME = 'cts-humming-microphone-capture';
const WORKLET_CHUNK_FRAMES = 4_096;
const FLUSH_TIMEOUT_MS = 2_000;

export type MicrophoneCaptureErrorCode =
  | 'unsupported'
  | 'insecure-context'
  | 'permission-denied'
  | 'device-not-found'
  | 'device-busy'
  | 'device-ended'
  | 'busy'
  | 'cancelled'
  | 'too-short'
  | 'sample-rate-out-of-range'
  | 'channel-limit-exceeded'
  | 'resource-limit-exceeded'
  | 'synchronization-failed'
  | 'clock-discontinuity'
  | 'worklet-failed'
  | 'capture-failed';

export class MicrophoneCaptureError extends Error {
  constructor(readonly code: MicrophoneCaptureErrorCode) {
    super(code);
    this.name = 'MicrophoneCaptureError';
  }
}

export type MicrophonePcmCapture = Readonly<{
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  durationSeconds: number;
  stopReason: 'manual' | 'duration-limit';
  /** Generation supplied by the shared AudioContext owner, or a standalone generation. */
  contextGeneration: number;
  /** Shared AudioContext frame of the first retained PCM sample. */
  firstContextFrame: number;
  /** Exclusive shared AudioContext frame immediately after the final retained sample. */
  endContextFrameExclusive: number;
  /** Input-track latency snapshot in seconds. Missing/invalid host estimates become null. */
  inputLatencySeconds: number | null;
  getChannelData: (channel: number) => Float32Array;
}>;

export type MicrophoneCaptureSession = Readonly<{
  startedAt: number;
  maxDurationSeconds: number;
  result: Promise<MicrophonePcmCapture>;
  elapsedSeconds: () => number;
  stop: () => Promise<MicrophonePcmCapture>;
  cancel: () => void;
}>;

type CaptureGraphHandlers = Readonly<{
  onReady: (ready: WorkletReadyMessage) => void;
  onArmed: (armed: WorkletArmedMessage) => void;
  onChunk: (
    channels: readonly Float32Array[],
    peak: number,
    timing: Readonly<{ sequence: number; firstContextFrame: number }>,
  ) => void;
  onStopped: (stopped: WorkletStoppedMessage) => void;
  onError: (code?: string) => void;
}>;

type CaptureGraph = Readonly<{
  arm: (startFrame: number, maximumFrames: number) => void;
  flush: () => void;
  disconnect: () => void;
}>;

export type MicrophoneCaptureGraphOptions = Readonly<{
  /** Route the live input to the output device. Keep false unless the user opts in. */
  monitorInput: boolean;
}>;

export type MicrophoneCapturePlatform = Readonly<{
  secureContext: boolean;
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | null;
  workletSupported: boolean;
  workletModuleUrl: string;
  createAudioContext: () => AudioContext;
  addWorkletModule: (context: AudioContext, url: string) => Promise<void>;
  createGraph: (
    context: AudioContext,
    stream: MediaStream,
    handlers: CaptureGraphHandlers,
    options: MicrophoneCaptureGraphOptions,
  ) => CaptureGraph;
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}>;

export type BorrowedMicrophoneAudioContext = Readonly<{
  /** Context remains owned by the caller and is never closed by microphone capture. */
  context: AudioContext;
  /** Monotonic generation that changes whenever the owner replaces its context. */
  contextGeneration: number;
}>;

export type MicrophoneCaptureSynchronization = Readonly<{
  context: AudioContext;
  contextGeneration: number;
  sampleRate: number;
  renderQuantumSize: number;
  /** Future, render-quantum-aligned candidate. The coordinator may choose a later frame. */
  earliestStartFrame: number;
  /** Arms the Worklet once and resolves only after its rendering-thread acknowledgement. */
  armAtFrame: (startFrame: number) => Promise<void>;
}>;

export type StartMicrophoneCaptureOptions = Readonly<{
  signal?: AbortSignal;
  countdownSeconds?: number;
  maxDurationSeconds?: number;
  /** Omit (or pass an empty id) to use the host's default audio input. */
  inputDeviceId?: string;
  onCountdown?: (secondsRemaining: number) => void;
  /** Countdown finished; the capture graph is being prepared and synchronized. */
  onPreparing?: () => void;
  onLevel?: (peak: number) => void;
  /** Live input monitoring. Disabled by default to avoid speaker feedback. */
  monitorInput?: boolean;
  /** Borrow the playback AudioContext so capture and transport use one audio clock. */
  borrowedAudioContext?: BorrowedMicrophoneAudioContext;
  /** Choose the exact future capture frame. Omit for legacy standalone auto-arm behavior. */
  synchronize?: (
    synchronization: MicrophoneCaptureSynchronization,
  ) => void | Promise<void>;
  /** Deterministic test seam. Production callers must omit this. */
  platform?: MicrophoneCapturePlatform;
}>;

type WorkletChunkMessage = Readonly<{
  type: 'chunk';
  sequence: number;
  firstContextFrame: number;
  channelCount: number;
  frameCount: number;
  peak: number;
  channels: readonly ArrayBuffer[];
}>;

type WorkletReadyMessage = Readonly<{
  type: 'ready';
  currentFrame: number;
  renderQuantumSize: number;
}>;

type WorkletArmedMessage = Readonly<{
  type: 'armed';
  startFrame: number;
  endFrameExclusive: number;
  observedFrame: number;
}>;

type WorkletStoppedMessage = Readonly<{
  type: 'stopped';
  reason: 'manual' | 'duration-limit';
  firstContextFrame: number | null;
  endContextFrameExclusive: number | null;
}>;

let activeCaptureToken: symbol | null = null;
let standaloneContextGeneration = 0;
const loadedWorkletModules = new WeakMap<AudioContext, Promise<void>>();

function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function releaseCaptureToken(token: symbol): void {
  if (activeCaptureToken === token) activeCaptureToken = null;
}

function safeContextFrame(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function workletReadyMessage(value: unknown): WorkletReadyMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<WorkletReadyMessage>;
  if (
    candidate.type !== 'ready'
    || !safeContextFrame(candidate.currentFrame)
    || !Number.isSafeInteger(candidate.renderQuantumSize)
    || (candidate.renderQuantumSize ?? 0) <= 0
    || (candidate.renderQuantumSize ?? 65_537) > 65_536
  ) return null;
  return candidate as WorkletReadyMessage;
}

function workletArmedMessage(value: unknown): WorkletArmedMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<WorkletArmedMessage>;
  if (
    candidate.type !== 'armed'
    || !safeContextFrame(candidate.startFrame)
    || !safeContextFrame(candidate.endFrameExclusive)
    || !safeContextFrame(candidate.observedFrame)
    || (candidate.endFrameExclusive ?? 0) <= (candidate.startFrame ?? 0)
    || (candidate.observedFrame ?? Number.MAX_SAFE_INTEGER) > (candidate.startFrame ?? -1)
  ) return null;
  return candidate as WorkletArmedMessage;
}

function workletStoppedMessage(value: unknown): WorkletStoppedMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<WorkletStoppedMessage>;
  const first = candidate.firstContextFrame;
  const end = candidate.endContextFrameExclusive;
  if (
    candidate.type !== 'stopped'
    || (candidate.reason !== 'manual' && candidate.reason !== 'duration-limit')
    || !(
      (first === null && end === null)
      || (safeContextFrame(first) && safeContextFrame(end) && end > first)
    )
  ) return null;
  return candidate as WorkletStoppedMessage;
}

function workletChunkMessage(value: unknown): WorkletChunkMessage | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const candidate = value as Partial<WorkletChunkMessage>;
  if (
    candidate.type !== 'chunk' ||
    !Number.isSafeInteger(candidate.sequence) ||
    (candidate.sequence ?? -1) < 0 ||
    !safeContextFrame(candidate.firstContextFrame) ||
    !Number.isSafeInteger(candidate.channelCount) ||
    (candidate.channelCount ?? 0) < 1 ||
    (candidate.channelCount ?? 0) > MAX_MICROPHONE_CAPTURE_CHANNELS ||
    !Number.isSafeInteger(candidate.frameCount) ||
    (candidate.frameCount ?? 0) <= 0 ||
    (candidate.frameCount ?? WORKLET_CHUNK_FRAMES + 1) > WORKLET_CHUNK_FRAMES ||
    !Number.isFinite(candidate.peak) ||
    (candidate.peak ?? -1) < 0 ||
    (candidate.peak ?? 2) > 1 ||
    !Array.isArray(candidate.channels) ||
    candidate.channels.length !== candidate.channelCount
  ) {
    return null;
  }
  const frameCount = candidate.frameCount;
  if (frameCount === undefined) return null;
  const expectedBytes = frameCount * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    candidate.channels.some(
      (channel) => !(channel instanceof ArrayBuffer) || channel.byteLength !== expectedBytes,
    )
  ) {
    return null;
  }
  return candidate as WorkletChunkMessage;
}

function createBrowserGraph(
  context: AudioContext,
  stream: MediaStream,
  handlers: CaptureGraphHandlers,
  options: MicrophoneCaptureGraphOptions,
): CaptureGraph {
  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      chunkFrames: WORKLET_CHUNK_FRAMES,
      maxChannels: MAX_MICROPHONE_CAPTURE_CHANNELS,
    },
  });
  const monitorOutput = context.createGain();
  monitorOutput.gain.value = options.monitorInput ? 1 : 0;

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== 'object' || event.data === null || !('type' in event.data)) {
      handlers.onError();
      return;
    }
    if (event.data.type === 'ready') {
      const ready = workletReadyMessage(event.data);
      if (ready) handlers.onReady(ready);
      else handlers.onError();
      return;
    }
    if (event.data.type === 'armed') {
      const armed = workletArmedMessage(event.data);
      if (armed) handlers.onArmed(armed);
      else handlers.onError();
      return;
    }
    if (event.data.type === 'stopped') {
      const stopped = workletStoppedMessage(event.data);
      if (stopped) handlers.onStopped(stopped);
      else handlers.onError();
      return;
    }
    if (event.data.type === 'error') {
      const code = 'code' in event.data && typeof event.data.code === 'string'
        ? event.data.code
        : undefined;
      handlers.onError(code);
      return;
    }
    const chunk = workletChunkMessage(event.data);
    if (!chunk) {
      handlers.onError();
      return;
    }
    handlers.onChunk(
      chunk.channels.map((channel) => new Float32Array(channel)),
      chunk.peak,
      { sequence: chunk.sequence, firstContextFrame: chunk.firstContextFrame },
    );
  };
  const onProcessorError = (): void => handlers.onError('processor-error');
  worklet.port.addEventListener('message', onMessage);
  worklet.port.start();
  worklet.addEventListener('processorerror', onProcessorError);
  source.connect(worklet);
  worklet.connect(monitorOutput);
  monitorOutput.connect(context.destination);

  let disconnected = false;
  return {
    arm(startFrame, maximumFrames): void {
      if (!disconnected) {
        worklet.port.postMessage({ type: 'arm', startFrame, maximumFrames });
      }
    },
    flush(): void {
      if (!disconnected) worklet.port.postMessage({ type: 'stop' });
    },
    disconnect(): void {
      if (disconnected) return;
      disconnected = true;
      worklet.port.removeEventListener('message', onMessage);
      worklet.removeEventListener('processorerror', onProcessorError);
      worklet.port.close();
      for (const node of [source, worklet, monitorOutput]) {
        try {
          node.disconnect();
        } catch {
          // Cleanup is best-effort after the graph has already been isolated.
        }
      }
    },
  };
}

function addWorkletModuleOnce(
  platform: MicrophoneCapturePlatform,
  context: AudioContext,
): Promise<void> {
  const existing = loadedWorkletModules.get(context);
  if (existing) return existing;
  const loading = platform.addWorkletModule(context, platform.workletModuleUrl);
  loadedWorkletModules.set(context, loading);
  void loading.catch(() => {
    if (loadedWorkletModules.get(context) === loading) loadedWorkletModules.delete(context);
  });
  return loading;
}

function browserPlatform(): MicrophoneCapturePlatform {
  const mediaDevices = typeof navigator === 'undefined'
    ? null
    : navigator.mediaDevices ?? null;
  return {
    secureContext: globalThis.isSecureContext === true,
    mediaDevices,
    workletSupported: typeof AudioWorkletNode !== 'undefined',
    workletModuleUrl: microphoneCaptureWorkletUrl,
    createAudioContext: () => {
      try {
        return new AudioContext({ sampleRate: 48_000 });
      } catch {
        return new AudioContext();
      }
    },
    addWorkletModule: (context, url) => context.audioWorklet.addModule(url),
    createGraph: createBrowserGraph,
    now: () => performance.now(),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (timer) => clearTimeout(timer),
  };
}

function platformIsSupported(platform: MicrophoneCapturePlatform): boolean {
  return Boolean(
    platform.secureContext &&
    platform.mediaDevices &&
    platform.workletSupported &&
    typeof platform.createAudioContext === 'function',
  );
}

export function isMicrophoneCaptureSupported(
  platform: MicrophoneCapturePlatform = browserPlatform(),
): boolean {
  return platformIsSupported(platform);
}

function mappedCaptureError(error: unknown): MicrophoneCaptureError {
  if (error instanceof MicrophoneCaptureError) return error;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return new MicrophoneCaptureError('permission-denied');
      case 'NotFoundError':
      case 'OverconstrainedError':
        return new MicrophoneCaptureError('device-not-found');
      case 'NotReadableError':
      case 'AbortError':
        return new MicrophoneCaptureError('device-busy');
      case 'SecurityError':
        return new MicrophoneCaptureError('insecure-context');
      default:
        break;
    }
  }
  return new MicrophoneCaptureError('capture-failed');
}

function countdownValue(value: number | undefined): number {
  const resolved = value ?? 3;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 10) {
    throw new MicrophoneCaptureError('capture-failed');
  }
  return resolved;
}

function durationValue(value: number | undefined): number {
  const resolved = value ?? MAX_MICROPHONE_CAPTURE_SECONDS;
  if (
    !Number.isFinite(resolved) ||
    resolved < MIN_MICROPHONE_CAPTURE_SECONDS ||
    resolved > MAX_MICROPHONE_CAPTURE_SECONDS
  ) {
    throw new MicrophoneCaptureError('capture-failed');
  }
  return resolved;
}

function awaitSetupOrCancel<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new MicrophoneCaptureError('cancelled'));
    };
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForCountdownTick(
  platform: MicrophoneCapturePlatform,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: MicrophoneCaptureError): void => {
      if (timer !== null) platform.clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new MicrophoneCaptureError('cancelled'));
    if (signal?.aborted) {
      finish(new MicrophoneCaptureError('cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = platform.setTimer(() => finish(), 1_000);
  });
}

async function permissionStream(
  platform: MicrophoneCapturePlatform,
  signal: AbortSignal | undefined,
  token: symbol,
  inputDeviceId: string | undefined,
  sampleRate: number,
): Promise<{ stream: MediaStream | null; deferredRelease: boolean }> {
  if (!platform.mediaDevices) throw new MicrophoneCaptureError('unsupported');
  if (signal?.aborted) throw new MicrophoneCaptureError('cancelled');
  const audioConstraints: MediaTrackConstraints & Readonly<{
    latency: Readonly<{ ideal: number }>;
  }> = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: sampleRate },
    latency: { ideal: 0 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
    ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
  };
  const request = platform.mediaDevices.getUserMedia({
    video: false,
    audio: audioConstraints,
  });
  if (!signal) return { stream: await request, deferredRelease: false };

  const deferRequestCleanup = (): void => {
    void request.then(
      (stream) => stopStream(stream),
      () => undefined,
    ).finally(() => releaseCaptureToken(token));
  };
  if (signal.aborted) {
    deferRequestCleanup();
    return { stream: null, deferredRelease: true };
  }

  let removeAbort = (): void => undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    const onAbort = (): void => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', onAbort);
  });
  const outcome = await Promise.race([
    request.then((stream) => ({ stream }) as const),
    aborted,
  ]);
  removeAbort();
  if (outcome === 'aborted') {
    deferRequestCleanup();
    return { stream: null, deferredRelease: true };
  }
  if (signal.aborted) {
    stopStream(outcome.stream);
    throw new MicrophoneCaptureError('cancelled');
  }
  return { stream: outcome.stream, deferredRelease: false };
}

function concatenateChannels(
  chunks: readonly (readonly Float32Array[])[],
  channelCount: number,
  totalFrames: number,
): readonly Float32Array[] {
  try {
    return Array.from({ length: channelCount }, (_, channelIndex) => {
      const output = new Float32Array(totalFrames);
      let offset = 0;
      for (const chunk of chunks) {
        const channel = chunk[channelIndex];
        if (!channel || offset + channel.length > totalFrames) {
          throw new MicrophoneCaptureError('capture-failed');
        }
        output.set(channel, offset);
        offset += channel.length;
      }
      if (offset !== totalFrames) throw new MicrophoneCaptureError('capture-failed');
      return output;
    });
  } catch (error) {
    if (error instanceof MicrophoneCaptureError) throw error;
    throw new MicrophoneCaptureError('resource-limit-exceeded');
  }
}

export async function startMicrophoneCapture(
  options: StartMicrophoneCaptureOptions = {},
): Promise<MicrophoneCaptureSession> {
  const platform = options.platform ?? browserPlatform();
  if (!platform.secureContext) throw new MicrophoneCaptureError('insecure-context');
  if (!platformIsSupported(platform)) throw new MicrophoneCaptureError('unsupported');
  const countdownSeconds = countdownValue(options.countdownSeconds);
  const maxDurationSeconds = durationValue(options.maxDurationSeconds);
  const inputDeviceId = options.inputDeviceId;
  if (
    inputDeviceId !== undefined
    && (
      typeof inputDeviceId !== 'string'
      || inputDeviceId.length > MAX_MICROPHONE_INPUT_DEVICE_ID_LENGTH
    )
  ) {
    throw new MicrophoneCaptureError('device-not-found');
  }
  const borrowed = options.borrowedAudioContext;
  if (
    borrowed !== undefined
    && (
      typeof borrowed !== 'object'
      || borrowed === null
      || typeof borrowed.context !== 'object'
      || borrowed.context === null
      || !Number.isSafeInteger(borrowed.contextGeneration)
      || borrowed.contextGeneration < 0
    )
  ) {
    throw new MicrophoneCaptureError('synchronization-failed');
  }
  if (activeCaptureToken) throw new MicrophoneCaptureError('busy');

  const token = Symbol('microphone-capture');
  activeCaptureToken = token;
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let graph: CaptureGraph | null = null;
  let deferredRelease = false;
  const ownsContext = borrowed === undefined;
  let contextGeneration = borrowed?.contextGeneration ?? 0;

  try {
    if (options.signal?.aborted) throw new MicrophoneCaptureError('cancelled');
    context = borrowed?.context ?? platform.createAudioContext();
    if (ownsContext) {
      standaloneContextGeneration = standaloneContextGeneration >= Number.MAX_SAFE_INTEGER
        ? 1
        : standaloneContextGeneration + 1;
      contextGeneration = standaloneContextGeneration;
    }
    if (
      !Number.isSafeInteger(context.sampleRate) ||
      context.sampleRate < 8_000 ||
      context.sampleRate > MAX_MICROPHONE_CAPTURE_SAMPLE_RATE
    ) {
      throw new MicrophoneCaptureError('sample-rate-out-of-range');
    }
    const maximumFrames = Math.floor(maxDurationSeconds * context.sampleRate);
    const maximumPcmBytes =
      maximumFrames * MAX_MICROPHONE_CAPTURE_CHANNELS * Float32Array.BYTES_PER_ELEMENT;
    if (
      !Number.isSafeInteger(maximumFrames) ||
      maximumFrames <= 0 ||
      !Number.isSafeInteger(maximumPcmBytes) ||
      maximumPcmBytes > MAX_MICROPHONE_CAPTURE_PCM_BYTES
    ) {
      throw new MicrophoneCaptureError('resource-limit-exceeded');
    }
    if (context.state !== 'running') {
      await awaitSetupOrCancel(context.resume(), options.signal);
    }
    await awaitSetupOrCancel(
      addWorkletModuleOnce(platform, context),
      options.signal,
    );
    const permission = await permissionStream(
      platform,
      options.signal,
      token,
      inputDeviceId,
      context.sampleRate,
    );
    deferredRelease = permission.deferredRelease;
    stream = permission.stream;
    if (!stream) throw new MicrophoneCaptureError('cancelled');

    const tracks = stream.getAudioTracks();
    if (tracks.length < 1) throw new MicrophoneCaptureError('device-not-found');
    if (tracks.some((track) => track.readyState === 'ended')) {
      throw new MicrophoneCaptureError('device-ended');
    }
    if (
      tracks.some((track) => {
        const channels = track.getSettings().channelCount;
        return channels !== undefined && channels > MAX_MICROPHONE_CAPTURE_CHANNELS;
      })
    ) {
      throw new MicrophoneCaptureError('channel-limit-exceeded');
    }
    const reportedInputLatency = (
      tracks[0]?.getSettings() as (MediaTrackSettings & { latency?: unknown }) | undefined
    )?.latency;
    const inputLatencySeconds = typeof reportedInputLatency === 'number'
      && Number.isFinite(reportedInputLatency)
      && reportedInputLatency >= 0
      ? reportedInputLatency
      : null;

    for (let remaining = countdownSeconds; remaining > 0; remaining -= 1) {
      options.onCountdown?.(remaining);
      await waitForCountdownTick(platform, options.signal);
      if (tracks.some((track) => track.readyState === 'ended')) {
        throw new MicrophoneCaptureError('device-ended');
      }
    }
    if (options.signal?.aborted) throw new MicrophoneCaptureError('cancelled');
    if (tracks.some((track) => track.readyState === 'ended')) {
      throw new MicrophoneCaptureError('device-ended');
    }
    options.onPreparing?.();

    const chunks: Array<readonly Float32Array[]> = [];
    let channelCount = 0;
    let totalFrames = 0;
    let firstContextFrame: number | null = null;
    let expectedNextContextFrame: number | null = null;
    let expectedSequence = 0;
    let state: 'recording' | 'stopping' | 'finalizing' | 'settled' = 'recording';
    let stopReason: MicrophonePcmCapture['stopReason'] = 'manual';
    let automaticTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let armedStartFrame: number | null = null;
    const startedAt = platform.now();
    let resolveResult!: (capture: MicrophonePcmCapture) => void;
    let rejectResult!: (error: MicrophoneCaptureError) => void;
    const result = new Promise<MicrophonePcmCapture>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Setup can fail before the session promise is returned. Keep that original
    // promise observable without allowing an unhandled-rejection report.
    void result.catch(() => undefined);

    let resolveReady!: (ready: WorkletReadyMessage) => void;
    let rejectReady!: (error: MicrophoneCaptureError) => void;
    const readyResult = new Promise<WorkletReadyMessage>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let resolveArmed!: (armed: WorkletArmedMessage) => void;
    let rejectArmed!: (error: MicrophoneCaptureError) => void;
    const armedResult = new Promise<WorkletArmedMessage>((resolve, reject) => {
      resolveArmed = resolve;
      rejectArmed = reject;
    });
    let setupSettled = false;
    const failSetup = (error: MicrophoneCaptureError): void => {
      if (setupSettled) return;
      rejectReady(error);
      rejectArmed(error);
    };

    const removeEndedListeners = (): void => {
      for (const track of tracks) track.removeEventListener('ended', onTrackEnded);
    };
    const closeResources = async (): Promise<void> => {
      if (automaticTimer !== null) platform.clearTimer(automaticTimer);
      if (flushTimer !== null) platform.clearTimer(flushTimer);
      options.signal?.removeEventListener('abort', onSignalAbort);
      removeEndedListeners();
      graph?.disconnect();
      graph = null;
      stopStream(stream);
      stream = null;
      const closing = context;
      context = null;
      if (closing && ownsContext) await closing.close().catch(() => undefined);
      releaseCaptureToken(token);
    };
    const settleError = (error: MicrophoneCaptureError): void => {
      if (state === 'finalizing' || state === 'settled') return;
      state = 'finalizing';
      failSetup(error);
      void closeResources().finally(() => {
        state = 'settled';
        rejectResult(error);
      });
    };
    const settleCapture = (): void => {
      if (state === 'finalizing' || state === 'settled') return;
      state = 'finalizing';
      let capture: MicrophonePcmCapture;
      try {
        if (
          channelCount < 1
          || firstContextFrame === null
          || expectedNextContextFrame === null
          || expectedNextContextFrame - firstContextFrame !== totalFrames
          || totalFrames < context!.sampleRate * MIN_MICROPHONE_CAPTURE_SECONDS
        ) {
          throw new MicrophoneCaptureError('too-short');
        }
        const channels = concatenateChannels(chunks, channelCount, totalFrames);
        chunks.length = 0;
        const sampleRate = context!.sampleRate;
        capture = {
          numberOfChannels: channelCount,
          length: totalFrames,
          sampleRate,
          durationSeconds: totalFrames / sampleRate,
          stopReason,
          contextGeneration,
          firstContextFrame,
          endContextFrameExclusive: expectedNextContextFrame,
          inputLatencySeconds,
          getChannelData(channel: number): Float32Array {
            const samples = channels[channel];
            if (!samples) throw new MicrophoneCaptureError('channel-limit-exceeded');
            return samples;
          },
        };
      } catch (error) {
        state = 'stopping';
        settleError(mappedCaptureError(error));
        return;
      }
      void closeResources().finally(() => {
        state = 'settled';
        resolveResult(capture);
      });
    };
    const requestStop = (reason: MicrophonePcmCapture['stopReason']): void => {
      if (state !== 'recording') return;
      state = 'stopping';
      stopReason = reason;
      if (automaticTimer !== null) {
        platform.clearTimer(automaticTimer);
        automaticTimer = null;
      }
      try {
        graph?.flush();
      } catch {
        settleError(new MicrophoneCaptureError('worklet-failed'));
        return;
      }
      flushTimer = platform.setTimer(
        () => settleError(new MicrophoneCaptureError('worklet-failed')),
        FLUSH_TIMEOUT_MS,
      );
    };
    const onTrackEnded = (): void => {
      if (state === 'recording') settleError(new MicrophoneCaptureError('device-ended'));
    };
    const onSignalAbort = (): void => settleError(new MicrophoneCaptureError('cancelled'));

    graph = platform.createGraph(context, stream, {
      onReady(ready): void {
        resolveReady(ready);
      },
      onArmed(armed): void {
        if (
          armedStartFrame === null
          || armed.startFrame !== armedStartFrame
          || armed.endFrameExclusive !== armedStartFrame + maximumFrames
        ) {
          settleError(new MicrophoneCaptureError('synchronization-failed'));
          return;
        }
        resolveArmed(armed);
      },
      onChunk(nextChannels, peak, timing): void {
        if (state !== 'recording' && state !== 'stopping') return;
        if (
          nextChannels.length < 1 ||
          nextChannels.length > MAX_MICROPHONE_CAPTURE_CHANNELS ||
          nextChannels.some((channel) => channel.length !== nextChannels[0]?.length)
        ) {
          settleError(new MicrophoneCaptureError('capture-failed'));
          return;
        }
        if (
          timing.sequence !== expectedSequence
          || !safeContextFrame(timing.firstContextFrame)
          || (
            expectedNextContextFrame === null
            && (
              armedStartFrame === null
              || timing.firstContextFrame !== armedStartFrame
            )
          )
          || (
            expectedNextContextFrame !== null
            && timing.firstContextFrame !== expectedNextContextFrame
          )
        ) {
          settleError(new MicrophoneCaptureError('clock-discontinuity'));
          return;
        }
        if (channelCount === 0) channelCount = nextChannels.length;
        if (nextChannels.length !== channelCount) {
          settleError(new MicrophoneCaptureError('channel-limit-exceeded'));
          return;
        }
        const frameCount = nextChannels[0]?.length ?? 0;
        const acceptedFrames = Math.min(frameCount, maximumFrames - totalFrames);
        if (acceptedFrames > 0) {
          if (firstContextFrame === null) firstContextFrame = timing.firstContextFrame;
          chunks.push(
            acceptedFrames === frameCount
              ? nextChannels
              : nextChannels.map((channel) => channel.slice(0, acceptedFrames)),
          );
          totalFrames += acceptedFrames;
          expectedNextContextFrame = timing.firstContextFrame + acceptedFrames;
          expectedSequence += 1;
          try {
            options.onLevel?.(peak);
          } catch {
            // Presentation callbacks cannot break capture ownership or cleanup.
          }
        }
        if (totalFrames >= maximumFrames) requestStop('duration-limit');
      },
      onStopped(stopped): void {
        if (state !== 'recording' && state !== 'stopping') return;
        const stopWasRequested = state === 'stopping';
        if (
          (totalFrames === 0
            ? stopped.firstContextFrame !== null || stopped.endContextFrameExclusive !== null
            : stopped.firstContextFrame !== firstContextFrame
              || stopped.endContextFrameExclusive !== expectedNextContextFrame)
        ) {
          settleError(new MicrophoneCaptureError('clock-discontinuity'));
          return;
        }
        if (!stopWasRequested) stopReason = stopped.reason;
        settleCapture();
      },
      onError(code): void {
        let captureCode: MicrophoneCaptureErrorCode = 'worklet-failed';
        if (code === 'channel-limit-exceeded' || code === 'channel-layout-changed') {
          captureCode = 'channel-limit-exceeded';
        } else if (code === 'clock-discontinuity') {
          captureCode = 'clock-discontinuity';
        } else if (code === 'arm-frame-passed' || code === 'invalid-arm') {
          captureCode = 'synchronization-failed';
        }
        settleError(
          new MicrophoneCaptureError(captureCode),
        );
      },
    }, { monitorInput: options.monitorInput === true });
    for (const track of tracks) track.addEventListener('ended', onTrackEnded);
    options.signal?.addEventListener('abort', onSignalAbort, { once: true });

    const ready = await awaitSetupOrCancel(readyResult, options.signal);
    const currentTimeFrames = Number.isFinite(context.currentTime)
      ? Math.ceil(Math.max(0, context.currentTime) * context.sampleRate)
      : ready.currentFrame;
    const leadFrames = Math.max(
      ready.renderQuantumSize * 2,
      Math.ceil(context.sampleRate * 0.05),
    );
    const unalignedEarliest = Math.max(ready.currentFrame, currentTimeFrames) + leadFrames;
    const earliestStartFrame = Math.ceil(
      unalignedEarliest / ready.renderQuantumSize,
    ) * ready.renderQuantumSize;
    if (!safeContextFrame(earliestStartFrame)) {
      throw new MicrophoneCaptureError('synchronization-failed');
    }

    let armCalled = false;
    let armAttempt: Promise<void> | null = null;
    let armFailure: MicrophoneCaptureError | null = null;
    const rejectedArmAttempt = (error: MicrophoneCaptureError): Promise<void> => {
      const failure = Promise.reject<void>(error);
      // A synchronizer may intentionally fire-and-forget armAtFrame. Mark a
      // rejected attempt as observed while preserving rejection for awaiters.
      void failure.catch(() => undefined);
      return failure;
    };
    const armAtFrame = (startFrame: number): Promise<void> => {
      if (armCalled) {
        const error = new MicrophoneCaptureError('synchronization-failed');
        armFailure = error;
        return rejectedArmAttempt(error);
      }
      armCalled = true;
      if (
        !safeContextFrame(startFrame)
        || startFrame < earliestStartFrame
        || !Number.isSafeInteger(startFrame + maximumFrames)
      ) {
        const error = new MicrophoneCaptureError('synchronization-failed');
        armFailure = error;
        armAttempt = rejectedArmAttempt(error);
        return armAttempt;
      }
      armedStartFrame = startFrame;
      try {
        graph?.arm(startFrame, maximumFrames);
      } catch {
        const error = new MicrophoneCaptureError('worklet-failed');
        armFailure = error;
        armAttempt = rejectedArmAttempt(error);
        return armAttempt;
      }
      armAttempt = armedResult.then(() => undefined);
      return armAttempt;
    };

    if (options.synchronize) {
      try {
        await awaitSetupOrCancel(
          Promise.resolve(options.synchronize({
            context,
            contextGeneration,
            sampleRate: context.sampleRate,
            renderQuantumSize: ready.renderQuantumSize,
            earliestStartFrame,
            armAtFrame,
          })),
          options.signal,
        );
      } catch (error) {
        if (error instanceof MicrophoneCaptureError) throw error;
        throw new MicrophoneCaptureError('synchronization-failed');
      }
      if (armFailure) throw armFailure;
      const synchronizedArmAttempt = armAttempt as Promise<void> | null;
      if (!armCalled || synchronizedArmAttempt === null) {
        throw new MicrophoneCaptureError('synchronization-failed');
      }
      await awaitSetupOrCancel(synchronizedArmAttempt, options.signal);
    } else {
      await awaitSetupOrCancel(armAtFrame(earliestStartFrame), options.signal);
    }
    if (armedStartFrame === null) {
      throw new MicrophoneCaptureError('synchronization-failed');
    }
    const watchdogCurrentFrame = Number.isFinite(context.currentTime)
      ? Math.max(0, context.currentTime) * context.sampleRate
      : ready.currentFrame;
    const secondsUntilArm = Math.max(
      0,
      (armedStartFrame - watchdogCurrentFrame) / context.sampleRate,
    );
    automaticTimer = platform.setTimer(
      () => requestStop('duration-limit'),
      (secondsUntilArm + maxDurationSeconds) * 1_000 + FLUSH_TIMEOUT_MS,
    );
    setupSettled = true;

    return {
      startedAt,
      maxDurationSeconds,
      result,
      elapsedSeconds: () => Math.min(
        maxDurationSeconds,
        Math.max(
          0,
          armedStartFrame === null || context === null || !Number.isFinite(context.currentTime)
            ? (platform.now() - startedAt) / 1_000
            : (context.currentTime * context.sampleRate - armedStartFrame) / context.sampleRate,
        ),
      ),
      stop: () => {
        requestStop('manual');
        return result;
      },
      cancel: () => settleError(new MicrophoneCaptureError('cancelled')),
    };
  } catch (error) {
    graph?.disconnect();
    stopStream(stream);
    if (context && ownsContext) await context.close().catch(() => undefined);
    if (!deferredRelease) releaseCaptureToken(token);
    throw mappedCaptureError(error);
  }
}
