import { describe, expect, it, vi } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { createEmptyProject, type ReadyAudioAsset } from '@cts/project-model';
import { encodePortableProjectBundle } from '@cts/project-bundle';
import {
  AudioAssetRepositoryError,
  MemoryAudioAssetRepository,
} from '../src/platform/audioAssetRepository';
import { createStudioStore } from '../src/state/store';
import {
  exportPortableProjectBundle as exportPortableProjectBundleWithReservation,
  importPortableProjectBundle as importPortableProjectBundleWithReservation,
} from '../src/features/export/portableProjectBundle';

type TestReservation =
  Parameters<typeof exportPortableProjectBundleWithReservation>[2]['reservation'];

function testReservation(release = vi.fn()): TestReservation {
  return {
    bytes: 384 * 1024 * 1024,
    released: false,
    resize: vi.fn(),
    release,
  };
}

type TestExportDependencies = Readonly<{
  reservation?: TestReservation;
  reserve?: () => TestReservation;
  codec?: Parameters<typeof exportPortableProjectBundleWithReservation>[2]['codec'];
}>;

async function exportPortableProjectBundle(
  project: Parameters<typeof exportPortableProjectBundleWithReservation>[0],
  repository: Parameters<typeof exportPortableProjectBundleWithReservation>[1],
  dependencies: TestExportDependencies = {},
) {
  const ownsReservation = dependencies.reservation === undefined;
  const reservation = dependencies.reservation
    ?? dependencies.reserve?.()
    ?? testReservation();
  try {
    return await exportPortableProjectBundleWithReservation(project, repository, {
      reservation,
      codec: dependencies.codec,
    });
  } finally {
    if (ownsReservation) reservation.release();
  }
}

type TestImportDependencies =
  Omit<Parameters<typeof importPortableProjectBundleWithReservation>[1], 'reservation'>
  & Readonly<{
    reservation?: TestReservation;
    reserve?: () => TestReservation;
  }>;

async function importPortableProjectBundle(
  bytes: Parameters<typeof importPortableProjectBundleWithReservation>[0],
  dependencies: TestImportDependencies,
) {
  const ownsReservation = dependencies.reservation === undefined;
  const reservation = dependencies.reservation
    ?? dependencies.reserve?.()
    ?? testReservation();
  try {
    return await importPortableProjectBundleWithReservation(bytes, {
      ...dependencies,
      reservation,
    });
  } finally {
    if (ownsReservation) reservation.release();
  }
}

function canonicalWav(...samples: number[]): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    view.setInt16(44 + index * 2, sample, true);
  });
  return bytes;
}

async function readyAsset(bytes: Uint8Array): Promise<ReadyAudioAsset> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const checksumSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    id: 'asset-portable',
    availability: 'ready',
    checksumSha256,
    originalName: 'self-authored.wav',
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: Math.max(1, Math.floor((bytes.byteLength - 44) / 2)),
  };
}

