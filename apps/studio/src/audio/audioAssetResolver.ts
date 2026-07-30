import type { Project, ReadyAudioAsset } from '@cts/project-model';
import {
  AudioResourceReservationError,
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  checkedHeavyAudioResourceTotal,
  reserveHeavyAudioResourceBudget,
  type HeavyAudioResourceBudget,
} from './audioResourceReservation';

/** Bound both attacker-controlled metadata and browser decode allocations. */
export const MAX_AUDIO_ASSET_PREFLIGHT_BYTES = 256 * 1024 * 1024;
export const MAX_AUDIO_ASSET_DECODED_BYTES = 256 * 1024 * 1024;
/** Shared process-level peak for live playback and offline audio preparation. */
export const MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES = MAX_HEAVY_AUDIO_RESOURCE_BYTES;

export type AudioAssetPlaybackErrorCode =
  | 'resolver-unavailable'
  | 'asset-missing'
  | 'asset-changed'
  | 'asset-unavailable'
  | 'decode-failed'
  | 'resource-limit'
  | 'cancelled';

export class AudioAssetPlaybackError extends Error {
  constructor(
    readonly code: AudioAssetPlaybackErrorCode,
    readonly assetId: string | null,
    message: string = code,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AudioAssetPlaybackError';
  }
}

/** Minimal engine-facing boundary; platform repositories adapt to this shape. */
export type AudioAssetBytesResolver = Readonly<{
  resolve: (asset: ReadyAudioAsset, signal?: AbortSignal) => Promise<Uint8Array>;
}>;

export type PreparedAudioAsset = Readonly<{
  asset: ReadyAudioAsset;
  bytes: Uint8Array;
}>;

export type PreparedAudioAssets = Readonly<{
  assets: readonly PreparedAudioAsset[];
  estimatedDecodedBytes: number;
}>;

export type PreparedAudioResourceEstimate = Readonly<{
  rawBytes: number;
  largestRawAssetBytes: number;
  decodedBytes: number;
}>;

export type AudioAssetCombinedResourceEstimate = PreparedAudioResourceEstimate & Readonly<{
  resolvePeakBytes: number;
  decodePeakBytes: number;
  estimatedPeakBytes: number;
}>;

export type AudioAssetBufferLease = Readonly<{
  buffersByAssetId: ReadonlyMap<string, AudioBuffer>;
  release: () => void;
}>;

type DecodedCacheEntry = {
  promise: Promise<AudioBuffer>;
  buffer: AudioBuffer | null;
  estimatedBytes: number;
  leases: number;
  lastUsed: number;
};

/**
 * Bounded checksum cache shared by live playback and WAV rendering.
 *
 * Raw resolution is single-flight but deliberately re-verified for every new
 * session so a removed/corrupt application-owned file is never hidden by a
 * stale byte cache. Decoded entries are keyed by checksum + context sample
 * rate. Leased buffers are never evicted; release is idempotent.
 */
export class AudioAssetPlaybackCache {
  private readonly rawFlights = new WeakMap<
    AudioAssetBytesResolver,
    Map<string, Promise<Uint8Array>>
  >();
  private readonly decoded = new Map<string, DecodedCacheEntry>();
  private decodedBytes = 0;
  private clock = 0;

  constructor(
    private readonly maxRawBytes = MAX_AUDIO_ASSET_PREFLIGHT_BYTES,
    private readonly maxDecodedBytes = MAX_AUDIO_ASSET_DECODED_BYTES,
  ) {}

  /** Current decoded reservations, including live leases and in-flight decodes. */
  get retainedDecodedBytes(): number {
    return this.decodedBytes;
  }

