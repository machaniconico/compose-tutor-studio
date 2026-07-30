import {
  MAX_DERIVED_AUDIO_PCM_BYTES,
  compileAudioWarpRenderRequestIndex,
  computeAudioWarpFormantResourcePlan,
  type AudioWarpRenderRequest,
} from './audioWarpPlan';
import {
  AudioWarpDspError,
  type DerivedAudioPcm,
} from './audioWarpDsp';
import {
  parseCanonicalPcm16Window,
  type CanonicalPcm16,
} from './canonicalPcm16';
import type { Project } from '@cts/project-model';
import type {
  AudioAssetBufferLease,
  PreparedAudioAssets,
} from './audioAssetResolver';
import type {
  AudioClipPlaybackBufferKey,
  AudioClipPlaybackPlan,
} from './audioClipPlanner';
import { AudioWarpWorkerClient } from './audioWarpWorker';
import {
  AudioResourceReservationError,
  checkedHeavyAudioResourceTotal,
  reserveDerivedAudioResources,
  reserveHeavyAudioResources,
  type HeavyAudioResourceBudget,
  type HeavyAudioResourceReservation,
} from './audioResourceReservation';

export type DerivedAudioBufferLease = Readonly<{
  key: string;
  pcm: DerivedAudioPcm;
  release: () => void;
}>;

export type DerivedAudioPcmRenderer = (
  request: AudioWarpRenderRequest,
  signal?: AbortSignal,
) => Promise<DerivedAudioPcm>;

type CacheEntry = {
  promise: Promise<DerivedAudioPcm>;
  pcm: DerivedAudioPcm | null;
  bytes: number;
  leases: number;
  lastUsed: number;
  reservation: HeavyAudioResourceReservation | null;
  renderController: AbortController;
};

type OwnedRender = Readonly<{
  pcm: DerivedAudioPcm;
  reservation: HeavyAudioResourceReservation;
}>;

/** Content-addressed, single-flight, leased LRU for derived clip PCM. */
export class AudioClipBufferCache {
  private readonly entries = new Map<string, CacheEntry>();
  private retainedBytes = 0;
  private clock = 0;

