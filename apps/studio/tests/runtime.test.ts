import { describe, expect, it, vi } from 'vitest';
import {
  canStageCrashDraft,
  MemoryProjectRepository,
  NativeRecoveryProjectRepository,
} from '@cts/project-persistence';
import {
  createAudioAssetBytesResolver,
  createStudioRuntime,
} from '../src/platform/runtime';
import type { TauriBridge } from '../src/platform/tauriBridge';
import type { NativeLegacyMigrationGateway } from '../src/platform/nativeLegacyMigration';
import {
  AudioAssetRepositoryError,
  MemoryAudioAssetRepository,
  type AudioAssetRepository,
} from '../src/platform/audioAssetRepository';

function bridge(native: boolean): TauriBridge {
  return {
    isTauri: () => native,
    invoke: vi.fn(async () => null),
  };
}

describe('Studio runtime repository selection', () => {
  it('keeps the injected browser repository in a web runtime', () => {
    const browserRepository = new MemoryProjectRepository();
    const audioAssets = new MemoryAudioAssetRepository();
    const runtime = createStudioRuntime({
      bridge: bridge(false),
      browserRepository,
      audioAssetRepository: audioAssets,
    });

    expect(runtime.kind).toBe('web');
    expect(runtime.repository).toBe(browserRepository);
    expect(runtime.audioAssets).toBe(audioAssets);
  });

  it('selects the typed SQLite adapter when the module API reports Tauri', () => {
    const nativeBridge = bridge(true);
    const audioAssets = new MemoryAudioAssetRepository();
    const runtime = createStudioRuntime({
      bridge: nativeBridge,
      browserRepository: new MemoryProjectRepository(),
      audioAssetRepository: audioAssets,
    });

    expect(runtime.kind).toBe('native');
    expect(runtime.repository).toBeInstanceOf(NativeRecoveryProjectRepository);
    expect(runtime.repository.kind).toBe('sqlite');
    expect(canStageCrashDraft(runtime.repository)).toBe(true);
    expect(runtime.audioAssets).toBe(audioAssets);
  });

  it('contains a throwing localStorage provider inside the migration boundary', async () => {
    const nativeBridge: TauriBridge = {
      isTauri: () => true,
      invoke: vi.fn(async () => null),
    };
    const migrationGateway: NativeLegacyMigrationGateway = {
      backupSnapshot: vi.fn(async () => ({ ok: true as const, value: undefined })),
      getStatus: vi.fn(async () => ({ ok: true as const, value: { complete: false } })),
      importProject: vi.fn(async (request) => ({
        ok: true as const,
        value: { projectId: request.projectId, status: 'imported' as const },
      })),
      complete: vi.fn(async () => ({ ok: true as const, value: undefined })),
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      },
    });
    try {
      // Construction stores the production provider function without touching
      // the throwing global getter.
      const runtime = createStudioRuntime({ bridge: nativeBridge, migrationGateway });
      await expect(runtime.repository.initialize()).resolves.toMatchObject({
        ok: false,
        error: { operation: 'initialize', code: 'migration-failed', retry: 'manual' },
      });
      expect(migrationGateway.backupSnapshot).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('Studio audio asset resolver adapter', () => {
  const asset = {
    id: 'asset-runtime',
    availability: 'ready' as const,
    checksumSha256: 'a'.repeat(64),
    originalName: 'audio.wav',
    mediaType: 'audio/wav' as const,
    byteLength: 4,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 1,
  };

  it.each([
    ['missing', 'asset-missing'],
    ['checksum-mismatch', 'asset-changed'],
    ['length-mismatch', 'asset-changed'],
    ['corrupt', 'asset-changed'],
    ['too-large', 'resource-limit'],
    ['read-failed', 'asset-unavailable'],
  ] as const)('maps repository %s to engine %s', async (repositoryCode, engineCode) => {
    const repository: AudioAssetRepository = {
      kind: 'memory',
      store: vi.fn(),
      read: vi.fn(async () => {
        throw new AudioAssetRepositoryError(repositoryCode);
      }),
      verify: vi.fn(),
    };
    await expect(createAudioAssetBytesResolver(repository).resolve(asset))
      .rejects.toMatchObject({ code: engineCode, assetId: asset.id });
  });
});
