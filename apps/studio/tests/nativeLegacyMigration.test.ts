import { describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyProject,
  encodeProjectJson,
  type Project,
} from '@cts/project-model';
import {
  MemoryProjectRepository,
  LocalStorageProjectRepository,
  canStageCrashDraft,
  legacyProjectKey,
  type CrashDraftReceipt,
  type LegacyStorageSnapshot,
  type RepositoryResult,
  type SaveRequest,
  type StorageLike,
} from '@cts/project-persistence';
import {
  LEGACY_MIGRATION_VERSION,
  NativeLegacyMigratingRepository,
  type LegacyMigrationCompletion,
  type LegacyProjectImportReceipt,
  type LegacyProjectImportRequest,
  type NativeLegacyMigrationGateway,
} from '../src/platform/nativeLegacyMigration';
import legacyMigrationCorpus from '../../../fixtures/persistence/legacy-migration-v1.json';

const NOW = '2026-07-10T12:00:00.000Z';

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

function projectFixture(id = 'legacy-project', title = 'Legacy project'): Project {
  return {
    ...createEmptyProject({ title, clock: () => new Date(NOW) }),
    id,
  };
}

function migrateArchivedCorpusProjectJson(projectJson: string): string {
  const project = JSON.parse(projectJson) as Record<string, unknown>;
  if (
    project.schemaVersion !== LEGACY_MIGRATION_VERSION - 1
    || LEGACY_MIGRATION_VERSION !== 5
    || CURRENT_SCHEMA_VERSION !== 8
    || Object.prototype.hasOwnProperty.call(project, 'audioTakeFolders')
  ) {
    throw new Error('archived legacy corpus is not an unmigrated schema-v4 project');
  }
  if (!Array.isArray(project.automationLanes)) {
    throw new Error('archived legacy corpus is missing schema-v4 automation lanes');
  }
  const automationLanes = project.automationLanes.map((lane) => {
    if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) {
      throw new Error('archived legacy corpus contains an invalid automation lane');
    }
    const migratedLane: Array<[string, unknown]> = [];
    let insertedBypassed = false;
    for (const entry of Object.entries(lane)) {
      migratedLane.push(entry);
      if (entry[0] === 'id') {
        migratedLane.push(['bypassed', false]);
        insertedBypassed = true;
      }
    }
    if (!insertedBypassed) {
      throw new Error('archived legacy corpus automation lane is missing an id');
    }
    return Object.fromEntries(migratedLane);
  });

  project.schemaVersion = CURRENT_SCHEMA_VERSION;
  const migratedEntries: Array<[string, unknown]> = [];
  for (const entry of Object.entries(project)) {
    migratedEntries.push(
      entry[0] === 'automationLanes'
        ? ['automationLanes', automationLanes]
        : entry,
    );
    if (entry[0] === 'audioAssets') {
      migratedEntries.push(['audioTakeFolders', []]);
    }
    if (entry[0] === 'automationLanes') {
      migratedEntries.push([
        'automationReadState',
        { globalEnabled: true, disabledTrackIds: [] },
      ]);
    }
  }
  return JSON.stringify(Object.fromEntries(migratedEntries));
}

function success<T>(value: T): RepositoryResult<T> {
  return { ok: true, value };
}

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

function crashDraftSuccess(request: SaveRequest): RepositoryResult<CrashDraftReceipt> {
  const encoded = encodeProjectJson(request.project);
  if (!encoded.ok) throw new Error('fixture must encode');
  return success({
    projectId: request.project.id,
    activationId: request.activationId,
    revision: request.revision,
    writeId: request.writeId,
    protectedAt: NOW,
    bytes: encoded.bytes,
  });
}

class CrashDraftMemoryRepository extends MemoryProjectRepository {
  readonly draftRequests: SaveRequest[] = [];

  stageCrashDraft(request: SaveRequest): Promise<RepositoryResult<CrashDraftReceipt>> {
    this.draftRequests.push(request);
    return Promise.resolve(crashDraftSuccess(request));
  }
}