  constructor(readonly maxBytes = MAX_DERIVED_AUDIO_PCM_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_DERIVED_AUDIO_PCM_BYTES) {
      throw new AudioWarpDspError('resource-limit', 'Derived PCM cache limit is invalid.');
    }
  }

  get retainedDerivedBytes(): number {
    return this.retainedBytes;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  has(cacheKey: string): boolean {
    return this.entries.has(cacheKey);
  }

  async acquire(
    request: AudioWarpRenderRequest,
    renderer: DerivedAudioPcmRenderer,
    options: Readonly<{
      signal?: AbortSignal;
      generation?: number;
      currentGeneration?: () => number;
      resourceBudget?: HeavyAudioResourceBudget;
    }> = {},
  ): Promise<DerivedAudioBufferLease> {
    if (options.signal?.aborted) throw cancelled();
    const existing = this.entries.get(request.cacheKey);
    if (existing) {
      existing.leases += 1;
      existing.lastUsed = ++this.clock;
      return this.waitForLease(request.cacheKey, existing, options);
    }

    const expectedBytes = derivedPcmBytes(
      request.outputFrameCount,
      request.channelCount,
    );
    this.evictFor(expectedBytes);
    if (this.retainedBytes + expectedBytes > this.maxBytes) {
      throw new AudioWarpDspError('resource-limit', 'Derived PCM cache exceeds 128 MiB.');
    }

    const renderController = new AbortController();
    let entry: CacheEntry;
    const promise = this.renderOwned(
      request,
      renderer,
      renderController.signal,
      options.resourceBudget,
    )
      .then(({ pcm, reservation }) => {
        let adopted = false;
        try {
          validateDerived(request, pcm);
          if (this.entries.get(request.cacheKey) !== entry) return pcm;
          const bytes = derivedPcmBytes(pcm.frameCount, pcm.channelCount);
          this.evictFor(bytes - entry.bytes);
          if (this.retainedBytes - entry.bytes + bytes > this.maxBytes) {
            throw new AudioWarpDspError('resource-limit', 'Derived PCM cache exceeds 128 MiB.');
          }
          resizeAsDerived(reservation, bytes);
          this.retainedBytes += bytes - entry.bytes;
          entry.bytes = bytes;
          entry.pcm = pcm;
          entry.reservation = reservation;
          adopted = true;
          return pcm;
        } finally {
          if (!adopted) reservation.release();
        }
      })
      .catch((error) => {
        if (this.entries.get(request.cacheKey) === entry) this.remove(request.cacheKey, entry);
        throw error;
      });
    entry = {
      promise,
      pcm: null,
      bytes: expectedBytes,
      leases: 1,
      lastUsed: ++this.clock,
      reservation: null,
      renderController,
    };
    this.entries.set(request.cacheKey, entry);
    this.retainedBytes += expectedBytes;
    return this.waitForLease(request.cacheKey, entry, options);
  }

  clearUnused(): void {
    for (const [key, entry] of this.entries) {
      if (entry.leases === 0 && entry.pcm !== null) this.remove(key, entry);
    }
  }

  private async renderOwned(
    request: AudioWarpRenderRequest,
    renderer: DerivedAudioPcmRenderer,
    signal: AbortSignal,
    resourceBudget?: HeavyAudioResourceBudget,
  ): Promise<OwnedRender> {
    if (signal.aborted) throw cancelled();
    let intermediate: HeavyAudioResourceReservation;
    try {
      const bytes = estimateAudioWarpRenderWorkingBytes(request);
      intermediate = resourceBudget
        ? resourceBudget.claim(bytes)
        : reserveHeavyAudioResources(bytes);
    } catch (error) {
      if (!(error instanceof AudioResourceReservationError)) throw error;
      throw new AudioWarpDspError('resource-limit', 'Concurrent audio work exceeds 384 MiB.');
    }
    try {
      const pcm = await renderer(request, signal);
      if (signal.aborted) throw cancelled();
      return { pcm, reservation: intermediate };
    } catch (error) {
      intermediate.release();
      throw error;
    }
  }

  private async waitForLease(
    key: string,
    entry: CacheEntry,
    options: Readonly<{
      signal?: AbortSignal;
      generation?: number;
      currentGeneration?: () => number;
    }>,
  ): Promise<DerivedAudioBufferLease> {
    try {
      const pcm = await awaitOrAbort(entry.promise, options.signal);
      assertCurrent(options);
      return this.lease(key, entry, pcm);
    } catch (error) {
      this.releaseWaiter(key, entry, true);
      throw error;
    }
  }

  private lease(key: string, entry: CacheEntry, pcm: DerivedAudioPcm): DerivedAudioBufferLease {
    let released = false;
    return {
      key,
      pcm,
      release: () => {
        if (released) return;
        released = true;
        this.releaseWaiter(key, entry, false);
      },
    };
  }

  private releaseWaiter(key: string, entry: CacheEntry, failed: boolean): void {
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsed = ++this.clock;
    if (entry.leases === 0 && (entry.pcm === null || failed)) {
      this.remove(key, entry);
      return;
    }
    this.evictFor(0);
  }

  private evictFor(requiredBytes: number): void {
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => entry.leases === 0 && entry.pcm !== null)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [key, entry] of candidates) {
      if (this.retainedBytes + requiredBytes <= this.maxBytes) break;
      this.remove(key, entry);
    }
  }

  private remove(key: string, entry: CacheEntry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.retainedBytes = Math.max(0, this.retainedBytes - entry.bytes);
    if (entry.pcm === null) entry.renderController.abort();
    entry.reservation?.release();
    entry.reservation = null;
  }
}

/**
 * Conservative render peak after the caller separately reserves its canonical
 * source window: transferable Worker input, DSP source/input/alignment
 * intermediates, and derived output.
 */
export function estimateAudioWarpRenderWorkingBytes(
  request: AudioWarpRenderRequest,
): number {
  // Source: transferable input, DSP window, active segment, mono alignment.
  // Output: destination, pitch-scaled WSOLA, weights, resample, transfer copy.
  const sourceBytes = derivedPcmBytes(
    Math.max(request.sourceFrameCount, request.sourceFrameCountAtTargetRate),
    request.channelCount,
  );
  const outputBytes = derivedPcmBytes(
    request.outputFrameCount,
    request.channelCount,
  );
  const legacyPeak = () => checkedWarpTotal([
    sourceBytes, sourceBytes, sourceBytes, sourceBytes,
    outputBytes, outputBytes, outputBytes, outputBytes, outputBytes,
  ]);
  if (request.formantMode === 'off') return legacyPeak();
  const plan = computeAudioWarpFormantResourcePlan({
    sourceBytes,
    outputBytes,
    outputFrames: request.outputFrameCount,
    channelCount: request.channelCount,
    sampleRate: request.targetSampleRate,
  });
  if (!plan.accepted) {
    throw new AudioWarpDspError('resource-limit', 'Elastic Audio working memory overflowed.');
  }
  return plan.processingPeakBytes;
}

