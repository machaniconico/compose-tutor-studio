import { describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '@cts/project-model';
import {
  AudioAssetPlaybackCache,
  AudioAssetPlaybackError,
  MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES,
  acquireProjectAudioBuffers,
  assertProjectAudioAssetCombinedResourceBudget,
  estimateProjectAudioResources,
  firstReferencedReadyAudioAssetId,
  getAudioAssetBytesResolver,
  preflightProjectAudioAssets,
  projectHasReferencedReadyAudioAssets,
  setAudioAssetBytesResolver,
  sha256Hex,
  type AudioAssetBytesResolver,
} from '../src/audio/audioAssetResolver';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function projectWithAsset(asset: ReadyAudioAsset): Project {
  const clip: AudioClip = {
    id: 'audio-clip',
    trackId: 'audio-track',
    type: 'audio',
    startBeat: 0,
    lengthBeats: 1,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 0,
    sourceFrameCount: asset.frameCount,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
  };
  const track: Track = {
    id: 'audio-track',
    name: 'Audio',
    type: 'audio',
    role: 'general',
    clips: [clip],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  return {
    id: 'audio-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Asset resolver test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
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
}

function projectWithTakeFolder(asset: ReadyAudioAsset): Project {
  const project = projectWithAsset(asset);
  project.tracks[0]!.clips = [];
  project.audioTakeFolders = [{
    id: 'take-folder',
    trackId: project.tracks[0]!.id,
    startBeat: 0,
    lengthBeats: 1,
    crossfadeMs: 5,
    takes: [
      {
        id: 'take-1',
        audioAssetId: asset.id,
        offsetBeats: 0,
        lengthBeats: 1,
        sourceStartFrame: 0,
        sourceFrameCount: asset.frameCount,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
      {
        id: 'take-2',
        audioAssetId: asset.id,
        offsetBeats: 0,
        lengthBeats: 1,
        sourceStartFrame: 0,
        sourceFrameCount: asset.frameCount,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      },
    ],
    compSegments: [{
      id: 'comp-segment',
      takeId: 'take-1',
      offsetBeats: 0,
      lengthBeats: 1,
    }],
  }];
  return project;
}

async function fixture(bytes = Uint8Array.from([1, 2, 3, 4])) {
  const asset: ReadyAudioAsset = {
    id: 'asset-1',
    availability: 'ready',
    checksumSha256: await sha256Hex(bytes),
    originalName: 'canonical.wav',
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  };
  return { asset, project: projectWithAsset(asset), bytes };
}

function decodedBuffer(overrides: Partial<AudioBuffer> = {}): AudioBuffer {
  return {
    duration: 1,
    length: 44_100,
    sampleRate: 44_100,
    numberOfChannels: 1,
    ...overrides,
  } as AudioBuffer;
}

describe('audio asset resolver preflight', () => {
  it('requires no resolver when the project has no referenced ready audio', async () => {
    const { project } = await fixture();
    project.tracks = [];

    await expect(preflightProjectAudioAssets(project, {
      resolver: null,
      cache: new AudioAssetPlaybackCache(),
    })).resolves.toEqual({ assets: [], estimatedDecodedBytes: 0 });
  });

  it('verifies length and checksum before any decode context is needed', async () => {
    const { asset, project, bytes } = await fixture();
    const resolve = vi.fn(async () => bytes);
    const prepared = await preflightProjectAudioAssets(project, {
      resolver: { resolve },
      cache: new AudioAssetPlaybackCache(),
      targetSampleRate: 48_000,
    });

    expect(resolve).toHaveBeenCalledWith(asset);
    expect(prepared.assets[0]?.bytes).toEqual(bytes);
    expect(prepared.estimatedDecodedBytes).toBe(48_000 * 4);
  });

  it('prepares a ready asset referenced only by an Audio take folder', async () => {
    const { asset, bytes } = await fixture();
    const project = projectWithTakeFolder(asset);
    const resolve = vi.fn(async () => bytes);

    expect(projectHasReferencedReadyAudioAssets(project)).toBe(true);
    expect(firstReferencedReadyAudioAssetId(project)).toBe(asset.id);
    expect(estimateProjectAudioResources(project, 48_000)).toEqual({
      rawBytes: bytes.byteLength,
      largestRawAssetBytes: bytes.byteLength,
      decodedBytes: 48_002 * Float32Array.BYTES_PER_ELEMENT,
    });

    const prepared = await preflightProjectAudioAssets(project, {
      resolver: { resolve },
      cache: new AudioAssetPlaybackCache(),
      targetSampleRate: 48_000,
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(asset);
    expect(prepared.assets).toEqual([{ asset, bytes }]);
    expect(prepared.estimatedDecodedBytes).toBe(48_000 * Float32Array.BYTES_PER_ELEMENT);
  });

  it('passes the combined gate for an ordinary short referenced asset', async () => {
    const { project } = await fixture();

    expect(assertProjectAudioAssetCombinedResourceBudget(project, 48_000)).toEqual({
      rawBytes: 4,
      largestRawAssetBytes: 4,
      decodedBytes: 48_002 * Float32Array.BYTES_PER_ELEMENT,
      resolvePeakBytes: 12,
      decodePeakBytes: 4 + 4 + 48_002 * Float32Array.BYTES_PER_ELEMENT,
      estimatedPeakBytes: 4 + 4 + 48_002 * Float32Array.BYTES_PER_ELEMENT,
    });
  });

  it('includes derived and Worker ownership in the shared combined gate', async () => {
    const { project } = await fixture();
    const baseline = assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
    ).estimatedPeakBytes;
    expect(() => assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
      0,
      MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES - baseline + 1,
    )).toThrowError(expect.objectContaining({
      code: 'resource-limit',
      assetId: 'asset-1',
    }) as AudioAssetPlaybackError);
  });

  it('rejects a raw-heavy combined peak before calling the resolver', async () => {
    const { asset } = await fixture();
    const rawHeavyAsset = {
      ...asset,
      byteLength: Math.floor(MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES / 3) + 1,
      frameCount: 1,
    };
    const resolve = vi.fn(async () => new Uint8Array());

    await expect(preflightProjectAudioAssets(projectWithAsset(rawHeavyAsset), {
      resolver: { resolve },
      cache: new AudioAssetPlaybackCache(),
      targetSampleRate: 48_000,
    })).rejects.toMatchObject({
      name: 'AudioAssetPlaybackError',
      code: 'resource-limit',
      assetId: 'asset-1',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps retained decoded buffers in a raw-heavy resolver/hash peak', async () => {
    const { asset } = await fixture();
    const retainedDecodedBytes = 1024 * 1024;
    const rawBytes = Math.floor((
      MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES - retainedDecodedBytes
    ) / 3) + 1;
    const rawHeavyAsset = {
      ...asset,
      byteLength: rawBytes,
      frameCount: 1,
    };
    const project = projectWithAsset(rawHeavyAsset);

    expect(assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
      0,
    ).estimatedPeakBytes).toBeLessThanOrEqual(
      MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES,
    );
    expect(() => assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
      retainedDecodedBytes,
    )).toThrowError(expect.objectContaining({
      code: 'resource-limit',
      assetId: 'asset-1',
    }) as AudioAssetPlaybackError);
  });

  it('uses the actual destination context rate at the combined boundary', async () => {
    const { asset, bytes } = await fixture();
    const resampledAsset = {
      ...asset,
      frameCount: 51_000_000,
    };
    const project = projectWithAsset(resampledAsset);
    const resolve = vi.fn(async () => bytes);
    const cache = new AudioAssetPlaybackCache();

    await expect(preflightProjectAudioAssets(project, {
      resolver: { resolve },
      cache,
      targetSampleRate: 48_000,
    })).resolves.toMatchObject({ assets: [{ asset: { id: 'asset-1' } }] });
    await expect(preflightProjectAudioAssets(project, {
      resolver: { resolve },
      cache,
      targetSampleRate: 96_000,
    })).rejects.toMatchObject({ code: 'resource-limit', assetId: 'asset-1' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('enforces the 256 MiB target-rate decode cap before resolver I/O', async () => {
    const { asset, bytes } = await fixture();
    const targetHeavyAsset = {
      ...asset,
      frameCount: 50_000_000,
    };
    const resolve = vi.fn(async () => bytes);

    await expect(preflightProjectAudioAssets(projectWithAsset(targetHeavyAsset), {
      resolver: { resolve },
      cache: new AudioAssetPlaybackCache(),
      targetSampleRate: 72_000,
    })).rejects.toMatchObject({
      code: 'resource-limit',
      assetId: 'asset-1',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('counts active cache leases but excludes reclaimable LRU entries after cleanup', async () => {
    const seed = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await cache.preflight(seed.project, {
      resolve: async () => seed.bytes,
    });
    const lease = await cache.acquireDecoded(prepared, {
      sampleRate: 44_100,
      decodeAudioData: vi.fn(async () => decodedBuffer()),
    } as unknown as BaseAudioContext);
    expect(cache.retainedDecodedBytes).toBeGreaterThan(0);

    const targetDecodedBytes = 256 * 1024 * 1024;
    const frameCount = targetDecodedBytes / Float32Array.BYTES_PER_ELEMENT - 2;
    const rawBytes = Math.floor((
      MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES -
      targetDecodedBytes -
      cache.retainedDecodedBytes
    ) / 2) + 1;
    const nearLimitAsset: ReadyAudioAsset = {
      ...seed.asset,
      id: 'asset-near-limit',
      checksumSha256: 'f'.repeat(64),
      byteLength: rawBytes,
      frameCount,
    };
    const nearLimitProject = projectWithAsset(nearLimitAsset);
    expect(assertProjectAudioAssetCombinedResourceBudget(
      nearLimitProject,
      48_000,
      0,
    ).estimatedPeakBytes).toBeLessThanOrEqual(
      MAX_AUDIO_ASSET_COMBINED_ESTIMATED_BYTES,
    );
    const resolve = vi.fn(async () => new Uint8Array());

    await expect(preflightProjectAudioAssets(nearLimitProject, {
      resolver: { resolve },
      cache,
      targetSampleRate: 48_000,
    })).rejects.toMatchObject({ code: 'resource-limit', assetId: 'asset-near-limit' });
    expect(resolve).not.toHaveBeenCalled();

    lease.release();
    expect(cache.retainedDecodedBytes).toBeGreaterThan(0);
    cache.clearUnused();
    expect(cache.retainedDecodedBytes).toBe(0);
    const missing = new AudioAssetPlaybackError('asset-missing', 'asset-near-limit');
    resolve.mockRejectedValueOnce(missing);
    await expect(preflightProjectAudioAssets(nearLimitProject, {
      resolver: { resolve },
      cache,
      targetSampleRate: 48_000,
    })).rejects.toBe(missing);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('fails checked combined arithmetic closed before resolver I/O', async () => {
    const { asset } = await fixture();
    const overflowAsset = {
      ...asset,
      byteLength: Number.MAX_SAFE_INTEGER,
      frameCount: 1,
    };
    const resolve = vi.fn(async () => new Uint8Array());

    await expect(preflightProjectAudioAssets(projectWithAsset(overflowAsset), {
      resolver: { resolve },
      cache: new AudioAssetPlaybackCache(),
      targetSampleRate: 48_000,
    })).rejects.toMatchObject({ code: 'resource-limit', assetId: 'asset-1' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'changed byte length',
      mutate: (bytes: Uint8Array) => bytes.slice(0, 3),
    },
    {
      label: 'changed checksum',
      mutate: (bytes: Uint8Array) => Uint8Array.from([...bytes.slice(0, 3), 9]),
    },
  ])('rejects $label with a typed error', async ({ mutate }) => {
    const { project, bytes } = await fixture();
    await expect(preflightProjectAudioAssets(project, {
      resolver: { resolve: async () => mutate(bytes) },
      cache: new AudioAssetPlaybackCache(),
    })).rejects.toMatchObject({
      name: 'AudioAssetPlaybackError',
      code: 'asset-changed',
      assetId: 'asset-1',
    });
  });

  it('preserves typed missing errors from a platform adapter', async () => {
    const { project } = await fixture();
    const missing = new AudioAssetPlaybackError('asset-missing', 'asset-1');

    await expect(preflightProjectAudioAssets(project, {
      resolver: { resolve: async () => { throw missing; } },
      cache: new AudioAssetPlaybackCache(),
    })).rejects.toBe(missing);
  });

  it('rejects decoded-memory metadata before reading bytes', async () => {
    const { asset } = await fixture();
    const oversized = {
      ...asset,
      frameCount: 100_000_000,
    };
    const resolve = vi.fn(async () => new Uint8Array(asset.byteLength));

    await expect(preflightProjectAudioAssets(projectWithAsset(oversized), {
      resolver: { resolve },
      cache: new AudioAssetPlaybackCache(),
    })).rejects.toMatchObject({ code: 'resource-limit' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('single-flights concurrent reads but re-verifies a later session', async () => {
    const { project, bytes } = await fixture();
    const resolve = vi.fn(async () => bytes);
    const resolver: AudioAssetBytesResolver = { resolve };
    const cache = new AudioAssetPlaybackCache();

    await Promise.all([
      preflightProjectAudioAssets(project, { resolver, cache }),
      preflightProjectAudioAssets(project, { resolver, cache }),
    ]);
    await preflightProjectAudioAssets(project, { resolver, cache });

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('resolves duplicate asset ids sharing one checksum only once per session', async () => {
    const { asset, project, bytes } = await fixture();
    const duplicate = { ...asset, id: 'asset-2' };
    project.audioAssets.push(duplicate);
    project.tracks[0]?.clips.push({
      ...(project.tracks[0]?.clips[0] as AudioClip),
      id: 'audio-clip-2',
      audioAssetId: duplicate.id,
    });
    const resolve = vi.fn(async () => bytes);
    const cache = new AudioAssetPlaybackCache();

    const prepared = await cache.preflight(project, { resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(prepared.assets).toHaveLength(2);
    expect(prepared.assets[0]?.bytes).toBe(prepared.assets[1]?.bytes);
    expect(prepared.estimatedDecodedBytes).toBe(48_000 * 4);
    expect(assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
    )).toMatchObject({
      rawBytes: bytes.byteLength,
      largestRawAssetBytes: bytes.byteLength,
      decodedBytes: 48_002 * Float32Array.BYTES_PER_ELEMENT,
    });
  });

  it('cancels one waiter without poisoning a concurrent shared read', async () => {
    const { project, bytes } = await fixture();
    const read = deferred<Uint8Array>();
    const resolve = vi.fn(() => read.promise);
    const resolver = { resolve };
    const cache = new AudioAssetPlaybackCache();
    const controller = new AbortController();

    const cancelled = cache.preflight(project, resolver, controller.signal);
    const surviving = cache.preflight(project, resolver);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

    read.resolve(bytes);
    await expect(surviving).resolves.toMatchObject({ assets: [{ asset: { id: 'asset-1' } }] });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'asset-1' }));
  });
});

describe('default audio asset resolver registration', () => {
  it('restores the previous resolver when a temporary override is released', () => {
    const previous = getAudioAssetBytesResolver();
    const first: AudioAssetBytesResolver = { resolve: vi.fn() };
    const second: AudioAssetBytesResolver = { resolve: vi.fn() };
    const releaseFirst = setAudioAssetBytesResolver(first);
    const releaseSecond = setAudioAssetBytesResolver(second);

    expect(getAudioAssetBytesResolver()).toBe(second);
    releaseSecond();
    expect(getAudioAssetBytesResolver()).toBe(first);
    releaseSecond();
    expect(getAudioAssetBytesResolver()).toBe(first);
    releaseFirst();
    expect(getAudioAssetBytesResolver()).toBe(previous);
  });

  it('does not resurrect an earlier resolver released out of order', () => {
    const previous = getAudioAssetBytesResolver();
    const first: AudioAssetBytesResolver = { resolve: vi.fn() };
    const second: AudioAssetBytesResolver = { resolve: vi.fn() };
    const releaseFirst = setAudioAssetBytesResolver(first);
    const releaseSecond = setAudioAssetBytesResolver(second);

    releaseFirst();
    expect(getAudioAssetBytesResolver()).toBe(second);
    releaseSecond();
    expect(getAudioAssetBytesResolver()).toBe(previous);
  });
});

describe('decoded audio asset leases', () => {
  it('decodes a ready asset referenced only by an Audio take folder', async () => {
    const { asset, bytes } = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await preflightProjectAudioAssets(
      projectWithTakeFolder(asset),
      {
        resolver: { resolve: async () => bytes },
        cache,
      },
    );
    const decodeAudioData = vi.fn(async () => decodedBuffer({
      sampleRate: 48_000,
      length: 48_000,
      duration: 1,
    }));
    const context = {
      sampleRate: 48_000,
      decodeAudioData,
    } as unknown as BaseAudioContext;

    const lease = await acquireProjectAudioBuffers(prepared, context, { cache });

    expect(lease.buffersByAssetId.get(asset.id)).toMatchObject({
      sampleRate: 48_000,
      length: 48_000,
    });
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('decodes once per checksum/sample-rate and releases idempotently', async () => {
    const { project, bytes } = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await preflightProjectAudioAssets(project, {
      resolver: { resolve: async () => bytes },
      cache,
    });
    const decodeAudioData = vi.fn(async () => decodedBuffer());
    const context = { sampleRate: 44_100, decodeAudioData } as unknown as BaseAudioContext;

    const first = await acquireProjectAudioBuffers(prepared, context, { cache });
    const second = await acquireProjectAudioBuffers(prepared, context, { cache });
    expect(first.buffersByAssetId.get('asset-1')).toBe(second.buffersByAssetId.get('asset-1'));
    expect(decodeAudioData).toHaveBeenCalledTimes(1);

    first.release();
    first.release();
    second.release();
  });

  it('accepts context resampling when duration and channels still match', async () => {
    const { project, bytes } = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await cache.preflight(project, { resolve: async () => bytes });
    const context = {
      sampleRate: 44_100,
      decodeAudioData: vi.fn(async () => decodedBuffer({
        sampleRate: 44_100,
        length: 44_100,
        duration: 1,
      })),
    } as unknown as BaseAudioContext;

    const lease = await cache.acquireDecoded(prepared, context);
    expect(lease.buffersByAssetId.get('asset-1')?.sampleRate).toBe(44_100);
    lease.release();
  });

  it.each([22_049, 22_051])(
    'accepts a 48 kHz decode differing by one 44.1 kHz frame (%i frames)',
    async (decodedFrames) => {
      const { asset, bytes } = await fixture();
      const halfSecondAsset = { ...asset, frameCount: 24_000 };
      const cache = new AudioAssetPlaybackCache();
      const prepared = await cache.preflight(
        projectWithAsset(halfSecondAsset),
        { resolve: async () => bytes },
      );
      const context = {
        sampleRate: 44_100,
        decodeAudioData: vi.fn(async () => decodedBuffer({
          sampleRate: 44_100,
          length: decodedFrames,
          duration: decodedFrames / 44_100,
        })),
      } as unknown as BaseAudioContext;

      const lease = await cache.acquireDecoded(prepared, context);
      expect(lease.buffersByAssetId.get('asset-1')?.length).toBe(decodedFrames);
      lease.release();
    },
  );

  it.each([22_048, 22_052])(
    'rejects a 48 kHz decode differing by two 44.1 kHz frames (%i frames)',
    async (decodedFrames) => {
      const { asset, bytes } = await fixture();
      const halfSecondAsset = { ...asset, frameCount: 24_000 };
      const cache = new AudioAssetPlaybackCache();
      const prepared = await cache.preflight(
        projectWithAsset(halfSecondAsset),
        { resolve: async () => bytes },
      );
      const context = {
        sampleRate: 44_100,
        decodeAudioData: vi.fn(async () => decodedBuffer({
          sampleRate: 44_100,
          length: decodedFrames,
          duration: decodedFrames / 44_100,
        })),
      } as unknown as BaseAudioContext;

      await expect(cache.acquireDecoded(prepared, context)).rejects.toMatchObject({
        code: 'asset-changed',
        assetId: 'asset-1',
      });
    },
  );

  it('rejects a channel mismatch as changed asset metadata', async () => {
    const { project, bytes } = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await cache.preflight(project, { resolve: async () => bytes });
    const context = {
      sampleRate: 48_000,
      decodeAudioData: vi.fn(async () => decodedBuffer({
        sampleRate: 48_000,
        length: 48_000,
        numberOfChannels: 2,
        duration: 1,
      })),
    } as unknown as BaseAudioContext;

    await expect(cache.acquireDecoded(prepared, context)).rejects.toMatchObject({
      code: 'asset-changed',
      assetId: 'asset-1',
    });
  });

  it.each([
    { label: 'zero sample rate', buffer: { sampleRate: 0, length: 48_000, duration: 1 } },
    { label: 'zero frame length', buffer: { sampleRate: 48_000, length: 0, duration: 1 } },
    {
      label: 'non-finite duration',
      buffer: { sampleRate: 48_000, length: 48_000, duration: Number.NaN },
    },
    {
      label: 'inconsistent duration',
      buffer: { sampleRate: 48_000, length: 48_000, duration: 0.5 },
    },
  ])('rejects $label in decoded metadata', async ({ buffer }) => {
    const { project, bytes } = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await cache.preflight(project, { resolve: async () => bytes });
    const context = {
      sampleRate: 48_000,
      decodeAudioData: vi.fn(async () => decodedBuffer(buffer)),
    } as unknown as BaseAudioContext;

    await expect(cache.acquireDecoded(prepared, context)).rejects.toMatchObject({
      code: 'asset-changed',
      assetId: 'asset-1',
    });
  });

  it('types browser decode failures and resource failures separately', async () => {
    const { project, bytes } = await fixture();
    const normalCache = new AudioAssetPlaybackCache();
    const prepared = await normalCache.preflight(project, { resolve: async () => bytes });
    const decodeFailure = {
      sampleRate: 48_000,
      decodeAudioData: vi.fn(async () => { throw new DOMException('bad wav', 'EncodingError'); }),
    } as unknown as BaseAudioContext;
    await expect(normalCache.acquireDecoded(prepared, decodeFailure)).rejects.toMatchObject({
      code: 'decode-failed',
    });

    const resourceCache = new AudioAssetPlaybackCache();
    const resourcePrepared = await resourceCache.preflight(project, { resolve: async () => bytes });
    const resourceFailure = {
      sampleRate: 48_000,
      decodeAudioData: vi.fn(async () => { throw new RangeError('allocation'); }),
    } as unknown as BaseAudioContext;
    await expect(resourceCache.acquireDecoded(resourcePrepared, resourceFailure)).rejects.toMatchObject({
      code: 'resource-limit',
    });
  });

  it('budgets the target context resample rate before decode allocation', async () => {
    const { asset, bytes } = await fixture();
    const highRateAsset = {
      ...asset,
      frameCount: 20_000_000,
    };
    const cache = new AudioAssetPlaybackCache();
    const prepared = await cache.preflight(
      projectWithAsset(highRateAsset),
      { resolve: async () => bytes },
    );
    const decodeAudioData = vi.fn(async () => decodedBuffer());
    const context = {
      sampleRate: 192_000,
      decodeAudioData,
    } as unknown as BaseAudioContext;

    await expect(cache.acquireDecoded(prepared, context)).rejects.toMatchObject({
      code: 'resource-limit',
      assetId: 'asset-1',
    });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('does not evict or duplicate a decode that is still in flight', async () => {
    const { project, bytes } = await fixture();
    const cache = new AudioAssetPlaybackCache();
    const prepared = await cache.preflight(project, { resolve: async () => bytes });
    const decoding = deferred<AudioBuffer>();
    const decodeAudioData = vi.fn(() => decoding.promise);
    const context = { sampleRate: 44_100, decodeAudioData } as unknown as BaseAudioContext;

    const firstPromise = cache.acquireDecoded(prepared, context);
    cache.clearUnused();
    const secondPromise = cache.acquireDecoded(prepared, context);
    decoding.resolve(decodedBuffer());
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(first.buffersByAssetId.get('asset-1')).toBe(second.buffersByAssetId.get('asset-1'));
    first.release();
    second.release();
  });

  it('reserves a lease before decode fulfillment can trigger competing eviction', async () => {
    const firstFixture = await fixture(Uint8Array.from([1, 2, 3, 4]));
    const secondFixture = await fixture(Uint8Array.from([5, 6, 7, 8]));
    const cache = new AudioAssetPlaybackCache(1_024, 192_000);
    const preparedFirst = await cache.preflight(firstFixture.project, {
      resolve: async () => firstFixture.bytes,
    });
    const preparedSecond = await cache.preflight(secondFixture.project, {
      resolve: async () => secondFixture.bytes,
    });
    const decoding = deferred<AudioBuffer>();
    let competingQueued = false;
    let competing: ReturnType<AudioAssetPlaybackCache['acquireDecoded']> | undefined;
    let context!: BaseAudioContext;
    const firstBuffer = {
      duration: 1,
      get length() {
        if (!competingQueued) {
          competingQueued = true;
          queueMicrotask(() => {
            competing = cache.acquireDecoded(preparedSecond, context);
            void competing.catch(() => {});
          });
        }
        return 44_100;
      },
      sampleRate: 44_100,
      numberOfChannels: 1,
    } as AudioBuffer;
    const decodeAudioData = vi.fn(() => decoding.promise);
    context = { sampleRate: 44_100, decodeAudioData } as unknown as BaseAudioContext;

    const firstPromise = cache.acquireDecoded(preparedFirst, context);
    decoding.resolve(firstBuffer);
    const first = await firstPromise;

    expect(competing).toBeDefined();
    await expect(competing).rejects.toMatchObject({
      code: 'resource-limit',
      assetId: 'asset-1',
    });
    const secondLeaseForFirstAsset = await cache.acquireDecoded(preparedFirst, context);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(secondLeaseForFirstAsset.buffersByAssetId.get('asset-1')).toBe(firstBuffer);
    first.release();
    secondLeaseForFirstAsset.release();
  });
});
