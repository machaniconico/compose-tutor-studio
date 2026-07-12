import { describe, expect, it, vi } from 'vitest';
import {
  canStageCrashDraft,
  MemoryProjectRepository,
  NativeRecoveryProjectRepository,
} from '@cts/project-persistence';
import { createStudioRuntime } from '../src/platform/runtime';
import type { TauriBridge } from '../src/platform/tauriBridge';
import type { NativeLegacyMigrationGateway } from '../src/platform/nativeLegacyMigration';

function bridge(native: boolean): TauriBridge {
  return {
    isTauri: () => native,
    invoke: vi.fn(async () => null),
  };
}

describe('Studio runtime repository selection', () => {
  it('keeps the injected browser repository in a web runtime', () => {
    const browserRepository = new MemoryProjectRepository();
    const runtime = createStudioRuntime({
      bridge: bridge(false),
      browserRepository,
    });

    expect(runtime.kind).toBe('web');
    expect(runtime.repository).toBe(browserRepository);
  });

  it('selects the typed SQLite adapter when the module API reports Tauri', () => {
    const nativeBridge = bridge(true);
    const runtime = createStudioRuntime({
      bridge: nativeBridge,
      browserRepository: new MemoryProjectRepository(),
    });

    expect(runtime.kind).toBe('native');
    expect(runtime.repository).toBeInstanceOf(NativeRecoveryProjectRepository);
    expect(runtime.repository.kind).toBe('sqlite');
    expect(canStageCrashDraft(runtime.repository)).toBe(true);
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