export const AudioWarpDerivedPcmCache = AudioClipBufferCache;

const defaultDerivedCache = new AudioClipBufferCache();

export function getAudioClipBufferCache(): AudioClipBufferCache {
  return defaultDerivedCache;
}

export type AudioClipPlaybackBufferLease = Readonly<{
  source: AudioAssetBufferLease;
  derivedBuffersByKey: ReadonlyMap<string, AudioBuffer>;
  bufferForPlan: (plan: AudioClipPlaybackPlan) => AudioBuffer | undefined;
  release: () => void;
}>;

export type AcquireAudioClipPlaybackBuffersOptions = Readonly<{
  cache?: AudioClipBufferCache;
  resourceBudget?: HeavyAudioResourceBudget;
  signal?: AbortSignal;
  generation?: number;
  currentGeneration?: () => number;
  renderer?: (
    request: AudioWarpRenderRequest,
    source: CanonicalPcm16,
    signal?: AbortSignal,
  ) => Promise<DerivedAudioPcm>;
}>;

/**
 * Acquire source and derived buffers as one immutable playback generation.
 * Every expensive render settles before the caller is allowed to build a graph.
 */
export async function acquireAudioClipPlaybackBuffers(
  project: Project,
  prepared: PreparedAudioAssets,
  source: AudioAssetBufferLease,
  context: BaseAudioContext,
  options: AcquireAudioClipPlaybackBuffersOptions = {},
): Promise<AudioClipPlaybackBufferLease> {
  let compiled;
  try {
    compiled = compileAudioWarpRenderRequestIndex(project);
  } catch (error) {
    source.release();
    throw error;
  }
  if (compiled.requests.length === 0) {
    return combinedLease(source, new Map(), [], []);
  }
  const cache = options.cache ?? defaultDerivedCache;
  const preparedByAssetId = new Map(
    prepared.assets.map((item) => [item.asset.id, item]),
  );
  const leases: DerivedAudioBufferLease[] = [];
  const playbackBufferReservations: HeavyAudioResourceReservation[] = [];
  const buffers = new Map<string, AudioBuffer>();
  const acquiredCacheKeys = new Set<string>();
  try {
    for (const group of groupRequestsByCanonicalWindow(compiled.requests)) {
      let canonicalWindow: CanonicalPcm16 | null = null;
      const canonicalOwnership: {
        reservation: HeavyAudioResourceReservation | null;
      } = { reservation: null };
      try {
        for (const request of group) {
          if (acquiredCacheKeys.has(request.cacheKey)) continue;
          acquiredCacheKeys.add(request.cacheKey);
          const preparedAsset = preparedByAssetId.get(request.assetId);
          if (!preparedAsset) {
            throw new AudioWarpDspError(
              'invalid-request',
              'The verified source for an Elastic Audio edit is unavailable.',
            );
          }
          const lease = await cache.acquire(
            request,
            async (candidate, signal) => {
              // Cancellation can race with canonical-window preparation or the
              // lazy Worker import. Do not construct a new operation Worker
              // after the owning playback generation has already ended.
              if (signal?.aborted) throw cancelled();
              if (!canonicalWindow) {
                canonicalOwnership.reservation = reserveCanonicalWindow(
                  candidate,
                  options.resourceBudget,
                );
                try {
                  canonicalWindow = parseCanonicalPcm16Window(preparedAsset.bytes, {
                    sampleRate: preparedAsset.asset.sampleRate,
                    channelCount: preparedAsset.asset.channelCount,
                    frameCount: preparedAsset.asset.frameCount,
                  }, {
                    startFrame: candidate.sourceStartFrame,
                    frameCount: candidate.sourceFrameCount,
                  });
                } catch (error) {
                  canonicalOwnership.reservation.release();
                  canonicalOwnership.reservation = null;
                  throw error;
                }
              }
              const windowRequest = requestForCanonicalWindow(candidate);
              const sourceWindow = canonicalWindow;
              if (!sourceWindow) {
                throw new AudioWarpDspError(
                  'invalid-pcm',
                  'Elastic Audio source preparation failed.',
                );
              }
              if (options.renderer) {
                return options.renderer(windowRequest, sourceWindow, signal);
              }
              // The cache entry owns this Worker render. A caller that joins
              // the same entry may outlive the caller that created it, so only
              // the cache's zero-waiter signal may end CPU work.
              const client = await createWorkerClient(signal);
              try {
                if (signal?.aborted) {
                  throw cancelled();
                }
                const generation = client.beginGeneration();
                return await client.render(windowRequest, sourceWindow, {
                  ...(signal ? { signal } : {}),
                  generation,
                });
              } finally {
                client.dispose();
              }
            },
            {
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.generation !== undefined ? { generation: options.generation } : {}),
              ...(options.currentGeneration ? { currentGeneration: options.currentGeneration } : {}),
              ...(options.resourceBudget ? { resourceBudget: options.resourceBudget } : {}),
            },
          );
          leases.push(lease);
          const playbackReservation = reserveDerived(
            derivedPcmBytes(lease.pcm.frameCount, lease.pcm.channelCount),
            options.resourceBudget,
          );
          try {
            buffers.set(request.cacheKey, audioBufferFromPcm(context, lease.pcm));
            playbackBufferReservations.push(playbackReservation);
          } catch (error) {
            playbackReservation.release();
            throw error;
          }
        }
      } finally {
        canonicalWindow = null;
        canonicalOwnership.reservation?.release();
      }
    }
    return combinedLease(source, buffers, leases, playbackBufferReservations);
  } catch (error) {
    for (const lease of leases) lease.release();
    for (const reservation of playbackBufferReservations) reservation.release();
    source.release();
    cache.clearUnused();
    throw normalizeWarpError(error);
  }
}

