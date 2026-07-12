import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@cts/project-model';
import {
  NativeRecoveryJournal,
  NativeRecoveryProjectRepository,
  canStageCrashDraft,
  nativeRecoveryKey,
  type CrashDraftReceipt,
  type LoadedProject,
  type DurableProjectState,
  type ProjectBranch,
  type ProjectRepository,
  type ProjectSummary,
  type RemoveReceipt,
  type RemoveRequest,
  type RepositoryResult,
  type SaveReceipt,
  type SaveRequest,
} from '../src/index';
import { makeProject, TestStorage } from './helpers';

const fixedNow = () => new Date('2026-07-10T12:00:00.000Z');

function project(id: string, title = id, updatedAt = '2026-07-10T00:00:00.000Z'): Project {
  return { ...makeProject(title, updatedAt), id };
}

function recoveryRequest(
  value: Project,
  activationId: string,
  revision: number,
  writeId: string,
  expectedHeadVersion: string | null | undefined = null,
  predecessorWriteId?: string,
): SaveRequest {
  return {
    project: value,
    activationId,
    revision,
    writeId,
    expectedHeadVersion,
    ...(predecessorWriteId !== undefined ? { predecessorWriteId } : {}),
  };
}

function successReceipt(request: SaveRequest, ordinal: number): SaveReceipt {
  return {
    projectId: request.project.id,
    activationId: request.activationId,
    revision: request.revision,
    writeId: request.writeId,
    headVersion: `${ordinal}:active:${request.writeId}`,
    savedAt: `2026-07-10T12:00:${String(ordinal).padStart(2, '0')}.000Z`,
    bytes: 1,
    retainedGenerations: Math.min(ordinal, 3),
    legacyMirrorWritten: false,
  };
}

class RecordingRepository implements ProjectRepository {
  readonly kind = 'sqlite' as const;
  initializeCalls = 0;
  listCalls = 0;
  loadCalls: string[] = [];
  mostRecentCalls = 0;
  branchCalls: Array<{ projectId: string; branchId: string }> = [];
  removeCalls: RemoveRequest[] = [];
  closeCalls = 0;
  saveRequests: SaveRequest[] = [];
  initializeResult: RepositoryResult<void> = { ok: true, value: undefined };
  listResult: RepositoryResult<readonly ProjectSummary[]> = { ok: true, value: [] };
  loadResult: RepositoryResult<LoadedProject | null> = { ok: true, value: null };
  mostRecentResult: RepositoryResult<LoadedProject | null> = { ok: true, value: null };
  branchResult: RepositoryResult<ProjectBranch | null> = { ok: true, value: null };
  projectStateResult: RepositoryResult<DurableProjectState> = {
    ok: true,
    value: 'missing',
  };
  removeResult: RepositoryResult<RemoveReceipt> = {
    ok: true,
    value: {
      projectId: 'project-remove',
      deleteId: 'delete-1',
      headVersion: '1:deleted:delete-1',
      removed: true,
      cleanupComplete: true,
    },
  };
  removeHandler: (request: RemoveRequest) => Promise<RepositoryResult<RemoveReceipt>> = () =>
    Promise.resolve(this.removeResult);
  saveHandler: (request: SaveRequest, ordinal: number) => Promise<RepositoryResult<SaveReceipt>> =
    (request, ordinal) => Promise.resolve({ ok: true, value: successReceipt(request, ordinal) });

  initialize(): Promise<RepositoryResult<void>> {
    this.initializeCalls += 1;
    return Promise.resolve(this.initializeResult);
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    this.listCalls += 1;
    return Promise.resolve(this.listResult);
  }

  load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    this.loadCalls.push(id);
    return Promise.resolve(this.loadResult);
  }

  loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    this.mostRecentCalls += 1;
    return Promise.resolve(this.mostRecentResult);
  }

  getDurableProjectState(): Promise<RepositoryResult<DurableProjectState>> {
    return Promise.resolve(this.projectStateResult);
  }

  loadProjectBranch(
    projectId: string,
    branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>> {
    this.branchCalls.push({ projectId, branchId });
    return Promise.resolve(this.branchResult);
  }

  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    this.saveRequests.push(request);
    return this.saveHandler(request, this.saveRequests.length);
  }

  remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    this.removeCalls.push(request);
    return this.removeHandler(request);
  }

  close(): Promise<RepositoryResult<void>> {
    this.closeCalls += 1;
    return Promise.resolve({ ok: true, value: undefined });
  }
}

