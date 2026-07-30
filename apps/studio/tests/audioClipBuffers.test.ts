import {
  CURRENT_SCHEMA_VERSION,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '@cts/project-model';
import { describe, expect, it, vi } from 'vitest';
import {
  AudioClipBufferCache,
  acquireAudioClipPlaybackBuffers,
  derivedPcmBytes,
  estimateAudioWarpRenderWorkingBytes,
  estimateAudioWarpResourcePeakBytes,
} from '../src/audio/audioClipBuffers';
import {
  renderAudioWarp,
  type DerivedAudioPcm,
} from '../src/audio/audioWarpDsp';
import {
  compileAudioWarpRenderRequests,
  type AudioWarpRenderRequest,
} from '../src/audio/audioWarpPlan';
import {
  assertProjectAudioAssetCombinedResourceBudget,
  type AudioAssetBufferLease,
  type PreparedAudioAssets,
} from '../src/audio/audioAssetResolver';
import {
  AudioResourceReservationError,
  getReservedHeavyAudioResourceBytes,
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  reserveHeavyAudioResourceBudget,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import {
  CanonicalPcm16Error,
  parseCanonicalPcm16,
  type CanonicalPcm16,
} from '../src/audio/canonicalPcm16';

function request(key: string, frames = 4): AudioWarpRenderRequest {
  return {
    algorithmVersion: 'wsola-v1/dsp-1',
    assetId: 'asset',
    checksumSha256: key.padEnd(64, 'a').slice(0, 64),
    sourceSampleRate: 48_000,
    sourceStartFrame: 0,
    sourceFrameCount: frames,
    sourceStartIndex: 0,
    sourceFrameCountAtTargetRate: frames,
    targetSampleRate: 48_000,
    channelCount: 1,
    outputFrameCount: frames,
    knots: [
      { sourceFrame: 0, sourceIndex: 0, outputFrame: 0 },
      { sourceFrame: frames, sourceIndex: frames, outputFrame: frames },
    ],
    pitchRegions: [],
    cacheKey: key,
  };
}

const pcm = (frames = 4): DerivedAudioPcm => ({
  sampleRate: 48_000,
  frameCount: frames,
  channelCount: 1,
  channels: [new Float32Array(frames)],
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('derived Audio Clip buffer cache', () => {
  it('deduplicates concurrent renders and retains data until every lease releases', async () => {
    const cache = new AudioClipBufferCache(64);
    const renderer = vi.fn(async () => pcm());
    const [first, second] = await Promise.all([
      cache.acquire(request('same'), renderer),
      cache.acquire(request('same'), renderer),
    ]);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(cache.entryCount).toBe(1);
    first.release();
    expect(cache.entryCount).toBe(1);
    second.release();
    cache.clearUnused();
    expect(cache.entryCount).toBe(0);
    expect(cache.retainedDerivedBytes).toBe(0);
  });

  it('evicts least-recently-used unleased PCM and cleans resource ownership', async () => {
    const cache = new AudioClipBufferCache(16);
    const renderer = async () => pcm();
    const first = await cache.acquire(request('first'), renderer);
    first.release();
    const second = await cache.acquire(request('second'), renderer);
    expect(cache.entryCount).toBe(1);
    expect(second.key).toBe('second');
    second.release();
    cache.clearUnused();
    expect(cache.retainedDerivedBytes).toBe(0);
  });

  it('rejects stale generation before cache adoption', async () => {
    const cache = new AudioClipBufferCache(64);
    let generation = 1;
    await expect(cache.acquire(request('stale'), async () => {
      generation = 2;
      return pcm();
    }, {
      generation: 1,
      currentGeneration: () => generation,
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(cache.entryCount).toBe(0);
    expect(cache.retainedDerivedBytes).toBe(0);
  });

  it('keeps a newer waiter on a shared render when the original generation becomes stale', async () => {
    const cache = new AudioClipBufferCache(64);
    const render = deferred<DerivedAudioPcm>();
    const renderer = vi.fn(() => render.promise);
    let generation = 1;
    const first = cache.acquire(request('cross-generation'), renderer, {
      generation: 1,
      currentGeneration: () => generation,
    });
    generation = 2;
    const second = cache.acquire(request('cross-generation'), renderer, {
      generation: 2,
      currentGeneration: () => generation,
    });

    render.resolve(pcm());
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult).toMatchObject({
      status: 'rejected',
      reason: { code: 'cancelled' },
    });
    expect(secondResult.status).toBe('fulfilled');
    expect(renderer).toHaveBeenCalledTimes(1);
    if (secondResult.status === 'fulfilled') secondResult.value.release();
    cache.clearUnused();
    expect(cache.retainedDerivedBytes).toBe(0);
  });

  it('does not cancel a shared render when only one joined waiter aborts', async () => {
    const cache = new AudioClipBufferCache(64);
    const render = deferred<DerivedAudioPcm>();
    let renderSignal: AbortSignal | undefined;
    const renderer = vi.fn((_request, signal) => {
      renderSignal = signal;
      return render.promise;
    });
    const controller = new AbortController();
    const first = cache.acquire(request('joined-abort'), renderer, {
      signal: controller.signal,
    });
    const second = cache.acquire(request('joined-abort'), renderer);

    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    expect(renderSignal?.aborted).toBe(false);
    render.resolve(pcm());
    const lease = await second;
    expect(renderer).toHaveBeenCalledTimes(1);
    lease.release();
    cache.clearUnused();
  });

  it('reserves the bounded canonical, Worker, DSP, and derived working peak before rendering', async () => {
    const cache = new AudioClipBufferCache(64);
    const sampleBytes = 4 * Float32Array.BYTES_PER_ELEMENT;
    // The cache owns four Worker/DSP source-sized allocations and five
    // output-sized allocations. Its caller reserves canonical PCM separately.
    const workingBytes = sampleBytes * 9;
    const competing = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - workingBytes + 1,
    );
    const renderer = vi.fn(async () => pcm());
    let lease: Awaited<ReturnType<typeof cache.acquire>> | undefined;
    let error: unknown;
    try {
      lease = await cache.acquire(request('working-peak'), renderer);
    } catch (candidate) {
      error = candidate;
    } finally {
      lease?.release();
      cache.clearUnused();
      competing.release();
    }
    expect(error).toMatchObject({ code: 'resource-limit' });
    expect(renderer).not.toHaveBeenCalled();
  });
});

function canonicalWav(frameCount: number): Uint8Array {
  const bytes = new Uint8Array(44 + frameCount * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frameCount * 2, true);
  for (let frame = 0; frame < frameCount; frame += 1) {
    view.setInt16(44 + frame * 2, ((frame % 200) - 100) * 100, true);
  }
  return bytes;
}

function warpProject(): {
  project: Project;
  prepared: PreparedAudioAssets;
  source: AudioAssetBufferLease;
} {
  const bytes = canonicalWav(9_600);
  const asset: ReadyAudioAsset = {
    id: 'asset',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'long.wav',
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 9_600,
  };
  const clip: AudioClip = {
    id: 'clip',
    trackId: 'track',
    type: 'audio',
    startBeat: 0,
    lengthBeats: 0.1,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 2_400,
    sourceFrameCount: 2_400,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
    audioWarp: {
      algorithm: 'wsola-v1',
      timingEnabled: true,
      pitchEnabled: false,
      markers: [
        { sourceFrame: 2_400, targetBeatOffset: 0 },
        { sourceFrame: 4_800, targetBeatOffset: 0.1 },
      ],
      pitchRegions: [],
    },
  };
  const track: Track = {
    id: 'track',
    name: 'Voice',
    type: 'audio',
    role: 'general',
    clips: [clip],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  const project: Project = {
    id: 'project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Window',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
    timeSignatureMap: [{ id: 'meter', beat: 0, numerator: 4, denominator: 4 }],
    audioAssets: [asset],
    audioTakeFolders: [],
    automationLanes: [],
    automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    audioRouting: {
      outputs: [{ sourceTrackId: track.id, destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [track],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
  return {
    project,
    prepared: {
      assets: [{ asset, bytes }],
      estimatedDecodedBytes: asset.frameCount * 4,
    },
    source: {
      buffersByAssetId: new Map(),
      release: vi.fn(),
    },
  };
}

function contextStub(): BaseAudioContext {
  return {
    createBuffer: vi.fn((channels: number, frames: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length: frames,
      sampleRate,
      copyToChannel: vi.fn(),
    })),
  } as unknown as BaseAudioContext;
}

function advertisedBoundaryProject(): Project {
  const fixture = warpProject();
  const frameCount = 60 * 48_000;
  fixture.project.lengthBars = 60;
  fixture.project.lengthBeats = 240;
  fixture.project.audioAssets[0] = {
    ...(fixture.project.audioAssets[0] as ReadyAudioAsset),
    byteLength: 44 + frameCount * 2 * Int16Array.BYTES_PER_ELEMENT,
    channelCount: 2,
    frameCount,
  };
  const clip = fixture.project.tracks[0]!.clips[0] as AudioClip;
  clip.startBeat = 0;
  clip.lengthBeats = 240;
  clip.sourceStartFrame = 0;
  clip.sourceFrameCount = frameCount;
  clip.fadeInFrames = 0;
  clip.fadeOutFrames = 0;
  clip.audioWarp = {
    algorithm: 'wsola-v1',
    timingEnabled: true,
    pitchEnabled: false,
    markers: [
      { sourceFrame: 0, targetBeatOffset: 0 },
      { sourceFrame: frameCount, targetBeatOffset: 240 },
    ],
    pitchRegions: [],
  };
  return fixture.project;
}

describe('Elastic Audio resource ownership boundary', () => {
  it('accepts the advertised 60-second stereo 2x boundary and rejects one byte less headroom', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    const project = advertisedBoundaryProject();
    const cache = new AudioClipBufferCache();
    const resources = estimateAudioWarpResourcePeakBytes(project, cache);
    const requestAtBoundary = compileAudioWarpRenderRequests(project)[0]!;
    const workingBytes = estimateAudioWarpRenderWorkingBytes(requestAtBoundary);
    const canonicalBytes = derivedPcmBytes(
      requestAtBoundary.sourceFrameCount,
      requestAtBoundary.channelCount,
    );
    const completePeak = assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
      0,
      resources.estimatedPeakBytes,
    ).estimatedPeakBytes;
    const exactCompetingBytes = MAX_HEAVY_AUDIO_RESOURCE_BYTES - completePeak;

    expect(requestAtBoundary.outputFrameCount).toBe(2 * 60 * 48_000);
    expect(resources.additionalPeakBytes).toBe(workingBytes + canonicalBytes);
    expect(completePeak).toBeLessThanOrEqual(MAX_HEAVY_AUDIO_RESOURCE_BYTES);

    const exactCompeting = reserveHeavyAudioResources(exactCompetingBytes);
    const budget = reserveHeavyAudioResourceBudget(completePeak);
    const working = budget.claim(workingBytes);
    const canonical = budget.claim(canonicalBytes);
    expect(getReservedHeavyAudioResourceBytes()).toBe(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES,
    );
    expect(() => reserveHeavyAudioResources(1))
      .toThrow(AudioResourceReservationError);
    budget.release();
    working.release();
    canonical.release();
    exactCompeting.release();

    const oneByteTooMuch = reserveHeavyAudioResources(exactCompetingBytes + 1);
    expect(() => reserveHeavyAudioResourceBudget(completePeak))
      .toThrow(AudioResourceReservationError);
    oneByteTooMuch.release();
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });

  it('reuses retained PCM without a second Worker peak or duplicate cache ownership', async () => {
    const fixture = warpProject();
    const cache = new AudioClipBufferCache(1024 * 1024);
    const baseline = getReservedHeavyAudioResourceBytes();
    const renderer = vi.fn(async (candidate: AudioWarpRenderRequest) =>
      pcm(candidate.outputFrameCount));

    const firstResources = estimateAudioWarpResourcePeakBytes(
      fixture.project,
      cache,
    );
    const firstBudget = reserveHeavyAudioResourceBudget(
      firstResources.additionalPeakBytes,
    );
    const first = await acquireAudioClipPlaybackBuffers(
      fixture.project,
      fixture.prepared,
      fixture.source,
      contextStub(),
      { cache, renderer, resourceBudget: firstBudget },
    );
    firstBudget.release();
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(getReservedHeavyAudioResourceBytes() - baseline).toBe(
      2 * cache.retainedDerivedBytes,
    );
    first.release();
    expect(getReservedHeavyAudioResourceBytes() - baseline).toBe(
      cache.retainedDerivedBytes,
    );

    const retainedBytes = cache.retainedDerivedBytes;
    const secondResources = estimateAudioWarpResourcePeakBytes(
      fixture.project,
      cache,
    );
    expect(secondResources).toMatchObject({
      retainedDerivedBytes: retainedBytes,
      additionalPeakBytes: retainedBytes,
      estimatedPeakBytes: 2 * retainedBytes,
    });
    const secondBudget = reserveHeavyAudioResourceBudget(
      secondResources.additionalPeakBytes,
    );
    const secondSource: AudioAssetBufferLease = {
      buffersByAssetId: new Map(),
      release: vi.fn(),
    };
    const second = await acquireAudioClipPlaybackBuffers(
      fixture.project,
      fixture.prepared,
      secondSource,
      contextStub(),
      { cache, renderer, resourceBudget: secondBudget },
    );
    secondBudget.release();
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(getReservedHeavyAudioResourceBytes() - baseline).toBe(
      2 * retainedBytes,
    );
    second.release();
    expect(getReservedHeavyAudioResourceBytes() - baseline).toBe(retainedBytes);
    cache.clearUnused();
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });

  it('fails an undersized claim before constructing the Worker', async () => {
    const fixture = warpProject();
    const cache = new AudioClipBufferCache(1024 * 1024);
    const compiled = compileAudioWarpRenderRequests(fixture.project)[0]!;
    const budget = reserveHeavyAudioResourceBudget(
      estimateAudioWarpRenderWorkingBytes(compiled) - 1,
    );
    const baselineWithBudget = getReservedHeavyAudioResourceBytes();
    const worker = vi.fn();
    vi.stubGlobal('Worker', worker);

    try {
      await expect(acquireAudioClipPlaybackBuffers(
        fixture.project,
        fixture.prepared,
        fixture.source,
        contextStub(),
        { cache, resourceBudget: budget },
      )).rejects.toMatchObject({ code: 'resource-limit' });
      expect(worker).not.toHaveBeenCalled();
      expect(getReservedHeavyAudioResourceBytes()).toBe(baselineWithBudget);
    } finally {
      budget.release();
      cache.clearUnused();
      vi.unstubAllGlobals();
    }
  });
});

describe('bounded canonical clip windows', () => {
  it('decodes and passes only the required source window from a longer asset', async () => {
    const fixture = warpProject();
    const cache = new AudioClipBufferCache(1024 * 1024);
    const reservedBefore = getReservedHeavyAudioResourceBytes();
    const originalRequest = compileAudioWarpRenderRequests(fixture.project)[0]!;
    const fullSource = parseCanonicalPcm16(fixture.prepared.assets[0]!.bytes, {
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 9_600,
    });
    const expected = renderAudioWarp(originalRequest, fullSource);
    const rendered: DerivedAudioPcm[] = [];
    const renderer = vi.fn(async (
      candidate: AudioWarpRenderRequest,
      source: CanonicalPcm16,
      signal?: AbortSignal,
    ) => {
      expect(candidate.sourceStartFrame).toBe(0);
      expect(source.frameCount).toBe(2_400);
      expect(source.channels[0]?.length).toBe(2_400);
      expect(source.channels[0]?.[0]).toBeCloseTo(-10_000 / 32_768, 7);
      expect(getReservedHeavyAudioResourceBytes()).toBeGreaterThanOrEqual(
        2_400 * Float32Array.BYTES_PER_ELEMENT * 10,
      );
      const result = renderAudioWarp(candidate, source, signal);
      rendered.push(result);
      return result;
    });

    const lease = await acquireAudioClipPlaybackBuffers(
      fixture.project,
      fixture.prepared,
      fixture.source,
      contextStub(),
      { cache, renderer },
    );
    expect(renderer).toHaveBeenCalledTimes(1);
    expect([...(rendered[0]?.channels[0] ?? [])]).toEqual([
      ...expected.channels[0]!,
    ]);
    expect(getReservedHeavyAudioResourceBytes() - reservedBefore).toBe(
      2 * 2_400 * Float32Array.BYTES_PER_ELEMENT,
    );
    lease.release();
    expect(getReservedHeavyAudioResourceBytes() - reservedBefore).toBe(
      2_400 * Float32Array.BYTES_PER_ELEMENT,
    );
    cache.clearUnused();
    expect(getReservedHeavyAudioResourceBytes()).toBe(reservedBefore);
  });

  it('deduplicates one canonical window by checksum across independent Asset IDs', async () => {
    const fixture = warpProject();
    const reservedBefore = getReservedHeavyAudioResourceBytes();
    const firstAsset = fixture.project.audioAssets[0] as ReadyAudioAsset;
    const alias: ReadyAudioAsset = { ...firstAsset, id: 'asset-alias' };
    fixture.project.audioAssets.push(alias);
    const firstClip = fixture.project.tracks[0]!.clips[0] as AudioClip;
    fixture.project.tracks[0]!.clips.push({
      ...firstClip,
      id: 'clip-alias',
      startBeat: 0.2,
      lengthBeats: 0.11,
      audioAssetId: alias.id,
      audioWarp: {
        ...firstClip.audioWarp!,
        markers: [
          firstClip.audioWarp!.markers[0]!,
          { sourceFrame: 4_800, targetBeatOffset: 0.11 },
        ],
      },
    });
    fixture.prepared = {
      assets: [
        fixture.prepared.assets[0]!,
        { asset: alias, bytes: fixture.prepared.assets[0]!.bytes },
      ],
      estimatedDecodedBytes: fixture.prepared.estimatedDecodedBytes,
    };
    const sources: unknown[] = [];
    const cache = new AudioClipBufferCache(1024 * 1024);
    const renderer = vi.fn(async (
      candidate: AudioWarpRenderRequest,
      source: CanonicalPcm16,
    ) => {
      sources.push(source);
      return pcm(candidate.outputFrameCount);
    });

    const lease = await acquireAudioClipPlaybackBuffers(
      fixture.project,
      fixture.prepared,
      fixture.source,
      contextStub(),
      { cache, renderer },
    );
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(sources[0]).toBe(sources[1]);
    expect((sources[0] as { frameCount: number }).frameCount).toBe(2_400);
    lease.release();
    cache.clearUnused();
    expect(getReservedHeavyAudioResourceBytes()).toBe(reservedBefore);
  });

  it('releases the canonical and render reservations when window parsing fails', async () => {
    const fixture = warpProject();
    const corrupt = fixture.prepared.assets[0]!.bytes.slice();
    corrupt[0] = 0;
    fixture.prepared = {
      ...fixture.prepared,
      assets: [{
        asset: fixture.prepared.assets[0]!.asset,
        bytes: corrupt,
      }],
    };
    const cache = new AudioClipBufferCache(1024 * 1024);
    const reservedBefore = getReservedHeavyAudioResourceBytes();

    await expect(acquireAudioClipPlaybackBuffers(
      fixture.project,
      fixture.prepared,
      fixture.source,
      contextStub(),
      { cache, renderer: async (candidate) => pcm(candidate.outputFrameCount) },
    )).rejects.toMatchObject({ code: 'invalid-pcm' });
    expect(fixture.source.release).toHaveBeenCalledTimes(1);
    expect(cache.entryCount).toBe(0);
    expect(cache.retainedDerivedBytes).toBe(0);
    expect(getReservedHeavyAudioResourceBytes()).toBe(reservedBefore);
  });
});

describe('canonical PCM16 parsing', () => {
  it('parses exact interleaved PCM and rejects metadata mismatch', () => {
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
      for (let index = 0; index < value.length; index += 1) {
        bytes[offset + index] = value.charCodeAt(index);
      }
    }
    view.setUint32(4, 40, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 96_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, 4, true);
    view.setInt16(44, -32_768, true);
    view.setInt16(46, 16_384, true);

    const parsed = parseCanonicalPcm16(bytes, {
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 2,
    });
    expect([...parsed.channels[0]!]).toEqual([-1, 0.5]);
    expect(() => parseCanonicalPcm16(bytes, { frameCount: 3 })).toThrowError(
      expect.objectContaining({ code: 'metadata-mismatch' }) as CanonicalPcm16Error,
    );
  });
});
