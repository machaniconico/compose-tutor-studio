import { describe, expect, it, vi } from 'vitest';
import {
  MemoryProjectRepository,
  type LoadedProject,
  type ProjectRepository,
  type ProjectSummary,
  type RemoveReceipt,
  type RemoveRequest,
  type RepositoryResult,
  type SaveReceipt,
  type SaveRequest,
} from '@cts/project-persistence';
import type { Project } from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import { createStudioStore } from '../src/state/store';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledRepository implements ProjectRepository {
  readonly kind = 'memory' as const;
  readonly base = new MemoryProjectRepository(
    () => new Date('2026-07-10T12:00:00.000Z'),
  );
  readonly removeRequests: RemoveRequest[] = [];
  rejectInitialize = false;
  initializeCalls = 0;
  rejectLoadId: string | null = null;
  failNextRemove = false;
  pendingLoadId: string | null = null;
  pendingSaveRequest: SaveRequest | null = null;
  lastReleasedSave: RepositoryResult<SaveReceipt> | null = null;
  private loadGate: Deferred<RepositoryResult<LoadedProject | null>> | null = null;
  private saveGate: Deferred<RepositoryResult<SaveReceipt>> | null = null;
  private deferSave = false;

  initialize(): Promise<RepositoryResult<void>> {
    this.initializeCalls += 1;
    return this.rejectInitialize
      ? Promise.reject(new Error('desktop bridge unavailable'))
      : this.base.initialize();
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    return this.base.list();
  }

  load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    if (this.rejectLoadId === id) return Promise.reject(new Error('load bridge rejected'));
    if (this.loadGate && this.pendingLoadId === id) return this.loadGate.promise;
    return this.base.load(id);
  }

  loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    return this.base.loadMostRecent();
  }

  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    if (this.deferSave && !this.saveGate) {
      this.deferSave = false;
      this.pendingSaveRequest = request;
      this.saveGate = deferred<RepositoryResult<SaveReceipt>>();
      return this.saveGate.promise;
    }
    return this.base.save(request);
  }

  remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    this.removeRequests.push(request);
    if (this.failNextRemove) {
      this.failNextRemove = false;
      return Promise.resolve({
        ok: false,
        error: {
          operation: 'remove',
          code: 'delete-failed',
          retry: 'automatic',
          projectId: request.projectId,
        },
      });
    }
    return this.base.remove(request);
  }

  close(): Promise<RepositoryResult<void>> {
    return this.base.close();
  }

  async seed(project: Project): Promise<void> {
    const result = await this.base.save({
      project,
      activationId: `seed-${project.id}`,
      revision: 0,
      writeId: `seed-write-${project.id}`,
      expectedHeadVersion: null,
    });
    if (!result.ok) throw new Error('Failed to seed controlled repository');
  }

  deferLoad(id: string): void {
    this.pendingLoadId = id;
    this.loadGate = deferred<RepositoryResult<LoadedProject | null>>();
  }

  async releaseLoad(): Promise<void> {
    const id = this.pendingLoadId;
    const gate = this.loadGate;
    if (!id || !gate) throw new Error('No deferred load');
    gate.resolve(await this.base.load(id));
    this.pendingLoadId = null;
    this.loadGate = null;
  }

  deferNextSave(): void {
    this.deferSave = true;
  }

  async releaseSave(): Promise<void> {
    const request = this.pendingSaveRequest;
    const gate = this.saveGate;
    if (!request || !gate) throw new Error('No deferred save');
    const result = await this.base.save(request);
    this.lastReleasedSave = result;
    gate.resolve(result);
    this.pendingSaveRequest = null;
    this.saveGate = null;
  }
}