function gateway(
  overrides: Partial<NativeLegacyMigrationGateway> = {},
): NativeLegacyMigrationGateway & {
  getStatus: ReturnType<typeof vi.fn>;
  backupSnapshot: ReturnType<typeof vi.fn>;
  importProject: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn(async () => success({ complete: false })),
    backupSnapshot: vi.fn(async () => success(undefined)),
    importProject: vi.fn(async (request: LegacyProjectImportRequest) =>
      success<LegacyProjectImportReceipt>({
        projectId: request.projectId,
        status: 'imported',
      }),
    ),
    complete: vi.fn(async () => success(undefined)),
    ...overrides,
  } as NativeLegacyMigrationGateway & {
    getStatus: ReturnType<typeof vi.fn>;
    backupSnapshot: ReturnType<typeof vi.fn>;
    importProject: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  };
}

describe('NativeLegacyMigratingRepository', () => {
  it('uses schema-v5 legacy migration protocol receipts', () => {
    expect(LEGACY_MIGRATION_VERSION).toBe(5);
  });

  it('preserves crash-draft capability while enforcing migration lifecycle state', async () => {
    const project = projectFixture('crash-draft-project');
    const request: SaveRequest = {
      project,
      activationId: 'activation-a',
      revision: 1,
      writeId: 'write-1',
      expectedHeadVersion: null,
    };
    const withoutCapability = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: gateway(),
      storage: new TestStorage(),
      now: () => new Date(NOW),
    });
    expect(canStageCrashDraft(withoutCapability)).toBe(false);

    const native = new CrashDraftMemoryRepository();
    const repository = new NativeLegacyMigratingRepository({
      repository: native,
      gateway: gateway(),
      storage: new TestStorage(),
      now: () => new Date(NOW),
    });
    expect(canStageCrashDraft(repository)).toBe(true);
    if (!canStageCrashDraft(repository)) throw new Error('crash capability missing');
    await expect(repository.stageCrashDraft(request)).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'migration-failed', retry: 'manual' },
    });
    expect(native.draftRequests).toEqual([]);

    await expect(repository.initialize()).resolves.toEqual(success(undefined));
    await expect(repository.stageCrashDraft(request)).resolves.toMatchObject({
      ok: true,
      value: { projectId: project.id, revision: 1, writeId: 'write-1' },
    });
    expect(native.draftRequests).toEqual([request]);

    await expect(repository.close()).resolves.toEqual(success(undefined));
    await expect(repository.stageCrashDraft(request)).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'migration-failed', retry: 'never' },
    });
    expect(native.draftRequests).toEqual([request]);
  });

  it('waits for an accepted crash-draft write before closing and recovers after close failure', async () => {
    const native = new CrashDraftMemoryRepository();
    const pendingDraft = deferred<RepositoryResult<CrashDraftReceipt>>();
    const stage = vi
      .spyOn(native, 'stageCrashDraft')
      .mockImplementationOnce(() => pendingDraft.promise)
      .mockImplementation(async (request) => crashDraftSuccess(request));
    const close = vi
      .spyOn(native, 'close')
      .mockResolvedValueOnce({
        ok: false,
        error: { operation: 'close', code: 'storage-unavailable', retry: 'automatic' },
      })
      .mockResolvedValueOnce(success(undefined));
    const repository = new NativeLegacyMigratingRepository({
      repository: native,
      gateway: gateway(),
      storage: new TestStorage(),
      now: () => new Date(NOW),
    });
    await expect(repository.initialize()).resolves.toEqual(success(undefined));
    expect(canStageCrashDraft(repository)).toBe(true);
    if (!canStageCrashDraft(repository)) throw new Error('crash capability missing');
    const firstRequest: SaveRequest = {
      project: projectFixture('close-race-project'),
      activationId: 'activation-a',
      revision: 1,
      writeId: 'write-1',
      expectedHeadVersion: null,
    };

    const protecting = repository.stageCrashDraft(firstRequest);
    const closing = repository.close();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    await expect(
      repository.stageCrashDraft({ ...firstRequest, revision: 2, writeId: 'write-blocked' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'migration-failed', retry: 'never' },
    });
    expect(stage).toHaveBeenCalledOnce();
    pendingDraft.resolve(crashDraftSuccess(firstRequest));
    await expect(protecting).resolves.toMatchObject({ ok: true, value: { revision: 1 } });
    await expect(closing).resolves.toMatchObject({
      ok: false,
      error: { operation: 'close', code: 'storage-unavailable' },
    });
    expect(close).toHaveBeenCalledOnce();

    const secondRequest = { ...firstRequest, revision: 2, writeId: 'write-2' };
    await expect(repository.stageCrashDraft(secondRequest)).resolves.toMatchObject({
      ok: true,
      value: { revision: 2, writeId: 'write-2' },
    });
    expect(stage).toHaveBeenCalledTimes(2);
    await expect(repository.close()).resolves.toEqual(success(undefined));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('archives exact legacy bytes before importing a canonical project and marking complete', async () => {
    const storage = new TestStorage();
    const project = projectFixture();
    const encoded = encodeProjectJson(project);
    if (!encoded.ok) throw new Error('fixture must encode');
    storage.setItem(legacyProjectKey(project.id), encoded.json);
    storage.setItem('unrelated', 'must not cross the native boundary');
    const native = new MemoryProjectRepository();
    const migration = gateway();
    const repository = new NativeLegacyMigratingRepository({
      repository: native,
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toEqual(success(undefined));

    const snapshot = migration.backupSnapshot.mock.calls[0]?.[0] as LegacyStorageSnapshot;
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ key: legacyProjectKey(project.id), value: encoded.json }),
    ]);
    expect(migration.importProject).toHaveBeenCalledWith({
        contentChecksum: snapshot.contentChecksum,
        migrationVersion: LEGACY_MIGRATION_VERSION,
        projectId: project.id,
        sourceKeys: [legacyProjectKey(project.id)],
      projectJson: encoded.json,
    });
    expect(migration.backupSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      migration.importProject.mock.invocationCallOrder[0] as number,
    );
    expect(migration.complete).toHaveBeenCalledWith(
      expect.objectContaining<Partial<LegacyMigrationCompletion>>({
        contentChecksum: snapshot.contentChecksum,
        migrationVersion: LEGACY_MIGRATION_VERSION,
        recordCount: 1,
        readyProjectCount: 1,
        unreadableProjectCount: 0,
        branchCount: 0,
      }),
    );
    // A successful instance never repeats the same migration in-process.
    await repository.initialize();
    expect(migration.getStatus).toHaveBeenCalledOnce();
  });

  it('verifies the exact backup before trusting a durable marker for identical content', async () => {
    const storage = new TestStorage();
    const migration = gateway({
      getStatus: vi.fn(async () => success({ complete: true })),
    });
    const repository = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toEqual(success(undefined));

    expect(migration.backupSnapshot).toHaveBeenCalledOnce();
    expect(migration.backupSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      migration.getStatus.mock.invocationCallOrder[0] as number,
    );
    expect(migration.importProject).not.toHaveBeenCalled();
    expect(migration.complete).not.toHaveBeenCalled();
  });

  it('rejects a durable marker when the legacy source changes during its status lookup', async () => {
    const storage = new TestStorage();
    const original = projectFixture('marker-race', 'Before status');
    const changed = { ...original, title: 'Changed during status' };
    const encodedOriginal = encodeProjectJson(original);
    const encodedChanged = encodeProjectJson(changed);
    if (!encodedOriginal.ok || !encodedChanged.ok) throw new Error('fixtures must encode');
    storage.setItem(legacyProjectKey(original.id), encodedOriginal.json);
    const status = deferred<RepositoryResult<{ complete: boolean }>>();
    const migration = gateway({
      getStatus: vi.fn(() => status.promise),
    });
    const repository = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    const initialization = repository.initialize();
    await vi.waitFor(() => expect(migration.getStatus).toHaveBeenCalledOnce());
    storage.setItem(legacyProjectKey(original.id), encodedChanged.json);
    status.resolve(success({ complete: true }));

    await expect(initialization).resolves.toMatchObject({
      ok: false,
      error: { operation: 'initialize', code: 'migration-failed', retry: 'manual' },
    });
    expect(storage.getItem(legacyProjectKey(original.id))).toBe(encodedChanged.json);
    expect(migration.importProject).not.toHaveBeenCalled();
    expect(migration.complete).not.toHaveBeenCalled();
    await expect(repository.list()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'list', code: 'migration-failed', retry: 'manual' },
    });
  });

  it('backs up future/corrupt records without decoding or deleting them', async () => {
    const storage = new TestStorage();
    storage.setItem(legacyProjectKey('future'), JSON.stringify({ schemaVersion: 999 }));
    const migration = gateway();
    const repository = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toEqual(success(undefined));

    expect(migration.backupSnapshot).toHaveBeenCalledTimes(2);
    expect(migration.importProject).toHaveBeenCalledWith(
      expect.objectContaining({
        migrationVersion: LEGACY_MIGRATION_VERSION,
        projectId: 'future',
        sourceKeys: [legacyProjectKey('future')],
        diagnostic: { errorCode: 'unsupported-version' },
      }),
    );
    expect(migration.complete).toHaveBeenCalledWith(
      expect.objectContaining({ readyProjectCount: 0, unreadableProjectCount: 1 }),
    );
    expect(storage.getItem(legacyProjectKey('future'))).not.toBeNull();
  });

  it('does not mark complete when the live source changes during async import', async () => {
    const storage = new TestStorage();
    const project = projectFixture();
    const encoded = encodeProjectJson(project);
    if (!encoded.ok) throw new Error('fixture must encode');
    storage.setItem(legacyProjectKey(project.id), encoded.json);
    const migration = gateway({
      importProject: vi.fn(async (request: LegacyProjectImportRequest) => {
        storage.setItem(legacyProjectKey('new-project'), encoded.json);
        return success<LegacyProjectImportReceipt>({
          projectId: request.projectId,
          status: 'imported',
        });
      }),
    });
    const repository = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'initialize', code: 'migration-failed', retry: 'manual' },
    });

    expect(migration.complete).not.toHaveBeenCalled();
  });

  it('stages retained legacy branches without promoting them as canonical heads', async () => {
    const storage = new TestStorage();
    const canonical = projectFixture('legacy-branched', 'Canonical');
    const legacy = new LocalStorageProjectRepository({
      storage,
      lockManager: null,
      now: () => new Date(NOW),
    });
    await legacy.initialize();
    const saved = await legacy.save({
      project: canonical,
      activationId: 'activation-head',
      revision: 1,
      writeId: 'write-head',
      expectedHeadVersion: null,
    });
    if (!saved.ok) throw new Error('legacy fixture save failed');
    expect(
      legacy.saveRecoverySynchronously({
        project: { ...canonical, title: 'Emergency branch' },
        activationId: 'activation-branch',
        revision: 2,
        writeId: 'write-branch',
      }).ok,
    ).toBe(true);
    const migration = gateway();
    const repository = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toEqual(success(undefined));

    expect(migration.importProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: canonical.id,
        sourceKeys: expect.any(Array),
        projectJson: expect.any(String),
      }),
    );
    expect('branch' in (migration.importProject.mock.calls[0]?.[0] ?? {})).toBe(false);
    expect(migration.importProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: canonical.id,
        sourceKeys: expect.any(Array),
        branch: expect.objectContaining({
          source: 'recovery-journal',
          activationId: 'activation-branch',
          revision: 2,
          writeId: 'write-branch',
        }),
      }),
    );
    expect(migration.complete).toHaveBeenCalledWith(
      expect.objectContaining({ readyProjectCount: 1, branchCount: 1 }),
    );
  });

  it('does not stage a promoted recovery candidate twice as both head and branch', async () => {
    const storage = new TestStorage();
    const canonical = projectFixture('legacy-promoted-recovery', 'Canonical');
    const legacy = new LocalStorageProjectRepository({
      storage,
      lockManager: null,
      now: () => new Date(NOW),
    });
    await legacy.initialize();
    const saved = await legacy.save({
      project: canonical,
      activationId: 'activation-head',
      revision: 1,
      writeId: 'write-head',
      expectedHeadVersion: null,
    });
    if (!saved.ok) throw new Error('legacy fixture save failed');
    expect(
      legacy.saveRecoverySynchronously({
        project: { ...canonical, title: 'Emergency recovery' },
        activationId: 'activation-recovery',
        revision: 2,
        writeId: 'write-recovery',
        expectedHeadVersion: saved.value.headVersion,
      }).ok,
    ).toBe(true);
    const migration = gateway();
    const repository = new NativeLegacyMigratingRepository({
      repository: new MemoryProjectRepository(),
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toEqual(success(undefined));

    expect(migration.importProject).toHaveBeenCalledTimes(1);
    const request = migration.importProject.mock.calls[0]?.[0] as LegacyProjectImportRequest;
    expect('branch' in request).toBe(false);
    if (!('projectJson' in request)) throw new Error('expected a project import');
    expect(JSON.parse(request.projectJson)).toMatchObject({ title: 'Emergency recovery' });
    expect(migration.complete).toHaveBeenCalledWith(
      expect.objectContaining({ readyProjectCount: 1, branchCount: 0 }),
    );
  });

  it('keeps the shared TypeScript and Rust legacy authority corpus in parity', async () => {
    expect(legacyMigrationCorpus.version + 1).toBe(LEGACY_MIGRATION_VERSION);
    for (const fixture of legacyMigrationCorpus.cases) {
      const storage = new TestStorage();
      for (const entry of fixture.storageEntries) storage.setItem(entry.key, entry.value);

      const legacy = new LocalStorageProjectRepository({ storage, lockManager: null });
      await expect(legacy.initialize(), fixture.name).resolves.toEqual(success(undefined));
      const listed = await legacy.list();
      if (!listed.ok) throw new Error(`${fixture.name}: legacy list failed`);
      const summary = listed.value.find((candidate) => candidate.id === fixture.projectId);
      if (fixture.expected.status === 'deleted') {
        expect(summary, fixture.name).toBeUndefined();
      } else {
        expect(summary?.status, fixture.name).toBe(fixture.expected.status);
        expect(summary?.branches.length, fixture.name).toBe(fixture.expected.branchCount);
        if (fixture.expected.status === 'unreadable') {
          expect(summary, fixture.name).toMatchObject({ errorCode: fixture.expected.errorCode });
        } else {
          const loaded = await legacy.load(fixture.projectId);
          if (!loaded.ok || !loaded.value) throw new Error(`${fixture.name}: legacy load failed`);
          const encoded = encodeProjectJson(loaded.value.project);
          if (!encoded.ok) throw new Error(`${fixture.name}: legacy re-encode failed`);
          const canonicalProjectJson = fixture.expected.canonicalProjectJson;
          if (typeof canonicalProjectJson !== 'string') {
            throw new Error(`${fixture.name}: ready fixture is missing canonical JSON`);
          }
          expect(encoded.json, fixture.name).toBe(
            migrateArchivedCorpusProjectJson(canonicalProjectJson),
          );
          expect(loaded.value.recoveryReason, fixture.name).toBe(
            fixture.expected.recoveryReason,
          );
        }
      }

      const migration = gateway();
      const repository = new NativeLegacyMigratingRepository({
        repository: new MemoryProjectRepository(),
        gateway: migration,
        storage,
        now: () => new Date(NOW),
      });
      await expect(repository.initialize(), fixture.name).resolves.toEqual(success(undefined));

      const actualImports = migration.importProject.mock.calls.map((call) => {
        const request = call[0] as LegacyProjectImportRequest;
        if ('diagnostic' in request) {
          return { kind: 'diagnostic', errorCode: request.diagnostic.errorCode };
        }
        if (request.branch) {
          return {
            kind: 'branch',
            projectJson: request.projectJson,
            source: request.branch.source,
            activationId: request.branch.activationId,
            revision: request.branch.revision,
            writeId: request.branch.writeId,
            savedAt: request.branch.savedAt,
          };
        }
        return { kind: 'head', projectJson: request.projectJson };
      });
      const sortImports = (imports: readonly object[]) =>
        [...imports].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
      expect(sortImports(actualImports), fixture.name).toEqual(
        sortImports(
          fixture.expectedImports.map((expectedImport) => {
            if (!('projectJson' in expectedImport)) return expectedImport;
            if (typeof expectedImport.projectJson !== 'string') {
              throw new Error(`${fixture.name}: import is missing canonical JSON`);
            }
            return {
              ...expectedImport,
              projectJson: migrateArchivedCorpusProjectJson(expectedImport.projectJson),
            };
          }),
        ),
      );
      const completion = migration.complete.mock.calls[0]?.[0] as
        | LegacyMigrationCompletion
        | undefined;
      expect(completion, fixture.name).toMatchObject(fixture.expectedCompletion);
    }
  });

  it('keeps a failed migration retryable and forwards repository operations', async () => {
    const storage = new TestStorage();
    const migration = gateway({
      backupSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          error: { operation: 'initialize', code: 'write-failed', retry: 'automatic' },
        })
        .mockResolvedValue(success(undefined)),
    });
    const native = new MemoryProjectRepository();
    const repository = new NativeLegacyMigratingRepository({
      repository: native,
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    await expect(repository.initialize()).resolves.toMatchObject({
      ok: false,
      error: { code: 'migration-failed', retry: 'automatic' },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'list', code: 'migration-failed' },
    });
    await expect(
      repository.save({
        project: projectFixture(),
        activationId: 'activation-blocked',
        revision: 0,
        writeId: 'write-blocked',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'migration-failed' },
    });
    expect(await native.list()).toEqual({ ok: true, value: [] });
    await expect(repository.initialize()).resolves.toEqual(success(undefined));
    expect(migration.backupSnapshot).toHaveBeenCalledTimes(3);
    await expect(repository.list()).resolves.toEqual(await native.list());
    await expect(repository.close()).resolves.toEqual(success(undefined));
  });

  it('keeps close terminal when it races an in-flight initialization', async () => {
    const storage = new TestStorage();
    const status = deferred<RepositoryResult<{ complete: boolean }>>();
    const migration = gateway({
      getStatus: vi.fn(() => status.promise),
    });
    const native = new MemoryProjectRepository();
    const nativeClose = vi.spyOn(native, 'close');
    const repository = new NativeLegacyMigratingRepository({
      repository: native,
      gateway: migration,
      storage,
      now: () => new Date(NOW),
    });

    const initialization = repository.initialize();
    await vi.waitFor(() => expect(migration.getStatus).toHaveBeenCalledOnce());
    const closing = repository.close();
    await Promise.resolve();
    expect(nativeClose).not.toHaveBeenCalled();

    status.resolve(success({ complete: true }));
    await expect(initialization).resolves.toEqual(success(undefined));
    await expect(closing).resolves.toEqual(success(undefined));
    expect(nativeClose).toHaveBeenCalledOnce();

    await expect(repository.initialize()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'initialize', code: 'migration-failed', retry: 'never' },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'list', code: 'migration-failed', retry: 'never' },
    });
  });
});