  async preflight(
    project: Project,
    resolver: AudioAssetBytesResolver | null,
    signal?: AbortSignal,
  ): Promise<PreparedAudioAssets> {
    const assets = referencedReadyAudioAssets(project);
    if (assets.length === 0) return { assets: [], estimatedDecodedBytes: 0 };
    if (!resolver) {
      throw new AudioAssetPlaybackError(
        'resolver-unavailable',
        assets[0]?.id ?? null,
        'Audio assets are present but no byte resolver is installed.',
      );
    }
    throwIfAborted(signal, assets[0]?.id ?? null);
    const estimatedDecodedBytes = preflightResourceBudget(
      assets,
      this.maxRawBytes,
      this.maxDecodedBytes,
    );
    const prepared: PreparedAudioAsset[] = [];
    const bytesByChecksum = new Map<string, Uint8Array>();
    for (const asset of assets) {
      throwIfAborted(signal, asset.id);
      let bytes = bytesByChecksum.get(asset.checksumSha256);
      if (!bytes) {
        bytes = await this.resolveVerifiedBytes(asset, resolver, signal);
        bytesByChecksum.set(asset.checksumSha256, bytes);
      }
      throwIfAborted(signal, asset.id);
      prepared.push({ asset, bytes });
    }
    return { assets: prepared, estimatedDecodedBytes };
  }

  async acquireDecoded(
    prepared: PreparedAudioAssets,
    context: BaseAudioContext,
    signal?: AbortSignal,
  ): Promise<AudioAssetBufferLease> {
    if (prepared.assets.length === 0) {
      return { buffersByAssetId: new Map(), release: () => {} };
    }

    const acquiredKeys = new Set<string>();
    const buffersByKey = new Map<string, Promise<AudioBuffer>>();
    const buffersByAssetId = new Map<string, AudioBuffer>();
    try {
      // Sequential decode avoids browser decoder contention and bounds the
      // transient copies retained by decodeAudioData.
      for (const preparedAsset of prepared.assets) {
        const { asset } = preparedAsset;
        throwIfAborted(signal, asset.id);
        const key = decodedCacheKey(asset, context.sampleRate);
        let bufferPromise = buffersByKey.get(key);
        if (!bufferPromise) {
          // acquireOneDecoded reserves this lease synchronously, before its
          // decode promise can settle. That closes the promise-resolution gap
          // in which another cache reservation could otherwise evict a decoded
          // buffer before this caller's await continuation increments leases.
          bufferPromise = this.acquireOneDecoded(preparedAsset, context, key);
          buffersByKey.set(key, bufferPromise);
          acquiredKeys.add(key);
        }
        const buffer = await bufferPromise;
        throwIfAborted(signal, asset.id);
        buffersByAssetId.set(asset.id, buffer);
      }
    } catch (error) {
      this.releaseDecodedKeys(acquiredKeys);
      throw error;
    }

    let released = false;
    return {
      buffersByAssetId,
      release: () => {
        if (released) return;
        released = true;
        this.releaseDecodedKeys(acquiredKeys);
      },
    };
  }

  /** Drop only unleased entries; active sessions retain their buffers. */
  clearUnused(): void {
    for (const [key, entry] of this.decoded) {
      if (entry.leases > 0 || entry.buffer === null) continue;
      this.decoded.delete(key);
      this.decodedBytes -= entry.estimatedBytes;
    }
    this.decodedBytes = Math.max(0, this.decodedBytes);
  }

  private async resolveVerifiedBytes(
    asset: ReadyAudioAsset,
    resolver: AudioAssetBytesResolver,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let resolverFlights = this.rawFlights.get(resolver);
    if (!resolverFlights) {
      resolverFlights = new Map();
      this.rawFlights.set(resolver, resolverFlights);
    }
    let flight = resolverFlights.get(asset.checksumSha256);
    if (!flight) {
      flight = (async () => {
        let resolved: Uint8Array;
        try {
          // Cancellation belongs to each waiter. Let the shared repository read
          // settle so an aborted WAV export cannot cancel concurrent live play.
          resolved = await resolver.resolve(asset);
        } catch (error) {
          if (error instanceof AudioAssetPlaybackError) throw error;
          throw new AudioAssetPlaybackError(
            'asset-unavailable',
            asset.id,
            `Audio asset "${asset.originalName}" could not be read.`,
            error,
          );
        }
        if (!(resolved instanceof Uint8Array)) {
          throw new AudioAssetPlaybackError(
            'asset-changed',
            asset.id,
            'Audio asset resolver returned an invalid byte payload.',
          );
        }
        const stableBytes = copyBytes(resolved);
        assertByteLength(asset, stableBytes);
        const checksum = await sha256Hex(stableBytes, asset.id);
        if (checksum !== asset.checksumSha256) {
          throw new AudioAssetPlaybackError(
            'asset-changed',
            asset.id,
            `Audio asset "${asset.originalName}" no longer matches its checksum.`,
          );
        }
        return stableBytes;
      })().finally(() => {
        resolverFlights?.delete(asset.checksumSha256);
      });
      resolverFlights.set(asset.checksumSha256, flight);
    }
    const bytes = await awaitFlightOrAbort(flight, signal, asset.id);
    assertByteLength(asset, bytes);
    return bytes;
  }