describe('async project persistence races', () => {
  it('blocks edits and manual save while a delayed load owns the project activation', async () => {
    const repository = new ControlledRepository();
    const projectB = createDefaultProject('Project B');
    await repository.seed(projectB);
    const store = createStudioStore(repository);
    await expect(store.getState().createNewProject('Project A')).resolves.toBe(true);
    const projectA = store.getState().project;
    repository.deferLoad(projectB.id);

    const loading = store.getState().loadProjectById(projectB.id);
    await vi.waitFor(() => expect(store.getState().projectOperationBusy).toBe(true));
    expect(repository.pendingLoadId).toBe(projectB.id);

    store.getState().setTitle('must be blocked');
    expect(store.getState().project).toEqual(projectA);
    await expect(store.getState().saveToLocalStorage()).resolves.toBe(false);

    await repository.releaseLoad();
    await expect(loading).resolves.toBe(true);
    expect(store.getState()).toMatchObject({
      projectOperationBusy: false,
      project: { id: projectB.id, title: 'Project B' },
    });

    store.getState().setTitle('Project B edited after activation');
    await expect(store.getState().saveToLocalStorage()).resolves.toBe(true);
    await expect(repository.base.load(projectB.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'Project B edited after activation' } },
    });
  });

  it('deletes an active project against the final head of an in-flight async save', async () => {
    const repository = new ControlledRepository();
    const store = createStudioStore(repository);
    await store.getState().createNewProject('Delete me');
    const deletedId = store.getState().project.id;
    store.getState().setTitle('latest before delete');
    repository.deferNextSave();

    const saving = store.getState().saveToLocalStorage();
    await vi.waitFor(() => expect(repository.pendingSaveRequest?.project.id).toBe(deletedId));
    const deleting = store.getState().deleteProject(deletedId);
    await vi.waitFor(() => expect(store.getState().projectOperationBusy).toBe(true));
    const bpmBeforeBlockedEdit = store.getState().project.bpm;
    store.getState().setBpm(200);
    expect(store.getState().project.bpm).toBe(bpmBeforeBlockedEdit);

    await repository.releaseSave();
    await saving;
    await expect(deleting).resolves.toBe(true);

    expect(repository.lastReleasedSave).toMatchObject({ ok: true });
    const finalHead = repository.lastReleasedSave?.ok
      ? repository.lastReleasedSave.value.headVersion
      : null;
    expect(repository.removeRequests[0]?.expectedHeadVersion).toBe(finalHead);
    await expect(repository.base.load(deletedId)).resolves.toEqual({ ok: true, value: null });
    expect(store.getState().project.id).not.toBe(deletedId);
    expect(store.getState().projectOperationBusy).toBe(false);
  });

  it('reactivates the final saved head after an active deletion fails', async () => {
    const repository = new ControlledRepository();
    const store = createStudioStore(repository);
    await store.getState().createNewProject('Keep me');
    const projectId = store.getState().project.id;
    store.getState().setTitle('saved while delete waits');
    repository.deferNextSave();
    repository.failNextRemove = true;

    const saving = store.getState().saveToLocalStorage();
    await vi.waitFor(() => expect(repository.pendingSaveRequest?.project.id).toBe(projectId));
    const deleting = store.getState().deleteProject(projectId);
    await repository.releaseSave();
    await saving;
    await expect(deleting).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      projectOperationBusy: false,
      project: { id: projectId, title: 'saved while delete waits' },
    });
    store.getState().setTitle('editable after failed delete');
    await expect(store.getState().saveToLocalStorage()).resolves.toBe(true);
    await expect(repository.base.load(projectId)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'editable after failed delete' } },
    });
  });

  it('turns a rejected bootstrap repository promise into an explicit degraded state', async () => {
    const repository = new ControlledRepository();
    repository.rejectInitialize = true;
    const store = createStudioStore(repository);

    await expect(store.getState().initializePersistence()).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({
      persistenceReady: true,
      projectOperationBusy: false,
      persistenceNotice: null,
      saveState: { phase: 'error', failure: 'read-failed', retry: 'automatic' },
    });
  });

  it('retries a failed bootstrap in-process and restores saved data on success', async () => {
    const repository = new ControlledRepository();
    const saved = createDefaultProject('Recovered after initialize retry');
    await repository.seed(saved);
    repository.rejectInitialize = true;
    const store = createStudioStore(repository);

    await store.getState().initializePersistence();
    expect(repository.initializeCalls).toBe(1);
    expect(store.getState().saveState).toMatchObject({ phase: 'error', failure: 'read-failed' });

    repository.rejectInitialize = false;
    await store.getState().initializePersistence();

    expect(repository.initializeCalls).toBe(2);
    expect(store.getState()).toMatchObject({
      persistenceReady: true,
      project: { id: saved.id, title: 'Recovered after initialize retry' },
      saveState: { phase: 'saved' },
    });
  });

  it('routes save retry through initialization without replacing edits made while unavailable', async () => {
    const repository = new ControlledRepository();
    const older = createDefaultProject('Older saved project');
    await repository.seed(older);
    repository.rejectInitialize = true;
    const store = createStudioStore(repository);
    const activeId = store.getState().project.id;

    await store.getState().initializePersistence();
    store.getState().setTitle('Keep this offline edit');
    repository.rejectInitialize = false;

    await expect(store.getState().saveToLocalStorage()).resolves.toBe(true);

    expect(repository.initializeCalls).toBe(2);
    expect(store.getState().project).toMatchObject({
      id: activeId,
      title: 'Keep this offline edit',
    });
    await expect(repository.base.load(activeId)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'Keep this offline edit' } },
    });
    await expect(repository.base.load(older.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'Older saved project' } },
    });
  });

  it('contains a rejected project load and always releases the visible operation lock', async () => {
    const repository = new ControlledRepository();
    const projectB = createDefaultProject('Rejected B');
    await repository.seed(projectB);
    const store = createStudioStore(repository);
    await store.getState().createNewProject('Safe A');
    const activeBefore = store.getState().project;
    repository.rejectLoadId = projectB.id;

    await expect(store.getState().loadProjectById(projectB.id)).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      projectOperationBusy: false,
      project: { id: activeBefore.id, title: activeBefore.title },
      persistenceNotice: { kind: 'warning' },
    });
  });
});
