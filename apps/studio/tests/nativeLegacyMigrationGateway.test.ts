import { describe, expect, it, vi } from 'vitest';
import {
  createLegacyStorageSnapshot,
  type StorageLike,
} from '@cts/project-persistence';
import {
  NATIVE_LEGACY_MIGRATION_COMMANDS,
  TauriLegacyMigrationGateway,
  type NativeLegacyMigrationInvoke,
} from '../src/platform/nativeLegacyMigrationGateway';

class TestStorage implements StorageLike {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function snapshotFixture() {
  const storage = new TestStorage();
  storage.setItem('cts.project.project-a', '{"schemaVersion":1}');
  const result = createLegacyStorageSnapshot({
    storage,
    now: () => new Date('2026-07-10T12:00:00.000Z'),
  });
  if (!result.ok) throw new Error('snapshot fixture failed');
  return result.value;
}

describe('TauriLegacyMigrationGateway', () => {
  it('uses the exact command wrappers and accepts strict success responses', async () => {
    const invoke: NativeLegacyMigrationInvoke = vi.fn(async (command, args) => {
      if (command === NATIVE_LEGACY_MIGRATION_COMMANDS.status) return { complete: false };
      if (command === NATIVE_LEGACY_MIGRATION_COMMANDS.importProject) {
        const request = args.request as { projectId: string };
        return {
          projectId: request.projectId,
          status: 'branched',
          branchId: 'sqlite-generation:42',
        };
      }
      return null;
    });
    const gateway = new TauriLegacyMigrationGateway(invoke);
    const snapshot = snapshotFixture();

    await expect(gateway.backupSnapshot(snapshot)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(gateway.getStatus(snapshot.contentChecksum, 1)).resolves.toEqual({
      ok: true,
      value: { complete: false },
    });
    await expect(
      gateway.importProject({
        contentChecksum: snapshot.contentChecksum,
        migrationVersion: 1,
        projectId: 'project-a',
        sourceKeys: ['cts.project.project-a'],
        projectJson: '{"schemaVersion":1}',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { projectId: 'project-a', status: 'branched', branchId: 'sqlite-generation:42' },
    });
    await expect(
      gateway.complete({
        contentChecksum: snapshot.contentChecksum,
        migrationVersion: 1,
        recordCount: 1,
        totalBytes: snapshot.totalBytes,
        readyProjectCount: 1,
        unreadableProjectCount: 0,
        branchCount: 0,
      }),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(invoke).toHaveBeenNthCalledWith(1, NATIVE_LEGACY_MIGRATION_COMMANDS.backup, {
      snapshot,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, NATIVE_LEGACY_MIGRATION_COMMANDS.status, {
      contentChecksum: snapshot.contentChecksum,
      migrationVersion: 1,
    });
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      NATIVE_LEGACY_MIGRATION_COMMANDS.importProject,
      {
        request: {
          contentChecksum: snapshot.contentChecksum,
          migrationVersion: 1,
          projectId: 'project-a',
          sourceKeys: ['cts.project.project-a'],
          projectJson: '{"schemaVersion":1}',
        },
      },
    );
  });

  it('rejects malformed success values and invalid snapshots', async () => {
    const invoke: NativeLegacyMigrationInvoke = vi.fn(async () => ({ complete: false, extra: 1 }));
    const gateway = new TauriLegacyMigrationGateway(invoke);
    await expect(gateway.getStatus('crc32:12345678', 1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'migration-failed', retry: 'never' },
    });
    await expect(
      gateway.backupSnapshot({
        ...snapshotFixture(),
        totalBytes: 1,
      }),
    ).resolves.toMatchObject({ ok: false, error: { retry: 'never' } });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('preserves valid structured native errors but rejects substituted identities', async () => {
    const valid = new TauriLegacyMigrationGateway(
      vi.fn(async () => {
        throw { code: 'conflict', retry: 'manual', projectId: 'project-a' };
      }),
    );
    await expect(
      valid.importProject({
        contentChecksum: 'crc32:12345678',
        migrationVersion: 1,
        projectId: 'project-a',
        sourceKeys: ['cts.project.project-a'],
        projectJson: '{"schemaVersion":1}',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict', retry: 'manual', projectId: 'project-a' },
    });

    const substituted = new TauriLegacyMigrationGateway(
      vi.fn(async () => {
        throw { code: 'conflict', retry: 'manual', projectId: 'project-b' };
      }),
    );
    await expect(
      substituted.importProject({
        contentChecksum: 'crc32:12345678',
        migrationVersion: 1,
        projectId: 'project-a',
        sourceKeys: ['cts.project.project-a'],
        projectJson: '{"schemaVersion":1}',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'migration-failed', retry: 'automatic' },
    });
  });
});