  private async acquireOneDecoded(
    prepared: PreparedAudioAsset,
    context: BaseAudioContext,
    key: string,
  ): Promise<AudioBuffer> {
    const cached = this.decoded.get(key);
    if (cached) {
      cached.lastUsed = ++this.clock;
      cached.leases += 1;
      const buffer = await cached.promise;
      assertDecodedMetadata(prepared.asset, buffer);
      return buffer;
    }

    const expectedBytes = decodedByteEstimateAtSampleRate(
      prepared.asset,
      context.sampleRate,
    );
    this.evictDecodedFor(expectedBytes);
    if (this.decodedBytes + expectedBytes > this.maxDecodedBytes) {
      throw new AudioAssetPlaybackError(
        'resource-limit',
        prepared.asset.id,
        'Decoded audio cache would exceed its memory limit.',
      );
    }

    let entry: DecodedCacheEntry;
    const promise = decodeAsset(context, prepared)
      .then((buffer) => {
        if (this.decoded.get(key) !== entry) return buffer;
        const actualBytes = decodedBufferBytes(prepared.asset, buffer);
        const delta = actualBytes - entry.estimatedBytes;
        if (delta > 0) {
          this.evictDecodedFor(delta);
          if (this.decodedBytes + delta > this.maxDecodedBytes) {
            throw new AudioAssetPlaybackError(
              'resource-limit',
              prepared.asset.id,
              'Decoded audio exceeded its reserved memory budget.',
            );
          }
        }
        this.decodedBytes += delta;
        entry.estimatedBytes = actualBytes;
        entry.buffer = buffer;
        return buffer;
      })
      .catch((error) => {
        if (this.decoded.get(key) === entry) {
          this.decoded.delete(key);
          this.decodedBytes -= entry.estimatedBytes;
        }
        throw error;
      });
    entry = {
      promise,
      buffer: null,
      estimatedBytes: expectedBytes,
      // Reserve ownership before the decode promise is observable. Promise
      // reactions from another acquisition can now never evict this entry in
      // the gap between decode completion and its caller resuming after await.
      leases: 1,
      lastUsed: ++this.clock,
    };
    this.decoded.set(key, entry);
    this.decodedBytes += expectedBytes;
    return promise;
  }

  private evictDecodedFor(requiredBytes: number): void {
    const candidates = [...this.decoded.entries()]
      .filter(([, entry]) => entry.leases === 0 && entry.buffer !== null)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [key, entry] of candidates) {
      if (this.decodedBytes + requiredBytes <= this.maxDecodedBytes) break;
      this.decoded.delete(key);
      this.decodedBytes -= entry.estimatedBytes;
    }
  }

  private releaseDecodedKeys(keys: ReadonlySet<string>): void {
    for (const key of keys) {
      const entry = this.decoded.get(key);
      if (entry) entry.leases = Math.max(0, entry.leases - 1);
    }
    this.evictDecodedFor(0);
  }
}

const defaultCache = new AudioAssetPlaybackCache();
let defaultResolver: AudioAssetBytesResolver | null = null;
type ResolverRegistration = {
  resolver: AudioAssetBytesResolver | null;
  active: boolean;
};
const resolverRegistrations: ResolverRegistration[] = [];

