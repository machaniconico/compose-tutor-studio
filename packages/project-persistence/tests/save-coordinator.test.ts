import { describe, expect, it, vi } from 'vitest';
import { encodeProjectJson } from '@cts/project-model';
import type {
  CrashDraftReceipt,
  LoadedProject,
  ProjectRepository,
  ProjectSummary,
  RemoveReceipt,
  RemoveRequest,
  RecoveryReceipt,
  RepositoryResult,
  SaveReceipt,
  SaveRequest,
} from '../src/index';
import {
  LocalStorageProjectRepository,
  ProjectSaveCoordinator,
  projectHeadKey,
} from '../src/index';
import { makeProject, TestStorage } from './helpers';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function receipt(request: SaveRequest, ordinal: number): RepositoryResult<SaveReceipt> {
  return {
    ok: true,
    value: {
      projectId: request.project.id,
      activationId: request.activationId,
      revision: request.revision,
      writeId: request.writeId,
      headVersion: `${ordinal}:${request.writeId}`,
      savedAt: '2026-07-10T12:00:00.000Z',
      bytes: 100,
      retainedGenerations: 3,
      legacyMirrorWritten: false,
    },
  };
}

function draftReceipt(request: SaveRequest): RepositoryResult<CrashDraftReceipt> {
  const encoded = encodeProjectJson(request.project);
  if (!encoded.ok) throw new Error('draft receipt project fixture failed to encode');
  return {
    ok: true,
    value: {
      projectId: request.project.id,
      activationId: request.activationId,
      revision: request.revision,
      writeId: request.writeId,
      protectedAt: '2026-07-10T12:00:00.000Z',
      bytes: encoded.bytes,
    },
  };
}

class DeferredRepository implements ProjectRepository {
  readonly kind = 'memory' as const;
  readonly requests: SaveRequest[] = [];
  readonly saves: Array<Deferred<RepositoryResult<SaveReceipt>>> = [];
  concurrent = 0;
  maxConcurrent = 0;
  loads = 0;
  loadResult: RepositoryResult<LoadedProject | null> = { ok: true, value: null };

  initialize(): Promise<RepositoryResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    return Promise.resolve({ ok: true, value: [] });
  }
  load(_id: string): Promise<RepositoryResult<LoadedProject | null>> {
    this.loads += 1;
    return Promise.resolve(this.loadResult);
  }
  loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    return Promise.resolve({ ok: true, value: null });
  }
  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    this.requests.push(request);
    const pending = deferred<RepositoryResult<SaveReceipt>>();
    this.saves.push(pending);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    return pending.promise.finally(() => {
      this.concurrent -= 1;
    });
  }
  remove(_request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    return Promise.resolve({
      ok: true,
      value: {
        projectId: '',
        deleteId: 'unused',
        headVersion: 'unused',
        removed: false,
        cleanupComplete: true,
      },
    });
  }
  close(): Promise<RepositoryResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}

class DeferredRecoveryRepository extends DeferredRepository {
  readonly local: LocalStorageProjectRepository;
  readonly recoveryRequests: SaveRequest[] = [];

  constructor(storage: TestStorage) {
    super();
    this.local = new LocalStorageProjectRepository({
      storage,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
    });
  }

  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt> {
    this.recoveryRequests.push(request);
    return this.local.saveRecoverySynchronously(request);
  }
}

class DeferredCrashDraftRepository extends DeferredRepository {
  readonly draftRequests: SaveRequest[] = [];
  readonly drafts: Array<Deferred<RepositoryResult<CrashDraftReceipt>>> = [];

  stageCrashDraft(request: SaveRequest): Promise<RepositoryResult<CrashDraftReceipt>> {
    this.draftRequests.push(request);
    const pending = deferred<RepositoryResult<CrashDraftReceipt>>();
    this.drafts.push(pending);
    return pending.promise;
  }
}