export function estimateAudioWarpDerivedBytes(project: Project): number {
  return compileAudioWarpRenderRequestIndex(project).requests.reduce(
    (total, request) => checkedHeavyAudioResourceTotal([
      total,
      derivedPcmBytes(request.outputFrameCount, request.channelCount),
    ]),
    0,
  );
}

export type AudioWarpResourcePeakEstimate = Readonly<{
  /** Bytes already owned by cache reservations from earlier operations. */
  retainedDerivedBytes: number;
  /** New ownership this operation must reserve inside its phase envelope. */
  additionalPeakBytes: number;
  /** Physical derived/Worker peak, including retained cache ownership once. */
  estimatedPeakBytes: number;
}>;

/**
 * Estimate the sequential Elastic Audio peak without charging retained cache
 * entries twice. A miss temporarily owns Worker/DSP + one canonical window;
 * settled cache PCM and playback AudioBuffers accumulate for later requests.
 */
export function estimateAudioWarpResourcePeakBytes(
  project: Project,
  cache: AudioClipBufferCache = defaultDerivedCache,
): AudioWarpResourcePeakEstimate {
  const requests = compileAudioWarpRenderRequestIndex(project).requests;
  const seenCacheKeys = new Set<string>();
  let settledAdditionalBytes = 0;
  let additionalPeakBytes = 0;

  for (const group of groupRequestsByCanonicalWindow(requests)) {
    let canonicalBytes = 0;
    for (const request of group) {
      if (seenCacheKeys.has(request.cacheKey)) continue;
      seenCacheKeys.add(request.cacheKey);
      const outputBytes = derivedPcmBytes(
        request.outputFrameCount,
        request.channelCount,
      );
      if (cache.has(request.cacheKey)) {
        settledAdditionalBytes = checkedWarpTotal([
          settledAdditionalBytes,
          outputBytes,
        ]);
        additionalPeakBytes = Math.max(
          additionalPeakBytes,
          settledAdditionalBytes,
        );
        continue;
      }

      canonicalBytes ||= derivedPcmBytes(
        request.sourceFrameCount,
        request.channelCount,
      );
      additionalPeakBytes = Math.max(
        additionalPeakBytes,
        checkedWarpTotal([
          settledAdditionalBytes,
          canonicalBytes,
          estimateAudioWarpRenderWorkingBytes(request),
        ]),
      );
      // One retained cache copy and one AudioBuffer playback copy survive.
      settledAdditionalBytes = checkedWarpTotal([
        settledAdditionalBytes,
        outputBytes,
        outputBytes,
      ]);
      additionalPeakBytes = Math.max(
        additionalPeakBytes,
        settledAdditionalBytes,
      );
    }
  }

  const retainedDerivedBytes = cache.retainedDerivedBytes;
  return {
    retainedDerivedBytes,
    additionalPeakBytes,
    estimatedPeakBytes: checkedWarpTotal([
      retainedDerivedBytes,
      additionalPeakBytes,
    ]),
  };
}

