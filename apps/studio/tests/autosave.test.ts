import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalStorageProjectRepository,
  projectHeadKey,
  projectRecoveryKey,
  type ProjectLockManager,
} from '@cts/project-persistence';
import type { StudioStore } from '../src/state/store';
import { createStudioStore } from '../src/state/store';
import { createBrowserProjectRepository } from '../src/state/persistence';
import { registerPersistenceLifecycle } from '../src/state/persistenceLifecycle';
import { MemoryStorage } from './localStorageStub';

class RecordingStorage extends MemoryStorage {
  writeAttempts = 0;
  successfulWrites = 0;
  generationWrites = 0;
  headWrites = 0;
  legacyWrites = 0;
  failureName: string | null = null;

  override setItem(key: string, value: string): void {
    this.writeAttempts += 1;
    if (this.failureName) {
      throw Object.assign(new Error('storage write failed'), { name: this.failureName });
    }
    super.setItem(key, value);
    this.successfulWrites += 1;
    if (key.includes('.gen.')) this.generationWrites += 1;
    else if (key.endsWith('.head')) this.headWrites += 1;
    else if (key.startsWith('cts.project.')) this.legacyWrites += 1;
  }
}

class VisibilityTarget extends EventTarget {
  visibilityState = 'visible';
}

/** Holds only the first granted lock after its synchronous commit has finished. */
class DeferredFirstLockCompletion implements ProjectLockManager {
  private releaseFirst: (() => void) | null = null;
  private calls = 0;