class RecordingRecoveryRepository extends DeferredRepository {
  readonly recoveryRequests: SaveRequest[] = [];

  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt> {
    this.recoveryRequests.push(request);
    return {
      ok: true,
      value: {
        projectId: request.project.id,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        savedAt: '2026-07-10T12:00:00.000Z',
        bytes: 100,
      },
    };
  }
}

class DeferredLoadRepository extends DeferredRepository {
  readonly pendingLoad = deferred<RepositoryResult<LoadedProject | null>>();

  override load(_id: string): Promise<RepositoryResult<LoadedProject | null>> {
    this.loads += 1;
    return this.pendingLoad.promise;
  }
}

function coordinator(repository: ProjectRepository): ProjectSaveCoordinator {
  let write = 0;
  return new ProjectSaveCoordinator({
    repository,
    createWriteId: () => `write-${++write}`,
  });
}

describe('ProjectSaveCoordinator', () => {
  it('protects the latest coalesced revision without forcing a canonical save', async () => {
    const repository = new DeferredCrashDraftRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: 'head-0',
    });
    saves.markDirty({ project: { ...project, title: 'rev1' }, activationId: 'a', revision: 1 });
    const protecting = saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));

    saves.markDirty({ project: { ...project, title: 'rev2' }, activationId: 'a', revision: 2 });
    const first = repository.draftRequests[0];
    if (!first) throw new Error('first draft request missing');
    repository.drafts[0]?.resolve(draftReceipt(first));
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(2));
    const second = repository.draftRequests[1];
    if (!second) throw new Error('second draft request missing');
    expect(second.predecessorWriteId).toBe(first.writeId);
    repository.drafts[1]?.resolve(draftReceipt(second));

    await expect(protecting).resolves.toMatchObject({
      ok: true,
      value: { revision: 2, writeId: second.writeId },
    });
    expect(saves.protectedRevision()).toBe(2);
    expect(repository.requests).toEqual([]);
    expect(saves.isDirty()).toBe(true);
  });

  it('keeps a failed draft retryable until protection succeeds', async () => {
    const repository = new DeferredCrashDraftRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    const failed = saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));
    repository.drafts[0]?.resolve({
      ok: false,
      error: { operation: 'save', code: 'write-failed', retry: 'automatic', projectId: project.id },
    });
    await expect(failed).resolves.toMatchObject({ ok: false, error: { code: 'write-failed' } });

    const retry = saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(2));
    const request = repository.draftRequests[1];
    if (!request) throw new Error('retry draft request missing');
    repository.drafts[1]?.resolve(draftReceipt(request));
    await expect(retry).resolves.toMatchObject({ ok: true, value: { revision: 1 } });
    expect(saves.protectedRevision()).toBe(1);
  });

  it('rejects a crash-draft receipt with the wrong payload byte count', async () => {
    const repository = new DeferredCrashDraftRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project, activationId: 'a', revision: 1 });

    const firstProtection = saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));
    const firstRequest = repository.draftRequests[0];
    if (!firstRequest) throw new Error('draft request missing');
    const validReceipt = draftReceipt(firstRequest);
    if (!validReceipt.ok) throw new Error('draft receipt fixture failed');
    repository.drafts[0]?.resolve({
      ok: true,
      value: { ...validReceipt.value, bytes: validReceipt.value.bytes + 1 },
    });
    await expect(firstProtection).resolves.toMatchObject({
      ok: false,
      error: { code: 'write-failed' },
    });
    expect(saves.protectedRevision()).toBe(0);

    const retry = saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(2));
    const retryRequest = repository.draftRequests[1];
    if (!retryRequest) throw new Error('retry draft request missing');
    expect(retryRequest.writeId).toBe(firstRequest.writeId);
    repository.drafts[1]?.resolve(draftReceipt(retryRequest));
    await expect(retry).resolves.toMatchObject({ ok: true, value: { revision: 1 } });
  });

  it('does not requeue a failed draft after the same revision saved canonically', async () => {
    const repository = new DeferredCrashDraftRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    const protecting = saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));

    const flushing = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    const canonicalRequest = repository.requests[0];
    if (!canonicalRequest) throw new Error('canonical request missing');
    repository.saves[0]?.resolve(receipt(canonicalRequest, 1));
    await vi.waitFor(() => expect(saves.persistedRevision()).toBe(1));
    repository.drafts[0]?.resolve({
      ok: false,
      error: {
        operation: 'save',
        code: 'conflict',
        retry: 'manual',
        projectId: project.id,
      },
    });

    await expect(protecting).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    await expect(flushing).resolves.toMatchObject({
      ok: true,
      value: { persistedRevision: 1, clean: true },
    });
    await expect(saves.protectLatest()).resolves.toEqual({ ok: true, value: null });
    expect(repository.draftRequests).toHaveLength(1);
    expect(saves.protectedRevision()).toBe(1);
  });

  it('does not finish a canonical flush until an in-flight draft write settles', async () => {
    const repository = new DeferredCrashDraftRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    void saves.protectLatest();
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));

    let flushResolved = false;
    const flush = saves.flush().then((result) => {
      flushResolved = true;
      return result;
    });
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    const canonical = repository.requests[0];
    if (!canonical) throw new Error('canonical request missing');
    repository.saves[0]?.resolve(receipt(canonical, 1));
    await Promise.resolve();
    expect(flushResolved).toBe(false);

    const draft = repository.draftRequests[0];
    if (!draft) throw new Error('draft request missing');
    repository.drafts[0]?.resolve(draftReceipt(draft));
    await expect(flush).resolves.toMatchObject({
      ok: true,
      value: { persistedRevision: 1, clean: true },
    });
    expect(flushResolved).toBe(true);
  });

  it('keeps one save in flight and coalesces rev2/rev3 to rev3', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project: { ...project, title: 'rev1' }, activationId: 'a', revision: 1 });
    const flushing = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    saves.markDirty({ project: { ...project, title: 'rev2' }, activationId: 'a', revision: 2 });
    saves.markDirty({ project: { ...project, title: 'rev3' }, activationId: 'a', revision: 3 });

    const first = repository.requests[0];
    if (!first) throw new Error('first request missing');
    repository.saves[0]?.resolve(receipt(first, 1));
    await vi.waitFor(() => expect(repository.requests).toHaveLength(2));
    expect(repository.requests.map((item) => item.revision)).toEqual([1, 3]);
    expect(repository.requests[1]?.expectedHeadVersion).toBe('1:write-1');
    const second = repository.requests[1];
    if (!second) throw new Error('second request missing');
    repository.saves[1]?.resolve(receipt(second, 2));

    await expect(flushing).resolves.toMatchObject({
      ok: true,
      value: { clean: true, persistedRevision: 3, receipt: { revision: 3 } },
    });
    expect(repository.maxConcurrent).toBe(1);
    expect(saves.isDirty()).toBe(false);
  });

  it('retains the newest snapshot after a failed older in-flight save', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project: { ...project, title: 'old' }, activationId: 'a', revision: 1 });
    const firstFlush = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    saves.markDirty({ project: { ...project, title: 'latest' }, activationId: 'a', revision: 2 });
    repository.saves[0]?.resolve({
      ok: false,
      error: {
        operation: 'save',
        code: 'quota-exceeded',
        retry: 'manual',
        projectId: project.id,
      },
    });

    await expect(firstFlush).resolves.toMatchObject({ ok: false, error: { code: 'quota-exceeded' } });
    expect(saves.isDirty()).toBe(true);
    const retry = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(2));
    expect(repository.requests[1]?.project.title).toBe('latest');
    const second = repository.requests[1];
    if (!second) throw new Error('retry request missing');
    repository.saves[1]?.resolve(receipt(second, 1));
    await expect(retry).resolves.toMatchObject({ ok: true, value: { persistedRevision: 2 } });
  });

  it('rejects a late older revision instead of replacing the newest pending snapshot', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    expect(
      saves.markDirty({ project: { ...project, title: 'rev3' }, activationId: 'a', revision: 3 }),
    ).toBe(true);
    expect(
      saves.markDirty({ project: { ...project, title: 'late rev2' }, activationId: 'a', revision: 2 }),
    ).toBe(false);

    const flush = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    expect(repository.requests[0]?.revision).toBe(3);
    expect(repository.requests[0]?.project.title).toBe('rev3');
    const pending = repository.requests[0];
    if (!pending) throw new Error('request missing');
    repository.saves[0]?.resolve(receipt(pending, 1));
    await expect(flush).resolves.toMatchObject({ ok: true, value: { persistedRevision: 3 } });
  });

  it('rejects activation changes while a physical save is in flight', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const firstProject = makeProject('first');
    const secondProject = makeProject('second');
    saves.activate({
      projectId: firstProject.id,
      activationId: 'first-activation',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project: firstProject, activationId: 'first-activation', revision: 1 });
    const flush = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    expect(saves.activate({
      projectId: secondProject.id,
      activationId: 'second-activation',
      persistedRevision: 7,
      headVersion: '7:second',
    })).toBe(false);
    const first = repository.requests[0];
    if (!first) throw new Error('request missing');
    repository.saves[0]?.resolve(receipt(first, 1));

    await expect(flush).resolves.toMatchObject({ ok: true, value: { persistedRevision: 1 } });
    expect(saves.persistedRevision()).toBe(1);
    expect(saves.currentHeadVersion()).toBe('1:write-1');
  });

  it('waits for an in-flight write before cancellation completes', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    void saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    let cancelled = false;
    const cancellation = saves.cancelAndWait(project.id, 'a').then((result) => {
      cancelled = true;
      return result;
    });
    expect(
      saves.markDirty({ project: { ...project, title: 'too late' }, activationId: 'a', revision: 2 }),
    ).toBe(false);
    await Promise.resolve();
    expect(cancelled).toBe(false);
    const first = repository.requests[0];
    if (!first) throw new Error('request missing');
    repository.saves[0]?.resolve(receipt(first, 1));
    await expect(cancellation).resolves.toMatchObject({
      ok: true,
      value: {
        headVersion: '1:write-1',
        persistedRevision: 1,
        receipt: { revision: 1, writeId: 'write-1' },
      },
    });
    expect(cancelled).toBe(true);
    expect(saves.isDirty()).toBe(false);
  });

  it('reconciles a committed write whose success response was lost before cancellation', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const base = makeProject('base');
    const latest = { ...base, title: 'durably committed' };
    saves.activate({
      projectId: base.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: '1:active:base',
    });
    saves.markDirty({ project: latest, activationId: 'a', revision: 1 });
    void saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    repository.loadResult = {
      ok: true,
      value: {
        project: latest,
        headVersion: '2:active:write-1',
        source: 'generation',
        recovered: false,
        recoveryReason: null,
      },
    };
    const cancellation = saves.cancelAndWait(base.id, 'a');
    repository.saves[0]?.resolve({
      ok: false,
      error: { operation: 'save', code: 'write-failed', retry: 'automatic', projectId: base.id },
    });

    await expect(cancellation).resolves.toMatchObject({
      ok: true,
      value: { headVersion: '2:active:write-1', persistedRevision: 1 },
    });
  });

  it('aborts cancellation on a divergent newer head and keeps the activation editable', async () => {
    const repository = new RecordingRecoveryRepository();
    const saves = coordinator(repository);
    const base = makeProject('base');
    const draft = { ...base, title: 'tab A draft' };
    saves.activate({
      projectId: base.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: '1:active:base',
    });
    saves.markDirty({ project: draft, activationId: 'a', revision: 1 });
    void saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    const latestDraft = { ...draft, title: 'latest tab A draft' };
    saves.markDirty({ project: latestDraft, activationId: 'a', revision: 2 });
    repository.loadResult = {
      ok: true,
      value: {
        project: { ...base, title: 'tab B commit' },
        headVersion: '2:active:tab-b',
        source: 'generation',
        recovered: false,
        recoveryReason: null,
      },
    };
    const cancellation = saves.cancelAndWait(base.id, 'a');
    repository.saves[0]?.resolve({
      ok: false,
      error: { operation: 'save', code: 'write-failed', retry: 'automatic', projectId: base.id },
    });

    await expect(cancellation).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(saves.isDirty()).toBe(true);
    expect(saves.flushSynchronously()).toMatchObject({
      ok: true,
      value: { recoveryReceipt: { revision: 2 } },
    });
    expect(repository.recoveryRequests[0]?.project.title).toBe('latest tab A draft');
    expect(
      saves.markDirty({ project: { ...latestDraft, title: 'still editable' }, activationId: 'a', revision: 3 }),
    ).toBe(true);
  });

  it('restores a pending-only snapshot when cancellation reconciliation cannot read storage', async () => {
    const repository = new RecordingRecoveryRepository();
    const saves = coordinator(repository);
    const project = makeProject('pending latest');
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 4 });
    repository.loadResult = {
      ok: false,
      error: { operation: 'load', code: 'read-failed', retry: 'automatic', projectId: project.id },
    };

    await expect(saves.cancelAndWait(project.id, 'a')).resolves.toMatchObject({
      ok: false,
      error: { code: 'read-failed' },
    });
    expect(saves.flushSynchronously()).toMatchObject({
      ok: true,
      value: { recoveryReceipt: { revision: 4 } },
    });
    expect(repository.recoveryRequests[0]?.project.title).toBe('pending latest');
  });

  it('does not issue a synchronous write while an async save is in flight', async () => {
    const storageRepository = new DeferredRepository();
    const saves = coordinator(storageRepository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    const flush = saves.flush();
    await vi.waitFor(() => expect(storageRepository.requests).toHaveLength(1));

    expect(saves.flushSynchronously()).toMatchObject({
      ok: false,
      error: { code: 'sync-unsupported' },
    });
    expect(storageRepository.requests).toHaveLength(1);
    const pending = storageRepository.requests[0];
    if (!pending) throw new Error('request missing');
    storageRepository.saves[0]?.resolve(receipt(pending, 1));
    await flush;
  });

  it('journals the newest snapshot during pagehide without overtaking in-flight head I/O', async () => {
    const storage = new TestStorage();
    const repository = new DeferredRecoveryRepository(storage);
    const saves = coordinator(repository);
    const project = makeProject('base', '2026-07-10T00:00:01.000Z');
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    const flush = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    const latest = { ...project, title: 'journal latest', updatedAt: '2026-07-10T00:00:02.000Z' };
    saves.markDirty({ project: latest, activationId: 'a', revision: 2 });

    expect(saves.flushSynchronously()).toMatchObject({
      ok: true,
      value: {
        clean: false,
        recoveryReceipt: { revision: 2 },
      },
    });
    expect(saves.protectedRevision()).toBe(2);
    expect(repository.requests).toHaveLength(1);
    expect(repository.recoveryRequests).toHaveLength(1);
    expect(repository.recoveryRequests[0]?.predecessorWriteId).toBe(
      repository.requests[0]?.writeId,
    );
    await expect(repository.local.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'journal latest' }, recoveryReason: 'recovery-journal' },
    });

    const first = repository.requests[0];
    if (!first) throw new Error('request missing');
    repository.saves[0]?.resolve(receipt(first, 1));
    await vi.waitFor(() => expect(repository.requests).toHaveLength(2));
    const second = repository.requests[1];
    if (!second) throw new Error('latest request missing');
    repository.saves[1]?.resolve(receipt(second, 2));
    await flush;
  });

  it('rejects a malformed repository receipt and keeps the snapshot dirty', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    const flush = saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    const pending = repository.requests[0];
    if (!pending) throw new Error('request missing');
    const malformed = receipt(pending, 1);
    if (!malformed.ok) throw new Error('receipt fixture failed');
    repository.saves[0]?.resolve({
      ok: true,
      value: { ...malformed.value, revision: 999 },
    });

    await expect(flush).resolves.toMatchObject({ ok: false, error: { code: 'write-failed' } });
    expect(saves.isDirty()).toBe(true);
  });

  it('journals the exact latest snapshot for pagehide instead of bypassing the async lock', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({
      storage,
      now: () => new Date('2026-07-10T12:00:00.000Z'),
    });
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project: { ...project, title: 'old' }, activationId: 'a', revision: 1 });
    saves.markDirty({ project: { ...project, title: 'pagehide latest' }, activationId: 'a', revision: 2 });

    expect(saves.flushSynchronously()).toMatchObject({
      ok: true,
      value: { clean: false, persistedRevision: 0, recoveryReceipt: { revision: 2 } },
    });
    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'pagehide latest' }, recoveryReason: 'recovery-journal' },
    });
    expect(storage.getItem(projectHeadKey(project.id))).toBeNull();
  });

  it('never pretends an async-only repository was synchronously flushed', () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({ projectId: project.id, activationId: 'a', persistedRevision: 0, headVersion: null });
    saves.markDirty({ project, activationId: 'a', revision: 1 });

    expect(saves.flushSynchronously()).toMatchObject({
      ok: false,
      error: { code: 'sync-unsupported' },
    });
    expect(repository.requests).toHaveLength(0);
    expect(saves.isDirty()).toBe(true);
  });

  it('permanently seals before waiting for an in-flight physical save', async () => {
    const repository = new DeferredRecoveryRepository(new TestStorage());
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project, activationId: 'a', revision: 1 });
    void saves.flush();
    await vi.waitFor(() => expect(repository.requests).toHaveLength(1));
    saves.markDirty({
      project: { ...project, title: 'must be discarded' },
      activationId: 'a',
      revision: 2,
    });

    let settled = false;
    const sealing = saves.sealAndWait().then(() => {
      settled = true;
    });

    expect(saves.markDirty({ project, activationId: 'a', revision: 3 })).toBe(false);
    expect(saves.activate({
      projectId: project.id,
      activationId: 'new',
      persistedRevision: 0,
      headVersion: null,
    })).toBe(false);
    expect(saves.flushSynchronously()).toMatchObject({
      ok: false,
      error: { code: 'write-failed' },
    });
    expect(repository.recoveryRequests).toHaveLength(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    const first = repository.requests[0];
    if (!first) throw new Error('request missing');
    repository.saves[0]?.resolve(receipt(first, 1));
    await sealing;

    expect(settled).toBe(true);
    expect(repository.requests.map((request) => request.revision)).toEqual([1]);
    expect(saves.isDirty()).toBe(false);
    await expect(saves.flush()).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    await expect(saves.cancelAndWait(project.id, 'a')).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
  });

  it('drops pending work and returns the same permanent seal promise without I/O or reload', async () => {
    const repository = new DeferredRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project, activationId: 'a', revision: 1 });

    const first = saves.sealAndWait();
    const second = saves.sealAndWait();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(repository.requests).toHaveLength(0);
    expect(repository.loads).toBe(0);
    expect(saves.isDirty()).toBe(false);
    expect(saves.markDirty({ project, activationId: 'a', revision: 2 })).toBe(false);
  });

  it('stays permanently sealed when an earlier cancellation reconciliation settles later', async () => {
    const repository = new DeferredLoadRepository();
    const saves = coordinator(repository);
    const project = makeProject();
    saves.activate({
      projectId: project.id,
      activationId: 'a',
      persistedRevision: 0,
      headVersion: null,
    });
    saves.markDirty({ project, activationId: 'a', revision: 1 });

    const cancellation = saves.cancelAndWait(project.id, 'a');
    await vi.waitFor(() => expect(repository.loads).toBe(1));
    await expect(saves.sealAndWait()).resolves.toBeUndefined();
    repository.pendingLoad.resolve({ ok: true, value: null });

    await expect(cancellation).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(saves.activate({
      projectId: project.id,
      activationId: 'new',
      persistedRevision: 0,
      headVersion: null,
    })).toBe(false);
    expect(saves.markDirty({ project, activationId: 'a', revision: 2 })).toBe(false);
    await expect(saves.flush()).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
  });
});