export function playbackBufferMapKey(key: AudioClipPlaybackBufferKey): string {
  return key.kind === 'derived' ? key.cacheKey : key.assetId;
}

function combinedLease(
  source: AudioAssetBufferLease,
  derivedBuffersByKey: ReadonlyMap<string, AudioBuffer>,
  derivedLeases: readonly DerivedAudioBufferLease[],
  playbackBufferReservations: readonly HeavyAudioResourceReservation[],
): AudioClipPlaybackBufferLease {
  let released = false;
  return {
    source,
    derivedBuffersByKey,
    bufferForPlan: (plan) => plan.playbackBufferKey.kind === 'derived'
      ? derivedBuffersByKey.get(plan.playbackBufferKey.cacheKey)
      : source.buffersByAssetId.get(plan.playbackBufferKey.assetId),
    release: () => {
      if (released) return;
      released = true;
      for (const lease of derivedLeases) lease.release();
      for (const reservation of playbackBufferReservations) reservation.release();
      source.release();
    },
  };
}

function groupRequestsByCanonicalWindow(
  requests: readonly AudioWarpRenderRequest[],
): AudioWarpRenderRequest[][] {
  const groups = new Map<string, AudioWarpRenderRequest[]>();
  for (const request of requests) {
    const key = JSON.stringify([
      request.checksumSha256,
      request.sourceSampleRate,
      request.channelCount,
      request.sourceStartFrame,
      request.sourceFrameCount,
    ]);
    const group = groups.get(key);
    if (group) group.push(request);
    else groups.set(key, [request]);
  }
  return [...groups.values()];
}

/**
 * The Worker receives one exact clip window, so absolute source coordinates
 * are rebased without changing clip-relative knots, pitch indices, or identity.
 */
function requestForCanonicalWindow(
  request: AudioWarpRenderRequest,
): AudioWarpRenderRequest {
  const sourceStartFrame = request.sourceStartFrame;
  return Object.freeze({
    ...request,
    sourceStartFrame: 0,
    sourceStartIndex: 0,
    knots: Object.freeze(request.knots.map((knot) => Object.freeze({
      ...knot,
      sourceFrame: knot.sourceFrame - sourceStartFrame,
    }))),
    pitchRegions: Object.freeze(request.pitchRegions.map((region) => Object.freeze({
      ...region,
      sourceStartFrame: region.sourceStartFrame - sourceStartFrame,
    }))),
  });
}

function reserveCanonicalWindow(
  request: AudioWarpRenderRequest,
  resourceBudget?: HeavyAudioResourceBudget,
): HeavyAudioResourceReservation {
  const bytes = derivedPcmBytes(request.sourceFrameCount, request.channelCount);
  try {
    return resourceBudget
      ? resourceBudget.claim(bytes)
      : reserveHeavyAudioResources(bytes);
  } catch (error) {
    if (!(error instanceof AudioResourceReservationError)) throw error;
    throw new AudioWarpDspError('resource-limit', 'Concurrent audio work exceeds 384 MiB.');
  }
}

function audioBufferFromPcm(
  context: BaseAudioContext,
  pcm: DerivedAudioPcm,
): AudioBuffer {
  const buffer = context.createBuffer(pcm.channelCount, pcm.frameCount, pcm.sampleRate);
  for (let channel = 0; channel < pcm.channelCount; channel += 1) {
    const sourceChannel = pcm.channels[channel]!;
    if (!(sourceChannel.buffer instanceof ArrayBuffer)) {
      throw new AudioWarpDspError('invalid-pcm', 'Derived PCM must own an ArrayBuffer.');
    }
    // copyToChannel performs the one playback-buffer copy already covered by
    // playbackBufferReservations; do not manufacture another Float32Array.
    buffer.copyToChannel(
      sourceChannel as Float32Array<ArrayBuffer>,
      channel,
    );
  }
  return buffer;
}