/** Install the platform adapter used by live playback and default WAV export. */
export function setAudioAssetBytesResolver(
  resolver: AudioAssetBytesResolver | null,
): () => void {
  const registration: ResolverRegistration = { resolver, active: true };
  resolverRegistrations.push(registration);
  defaultResolver = resolver;
  defaultCache.clearUnused();
  return () => {
    if (!registration.active) return;
    registration.active = false;
    const index = resolverRegistrations.indexOf(registration);
    if (index >= 0) resolverRegistrations.splice(index, 1);
    defaultResolver = resolverRegistrations.at(-1)?.resolver ?? null;
    defaultCache.clearUnused();
  };
}

export function getAudioAssetBytesResolver(): AudioAssetBytesResolver | null {
  return defaultResolver;
}

export function getAudioAssetPlaybackCache(): AudioAssetPlaybackCache {
  return defaultCache;
}

export async function preflightProjectAudioAssets(
  project: Project,
  options: Readonly<{
    resolver?: AudioAssetBytesResolver | null;
    cache?: AudioAssetPlaybackCache;
    signal?: AbortSignal;
    /** Actual destination context rate; enables the live combined-memory gate. */
    targetSampleRate?: number;
  }> = {},
): Promise<PreparedAudioAssets> {
  const cache = options.cache ?? defaultCache;
  if (options.targetSampleRate !== undefined) {
    assertProjectAudioAssetCombinedResourceBudget(
      project,
      options.targetSampleRate,
      cache.retainedDecodedBytes,
    );
  }
  return cache.preflight(
    project,
    options.resolver === undefined ? defaultResolver : options.resolver,
    options.signal,
  );
}

export async function acquireProjectAudioBuffers(
  prepared: PreparedAudioAssets,
  context: BaseAudioContext,
  options: Readonly<{
    cache?: AudioAssetPlaybackCache;
    signal?: AbortSignal;
  }> = {},
): Promise<AudioAssetBufferLease> {
  return (options.cache ?? defaultCache).acquireDecoded(
    prepared,
    context,
    options.signal,
  );
}

/**
 * Estimate unique prepared bytes at a target context rate.
 * WAV planning uses this before creating its OfflineAudioContext so decoded,
 * raw, and render allocations share one process-level safety budget.
 */
export function estimatePreparedAudioResources(
  prepared: PreparedAudioAssets,
  targetSampleRate: number,
): PreparedAudioResourceEstimate {
  const seenChecksums = new Set<string>();
  let rawBytes = 0;
  let largestRawAssetBytes = 0;
  let decodedBytes = 0;
  for (const item of prepared.assets) {
    const { asset } = item;
    if (seenChecksums.has(asset.checksumSha256)) continue;
    seenChecksums.add(asset.checksumSha256);
    rawBytes = safeBudgetAdd(rawBytes, item.bytes.byteLength, asset.id);
    largestRawAssetBytes = Math.max(largestRawAssetBytes, item.bytes.byteLength);
    decodedBytes = safeBudgetAdd(
      decodedBytes,
      decodedByteEstimateAtSampleRate(asset, targetSampleRate),
      asset.id,
    );
  }
  return { rawBytes, largestRawAssetBytes, decodedBytes };
}

/**
 * Estimate unique, referenced ready assets using metadata only.
 *
 * This intentionally runs before resolver I/O. Assets sharing a checksum are
 * counted once, but inconsistent duplicate metadata fails closed because a
 * checksum cannot safely describe two different decode allocations.
 */
export function estimateProjectAudioResources(
  project: Project,
  targetSampleRate: number,
): PreparedAudioResourceEstimate {
  return estimateReadyAudioAssetResources(
    referencedReadyAudioAssets(project),
    targetSampleRate,
  );
}

/** Checked sum shared by live and offline peak calculations. */
export function checkedAudioResourceTotal(
  values: readonly number[],
  assetId: string | null = null,
): number {
  try {
    return checkedHeavyAudioResourceTotal(values);
  } catch (error) {
    if (!(error instanceof AudioResourceReservationError)) throw error;
    throw new AudioAssetPlaybackError(
      'resource-limit',
      assetId,
      'Audio asset memory budget overflowed.',
      error,
    );
  }
}