class CrashDraftRecordingRepository extends RecordingRepository {
  draftRequests: SaveRequest[] = [];

  stageCrashDraft(request: SaveRequest): Promise<RepositoryResult<CrashDraftReceipt>> {
    this.draftRequests.push(request);
    return Promise.resolve({
      ok: true,
      value: {
        projectId: request.project.id,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        protectedAt: '2026-07-10T12:00:00.000Z',
        bytes: 1,
      },
    });
  }
}

function setup(delegate = new RecordingRepository()) {
  const storage = new TestStorage();
  const journal = new NativeRecoveryJournal({ storage, now: fixedNow });
  const repository = new NativeRecoveryProjectRepository({ delegate, journal });
  return { delegate, storage, journal, repository };
}

function writeFutureJournal(
  storage: TestStorage,
  projectId: string,
  activationId: string,
): Readonly<{ key: string; raw: string }> {
  const key = nativeRecoveryKey(projectId, activationId);
  const raw = JSON.stringify({ storageVersion: 2, projectId });
  storage.setItem(key, raw);
  return { key, raw };
}

function rawStorageSnapshot(storage: TestStorage): Readonly<Record<string, string | null>> {
  return Object.fromEntries(
    storage.rawKeys().sort().map((key) => [key, storage.getItem(key)]),
  );
}