function normalizeWarpError(error: unknown): AudioWarpDspError {
  if (error instanceof AudioWarpDspError) return error;
  const candidate = error as { code?: unknown; message?: unknown };
  if (
    candidate?.code === 'invalid-wav'
    || candidate?.code === 'unsupported-format'
    || candidate?.code === 'metadata-mismatch'
  ) {
    return new AudioWarpDspError(
      'invalid-pcm',
      typeof candidate.message === 'string'
        ? candidate.message
        : 'Elastic Audio source is invalid.',
    );
  }
  return new AudioWarpDspError('invalid-pcm', 'Elastic Audio preparation failed.');
}

async function createWorkerClient(signal?: AbortSignal): Promise<AudioWarpWorkerClient> {
  try {
    const { createLocalAudioWarpThread } = await import('./audioWarpThread');
    if (signal?.aborted) throw cancelled();
    return new AudioWarpWorkerClient(createLocalAudioWarpThread());
  } catch (error) {
    if (error instanceof AudioWarpDspError) throw error;
    throw new AudioWarpDspError(
      'invalid-pcm',
      'Elastic Audio Worker is unavailable in this browser.',
    );
  }
}

export function derivedPcmBytes(frameCount: number, channelCount: number): number {
  const bytes = frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(frameCount)
    || frameCount <= 0
    || (channelCount !== 1 && channelCount !== 2)
    || !Number.isSafeInteger(bytes)
    || bytes > MAX_DERIVED_AUDIO_PCM_BYTES
  ) {
    throw new AudioWarpDspError('resource-limit', 'Derived PCM exceeds 128 MiB.');
  }
  return bytes;
}

function reserveDerived(
  bytes: number,
  resourceBudget?: HeavyAudioResourceBudget,
): HeavyAudioResourceReservation {
  try {
    return resourceBudget
      ? resourceBudget.claim(bytes)
      : reserveDerivedAudioResources(bytes);
  } catch (error) {
    if (!(error instanceof AudioResourceReservationError)) throw error;
    throw new AudioWarpDspError('resource-limit', 'Concurrent audio work exceeds 384 MiB.');
  }
}

function checkedWarpTotal(values: readonly number[]): number {
  try {
    return checkedHeavyAudioResourceTotal(values);
  } catch (error) {
    if (!(error instanceof AudioResourceReservationError)) throw error;
    throw new AudioWarpDspError(
      'resource-limit',
      'Elastic Audio working memory overflowed.',
    );
  }
}

function resizeAsDerived(
  reservation: HeavyAudioResourceReservation,
  bytes: number,
): void {
  // derivedPcmBytes has already enforced the independent 128 MiB ceiling.
  try {
    reservation.resize(bytes);
  } catch (error) {
    if (!(error instanceof AudioResourceReservationError)) throw error;
    throw new AudioWarpDspError('resource-limit', 'Concurrent audio work exceeds 384 MiB.');
  }
}

function validateDerived(request: AudioWarpRenderRequest, pcm: DerivedAudioPcm): void {
  if (
    pcm.sampleRate !== request.targetSampleRate
    || pcm.frameCount !== request.outputFrameCount
    || pcm.channelCount !== request.channelCount
    || pcm.channels.length !== pcm.channelCount
    || pcm.channels.some((channel) => channel.length !== pcm.frameCount)
    || pcm.channels.some((channel) => !(channel.buffer instanceof ArrayBuffer))
    || pcm.channels.some((channel) => channel.some((sample) => !Number.isFinite(sample)))
  ) {
    throw new AudioWarpDspError('invalid-pcm', 'Derived PCM does not match its request.');
  }
}

function assertCurrent(
  options: Readonly<{ generation?: number; currentGeneration?: () => number }>,
): void {
  if (
    options.generation !== undefined
    && options.currentGeneration
    && options.generation !== options.currentGeneration()
  ) throw cancelled('Stale derived PCM was rejected.');
}

function awaitOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function cancelled(message = 'Elastic Audio render was cancelled.'): AudioWarpDspError {
  return new AudioWarpDspError('cancelled', message);
}