/**
 * Reject a project's worst asset-preparation phase before resolver I/O.
 *
 * Resolve/hash retains all stable project bytes while the largest asset may
 * also exist as the repository result and WebCrypto digest input. Buffers
 * already reserved by the shared cache remain resident in both phases. Decode
 * then retains the stable raw set, one decode copy, and all target buffers.
 */
export function assertProjectAudioAssetCombinedResourceBudget(
  project: Project,
  targetSampleRate: number,
  retainedDecodedBytes = 0,
  derivedAndWorkerBytes = 0,
): AudioAssetCombinedResourceEstimate {
  const assets = referencedReadyAudioAssets(project);
  if (assets.length === 0) {
    return {
      rawBytes: 0,
      largestRawAssetBytes: 0,
      decodedBytes: 0,
      resolvePeakBytes: 0,
      decodePeakBytes: 0,
      estimatedPeakBytes: 0,
    };
  }
  const estimate = estimateReadyAudioAssetResources(assets, targetSampleRate);
  const assetId = assets[0]?.id ?? null;
  if (estimate.decodedBytes > MAX_AUDIO_ASSET_DECODED_BYTES) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      assetId,
      'Target-rate decoded audio exceeds the playback memory limit.',
    );
  }
  const resolvePeakBytes = checkedAudioResourceTotal([
    estimate.rawBytes,
    estimate.largestRawAssetBytes,
    estimate.largestRawAssetBytes,
    retainedDecodedBytes,
    derivedAndWorkerBytes,
  ], assetId);
  const decodePeakBytes = checkedAudioResourceTotal([
    estimate.rawBytes,
    estimate.largestRawAssetBytes,
    estimate.decodedBytes,
    retainedDecodedBytes,
    derivedAndWorkerBytes,
  ], assetId);
  const estimatedPeakBytes = Math.max(resolvePeakBytes, decodePeakBytes);
  if (estimatedPeakBytes > MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      assetId,
      'Project audio assets exceed the combined memory limit.',
    );
  }
  return { ...estimate, resolvePeakBytes, decodePeakBytes, estimatedPeakBytes };
}

/** Atomically reserve a previously checked project/WAV peak. */
export function reserveProjectAudioAssetResourceBudget(
  project: Project,
  estimatedPeakBytes: number,
): HeavyAudioResourceBudget {
  const assetId = referencedReadyAudioAssets(project)[0]?.id ?? null;
  try {
    return reserveHeavyAudioResourceBudget(estimatedPeakBytes);
  } catch (error) {
    if (!(error instanceof AudioResourceReservationError)) throw error;
    throw new AudioAssetPlaybackError(
      'resource-limit',
      assetId,
      'Concurrent audio work exceeds the shared memory limit.',
      error,
    );
  }
}

/** Synchronous fast path keeps ordinary synth/drum playback in the user gesture. */
export function projectHasReferencedReadyAudioAssets(project: Project): boolean {
  return referencedReadyAudioAssets(project).length > 0;
}

export function firstReferencedReadyAudioAssetId(project: Project): string | null {
  return referencedReadyAudioAssets(project)[0]?.id ?? null;
}

function referencedReadyAudioAssets(project: Project): ReadyAudioAsset[] {
  const byId = new Map(project.audioAssets.map((asset) => [asset.id, asset]));
  const referenced = new Map<string, ReadyAudioAsset>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== 'audio' || !clip.audioAssetId) continue;
      const asset = byId.get(clip.audioAssetId);
      if (asset?.availability === 'ready') referenced.set(asset.id, asset);
    }
  }
  for (const folder of project.audioTakeFolders) {
    for (const take of folder.takes) {
      const asset = byId.get(take.audioAssetId);
      if (asset?.availability === 'ready') referenced.set(asset.id, asset);
    }
  }
  return [...referenced.values()];
}

