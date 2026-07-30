import {
  isValidAudioWarpRenderRequest,
  type AudioWarpRenderRequest,
} from './audioWarpPlan';
import {
  AudioWarpDspError,
  type DerivedAudioPcm,
} from './audioWarpDsp';

export type AudioWarpWorkerRenderMessage = Readonly<{
  type: 'render';
  id: number;
  generation: number;
  request: AudioWarpRenderRequest;
  pcm: Readonly<{
    sampleRate: number;
    frameCount: number;
    channelCount: number;
    channels: readonly ArrayBuffer[];
  }>;
}>;

export type AudioWarpWorkerCancelMessage = Readonly<{
  type: 'cancel';
  generation: number;
}>;

export type AudioWarpWorkerRequest =
  | AudioWarpWorkerRenderMessage
  | AudioWarpWorkerCancelMessage;

export type AudioWarpWorkerResult =
  | Readonly<{
      type: 'rendered';
      id: number;
      generation: number;
      pcm: Readonly<{
        sampleRate: number;
        frameCount: number;
        channelCount: number;
        channels: readonly ArrayBuffer[];
      }>;
    }>
  | Readonly<{
      type: 'error';
      id: number;
      generation: number;
      code: 'invalid-request' | 'invalid-pcm' | 'resource-limit' | 'cancelled';
      message: string;
    }>;

export type AudioWarpWorkerLike = Readonly<{
  postMessage: (message: AudioWarpWorkerRequest, transfer?: Transferable[]) => void;
  addEventListener: (
    type: 'message' | 'error',
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: 'message' | 'error',
    listener: EventListenerOrEventListenerObject,
  ) => void;
  terminate?: () => void;
}>;

