/**
 * P02 acceptance tests: localStorage legacy scan vs wave5 v3 data (R3).
 * Spec: docs/14_wave5_port_plan.md section 1 principle 5 and the P02 list under
 * "R3 の受け入れ基準". The implementer must NOT edit this file.
 *
 * CONTRACT
 *   - `decodeProject` returns error code 'legacy-wave5-format' for wave5 v3 JSON
 *     (see packages/project-model/tests/acceptance/wave5-format-detection.test.ts).
 *   - The localStorage repository maps that code to the persistence error code
 *     'unsupported-version' (the same bucket as 'future-schema-version'), so a wave5
 *     snapshot under `cts.project.<id>` is listed as { status: 'unreadable',
 *     errorCode: 'unsupported-version' }, NOT 'corrupt-data'.
 *   - NativeLegacyMigratingRepository.initialize() therefore backs the bytes up, calls
 *     gateway.importProject with diagnostic { errorCode: 'unsupported-version' }, counts
 *     the project in unreadableProjectCount, and NEVER deletes or rewrites the key.
 *   - Keys that merely look like backups (`cts.project.backup.v2`, `cts.projectBackup.<id>`)
 *     holding wave5 data must not make initialize() throw/reject, must not be deleted,
 *     and must not stop a valid main project in the same storage from being imported.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CURRENT_SCHEMA_VERSION, createEmptyProject, encodeProjectJson } from '@cts/project-model';
import {
  MemoryProjectRepository,
  legacyProjectKey,
  type RepositoryResult,
  type StorageLike,
} from '@cts/project-persistence';
import {
  LEGACY_MIGRATION_VERSION,
  NativeLegacyMigratingRepository,
  type LegacyProjectImportReceipt,
  type LegacyProjectImportRequest,
  type NativeLegacyMigrationGateway,
} from '../../src/platform/nativeLegacyMigration';

const NOW = '2026-07-10T12:00:00.000Z';

function wave5Raw(name: 'project-full' | 'project-base-only'): string {
  const url = new URL(
    `../../../../packages/project-model/tests/fixtures/wave5-v3/${name}.json`,
    import.meta.url,
  );
  return readFileSync(fileURLToPath(url), 'utf8');
}

class TestStorage implements StorageLike {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function success<T>(value: T): RepositoryResult<T> {
  return { ok: true, value };
}

function gateway() {
  return {
    getStatus: vi.fn(async () => success({ complete: false })),
    backupSnapshot: vi.fn(async () => success(undefined)),
    importProject: vi.fn(async (request: LegacyProjectImportRequest) =>
      success<LegacyProjectImportReceipt>({ projectId: request.projectId, status: 'imported' }),
    ),
    complete: vi.fn(async () => success(undefined)),
  } satisfies NativeLegacyMigrationGateway;
}

function repositoryFor(storage: StorageLike, migration: ReturnType<typeof gateway>) {
  return new NativeLegacyMigratingRepository({
    repository: new MemoryProjectRepository(),
    gateway: migration,
    storage,
    now: () => new Date(NOW),
  });
}

describe('P02 localStorage legacy scan with wave5 v3 data', () => {
  it('localStorageLegacyScan_wave5Snapshot_isReportedUnsupported_andNotDeleted', async () => {
    const storage = new TestStorage();
    const raw = wave5Raw('project-full');
    storage.setItem(legacyProjectKey('wave5-full'), raw);
    const migration = gateway();

    await expect(repositoryFor(storage, migration).initialize()).resolves.toEqual(success(undefined));

    expect(migration.importProject).toHaveBeenCalledWith(
      expect.objectContaining({
        migrationVersion: LEGACY_MIGRATION_VERSION,
        projectId: 'wave5-full',
        sourceKeys: [legacyProjectKey('wave5-full')],
        diagnostic: { errorCode: 'unsupported-version' },
      }),
    );
    expect(migration.complete).toHaveBeenCalledWith(
      expect.objectContaining({ readyProjectCount: 0, unreadableProjectCount: 1 }),
    );
    expect(storage.getItem(legacyProjectKey('wave5-full'))).toBe(raw);
  });

  it('localStorageLegacyScan_wave5BackupKeys_doNotCrash', async () => {
    const storage = new TestStorage();
    const wave5 = wave5Raw('project-base-only');
    const main = createEmptyProject({ title: 'Main project', clock: () => new Date(NOW) });
    expect(main.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const encoded = encodeProjectJson(main);
    if (!encoded.ok) throw new Error('main fixture must encode');
    storage.setItem(legacyProjectKey(main.id), encoded.json);
    storage.setItem('cts.project.backup.v2', wave5);
    storage.setItem('cts.projectBackup.wave5-base-only', wave5);
    const migration = gateway();

    await expect(repositoryFor(storage, migration).initialize()).resolves.toEqual(success(undefined));

    expect(migration.importProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: main.id }),
    );
    expect(storage.getItem('cts.project.backup.v2')).toBe(wave5);
    expect(storage.getItem('cts.projectBackup.wave5-base-only')).toBe(wave5);
    expect(storage.getItem(legacyProjectKey(main.id))).toBe(encoded.json);
  });
});