function preflightResourceBudget(
  assets: readonly ReadyAudioAsset[],
  maxRawBytes: number,
  maxDecodedBytes: number,
): number {
  const unique = new Map<string, ReadyAudioAsset>();
  let rawBytes = 0;
  let decodedBytes = 0;
  for (const asset of assets) {
    const prior = unique.get(asset.checksumSha256);
    if (prior) {
      assertMatchingChecksumMetadata(prior, asset);
      continue;
    }
    unique.set(asset.checksumSha256, asset);
    rawBytes = safeBudgetAdd(rawBytes, asset.byteLength, asset.id);
    decodedBytes = safeBudgetAdd(decodedBytes, decodedByteEstimate(asset), asset.id);
  }
  if (rawBytes > maxRawBytes || decodedBytes > maxDecodedBytes) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      assets[0]?.id ?? null,
      'Project audio assets exceed the playback memory limit.',
    );
  }
  return decodedBytes;
}

function estimateReadyAudioAssetResources(
  assets: readonly ReadyAudioAsset[],
  targetSampleRate: number,
): PreparedAudioResourceEstimate {
  const unique = new Map<string, ReadyAudioAsset>();
  let rawBytes = 0;
  let largestRawAssetBytes = 0;
  let decodedBytes = 0;
  for (const asset of assets) {
    const prior = unique.get(asset.checksumSha256);
    if (prior) {
      assertMatchingChecksumMetadata(prior, asset);
      continue;
    }
    unique.set(asset.checksumSha256, asset);
    rawBytes = safeBudgetAdd(rawBytes, asset.byteLength, asset.id);
    largestRawAssetBytes = Math.max(largestRawAssetBytes, asset.byteLength);
    decodedBytes = safeBudgetAdd(
      decodedBytes,
      decodedByteEstimateAtSampleRate(asset, targetSampleRate),
      asset.id,
    );
  }
  return { rawBytes, largestRawAssetBytes, decodedBytes };
}

function assertMatchingChecksumMetadata(
  prior: ReadyAudioAsset,
  asset: ReadyAudioAsset,
): void {
  if (
    prior.byteLength !== asset.byteLength ||
    prior.sampleRate !== asset.sampleRate ||
    prior.channelCount !== asset.channelCount ||
    prior.frameCount !== asset.frameCount
  ) {
    throw new AudioAssetPlaybackError(
      'asset-changed',
      asset.id,
      'Assets sharing a checksum have inconsistent metadata.',
    );
  }
}

function decodedByteEstimate(asset: ReadyAudioAsset): number {
  const samples = asset.frameCount * asset.channelCount;
  const bytes = samples * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(samples) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      asset.id,
      'Audio asset decoded size is not safely representable.',
    );
  }
  return bytes;
}

function decodedByteEstimateAtSampleRate(
  asset: ReadyAudioAsset,
  contextSampleRate: number,
): number {
  if (!Number.isFinite(contextSampleRate) || contextSampleRate <= 0) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      asset.id,
      'Audio context sample rate is invalid.',
    );
  }
  const frames = Math.ceil(asset.frameCount * contextSampleRate / asset.sampleRate) + 2;
  const bytes = frames * asset.channelCount * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      asset.id,
      'Resampled audio size is not safely representable.',
    );
  }
  return bytes;
}

function decodedBufferBytes(asset: ReadyAudioAsset, buffer: AudioBuffer): number {
  const samples = buffer.length * buffer.numberOfChannels;
  const bytes = samples * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(samples) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      asset.id,
      'Decoded AudioBuffer size is not safely representable.',
    );
  }
  return bytes;
}

function safeBudgetAdd(total: number, value: number, assetId: string | null): number {
  if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
    throw new AudioAssetPlaybackError(
      'resource-limit',
      assetId,
      'Audio asset memory budget overflowed.',
    );
  }
  return total + value;
}

function assertByteLength(asset: ReadyAudioAsset, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.byteLength) {
    throw new AudioAssetPlaybackError(
      bytes.byteLength === 0 ? 'asset-missing' : 'asset-changed',
      asset.id,
      `Audio asset "${asset.originalName}" has an unexpected byte length.`,
    );
  }
}