type Pending = {
  generation: number;
  request: AudioWarpRenderRequest;
  resolve: (pcm: DerivedAudioPcm) => void;
  reject: (error: AudioWarpDspError) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class AudioWarpWorkerClient {
  private nextId = 1;
  private generation = 0;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;

  constructor(private readonly worker: AudioWarpWorkerLike) {
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Invalidates every old result before asking the Worker to stop its queue. */
  beginGeneration(): number {
    this.generation += 1;
    this.worker.postMessage({ type: 'cancel', generation: this.generation });
    for (const [id, pending] of this.pending) {
      if (pending.generation >= this.generation) continue;
      this.rejectPending(id, pending, cancelled());
    }
    return this.generation;
  }

  render(
    request: AudioWarpRenderRequest,
    pcm: DerivedAudioPcm,
    options: Readonly<{ signal?: AbortSignal; generation?: number }> = {},
  ): Promise<DerivedAudioPcm> {
    if (this.disposed) return Promise.reject(cancelled('Elastic Audio Worker is disposed.'));
    const generation = options.generation ?? this.generation;
    if (generation !== this.generation || options.signal?.aborted) {
      return Promise.reject(cancelled());
    }
    if (!isExactCanonicalWindow(request, pcm)) {
      return Promise.reject(new AudioWarpDspError(
        'invalid-pcm',
        'Worker source must be the exact rebased clip window.',
      ));
    }
    const id = this.nextId++;
    const copiedChannels = pcm.channels.map((channel) =>
      channel.buffer.slice(
        channel.byteOffset,
        channel.byteOffset + channel.byteLength,
      ) as ArrayBuffer);
    const message: AudioWarpWorkerRenderMessage = {
      type: 'render',
      id,
      generation,
      request,
      pcm: {
        sampleRate: pcm.sampleRate,
        frameCount: pcm.frameCount,
        channelCount: pcm.channelCount,
        channels: copiedChannels,
      },
    };
    if (!isAudioWarpWorkerRequest(message)) {
      return Promise.reject(new AudioWarpDspError('invalid-request', 'Worker request is invalid.'));
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        generation,
        request,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.abort = () => {
          // A synchronous CPU-bound Worker cannot observe a queued cancel message.
          // Termination is the operation-level cancellation boundary.
          this.beginGeneration();
          this.dispose();
        };
        options.signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      this.worker.postMessage(message, copiedChannels);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    for (const [id, pending] of this.pending) this.rejectPending(id, pending, cancelled());
    this.worker.terminate?.();
  }

  private readonly onMessage = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data;
    if (!isAudioWarpWorkerResult(data)) {
      if (record(data) && Number.isSafeInteger(data.id)) {
        const id = data.id as number;
        const pending = this.pending.get(id);
        if (pending) {
          this.rejectPending(
            id,
            pending,
            new AudioWarpDspError('invalid-pcm', 'Worker result failed protocol validation.'),
          );
        }
      }
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return;
    if (data.generation !== this.generation || data.generation !== pending.generation) {
      this.rejectPending(data.id, pending, cancelled('Stale Elastic Audio result was rejected.'));
      return;
    }
    if (data.type === 'error') {
      this.rejectPending(data.id, pending, new AudioWarpDspError(data.code, data.message));
      return;
    }
    try {
      const pcm = decodeWorkerPcm(data.pcm, pending.request);
      this.finishPending(data.id, pending);
      pending.resolve(pcm);
    } catch (error) {
      this.rejectPending(
        data.id,
        pending,
        error instanceof AudioWarpDspError
          ? error
          : new AudioWarpDspError('invalid-pcm', 'Worker result is invalid.'),
      );
    }
  };

  private readonly onError = (): void => {
    for (const [id, pending] of this.pending) {
      this.rejectPending(
        id,
        pending,
        new AudioWarpDspError('invalid-pcm', 'Elastic Audio Worker failed.'),
      );
    }
  };

  private finishPending(id: number, pending: Pending): void {
    this.pending.delete(id);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
  }

  private rejectPending(id: number, pending: Pending, error: AudioWarpDspError): void {
    this.finishPending(id, pending);
    pending.reject(error);
  }
}

function decodeWorkerPcm(
  value: AudioWarpWorkerResult & { type: 'rendered' } extends never ? never : {
    sampleRate: number;
    frameCount: number;
    channelCount: number;
    channels: readonly ArrayBuffer[];
  },
  request: AudioWarpRenderRequest,
): DerivedAudioPcm {
  if (
    value.sampleRate !== request.targetSampleRate
    || value.frameCount !== request.outputFrameCount
    || value.channelCount !== request.channelCount
    || value.channels.length !== request.channelCount
    || value.channels.some((buffer) => buffer.byteLength !== value.frameCount * 4)
  ) {
    throw new AudioWarpDspError('invalid-pcm', 'Worker PCM shape does not match its request.');
  }
  const channels = value.channels.map((buffer) => new Float32Array(buffer));
  if (channels.some((channel) => channel.some((sample) => !Number.isFinite(sample)))) {
    throw new AudioWarpDspError('invalid-pcm', 'Worker returned a non-finite sample.');
  }
  return Object.freeze({
    sampleRate: value.sampleRate,
    frameCount: value.frameCount,
    channelCount: value.channelCount,
    channels: Object.freeze(channels),
  });
}

export function isAudioWarpWorkerRequest(value: unknown): value is AudioWarpWorkerRequest {
  if (!record(value) || !safeGeneration(value.generation)) return false;
  if (value.type === 'cancel') return hasExactKeys(value, ['type', 'generation']);
  if (
    value.type !== 'render'
    || !hasExactKeys(value, ['type', 'id', 'generation', 'request', 'pcm'])
    || !Number.isSafeInteger(value.id)
    || (value.id as number) <= 0
    || !isValidAudioWarpRenderRequest(value.request)
    || !isTransferredPcm(value.pcm)
  ) return false;
  return value.request.sourceStartFrame === 0
    && value.pcm.sampleRate === value.request.sourceSampleRate
    && value.pcm.frameCount === value.request.sourceFrameCount
    && value.pcm.channelCount === value.request.channelCount;
}

export function isAudioWarpWorkerResult(value: unknown): value is AudioWarpWorkerResult {
  if (
    !record(value)
    || !Number.isSafeInteger(value.id)
    || (value.id as number) <= 0
    || !safeGeneration(value.generation)
  ) return false;
  if (value.type === 'error') {
    return hasExactKeys(value, ['type', 'id', 'generation', 'code', 'message'])
      && ['invalid-request', 'invalid-pcm', 'resource-limit', 'cancelled'].includes(
      value.code as string,
    ) && typeof value.message === 'string';
  }
  return value.type === 'rendered'
    && hasExactKeys(value, ['type', 'id', 'generation', 'pcm'])
    && isTransferredPcm(value.pcm);
}

function isTransferredPcm(value: unknown): value is {
  sampleRate: number;
  frameCount: number;
  channelCount: number;
  channels: readonly ArrayBuffer[];
} {
  return record(value)
    && hasExactKeys(value, ['sampleRate', 'frameCount', 'channelCount', 'channels'])
    && Number.isSafeInteger(value.sampleRate)
    && (value.sampleRate as number) > 0
    && Number.isSafeInteger(value.frameCount)
    && (value.frameCount as number) > 0
    && (value.channelCount === 1 || value.channelCount === 2)
    && Array.isArray(value.channels)
    && value.channels.length === value.channelCount
    && value.channels.every((channel) => channel instanceof ArrayBuffer)
    && value.channels.every(
      (channel) => channel.byteLength === (value.frameCount as number) * 4,
    );
}

function safeGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isExactCanonicalWindow(
  request: AudioWarpRenderRequest,
  pcm: DerivedAudioPcm,
): boolean {
  return request.sourceStartFrame === 0
    && pcm.sampleRate === request.sourceSampleRate
    && pcm.frameCount === request.sourceFrameCount
    && pcm.channelCount === request.channelCount
    && pcm.channels.length === request.channelCount
    && pcm.channels.every((channel) => channel.length === pcm.frameCount)
    && pcm.channels.every((channel) => channel.every(Number.isFinite));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && keys.every((key) => expected.includes(key));
}

function cancelled(message = 'Elastic Audio render was cancelled.'): AudioWarpDspError {
  const error = new AudioWarpDspError('cancelled', message);
  error.name = 'AbortError';
  return error;
}