describe('NativeRecoveryProjectRepository', () => {
  it('preserves crash-draft capability only when the delegate supports it', async () => {
    const withoutCapability = setup().repository;
    expect(canStageCrashDraft(withoutCapability)).toBe(false);

    const delegate = new CrashDraftRecordingRepository();
    const { repository } = setup(delegate);
    const request = recoveryRequest(project('project-crash-draft'), 'activation-a', 1, 'write-1');
    expect(canStageCrashDraft(repository)).toBe(true);
    if (!canStageCrashDraft(repository)) throw new Error('crash capability missing');

    await expect(repository.stageCrashDraft(request)).resolves.toMatchObject({
      ok: true,
      value: {
        projectId: request.project.id,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
      },
    });
    expect(delegate.draftRequests).toEqual([request]);
  });

  it('applies sticky native-recovery policy before forwarding a crash draft', async () => {
    const delegate = new CrashDraftRecordingRepository();
    const { repository, storage } = setup(delegate);
    const request = recoveryRequest(project('project-sticky-draft'), 'activation-a', 1, 'write-1');
    writeFutureJournal(storage, request.project.id, request.activationId);
    expect(canStageCrashDraft(repository)).toBe(true);
    if (!canStageCrashDraft(repository)) throw new Error('crash capability missing');

    await expect(repository.stageCrashDraft(request)).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'unsupported-version', retry: 'never' },
    });
    expect(delegate.draftRequests).toEqual([]);
  });

  it('delegates canonical operations and sends synchronous pagehide writes only to the journal', async () => {
    const { delegate, journal, repository } = setup();
    const value = project('project-delegate');
    const save = recoveryRequest(value, 'activation-a', 1, 'write-1', null);
    const loaded: LoadedProject = {
      project: value,
      headVersion: '1:active:write-1',
      source: 'generation',
      recovered: false,
      recoveryReason: null,
    };
    delegate.loadResult = { ok: true, value: loaded };
    delegate.mostRecentResult = { ok: true, value: loaded };
    delegate.removeResult = {
      ok: true,
      value: {
        projectId: value.id,
        deleteId: 'delete-1',
        headVersion: '1:deleted:delete-1',
        removed: true,
        cleanupComplete: true,
      },
    };
    delegate.listResult = {
      ok: true,
      value: [
        {
          status: 'ready',
          id: value.id,
          title: value.title,
          updatedAt: value.updatedAt,
          recovered: false,
          branches: [],
        },
      ],
    };

    expect(repository.kind).toBe('sqlite');
    expect(repository.saveRecoverySynchronously(save)).toMatchObject({ ok: true });
    expect(delegate.saveRequests).toHaveLength(0);
    expect(journal.list(value.id)).toMatchObject({ ok: true, value: [expect.any(Object)] });
    await expect(repository.load(value.id)).resolves.toEqual({ ok: true, value: loaded });
    await expect(repository.loadMostRecent()).resolves.toEqual({ ok: true, value: loaded });
    await expect(repository.remove({ projectId: value.id, deleteId: 'delete-1' }))
      .resolves.toEqual(delegate.removeResult);
    expect(journal.list(value.id)).toEqual({ ok: true, value: [] });
    await expect(repository.close()).resolves.toEqual({ ok: true, value: undefined });
    expect(delegate.loadCalls).toEqual([value.id, value.id]);
    expect(delegate.mostRecentCalls).toBe(0);
    expect(delegate.removeCalls).toHaveLength(1);
    expect(delegate.closeCalls).toBe(1);
  });

  it('returns invalid-project instead of throwing for a hostile null project id', () => {
    const { repository } = setup();
    const value = project('project-invalid-id');
    const invalidRequest = {
      ...recoveryRequest(value, 'activation-a', 1, 'write-1'),
      project: { ...value, id: null },
    } as unknown as SaveRequest;
    const invoke = () => repository.saveRecoverySynchronously(invalidRequest);

    expect(invoke).not.toThrow();
    expect(invoke()).toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'invalid-project', retry: 'never' },
    });
  });

  it('replays ready entries in a cross-platform deterministic order with exact causal fields', async () => {
    const { delegate, journal, repository } = setup();
    const projectA = project('project-a');
    const projectB = project('project-b');
    // Deliberately insert in the opposite order from replay.
    expect(
      journal.saveRecoverySynchronously(
        {
          ...recoveryRequest(projectB, 'activation-z', 3, 'write-z', null),
          expectedHeadVersion: undefined,
        },
      ).ok,
    ).toBe(true);
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest(
          projectA,
          'activation-a',
          4,
          'write-a',
          '7:active:base',
          'write-predecessor',
        ),
      ).ok,
    ).toBe(true);

    await expect(repository.initialize()).resolves.toEqual({ ok: true, value: undefined });
    expect(delegate.saveRequests.map(({ project, activationId }) => [project.id, activationId]))
      .toEqual([
        ['project-a', 'activation-a'],
        ['project-b', 'activation-z'],
      ]);
    expect(delegate.saveRequests[0]).toMatchObject({
      expectedHeadVersion: '7:active:base',
      predecessorWriteId: 'write-predecessor',
    });
    expect(Object.hasOwn(delegate.saveRequests[1] ?? {}, 'expectedHeadVersion')).toBe(false);
    expect(journal.list()).toEqual({ ok: true, value: [] });
  });

  it('does not choose a lexical winner between incomparable activations', async () => {
    const { delegate, journal, repository } = setup();
    const value = project('project-conflicting-activations');
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...value, title: 'A' }, 'activation-a', 2, 'write-a', null),
      ).ok,
    ).toBe(true);
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...value, title: 'Z' }, 'activation-z', 9, 'write-z', null),
      ).ok,
    ).toBe(true);

    await expect(repository.initialize()).resolves.toEqual({ ok: true, value: undefined });

    expect(delegate.saveRequests).toEqual([]);
    const listed = await repository.list();
    expect(listed).toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          errorCode: 'conflict',
          branches: [
            expect.objectContaining({ activationId: 'activation-a' }),
            expect.objectContaining({ activationId: 'activation-z' }),
          ],
        },
      ],
    });
  });

  it('retains failed, conflicting, malformed-receipt, replaced, and unreadable entries', async () => {
    const { delegate, storage, journal, repository } = setup();
    for (const [activationId, writeId] of [
      ['activation-conflict', 'write-conflict'],
      ['activation-throw', 'write-throw'],
      ['activation-malformed', 'write-malformed'],
      ['activation-replaced', 'write-replaced'],
    ] as const) {
      expect(
        journal.saveRecoverySynchronously(
          recoveryRequest(project(`project-${activationId}`), activationId, 1, writeId, null),
        ).ok,
      ).toBe(true);
    }
    const corruptKey = nativeRecoveryKey('project-corrupt', 'activation-corrupt');
    storage.setItem(corruptKey, '{corrupt');
    delegate.saveHandler = async (request, ordinal) => {
      if (request.writeId === 'write-conflict') {
        return {
          ok: false,
          error: {
            operation: 'save',
            code: 'conflict',
            retry: 'manual',
            projectId: request.project.id,
          },
        };
      }
      if (request.writeId === 'write-throw') throw new Error('transport failed');
      if (request.writeId === 'write-malformed') {
        return {
          ok: true,
          value: { ...successReceipt(request, ordinal), writeId: 'wrong-write' },
        };
      }
      if (request.writeId === 'write-replaced') {
        journal.saveRecoverySynchronously(
          recoveryRequest(request.project, request.activationId, 2, 'write-newer', null),
        );
      }
      return { ok: true, value: successReceipt(request, ordinal) };
    };

    await expect(repository.initialize()).resolves.toEqual({ ok: true, value: undefined });
    const remaining = journal.list();
    if (!remaining.ok) throw new Error('journal list failed');
    expect(remaining.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ready', writeId: 'write-conflict' }),
        expect.objectContaining({ status: 'ready', writeId: 'write-throw' }),
        expect.objectContaining({ status: 'ready', writeId: 'write-malformed' }),
        expect.objectContaining({ status: 'ready', writeId: 'write-newer', revision: 2 }),
        expect.objectContaining({ status: 'unreadable', errorCode: 'corrupt-data' }),
      ]),
    );
  });

  it('cleans only superseded or exact same-revision journals from the successful activation', async () => {
    const { journal, repository } = setup();
    const value = project('project-cleanup', 'canonical');

    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...value, title: 'older' }, 'activation-a', 1, 'write-1', null),
      ).ok,
    ).toBe(true);
    await expect(
      repository.save(recoveryRequest(value, 'activation-a', 2, 'write-2', null)),
    ).resolves.toMatchObject({ ok: true });
    expect(journal.list(value.id)).toEqual({ ok: true, value: [] });

    const exact = recoveryRequest(value, 'activation-a', 3, 'write-3', '2:active:write-2');
    expect(journal.saveRecoverySynchronously(exact).ok).toBe(true);
    await expect(repository.save(exact)).resolves.toMatchObject({ ok: true });
    expect(journal.list(value.id)).toEqual({ ok: true, value: [] });

    const routedThroughPredecessor = recoveryRequest(
      value,
      'activation-a',
      4,
      'write-4',
      '3:active:write-3',
      'write-3',
    );
    expect(journal.saveRecoverySynchronously(routedThroughPredecessor).ok).toBe(true);
    await expect(
      repository.save(
        recoveryRequest(value, 'activation-a', 4, 'write-4', '4:active:write-predecessor'),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(journal.list(value.id)).toEqual({ ok: true, value: [] });

    const journalVersion = recoveryRequest(
      { ...value, title: 'journal bytes' },
      'activation-a',
      5,
      'write-5',
      '4:active:write-4',
    );
    expect(journal.saveRecoverySynchronously(journalVersion).ok).toBe(true);
    await expect(
      repository.save(
        recoveryRequest(
          { ...value, title: 'different canonical bytes' },
          'activation-a',
          5,
          'write-5',
          '4:active:write-4',
        ),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(journal.list(value.id)).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ activationId: 'activation-a', revision: 5 })],
    });

    const otherActivation = recoveryRequest(value, 'activation-b', 6, 'write-6', null);
    expect(journal.saveRecoverySynchronously(otherActivation).ok).toBe(true);
    await expect(
      repository.save(recoveryRequest(value, 'activation-a', 6, 'write-6', null)),
    ).resolves.toMatchObject({ ok: true });
    expect(journal.list(value.id)).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ activationId: 'activation-b', revision: 6 })],
    });
  });

  it('merges ready branches without choosing a journal when canonical state is absent', async () => {
    const { delegate, journal, repository } = setup();
    const canonicalProject = project('project-canonical', 'Canonical');
    const orphan = project('project-orphan', 'Orphan');
    const canonicalBranch: ProjectSummary['branches'][number] = {
      branchId: 'delegate-branch',
      source: 'interrupted-save',
      activationId: 'delegate-activation',
      revision: 1,
      writeId: 'delegate-write',
      savedAt: '2026-07-10T01:00:00.000Z',
      title: 'Delegate branch',
      updatedAt: '2026-07-10T01:00:00.000Z',
    };
    delegate.listResult = {
      ok: true,
      value: [
        {
          status: 'ready',
          id: canonicalProject.id,
          title: canonicalProject.title,
          updatedAt: canonicalProject.updatedAt,
          recovered: false,
          branches: [canonicalBranch],
        },
      ],
    };
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest(canonicalProject, 'activation-native', 2, 'write-native', null),
      ).ok,
    ).toBe(true);
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...orphan, title: 'Branch Z' }, 'activation-z', 1, 'write-z', null),
      ).ok,
    ).toBe(true);
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...orphan, title: 'Branch A' }, 'activation-a', 1, 'write-a', null),
      ).ok,
    ).toBe(true);

    const listed = await repository.list();
    if (!listed.ok) throw new Error('decorated list failed');
    expect(listed.value).toHaveLength(2);
    expect(listed.value[0]).toMatchObject({
      status: 'ready',
      id: canonicalProject.id,
      branches: expect.arrayContaining([
        expect.objectContaining({ branchId: 'delegate-branch' }),
        expect.objectContaining({ source: 'recovery-journal', activationId: 'activation-native' }),
      ]),
    });
    expect(listed.value[1]).toMatchObject({
      status: 'unreadable',
      id: orphan.id,
      errorCode: 'conflict',
      branches: [
        expect.objectContaining({ activationId: 'activation-a', title: 'Branch A' }),
        expect.objectContaining({ activationId: 'activation-z', title: 'Branch Z' }),
      ],
    });

    await expect(repository.load(orphan.id)).resolves.toEqual({ ok: true, value: null });
    await expect(repository.loadMostRecent()).resolves.toEqual({ ok: true, value: null });
    expect(delegate.saveRequests).toHaveLength(0);
  });

  it('lets a sticky future journal hide mixed ready branches and block canonical reads and writes', async () => {
    const { delegate, storage, journal, repository } = setup();
    const value = project('project-sticky-future', 'Canonical');
    const loaded: LoadedProject = {
      project: value,
      headVersion: '1:active:canonical',
      source: 'generation',
      recovered: false,
      recoveryReason: null,
    };
    delegate.listResult = {
      ok: true,
      value: [
        {
          status: 'ready',
          id: value.id,
          title: value.title,
          updatedAt: value.updatedAt,
          recovered: false,
          branches: [],
        },
      ],
    };
    delegate.loadResult = { ok: true, value: loaded };
    delegate.mostRecentResult = { ok: true, value: loaded };
    delegate.projectStateResult = { ok: true, value: 'active' };
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...value, title: 'Older branch' }, 'activation-old', 1, 'write-old'),
      ).ok,
    ).toBe(true);

    const beforeFuture = await repository.list();
    if (!beforeFuture.ok) throw new Error('initial branch list failed');
    const olderBranchId = beforeFuture.value[0]?.branches[0]?.branchId;
    if (!olderBranchId) throw new Error('initial branch id missing');
    const future = writeFutureJournal(storage, value.id, 'activation-future');
    const before = rawStorageSnapshot(storage);

    await expect(repository.list()).resolves.toEqual({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: value.id,
          errorCode: 'unsupported-version',
          branches: [],
        },
      ],
    });
    await expect(repository.load(value.id)).resolves.toEqual({
      ok: false,
      error: {
        operation: 'load',
        code: 'unsupported-version',
        retry: 'never',
        projectId: value.id,
      },
    });
    await expect(repository.loadMostRecent()).resolves.toMatchObject({
      ok: false,
      error: { operation: 'load', code: 'unsupported-version', projectId: value.id },
    });
    await expect(repository.loadProjectBranch(value.id, olderBranchId)).resolves.toMatchObject({
      ok: false,
      error: { operation: 'load', code: 'unsupported-version', projectId: value.id },
    });
    await expect(repository.loadProjectBranch(value.id, 'delegate-branch')).resolves.toMatchObject({
      ok: false,
      error: { operation: 'load', code: 'unsupported-version', projectId: value.id },
    });
    await expect(
      repository.save(recoveryRequest(value, 'activation-canonical', 2, 'write-canonical')),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: 'save',
        code: 'unsupported-version',
        retry: 'never',
        projectId: value.id,
      },
    });
    expect(
      repository.saveRecoverySynchronously(
        recoveryRequest(
          { ...value, title: 'Must not journal' },
          'activation-new-emergency',
          3,
          'write-new-emergency',
        ),
      ),
    ).toEqual({
      ok: false,
      error: {
        operation: 'save',
        code: 'unsupported-version',
        retry: 'never',
        projectId: value.id,
      },
    });

    expect(delegate.loadCalls).toEqual([]);
    expect(delegate.mostRecentCalls).toBe(0);
    expect(delegate.branchCalls).toEqual([]);
    expect(delegate.saveRequests).toEqual([]);
    expect(storage.getItem(future.key)).toBe(future.raw);
    expect(rawStorageSnapshot(storage)).toEqual(before);
  });

  it('applies the same sticky no-mutation policy to migration diagnostics', async () => {
    const { delegate, storage, journal, repository } = setup();
    const value = project('project-sticky-migration');
    delegate.projectStateResult = { ok: true, value: 'active' };
    const future = writeFutureJournal(storage, value.id, 'activation-migration');
    const originalList = journal.list.bind(journal);
    vi.spyOn(journal, 'list').mockImplementation((projectId?: string) => {
      const result = originalList(projectId);
      if (!result.ok) return result;
      return {
        ok: true,
        value: result.value.map((entry) =>
          entry.status === 'unreadable' && entry.errorCode === 'unsupported-version'
            ? { ...entry, errorCode: 'migration-failed' as const }
            : entry,
        ),
      };
    });
    const before = rawStorageSnapshot(storage);

    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: value.id,
          errorCode: 'migration-failed',
          branches: [],
        },
      ],
    });
    await expect(repository.load(value.id)).resolves.toMatchObject({
      ok: false,
      error: { operation: 'load', code: 'migration-failed', projectId: value.id },
    });
    await expect(
      repository.save(recoveryRequest(value, 'activation-canonical', 1, 'write-canonical')),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'migration-failed', projectId: value.id },
    });
    expect(
      repository.saveRecoverySynchronously(
        recoveryRequest(value, 'activation-other', 2, 'write-other'),
      ),
    ).toMatchObject({
      ok: false,
      error: { operation: 'save', code: 'migration-failed', projectId: value.id },
    });
    await expect(
      repository.remove({ projectId: value.id, deleteId: 'delete-migration' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: 'remove', code: 'migration-failed', projectId: value.id },
    });

    expect(delegate.saveRequests).toEqual([]);
    expect(delegate.removeCalls).toEqual([]);
    expect(storage.getItem(future.key)).toBe(future.raw);
    expect(rawStorageSnapshot(storage)).toEqual(before);
  });

  it('restores a ready project before reporting an unrelated sticky orphan', async () => {
    const { delegate, storage, repository } = setup();
    const value = project('project-ready-first', 'Ready first');
    const loaded: LoadedProject = {
      project: value,
      headVersion: '1:active:ready',
      source: 'generation',
      recovered: false,
      recoveryReason: null,
    };
    delegate.listResult = {
      ok: true,
      value: [
        {
          status: 'ready',
          id: value.id,
          title: value.title,
          updatedAt: value.updatedAt,
          recovered: false,
          branches: [],
        },
      ],
    };
    delegate.loadResult = { ok: true, value: loaded };
    writeFutureJournal(storage, 'project-future-orphan', 'activation-future');

    await expect(repository.loadMostRecent()).resolves.toEqual({ ok: true, value: loaded });
    expect(delegate.loadCalls).toEqual([value.id]);
    expect(delegate.mostRecentCalls).toBe(0);
  });

  it('lets verified deletion suppress a stale canonical summary while retaining future bytes', async () => {
    const { delegate, storage, repository } = setup();
    const value = project('project-remove');
    delegate.listResult = {
      ok: true,
      value: [
        {
          status: 'ready',
          id: value.id,
          title: value.title,
          updatedAt: value.updatedAt,
          recovered: false,
          branches: [],
        },
      ],
    };
    delegate.projectStateResult = { ok: true, value: 'deleted' };
    const future = writeFutureJournal(storage, value.id, 'activation-future');

    await expect(repository.list()).resolves.toEqual({ ok: true, value: [] });
    await expect(repository.load(value.id)).resolves.toEqual({ ok: true, value: null });
    await expect(
      repository.loadProjectBranch(value.id, 'native-recovery-branch-v1-0000000000000000'),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(repository.loadMostRecent()).resolves.toEqual({ ok: true, value: null });
    await expect(
      repository.remove({ projectId: value.id, deleteId: 'delete-1' }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        projectId: value.id,
        deleteId: 'delete-1',
        cleanupComplete: false,
      },
    });

    expect(delegate.loadCalls).toEqual([]);
    expect(delegate.removeCalls).toEqual([
      { projectId: value.id, deleteId: 'delete-1' },
    ]);
    expect(storage.getItem(future.key)).toBe(future.raw);
  });

  it('blocks an active delete before durable or journal mutation when a future journal exists', async () => {
    const { delegate, storage, journal, repository } = setup();
    const value = project('project-remove');
    delegate.projectStateResult = { ok: true, value: 'active' };
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest(value, 'activation-ready', 1, 'write-ready'),
      ).ok,
    ).toBe(true);
    writeFutureJournal(storage, value.id, 'activation-future');
    const before = rawStorageSnapshot(storage);

    await expect(
      repository.remove({ projectId: value.id, deleteId: 'delete-1' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: 'remove',
        code: 'unsupported-version',
        retry: 'never',
        projectId: value.id,
      },
    });

    expect(delegate.removeCalls).toEqual([]);
    expect(rawStorageSnapshot(storage)).toEqual(before);
  });

  it.each(['appears', 'replaces'] as const)(
    'preserves a future journal that %s while canonical remove is awaiting',
    async (race) => {
      const { delegate, storage, journal, repository } = setup();
      const value = project('project-remove');
      expect(
        journal.saveRecoverySynchronously(
          recoveryRequest(value, 'activation-ready', 1, 'write-ready'),
        ).ok,
      ).toBe(true);
      delegate.removeResult = {
        ok: true,
        value: {
          projectId: value.id,
          deleteId: 'delete-1',
          headVersion: '2:deleted:delete-1',
          removed: true,
          cleanupComplete: true,
        },
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      delegate.removeHandler = async () => {
        await gate;
        return delegate.removeResult;
      };

      const pending = repository.remove({ projectId: value.id, deleteId: 'delete-1' });
      await Promise.resolve();
      expect(delegate.removeCalls).toHaveLength(1);
      const future = writeFutureJournal(
        storage,
        value.id,
        race === 'replaces' ? 'activation-ready' : 'activation-future',
      );
      release();

      await expect(pending).resolves.toMatchObject({
        ok: true,
        value: { cleanupComplete: false },
      });
      expect(storage.getItem(future.key)).toBe(future.raw);
      expect(
        journal.list(value.id),
      ).toMatchObject({
        ok: true,
        value: [expect.objectContaining({ errorCode: 'unsupported-version' })],
      });
    },
  );

  it('loads only the exact current opaque journal fingerprint and delegates other branch ids', async () => {
    const { delegate, journal, repository } = setup();
    const value = project('project-branch', 'First branch');
    const firstRequest = recoveryRequest(value, 'activation-a', 1, 'write-1', null);
    expect(journal.saveRecoverySynchronously(firstRequest).ok).toBe(true);
    const firstList = await repository.list();
    if (!firstList.ok) throw new Error('list failed');
    const firstSummary = firstList.value[0];
    const firstBranchId = firstSummary?.branches[0]?.branchId;
    if (!firstBranchId) throw new Error('branch id missing');
    expect(firstBranchId).toMatch(/^native-recovery-branch-v1-[0-9a-f]{16}$/);
    await expect(repository.loadProjectBranch(value.id, firstBranchId)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'First branch' }, branchId: firstBranchId },
    });

    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest({ ...value, title: 'Replacement' }, 'activation-a', 2, 'write-2', null),
      ).ok,
    ).toBe(true);
    await expect(repository.loadProjectBranch(value.id, firstBranchId)).resolves.toEqual({
      ok: true,
      value: null,
    });
    const secondList = await repository.list();
    if (!secondList.ok) throw new Error('list failed');
    const secondBranchId = secondList.value[0]?.branches[0]?.branchId;
    expect(secondBranchId).not.toBe(firstBranchId);

    await expect(repository.loadProjectBranch(value.id, 'delegate-branch')).resolves.toEqual(
      delegate.branchResult,
    );
    expect(delegate.branchCalls).toEqual([
      { projectId: value.id, branchId: 'delegate-branch' },
    ]);
    vi.spyOn(journal, 'list').mockImplementation(() => {
      throw new Error('unexpected journal exception');
    });
    await expect(repository.loadProjectBranch(value.id, 'delegate-branch')).resolves.toEqual(
      delegate.branchResult,
    );
    await expect(repository.loadProjectBranch(value.id, secondBranchId!)).resolves.toMatchObject({
      ok: false,
      error: { operation: 'load', code: 'read-failed', retry: 'automatic' },
    });
    expect(delegate.branchCalls).toEqual([
      { projectId: value.id, branchId: 'delegate-branch' },
      { projectId: value.id, branchId: 'delegate-branch' },
    ]);
    await expect(repository.loadProjectBranch(value.id, 'x'.repeat(4_097))).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-project', retry: 'never' },
    });
  });

  it('keeps an explicit recovery branch available for unreadable non-deleted native state', async () => {
    const { delegate, journal, repository } = setup();
    const value = project('project-corrupt-native', 'Emergency copy');
    delegate.projectStateResult = { ok: true, value: 'unreadable' };
    delegate.listResult = {
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: value.id,
          errorCode: 'corrupt-data',
          branches: [],
        },
      ],
    };
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest(value, 'activation-a', 1, 'write-1', null),
      ).ok,
    ).toBe(true);

    const listed = await repository.list();
    if (!listed.ok) throw new Error('list failed');
    const branchId = listed.value[0]?.branches[0]?.branchId;
    if (!branchId) throw new Error('recovery branch missing');
    await expect(repository.loadProjectBranch(value.id, branchId)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'Emergency copy' } },
    });
  });

  it('isolates journal availability failures from canonical initialize, list, and save', async () => {
    const delegate = new RecordingRepository();
    const storage = new TestStorage();
    storage.failEnumerate = Object.assign(new Error('journal denied'), { name: 'SecurityError' });
    const journal = new NativeRecoveryJournal({ storage, now: fixedNow });
    const repository = new NativeRecoveryProjectRepository({ delegate, journal });
    const canonicalSummary: ProjectSummary = {
      status: 'ready',
      id: 'project-canonical',
      title: 'Canonical',
      updatedAt: '2026-07-10T00:00:00.000Z',
      recovered: false,
      branches: [],
    };
    delegate.listResult = { ok: true, value: [canonicalSummary] };

    await expect(repository.initialize()).resolves.toEqual({ ok: true, value: undefined });
    await expect(repository.list()).resolves.toEqual({ ok: true, value: [canonicalSummary] });
    await expect(
      repository.save(
        recoveryRequest(project('project-canonical'), 'activation-a', 1, 'write-1', null),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(delegate.initializeCalls).toBe(1);
    expect(delegate.saveRequests).toHaveLength(1);

    expect(
      repository.saveRecoverySynchronously(
        recoveryRequest(project('project-sync'), 'activation-a', 1, 'write-sync', null),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        operation: 'save',
        code: 'access-denied',
        projectId: 'project-sync',
      },
    });
    await expect(
      repository.loadProjectBranch(
        'project-sync',
        'native-recovery-branch-v1-0000000000000000',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        operation: 'load',
        code: 'access-denied',
        projectId: 'project-sync',
      },
    });
  });

  it('surfaces a corrupt orphan journal as a removable unreadable project', async () => {
    const { storage, repository } = setup();
    storage.setItem(nativeRecoveryKey('project-corrupt-orphan', 'activation-a'), '{corrupt');

    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: 'project-corrupt-orphan',
          errorCode: 'corrupt-data',
          branches: [],
        },
      ],
    });
  });

  it('reports incomplete cleanup when a committed delete cannot clear journal branches', async () => {
    const { delegate, storage, journal, repository } = setup();
    const value = project('project-remove');
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest(value, 'activation-a', 1, 'write-1', null),
      ).ok,
    ).toBe(true);
    const beforeDelete = await repository.list();
    if (!beforeDelete.ok) throw new Error('branch list failed');
    const branchId = beforeDelete.value[0]?.branches[0]?.branchId;
    if (!branchId) throw new Error('branch id missing');
    storage.failEnumerate = Object.assign(new Error('journal denied'), { name: 'SecurityError' });

    await expect(
      repository.remove({ projectId: value.id, deleteId: 'delete-1' }),
    ).resolves.toMatchObject({
      ok: true,
      value: { removed: true, cleanupComplete: false },
    });
    expect(delegate.removeCalls).toHaveLength(1);
    delegate.projectStateResult = { ok: true, value: 'deleted' };
    storage.failEnumerate = null;
    await expect(repository.list()).resolves.toEqual({ ok: true, value: [] });
    await expect(repository.loadProjectBranch(value.id, branchId)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it('does not inspect or replay the journal when canonical initialization fails', async () => {
    const { delegate, storage, journal, repository } = setup();
    expect(
      journal.saveRecoverySynchronously(
        recoveryRequest(project('project-init-fail'), 'activation-a', 1, 'write-1', null),
      ).ok,
    ).toBe(true);
    delegate.initializeResult = {
      ok: false,
      error: {
        operation: 'initialize',
        code: 'storage-unavailable',
        retry: 'never',
      },
    };
    storage.failEnumerate = new Error('must not enumerate');

    await expect(repository.initialize()).resolves.toEqual(delegate.initializeResult);
    expect(delegate.saveRequests).toHaveLength(0);
  });
});