  async request<T>(
    _name: string,
    _options: Readonly<{ mode: 'exclusive'; signal?: AbortSignal }>,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.calls += 1;
    const result = await callback();
    if (this.calls === 1) {
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    return result;
  }

  release(): void {
    this.releaseFirst?.();
    this.releaseFirst = null;
  }
}

let storage: RecordingStorage;
let store: StudioStore;
let repository: ReturnType<typeof createBrowserProjectRepository>;

function storedProject(id: string): { id: string; title: string; bpm: number } | null {
  const raw = storage.getItem(`cts.project.${id}`);
  return raw ? (JSON.parse(raw) as { id: string; title: string; bpm: number }) : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  storage = new RecordingStorage();
  repository = createBrowserProjectRepository(storage);
  store = createStudioStore(repository);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('durable autosave', () => {
  it('saves the exact latest snapshot after the two-second idle debounce', async () => {
    const id = store.getState().project.id;

    store.getState().setTitle('編集中');
    expect(store.getState().saveState.phase).toBe('pending');
    expect(storage.writeAttempts).toBe(0);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(storage.writeAttempts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(storage.generationWrites).toBe(1);
    expect(storage.headWrites).toBe(1);
    expect(storage.legacyWrites).toBe(1);
    expect(storedProject(id)?.title).toBe('編集中');
    expect(store.getState().saveState).toMatchObject({
      phase: 'saved',
      failure: null,
      persistedRevision: 1,
    });
  });

  it('reschedules idle debounce and never commits an older edit', async () => {
    const id = store.getState().project.id;
    store.getState().setTitle('古い編集');
    await vi.advanceTimersByTimeAsync(1_000);
    store.getState().setTitle('最新の編集');
    await vi.advanceTimersByTimeAsync(1_999);

    expect(storage.headWrites).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.headWrites).toBe(1);
    expect(storedProject(id)?.title).toBe('最新の編集');
  });

  it('saves within the 30-second max wait during continuous editing', async () => {
    const id = store.getState().project.id;
    store.getState().setTitle('編集 0');

    for (let second = 1; second < 30; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      store.getState().setTitle(`編集 ${second}`);
    }
    await vi.advanceTimersByTimeAsync(999);
    expect(storage.headWrites).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(storage.headWrites).toBe(1);
    expect(storedProject(id)?.title).toBe('編集 29');
  });

  it('keeps quota failures visible and starts a fresh debounce after a new edit', async () => {
    storage.failureName = 'QuotaExceededError';
    store.getState().setTitle('保存失敗 1');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(storage.writeAttempts).toBe(1);
    expect(store.getState().saveState).toMatchObject({
      phase: 'error',
      failure: 'quota-exceeded',
      retry: 'manual',
    });
    store.getState().setTitle('失敗後の編集');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(storage.writeAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.writeAttempts).toBe(2);
  });

  it('clamps out-of-range BPM before it can poison persistence', async () => {
    const id = store.getState().project.id;
    store.getState().setBpm(301);
    expect(store.getState().project.bpm).toBe(300);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(storedProject(id)?.bpm).toBe(300);
    expect(store.getState().saveState).toMatchObject({ phase: 'saved', failure: null });
  });

  it('manual save cancels old debounce/max-wait timers', async () => {
    store.getState().setTitle('手動保存');

    await expect(store.getState().saveToLocalStorage()).resolves.toBe(true);
    expect(storage.headWrites).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(storage.headWrites).toBe(1);
  });

  it('flushes new work created between visibilitychange and pagehide', async () => {
    const deferredLock = new DeferredFirstLockCompletion();
    repository = new LocalStorageProjectRepository({
      storage,
      retainGenerations: 3,
      lockManager: deferredLock,
    });
    store = createStudioStore(repository);
    const page = new EventTarget();
    const visibilityDoc = new VisibilityTarget();
    const cleanup = registerPersistenceLifecycle(
      {
        flushAsync: () => store.getState().flushPendingSave(),
        flushSynchronously: () => store.getState().flushPendingSaveSynchronously(),
        hasUnsavedChanges: () => store.getState().saveState.phase !== 'saved',
      },
      page,
      visibilityDoc,
    );
    const id = store.getState().project.id;

    store.getState().setTitle('非表示化前');
    visibilityDoc.visibilityState = 'hidden';
    visibilityDoc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(storedProject(id)?.title).toBe('非表示化前'));

    store.getState().setTitle('pagehide 前の追加編集');
    page.dispatchEvent(new Event('pagehide'));
    const recoveryJournal = JSON.parse(
      storage.getItem(projectRecoveryKey(id, store.getState().saveState.activationId)) ?? 'null',
    ) as {
      predecessorWriteId?: string;
    } | null;
    const committedHead = JSON.parse(storage.getItem(projectHeadKey(id)) ?? 'null') as {
      operationId?: string;
    } | null;
    expect(recoveryJournal?.predecessorWriteId).toBe(committedHead?.operationId);
    const recovered = await repository.load(id);
    expect(recovered.ok && recovered.value?.project.title).toBe('pagehide 前の追加編集');
    expect(recovered.ok && recovered.value?.recoveryReason).toBe('recovery-journal');
    // The in-flight canonical head is never overtaken by pagehide.
    expect(storage.headWrites).toBe(1);
    deferredLock.release();
    await vi.waitFor(() => expect(store.getState().saveState.phase).toBe('saved'));
    cleanup();
  });

  it('flushes project A before creating project B', async () => {
    await expect(store.getState().createNewProject('A')).resolves.toBe(true);
    const projectA = store.getState().project.id;
    store.getState().setTitle('A の最新編集');

    await expect(store.getState().createNewProject('B')).resolves.toBe(true);

    expect(store.getState().project.title).toBe('B');
    expect(storedProject(projectA)?.title).toBe('A の最新編集');
  });

  it('flushes before loading even when reloading the active project', async () => {
    await store.getState().createNewProject('A');
    const projectA = store.getState().project.id;
    store.getState().setTitle('A の最新編集');

    await expect(store.getState().loadProjectById(projectA)).resolves.toBe(true);

    expect(store.getState().project.title).toBe('A の最新編集');
    expect(storedProject(projectA)?.title).toBe('A の最新編集');
  });

  it('blocks project switching when the latest snapshot cannot be saved', async () => {
    await store.getState().createNewProject('A');
    const projectA = store.getState().project.id;
    store.getState().setTitle('失ってはいけない編集');
    storage.failureName = 'QuotaExceededError';

    await expect(store.getState().createNewProject('B')).resolves.toBe(false);
    expect(store.getState().project.id).toBe(projectA);
    expect(store.getState().project.title).toBe('失ってはいけない編集');
    expect(store.getState().saveState).toMatchObject({
      phase: 'error',
      failure: 'quota-exceeded',
    });

    storage.failureName = null;
    await expect(store.getState().createNewProject('B')).resolves.toBe(true);
    expect(storedProject(projectA)?.title).toBe('失ってはいけない編集');
    expect(store.getState().project.title).toBe('B');
  });

  it('keeps a newly activated project visible and explicitly unsaved when its first write fails', async () => {
    await expect(store.getState().createNewProject('保存済み A')).resolves.toBe(true);
    const savedId = store.getState().project.id;
    storage.failureName = 'QuotaExceededError';

    await expect(store.getState().createNewProject('未保存 B')).resolves.toBe(true);

    expect(store.getState().project.title).toBe('未保存 B');
    expect(store.getState().project.id).not.toBe(savedId);
    expect(store.getState().saveState).toMatchObject({
      phase: 'error',
      failure: 'quota-exceeded',
      persistedRevision: -1,
    });
    expect(storedProject(savedId)?.title).toBe('保存済み A');
  });

  it('retries the newest snapshot after a visible failure', async () => {
    const id = store.getState().project.id;
    storage.failureName = 'QuotaExceededError';
    store.getState().setTitle('保存失敗 1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getState().saveState.phase).toBe('error');

    store.getState().setTitle('保存失敗後の最新編集');
    expect(store.getState().saveState.phase).toBe('error');
    storage.failureName = null;
    await expect(store.getState().saveToLocalStorage()).resolves.toBe(true);

    expect(store.getState().saveState).toMatchObject({ phase: 'saved', failure: null });
    expect(storedProject(id)?.title).toBe('保存失敗後の最新編集');
  });

  it('does not resurrect an actively deleted project from a pending timer', async () => {
    await store.getState().createNewProject('削除対象');
    const deletedId = store.getState().project.id;
    store.getState().setTitle('削除直前の編集');

    await expect(store.getState().deleteProject(deletedId)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(storage.getItem(`cts.project.${deletedId}`)).toBeNull();
    expect(store.getState().project.id).not.toBe(deletedId);
  });

  it('keeps the active pending save when deleting a different project', async () => {
    await store.getState().createNewProject('A');
    const projectA = store.getState().project.id;
    await store.getState().createNewProject('B');
    const projectB = store.getState().project.id;
    store.getState().setTitle('B の最新編集');

    await expect(store.getState().deleteProject(projectA)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(storedProject(projectB)?.title).toBe('B の最新編集');
  });

  it('stamps undo and redo as new edits instead of restoring old timestamps', async () => {
    await store.getState().createNewProject('履歴');
    await vi.advanceTimersByTimeAsync(1_000);
    store.getState().setBpm(140);
    const editedAt = store.getState().project.updatedAt;

    await vi.advanceTimersByTimeAsync(1_000);
    store.getState().undo();
    const undoneAt = store.getState().project.updatedAt;
    expect(Date.parse(undoneAt)).toBeGreaterThan(Date.parse(editedAt));

    await vi.advanceTimersByTimeAsync(1_000);
    store.getState().redo();
    expect(Date.parse(store.getState().project.updatedAt)).toBeGreaterThan(Date.parse(undoneAt));
  });
});
