import { describe, expect, it, vi } from 'vitest';
import type {
  LoadedProject,
  ProjectRepository,
  RepositoryResult,
  SaveReceipt,
} from '@cts/project-persistence';
import { createStudioStore } from '../src/state/store';
import { createBrowserProjectRepository } from '../src/state/persistence';
import { createDefaultProject } from '../src/state/defaultProject';
import { MemoryStorage } from './localStorageStub';

function success<T>(value: T): RepositoryResult<T> {
  return { ok: true, value };
}

function recovered(project: ReturnType<typeof createDefaultProject>): LoadedProject {
  return {
    project,
    headVersion: null,
    source: 'generation',
    recovered: true,
    recoveryReason: 'head-missing',
  };
}

describe('async persistence bootstrap', () => {
  it('restores and migrates a legacy project before the store becomes ready', async () => {
    const storage = new MemoryStorage();
    const project = createDefaultProject('旧保存から復元');
    storage.setItem(`cts.project.${project.id}`, JSON.stringify(project));
    const repository = createBrowserProjectRepository(storage);
    const store = createStudioStore(repository);

    expect(store.getState().persistenceReady).toBe(false);
    await store.getState().initializePersistence();

    expect(store.getState()).toMatchObject({
      persistenceReady: true,
      project: { id: project.id, title: '旧保存から復元' },
      persistenceNotice: { kind: 'recovered' },
      saveState: { phase: 'saved' },
    });
    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { recovered: false, project: { title: '旧保存から復元' } },
    });
  });

  it('keeps corrupt entries visible and never silently replaces them', async () => {
    const storage = new MemoryStorage();
    storage.setItem('cts.project.broken-project', '{broken');
    const store = createStudioStore(createBrowserProjectRepository(storage));

    await store.getState().initializePersistence();

    expect(store.getState().persistenceReady).toBe(true);
    expect(store.getState().persistenceNotice).toMatchObject({ kind: 'warning' });
    expect(store.getState().savedProjects).toContainEqual({
      status: 'unreadable',
      id: 'broken-project',
      errorCode: 'corrupt-data',
      branches: [],
    });
    expect(storage.getItem('cts.project.broken-project')).toBe('{broken');
  });

  it('replays a pagehide recovery journal and repairs the canonical head', async () => {
    const storage = new MemoryStorage();
    const repository = createBrowserProjectRepository(storage);
    const base = {
      ...createDefaultProject('保存済み'),
      updatedAt: '2026-07-10T00:00:01.000Z',
    };
    const saved = await repository.save({
      project: base,
      activationId: 'old-activation',
      revision: 1,
      writeId: 'write-1',
      expectedHeadVersion: null,
    });
    if (!saved.ok) throw new Error('fixture save failed');
    const latest = {
      ...base,
      title: '終了直前の編集',
      updatedAt: '2026-07-10T00:00:02.000Z',
    };
    repository.saveRecoverySynchronously({
      project: latest,
      activationId: 'old-activation',
      revision: 2,
      writeId: 'write-2',
      expectedHeadVersion: saved.value.headVersion,
    });
    const store = createStudioStore(repository);

    await store.getState().initializePersistence();

    expect(store.getState().project.title).toBe('終了直前の編集');
    expect(store.getState().persistenceNotice).toMatchObject({ kind: 'recovered' });
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: '終了直前の編集' }, recovered: false },
    });
  });

  it('uses Repair rather than Empty when a native-like repository restores a null head token', async () => {
    const project = createDefaultProject('修復対象');
    const restored = recovered(project);
    const save = vi.fn<ProjectRepository['save']>(async (request) => {
      if (request.expectedHeadVersion !== undefined) {
        return {
          ok: false,
          error: { operation: 'save', code: 'conflict', retry: 'manual', projectId: project.id },
        };
      }
      const receipt: SaveReceipt = {
        projectId: project.id,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        headVersion: '1:active:repair-write',
        savedAt: '2026-07-10T12:00:00.000Z',
        bytes: 1,
        retainedGenerations: 1,
        legacyMirrorWritten: false,
      };
      return success(receipt);
    });
    const repository: ProjectRepository = {
      kind: 'sqlite',
      initialize: async () => success(undefined),
      list: async () => success([]),
      load: async () => success(restored),
      loadMostRecent: async () => success(restored),
      save,
      remove: async () => ({
        ok: false,
        error: { operation: 'remove', code: 'delete-failed', retry: 'manual' },
      }),
      close: async () => success(undefined),
    };
    const store = createStudioStore(repository);

    await store.getState().initializePersistence();

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].expectedHeadVersion).toBeUndefined();
    expect(store.getState().saveState.phase).toBe('saved');
  });

  it('uses Repair when deleting a non-active recovered project with a null head token', async () => {
    const project = createDefaultProject('削除する復旧データ');
    const restored = recovered(project);
    let removed = false;
    const remove = vi.fn<ProjectRepository['remove']>(async (request) => {
      if (request.expectedHeadVersion !== undefined) {
        return {
          ok: false,
          error: { operation: 'remove', code: 'conflict', retry: 'manual', projectId: project.id },
        };
      }
      removed = true;
      return success({
        projectId: project.id,
        deleteId: request.deleteId,
        headVersion: '1:deleted:delete',
        removed: true,
        cleanupComplete: true,
      });
    });
    const repository: ProjectRepository = {
      kind: 'sqlite',
      initialize: async () => success(undefined),
      list: async () =>
        success(
          removed
            ? []
            : [{
                status: 'ready' as const,
                id: project.id,
                title: project.title,
                updatedAt: project.updatedAt,
                recovered: true,
                branches: [],
              }],
        ),
      load: async (id) => success(id === project.id && !removed ? restored : null),
      loadMostRecent: async () => success(null),
      save: async () => ({
        ok: false,
        error: { operation: 'save', code: 'write-failed', retry: 'manual' },
      }),
      remove,
      close: async () => success(undefined),
    };
    const store = createStudioStore(repository);
    await store.getState().initializePersistence();

    await expect(store.getState().deleteProject(project.id)).resolves.toBe(true);

    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]?.[0].expectedHeadVersion).toBeUndefined();
  });

  it('opens a stale tab draft as a fresh copy without overwriting either branch', async () => {
    const storage = new MemoryStorage();
    const repository = createBrowserProjectRepository(storage);
    const base = {
      ...createDefaultProject('共通の保存'),
      updatedAt: '2026-07-10T00:00:01.000Z',
    };
    const saved = await repository.save({
      project: base,
      activationId: 'base-tab',
      revision: 1,
      writeId: 'base-write',
      expectedHeadVersion: null,
    });
    if (!saved.ok) throw new Error('fixture save failed');
    const staleDraft = {
      ...base,
      title: 'タブAの未保存編集',
      updatedAt: '2026-07-10T00:00:02.000Z',
    };
    repository.saveRecoverySynchronously({
      project: staleDraft,
      activationId: 'tab-a',
      revision: 2,
      writeId: 'draft-a',
      expectedHeadVersion: saved.value.headVersion,
    });
    const canonical = {
      ...base,
      title: 'タブBの保存内容',
      updatedAt: '2026-07-10T00:00:03.000Z',
    };
    const savedB = await repository.save({
      project: canonical,
      activationId: 'tab-b',
      revision: 1,
      writeId: 'write-b',
      expectedHeadVersion: saved.value.headVersion,
    });
    if (!savedB.ok) throw new Error('fixture save failed');
    const store = createStudioStore(repository);
    await store.getState().initializePersistence();
    const originalSummary = store
      .getState()
      .savedProjects.find((summary) => summary.id === base.id);
    const branch = originalSummary?.branches[0];
    if (!branch) throw new Error('branch summary missing');

    await expect(store.getState().recoverProjectBranch(base.id, branch.branchId)).resolves.toBe(true);

    const recoveredCopy = store.getState().project;
    expect(recoveredCopy.id).not.toBe(base.id);
    expect(recoveredCopy.title).toContain('タブAの未保存編集');
    expect(store.getState().saveState.phase).toBe('saved');
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'タブBの保存内容' }, recovered: false },
    });
    await expect(repository.loadProjectBranch(base.id, branch.branchId)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'タブAの未保存編集' } },
    });
  });

  it('enters an explicit degraded state when storage is unavailable', async () => {
    const store = createStudioStore(createBrowserProjectRepository(null));

    await store.getState().initializePersistence();

    expect(store.getState()).toMatchObject({
      persistenceReady: true,
      persistenceNotice: null,
      saveState: {
        phase: 'error',
        failure: 'storage-unavailable',
        retry: 'never',
      },
    });
    expect(store.getState().flushPendingSaveSynchronously()).toBe(false);
    expect(store.getState().saveState).toMatchObject({
      phase: 'error',
      failure: 'storage-unavailable',
      retry: 'never',
    });
  });
});