async function decodeAsset(
  context: BaseAudioContext,
  prepared: PreparedAudioAsset,
): Promise<AudioBuffer> {
  let buffer: AudioBuffer;
  try {
    const bytes = copyBytes(prepared.bytes);
    buffer = await context.decodeAudioData(bytes.buffer);
  } catch (error) {
    if (isResourceDecodeError(error)) {
      throw new AudioAssetPlaybackError(
        'resource-limit',
        prepared.asset.id,
        `Audio asset "${prepared.asset.originalName}" could not be decoded within resource limits.`,
        error,
      );
    }
    throw new AudioAssetPlaybackError(
      'decode-failed',
      prepared.asset.id,
      `Audio asset "${prepared.asset.originalName}" could not be decoded.`,
      error,
    );
  }
  assertDecodedMetadata(prepared.asset, buffer);
  return buffer;
}

function assertDecodedMetadata(asset: ReadyAudioAsset, buffer: AudioBuffer): void {
  const expectedDecodedFrames =
    asset.frameCount * buffer.sampleRate / asset.sampleRate;
  // Chromium may truncate a mathematically integral resample by one frame
  // (for example 24,000 @ 48 kHz becomes 22,049 @ 44.1 kHz). Compare in the
  // decoder's frame domain so a floating-point seconds conversion cannot turn
  // that valid one-frame boundary into an asset-integrity failure.
  const frameTolerance = 1 + Number.EPSILON * Math.max(
    1,
    buffer.length,
    expectedDecodedFrames,
  );
  const decodedDuration = buffer.length / buffer.sampleRate;
  const durationRoundingTolerance = Number.EPSILON * 4 * Math.max(
    1,
    Math.abs(buffer.duration),
    Math.abs(decodedDuration),
  );
  if (
    buffer.numberOfChannels !== asset.channelCount ||
    !Number.isFinite(buffer.sampleRate) ||
    buffer.sampleRate <= 0 ||
    !Number.isSafeInteger(buffer.length) ||
    buffer.length <= 0 ||
    !Number.isFinite(buffer.duration) ||
    buffer.duration <= 0 ||
    !Number.isFinite(decodedDuration) ||
    Math.abs(buffer.duration - decodedDuration) > durationRoundingTolerance ||
    !Number.isFinite(expectedDecodedFrames) ||
    Math.abs(buffer.length - expectedDecodedFrames) > frameTolerance
  ) {
    throw new AudioAssetPlaybackError(
      'asset-changed',
      asset.id,
      `Decoded audio metadata for "${asset.originalName}" does not match the project.`,
    );
  }
}

function decodedCacheKey(asset: ReadyAudioAsset, contextSampleRate: number): string {
  return `${asset.checksumSha256}@${contextSampleRate}`;
}

export async function sha256Hex(bytes: Uint8Array, assetId: string | null = null): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AudioAssetPlaybackError(
      'resolver-unavailable',
      assetId,
      'SHA-256 verification is unavailable in this runtime.',
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest('SHA-256', copyBytes(bytes));
  } catch (error) {
    throw new AudioAssetPlaybackError(
      'asset-unavailable',
      assetId,
      'SHA-256 verification failed.',
      error,
    );
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function throwIfAborted(signal: AbortSignal | undefined, assetId: string | null): void {
  if (!signal?.aborted) return;
  throw new AudioAssetPlaybackError(
    'cancelled',
    assetId,
    'Audio asset loading was cancelled.',
    signal.reason,
  );
}

function awaitFlightOrAbort<T>(
  flight: Promise<T>,
  signal: AbortSignal | undefined,
  assetId: string,
): Promise<T> {
  if (!signal) return flight;
  throwIfAborted(signal, assetId);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value?: T, error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const onAbort = (): void => finish(undefined, new AudioAssetPlaybackError(
      'cancelled',
      assetId,
      'Audio asset loading was cancelled.',
      signal.reason,
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    void flight.then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    );
  });
}

function isResourceDecodeError(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return error instanceof DOMException && (
    error.name === 'QuotaExceededError' || error.name === 'OutOfMemoryError'
  );
}