describe('Studio portable project bundle orchestration', () => {
  it('validates, stores and verifies receipts before one fresh-id replacement', async () => {
    const events: string[] = [];
    const bytes = canonicalWav(1, 2, 3, 4);
    const asset = await readyAsset(bytes);
    const source = new MemoryAudioAssetRepository();
    await source.store({ ...asset, bytes });
    const project = {
      ...createEmptyProject({ title: '持ち運ぶ曲' }),
      audioAssets: [asset],
    };
    const bundle = await exportPortableProjectBundle(project, source);
    const destination = new MemoryAudioAssetRepository();
    const store = vi.spyOn(destination, 'store').mockImplementation(async (request) => {
      events.push('store');
      return MemoryAudioAssetRepository.prototype.store.call(destination, request);
    });
    const replaceProject = vi.fn(async (imported) => {
      events.push('replace');
      expect(imported.id).toBe('project-fresh');
      expect(imported.id).not.toBe(project.id);
      await destination.verify(asset);
      return true;
    });

    await expect(importPortableProjectBundle(bundle, {
      repository: destination,
      createProjectId: () => {
        events.push('fresh-id');
        return 'project-fresh';
      },
      replaceProject,
    })).resolves.toBe(true);

    expect(events).toEqual(['store', 'fresh-id', 'replace']);
    expect(store).toHaveBeenCalledOnce();
    expect(replaceProject).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'non-WAV bytes',
      bytes: Uint8Array.of(1, 2, 3, 4),
      patch: {},
      code: 'invalid-project',
    },
    {
      name: 'WAV metadata mismatch',
      bytes: canonicalWav(1, 2, 3, 4),
      patch: { frameCount: 5 },
      code: 'asset-metadata-conflict',
    },
  ])('rejects authenticated $name before the first repository write', async ({
    bytes,
    patch,
    code,
  }) => {
    const asset = { ...(await readyAsset(bytes)), ...patch };
    const bundle = await encodePortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [asset] },
      { read: async () => bytes },
    );
    const store = vi.fn();
    const replaceProject = vi.fn(async () => true);
    await expect(importPortableProjectBundle(bundle, {
      repository: {
        kind: 'memory',
        read: vi.fn(),
        store,
        verify: vi.fn(),
      },
      createProjectId: () => 'not-adopted',
      replaceProject,
    })).rejects.toMatchObject({ code });
    expect(store).not.toHaveBeenCalled();
    expect(replaceProject).not.toHaveBeenCalled();
  });

  it('reserves before repository reads and the codec output allocator', async () => {
    const events: string[] = [];
    const bytes = canonicalWav(6, 2, 6);
    const asset = await readyAsset(bytes);
    const release = vi.fn(() => events.push('release'));
    const repository = {
      kind: 'memory' as const,
      read: vi.fn(async () => {
        events.push('read');
        return bytes;
      }),
      store: vi.fn(),
      verify: vi.fn(),
    };

    await expect(exportPortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [asset] },
      repository,
      {
        reserve: () => {
          events.push('reserve');
          return {
            bytes: 384 * 1024 * 1024,
            released: false,
            resize: vi.fn(),
            release,
          };
        },
        codec: {
          allocate: (byteLength) => {
            events.push('allocate');
            return new Uint8Array(byteLength);
          },
        },
      },
    )).resolves.toBeInstanceOf(Uint8Array);

    expect(events[0]).toBe('reserve');
    expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('reserve'));
    expect(events.indexOf('allocate')).toBeGreaterThan(events.indexOf('reserve'));
    expect(events.at(-1)).toBe('release');
  });

  it('rejects an unsafe export memory plan before repository reads or output allocation', async () => {
    const projectedAssetBytes = 100 * 1024 * 1024;
    const asset: ReadyAudioAsset = {
      id: 'asset-memory-envelope',
      availability: 'ready',
      checksumSha256: 'a'.repeat(64),
      originalName: 'large-self-authored.wav',
      mediaType: 'audio/wav',
      byteLength: projectedAssetBytes,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: projectedAssetBytes / 2,
    };
    const read = vi.fn();
    const allocate = vi.fn((byteLength: number) => new Uint8Array(byteLength));

    await expect(exportPortableProjectBundleWithReservation(
      { ...createEmptyProject(), audioAssets: [asset] },
      {
        kind: 'memory',
        read,
        store: vi.fn(),
        verify: vi.fn(),
      },
      {
        reservation: testReservation(),
        codec: { allocate },
      },
    )).rejects.toMatchObject({ code: 'reservation-failed' });

    expect(read).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'non-WAV repository payload',
      bytes: Uint8Array.of(1, 2, 3, 4),
      patch: {},
      code: 'invalid-project',
      readCount: 1,
    },
    {
      name: 'WAV metadata mismatch',
      bytes: canonicalWav(1, 2, 3, 4),
      patch: { frameCount: 5 },
      code: 'asset-metadata-conflict',
      readCount: 1,
    },
    {
      name: 'non-canonical media type',
      bytes: canonicalWav(1, 2),
      patch: { mediaType: 'audio/mpeg' },
      code: 'invalid-project',
      readCount: 0,
    },
  ])('refuses to export a bundle that its own importer would reject: $name', async ({
    bytes,
    patch,
    code,
    readCount,
  }) => {
    const asset = { ...(await readyAsset(bytes)), ...patch } as ReadyAudioAsset;
    const read = vi.fn(async () => bytes);

    await expect(exportPortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [asset] },
      {
        kind: 'memory',
        read,
        store: vi.fn(),
        verify: vi.fn(),
      },
    )).rejects.toMatchObject({ code });

    expect(read).toHaveBeenCalledTimes(readCount);
  });

  it('keeps an unexpected export allocator failure in the export error direction', async () => {
    await expect(exportPortableProjectBundle(
      createEmptyProject(),
      new MemoryAudioAssetRepository(),
      {
        codec: {
          allocate: () => {
            throw new Error('secret allocator failure');
          },
        },
      },
    )).rejects.toMatchObject({ code: 'handoff-failed' });
  });

  it('does not store or replace when any payload fails cryptographic validation', async () => {
    const bytes = canonicalWav(8, 6, 7, 5);
    const asset = await readyAsset(bytes);
    const source = new MemoryAudioAssetRepository();
    await source.store({ ...asset, bytes });
    const bundle = await exportPortableProjectBundle({
      ...createEmptyProject(),
      audioAssets: [asset],
    }, source);
    const lastIndex = bundle.byteLength - 1;
    bundle[lastIndex] = (bundle[lastIndex] ?? 0) ^ 0xff;
    const destination = new MemoryAudioAssetRepository();
    const store = vi.spyOn(destination, 'store');
    const replaceProject = vi.fn(async () => true);

    await expect(importPortableProjectBundle(bundle, {
      repository: destination,
      createProjectId: () => 'project-never-used',
      replaceProject,
    })).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
    expect(replaceProject).not.toHaveBeenCalled();
  });

  it('stores one distinct checksum for aliases and accepts a deduplicated receipt', async () => {
    const bytes = canonicalWav(2, 7, 1, 8);
    const first = await readyAsset(bytes);
    const alias = { ...first, id: 'asset-alias', originalName: '別名.wav' };
    const source = new MemoryAudioAssetRepository();
    await source.store({ ...first, bytes });
    const bundle = await exportPortableProjectBundle({
      ...createEmptyProject(),
      audioAssets: [first, alias],
    }, source);
    const store = vi.fn(async (request: {
      checksumSha256: string;
      byteLength: number;
    }) => ({
      checksumSha256: request.checksumSha256,
      byteLength: request.byteLength,
      deduplicated: true,
    }));
    const replaceProject = vi.fn(async () => true);
    await expect(importPortableProjectBundle(bundle, {
      repository: {
        kind: 'memory',
        read: vi.fn(),
        store,
        verify: vi.fn(),
      },
      createProjectId: () => 'fresh-alias-project',
      replaceProject,
    })).resolves.toBe(true);
    expect(store).toHaveBeenCalledOnce();
    expect(replaceProject).toHaveBeenCalledOnce();
  });

  it('keeps Project state atomic across store, receipt, and adoption failures', async () => {
    const payloads = [canonicalWav(1, 1), canonicalWav(2, 2, 2)];
    const assets = await Promise.all(payloads.map((value) => readyAsset(value)));
    assets[0] = { ...assets[0]!, id: 'atomic-first' };
    assets[1] = { ...assets[1]!, id: 'atomic-second' };
    const source = new MemoryAudioAssetRepository();
    for (let index = 0; index < assets.length; index += 1) {
      await source.store({ ...assets[index]!, bytes: payloads[index]! });
    }
    const bundle = await exportPortableProjectBundle({
      ...createEmptyProject(),
      audioAssets: assets,
    }, source);
    const originalState = {
      project: createEmptyProject({ title: 'current' }),
      history: ['unchanged'],
      revision: 42,
    };
    let storeFailureCalls = 0;
    const scenarios = [
      {
        name: 'store',
        store: vi.fn(async (request: {
          checksumSha256: string;
          byteLength: number;
        }) => {
          storeFailureCalls += 1;
          if (storeFailureCalls === 2) throw new Error('disk');
          return { ...request, deduplicated: false };
        }),
        replace: vi.fn(async () => true),
        code: 'repository-store-failed',
      },
      {
        name: 'receipt',
        store: vi.fn(async () => ({
          checksumSha256: 'f'.repeat(64),
          byteLength: 99,
          deduplicated: false,
        })),
        replace: vi.fn(async () => true),
        code: 'receipt-mismatch',
      },
      {
        name: 'adoption',
        store: vi.fn(async (request: {
          checksumSha256: string;
          byteLength: number;
        }) => ({
          checksumSha256: request.checksumSha256,
          byteLength: request.byteLength,
          deduplicated: false,
        })),
        replace: vi.fn(async () => false),
        code: 'adoption-failed',
      },
    ] as const;
    for (const scenario of scenarios) {
      const state = structuredClone(originalState);
      await expect(importPortableProjectBundle(bundle, {
        repository: {
          kind: 'memory',
          read: vi.fn(),
          store: scenario.store,
          verify: vi.fn(),
        },
        createProjectId: () => 'fresh-not-adopted',
        replaceProject: scenario.replace,
      })).rejects.toMatchObject({ code: scenario.code });
      expect(state).toEqual(originalState);
      if (scenario.name !== 'adoption') expect(scenario.replace).not.toHaveBeenCalled();
    }
  });

  it('allows immutable content-addressed orphans after a later store failure', async () => {
    const payloads = [canonicalWav(4, 4), canonicalWav(5, 5, 5)];
    const assets = await Promise.all(payloads.map((value, index) =>
      readyAsset(value).then((entry) => ({ ...entry, id: `orphan-${index}` }))));
    const source = new MemoryAudioAssetRepository();
    for (let index = 0; index < assets.length; index += 1) {
      await source.store({ ...assets[index]!, bytes: payloads[index]! });
    }
    const bundle = await exportPortableProjectBundle({
      ...createEmptyProject(),
      audioAssets: assets,
    }, source);
    const destination = new MemoryAudioAssetRepository();
    const realStore = destination.store.bind(destination);
    let calls = 0;
    vi.spyOn(destination, 'store').mockImplementation(async (request) => {
      calls += 1;
      if (calls === 2) throw new Error('second write failed');
      return realStore(request);
    });
    const replaceProject = vi.fn(async () => true);
    await expect(importPortableProjectBundle(bundle, {
      repository: destination,
      createProjectId: () => 'unused',
      replaceProject,
    })).rejects.toMatchObject({ code: 'repository-store-failed' });
    const firstStored = [...assets].sort((left, right) =>
      left.checksumSha256.localeCompare(right.checksumSha256))[0]!;
    await expect(destination.verify(firstStored)).resolves.toBeUndefined();
    expect(replaceProject).not.toHaveBeenCalled();
  });

  it('keeps the real Store Project, history, revision, and selection unchanged when adoption fails', async () => {
    const bytes = canonicalWav(9, 2, 6, 5);
    const entry = await readyAsset(bytes);
    const source = new MemoryAudioAssetRepository();
    await source.store({ ...entry, bytes });
    const bundle = await exportPortableProjectBundle({
      ...createEmptyProject({ title: 'incoming bundle' }),
      audioAssets: [entry],
    }, source);

    const activeAssets = new MemoryAudioAssetRepository();
    const store = createStudioStore(new MemoryProjectRepository(), {
      audioAssetRepository: activeAssets,
      localDataErase: null,
    });
    await store.getState().initializePersistence();
    expect(store.getState().applyProjectChange((project) => ({
      ...project,
      title: 'current untouched project',
    }))).toBe(true);
    const before = {
      project: structuredClone(store.getState().project),
      past: structuredClone(store.getState().past),
      future: structuredClone(store.getState().future),
      revision: store.getState().saveState.revision,
      selectedTrackId: store.getState().editor.selectedTrackId,
    };

    const importedObjects = new MemoryAudioAssetRepository();
    await expect(importPortableProjectBundle(bundle, {
      repository: importedObjects,
      createProjectId: () => 'fresh-but-not-adopted',
      replaceProject: (project) => store.getState().replaceProject(project),
    })).rejects.toMatchObject({ code: 'adoption-failed' });

    expect({
      project: store.getState().project,
      past: store.getState().past,
      future: store.getState().future,
      revision: store.getState().saveState.revision,
      selectedTrackId: store.getState().editor.selectedTrackId,
    }).toEqual(before);
    await expect(importedObjects.verify(entry)).resolves.toBeUndefined();
    await expect(activeAssets.verify(entry)).rejects.toMatchObject({ code: 'missing' });
  });

  it('releases an owned 384 MiB lease on decode, store, receipt, and adoption failure', async () => {
    const bytes = canonicalWav(3, 3, 3);
    const entry = await readyAsset(bytes);
    const source = new MemoryAudioAssetRepository();
    await source.store({ ...entry, bytes });
    const bundle = await exportPortableProjectBundle({
      ...createEmptyProject(),
      audioAssets: [entry],
    }, source);
    const cases = [
      {
        input: bundle.subarray(0, bundle.byteLength - 1),
        store: vi.fn(),
        replace: vi.fn(async () => true),
      },
      {
        input: bundle,
        store: vi.fn(async () => { throw new Error('store'); }),
        replace: vi.fn(async () => true),
      },
      {
        input: bundle,
        store: vi.fn(async () => ({
          checksumSha256: '0'.repeat(64),
          byteLength: 0,
          deduplicated: false,
        })),
        replace: vi.fn(async () => true),
      },
      {
        input: bundle,
        store: vi.fn(async (request: {
          checksumSha256: string;
          byteLength: number;
        }) => ({ ...request, deduplicated: false })),
        replace: vi.fn(async () => false),
      },
    ];
    for (const failure of cases) {
      const release = vi.fn();
      const reserve = vi.fn(() => ({
        bytes: 384 * 1024 * 1024,
        released: false,
        resize: vi.fn(),
        release,
      }));
      await expect(importPortableProjectBundle(failure.input, {
        repository: {
          kind: 'memory',
          read: vi.fn(),
          store: failure.store,
          verify: vi.fn(),
        },
        createProjectId: () => 'fresh',
        replaceProject: failure.replace,
        reserve,
      })).rejects.toThrow();
      expect(reserve).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it.each([0, 1])(
    'releases the owned lease when store fails at asset position %i',
    async (failureIndex) => {
      const payloads = [canonicalWav(1, 3), canonicalWav(2, 4, 6)];
      const assets = await Promise.all(payloads.map(async (payload, index) => ({
        ...await readyAsset(payload),
        id: `store-failure-${index}`,
      })));
      const source = new MemoryAudioAssetRepository();
      for (let index = 0; index < assets.length; index += 1) {
        await source.store({ ...assets[index]!, bytes: payloads[index]! });
      }
      const bundle = await exportPortableProjectBundle({
        ...createEmptyProject(),
        audioAssets: assets,
      }, source);
      let storeIndex = 0;
      const release = vi.fn();

      await expect(importPortableProjectBundle(bundle, {
        repository: {
          kind: 'memory',
          read: vi.fn(),
          store: vi.fn(async (request) => {
            const currentIndex = storeIndex;
            storeIndex += 1;
            if (currentIndex === failureIndex) throw new Error('injected store failure');
            return { ...request, deduplicated: false };
          }),
          verify: vi.fn(),
        },
        createProjectId: () => 'never-adopted',
        replaceProject: vi.fn(async () => true),
        reserve: () => ({
          bytes: 384 * 1024 * 1024,
          released: false,
          resize: vi.fn(),
          release,
        }),
      })).rejects.toMatchObject({ code: 'repository-store-failed' });

      expect(storeIndex).toBe(failureIndex + 1);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['missing', 'repository-missing'],
    ['checksum-mismatch', 'repository-changed'],
    ['length-mismatch', 'repository-changed'],
    ['corrupt', 'repository-changed'],
    ['storage-unavailable', 'repository-unavailable'],
  ] as const)('maps repository %s without leaking its raw failure', async (rawCode, code) => {
    const bytes = canonicalWav(7);
    const entry = await readyAsset(bytes);
    const release = vi.fn();
    await expect(exportPortableProjectBundle(
      { ...createEmptyProject(), audioAssets: [entry] },
      {
        kind: 'memory',
        read: vi.fn(async () => { throw new AudioAssetRepositoryError(rawCode); }),
        store: vi.fn(),
        verify: vi.fn(),
      },
      {
        reserve: () => ({
          bytes: 384 * 1024 * 1024,
          released: false,
          resize: vi.fn(),
          release,
        }),
      },
    )).rejects.toMatchObject({ code });
    expect(release).toHaveBeenCalledOnce();
  });
});
