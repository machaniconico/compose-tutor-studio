import { MAX_AUDIO_ASSET_BYTES } from '../platform/audioAssetRepository';
import { encodeWavAsync } from './wav';

export const CANONICAL_AUDIO_SAMPLE_RATE = 48_000;
export const MAX_CANONICAL_AUDIO_CHANNELS = 2;
const WAV_HEADER_BYTES = 44;
const PCM16_BYTES_PER_SAMPLE = 2;

export type CanonicalAudioAssetErrorCode =
  | 'invalid-audio'
  | 'channel-limit-exceeded'
  | 'resource-limit-exceeded'
  | 'render-failed'
  | 'cancelled';

export class CanonicalAudioAssetError extends Error {
  constructor(readonly code: CanonicalAudioAssetErrorCode) {
    super(code);
    this.name = 'CanonicalAudioAssetError';
  }
}

export type CanonicalAudioAssetPlan = Readonly<{
  sampleRate: typeof CANONICAL_AUDIO_SAMPLE_RATE;
  channelCount: number;
  frameCount: number;
  byteLength: number;
  requiresResample: boolean;
}>;

export type CanonicalAudioAssetResult = CanonicalAudioAssetPlan & Readonly<{
  bytes: Uint8Array;
}>;

export type CanonicalAudioAssetProgress = Readonly<{
  phase: 'resampling' | 'encoding';
  fraction: number;
}>;

/** The browser render may outlive a caller that stops waiting after AbortSignal. */
export type CanonicalAudioResampleJob = Readonly<{
  settled: Promise<void>;
  startedAt: number;
}>;

export type CanonicalAudioAssetOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: CanonicalAudioAssetProgress) => void;
  createOfflineContext?: (
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ) => OfflineAudioContext;
  onResampleJob?: (job: CanonicalAudioResampleJob) => void;
  yieldControl?: () => Promise<void>;
}>;

type AudioBufferShape = Pick<
  AudioBuffer,
  'length' | 'duration' | 'sampleRate' | 'numberOfChannels' | 'getChannelData'
>;

function cancelled(): CanonicalAudioAssetError {
  return new CanonicalAudioAssetError('cancelled');
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

export function planCanonicalAudioAsset(source: AudioBufferShape): CanonicalAudioAssetPlan {
  if (
    !Number.isSafeInteger(source.length) ||
    source.length <= 0 ||
    !Number.isFinite(source.duration) ||
    source.duration <= 0 ||
    !Number.isFinite(source.sampleRate) ||
    source.sampleRate < 8_000 ||
    source.sampleRate > 384_000 ||
    !Number.isSafeInteger(source.numberOfChannels) ||
    source.numberOfChannels <= 0
  ) {
    throw new CanonicalAudioAssetError('invalid-audio');
  }
  const expectedDuration = source.length / source.sampleRate;
  if (Math.abs(source.duration - expectedDuration) > Math.max(1 / source.sampleRate, 1e-6)) {
    throw new CanonicalAudioAssetError('invalid-audio');
  }
  if (source.numberOfChannels > MAX_CANONICAL_AUDIO_CHANNELS) {
    throw new CanonicalAudioAssetError('channel-limit-exceeded');
  }
  const exactFrames = (source.length * CANONICAL_AUDIO_SAMPLE_RATE) / source.sampleRate;
  const frameCount = Math.max(1, Math.round(exactFrames));
  const byteLength =
    WAV_HEADER_BYTES + frameCount * source.numberOfChannels * PCM16_BYTES_PER_SAMPLE;
  if (
    !Number.isSafeInteger(frameCount) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength > MAX_AUDIO_ASSET_BYTES
  ) {
    throw new CanonicalAudioAssetError('resource-limit-exceeded');
  }
  return {
    sampleRate: CANONICAL_AUDIO_SAMPLE_RATE,
    channelCount: source.numberOfChannels,
    frameCount,
    byteLength,
    requiresResample: source.sampleRate !== CANONICAL_AUDIO_SAMPLE_RATE,
  };
}

function defaultOfflineContext(
  numberOfChannels: number,
  length: number,
  sampleRate: number,
): OfflineAudioContext {
  return new OfflineAudioContext(numberOfChannels, length, sampleRate);
}

function awaitRenderOrCancel(
  rendering: Promise<AudioBuffer>,
  signal: AbortSignal | undefined,
): Promise<AudioBuffer> {
  if (!signal) return rendering;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else if (result) resolve(result);
      else reject(new CanonicalAudioAssetError('render-failed'));
    };
    const onAbort = (): void => finish(cancelled());
    if (signal.aborted) {
      finish(cancelled());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void rendering.then(
      (result) => finish(undefined, result),
      () => finish(new CanonicalAudioAssetError('render-failed')),
    );
  });
}

async function resampleToCanonical(
  source: AudioBuffer,
  plan: CanonicalAudioAssetPlan,
  options: CanonicalAudioAssetOptions,
): Promise<AudioBuffer> {
  if (!plan.requiresResample) return source;
  throwIfCancelled(options.signal);
  let context: OfflineAudioContext;
  try {
    context = (options.createOfflineContext ?? defaultOfflineContext)(
      plan.channelCount,
      plan.frameCount,
      plan.sampleRate,
    );
    const node = context.createBufferSource();
    node.buffer = source;
    node.connect(context.destination);
    node.start(0);
  } catch {
    throw new CanonicalAudioAssetError('render-failed');
  }
  options.onProgress?.({ phase: 'resampling', fraction: 0 });
  let rendering: Promise<AudioBuffer>;
  try {
    rendering = context.startRendering();
  } catch {
    throw new CanonicalAudioAssetError('render-failed');
  }
  const resampleJob: CanonicalAudioResampleJob = {
    settled: rendering.then(
      () => undefined,
      () => undefined,
    ),
    startedAt: Date.now(),
  };
  options.onResampleJob?.(resampleJob);
  let rendered: AudioBuffer;
  try {
    rendered = await awaitRenderOrCancel(rendering, options.signal);
  } catch (error) {
    if (error instanceof CanonicalAudioAssetError) throw error;
    throw new CanonicalAudioAssetError('render-failed');
  }
  throwIfCancelled(options.signal);
  if (
    rendered.sampleRate !== plan.sampleRate ||
    rendered.numberOfChannels !== plan.channelCount ||
    rendered.length !== plan.frameCount
  ) {
    throw new CanonicalAudioAssetError('render-failed');
  }
  options.onProgress?.({ phase: 'resampling', fraction: 1 });
  return rendered;
}

/** Convert a decoded source into the one deterministic format persisted by Audio Tracks. */
export async function canonicalizeAudioAsset(
  source: AudioBuffer,
  options: CanonicalAudioAssetOptions = {},
): Promise<CanonicalAudioAssetResult> {
  const plan = planCanonicalAudioAsset(source);
  const rendered = await resampleToCanonical(source, plan, options);
  throwIfCancelled(options.signal);
  let wav: ArrayBuffer;
  try {
    wav = await encodeWavAsync(rendered, plan.sampleRate, {
      signal: options.signal,
      yieldControl: options.yieldControl,
      onProgress: (fraction) => options.onProgress?.({ phase: 'encoding', fraction }),
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw cancelled();
    }
    throw new CanonicalAudioAssetError('render-failed');
  }
  if (wav.byteLength !== plan.byteLength || wav.byteLength > MAX_AUDIO_ASSET_BYTES) {
    throw new CanonicalAudioAssetError('render-failed');
  }
  return { ...plan, bytes: new Uint8Array(wav) };
}
