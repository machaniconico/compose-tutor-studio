import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectRepository,
  ProjectSummary,
  RecoveryReceipt,
  RemoveRequest,
  RepositoryResult,
  SaveRequest,
  SynchronousRecoveryCapability,
} from '@cts/project-persistence';
import {
  registerNativeCloseGuard as registerNativeCloseGuardRaw,
  type NativeCloseGuardActions,
  type NativeCloseGuardOptions,
  type NativeCloseRequestedEvent,
  type NativeCloseWindow,
} from '../src/platform/nativeCloseGuard';
import { createNativeLifecycleGate } from '../src/platform/nativeLifecycleGate';
import { createBrowserProjectRepository } from '../src/state/persistence';
import { createStudioStore } from '../src/state/store';
import { MemoryStorage } from './localStorageStub';

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

class DeferredListRecoveryRepository
  implements ProjectRepository, SynchronousRecoveryCapability
{
  readonly kind = 'local-storage' as const;
  readonly delegate: ReturnType<typeof createBrowserProjectRepository>;
  listPending = false;
  private listGate: Deferred<RepositoryResult<readonly ProjectSummary[]>> | null = null;

  constructor(storage: MemoryStorage) {
    this.delegate = createBrowserProjectRepository(storage);
  }

  initialize() {
    return this.delegate.initialize();
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    if (!this.listGate) return this.delegate.list();
    this.listPending = true;
    return this.listGate.promise;
  }

  load(id: string) {
    return this.delegate.load(id);
  }

  loadMostRecent() {
    return this.delegate.loadMostRecent();
  }

  save(request: SaveRequest) {
    return this.delegate.save(request);
  }

  remove(request: RemoveRequest) {
    return this.delegate.remove(request);
  }

  close() {
    return this.delegate.close();
  }

  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt> {
    return this.delegate.saveRecoverySynchronously(request);
  }

  deferNextList(): void {
    if (this.listGate) throw new Error('list is already deferred');
    this.listGate = deferred<RepositoryResult<readonly ProjectSummary[]>>();
  }

  async releaseList(): Promise<void> {
    const gate = this.listGate;
    if (!gate || !this.listPending) throw new Error('no pending list');
    gate.resolve(await this.delegate.list());
    this.listGate = null;
    this.listPending = false;
  }
}

type TestCloseActions = Omit<NativeCloseGuardActions, 'claimCloseRequest'> &
  Partial<Pick<NativeCloseGuardActions, 'claimCloseRequest'>> &
  Readonly<{
    /** Retained only so pre-hardening fixtures prove these paths are ignored. */
    isDirectCloseSafe?: () => boolean;
    closeRepository?: () => Promise<boolean> | boolean;
  }>;

function registerNativeCloseGuard(
  actions: TestCloseActions,
  options?: NativeCloseGuardOptions,
): Promise<() => void> {
  return registerNativeCloseGuardRaw(
    {
      claimCloseRequest: () => 'close-0000000000000001',
      ...actions,
    },
    options,
  );
}

function closeHarness() {
  let handler:
    | ((event: NativeCloseRequestedEvent) => void | Promise<void>)
    | undefined;
  const unlisten = vi.fn();
  const lifecycleGate = createNativeLifecycleGate();
  const window: NativeCloseWindow = {
    onCloseRequested: vi.fn(async (next) => {
      handler = next;
      return unlisten;
    }),
  };
  return {
    window,
    unlisten,
    lifecycleGate,
    request: async () => {
      const preventDefault = vi.fn();
      if (!handler) throw new Error('close handler was not registered');
      await handler({ preventDefault });
      return preventDefault;
    },
  };
}

describe('registerNativeCloseGuard', () => {
  it('never permits a raw renderer close, even if a stale direct-close predicate is present', async () => {
    const harness = closeHarness();
    const flushAsync = vi.fn(async () => true);
    const flushSynchronously = vi.fn(() => true);
    const closeRepository = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        isDirectCloseSafe: () => true,
        flushAsync,
        flushSynchronously,
        closeRepository,
        finishClose,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const prevented = await harness.request();

    expect(prevented).toHaveBeenCalledOnce();
    expect(flushAsync).toHaveBeenCalledOnce();
    expect(flushSynchronously).not.toHaveBeenCalled();
    expect(closeRepository).not.toHaveBeenCalled();
    expect(finishClose).toHaveBeenCalledWith('close-0000000000000001');
    expect(harness.lifecycleGate.owner()).toBe('normal-close');
  });

  it('fails closed before flushing when Rust did not issue a close request id', async () => {
    const harness = closeHarness();
    const flushAsync = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    const blocked = vi.fn();
    await registerNativeCloseGuard(
      {
        claimCloseRequest: () => null,
        flushAsync,
        flushSynchronously: () => true,
        finishClose,
        onBlocked: blocked,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const prevented = await harness.request();

    expect(prevented).toHaveBeenCalledOnce();
    expect(blocked).toHaveBeenCalledWith('authorization');
    expect(flushAsync).not.toHaveBeenCalled();
    expect(finishClose).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('idle');
  });

  it('prevents native destruction before awaiting, then closes in durability order', async () => {
    const harness = closeHarness();
    const calls: string[] = [];
    const unregister = await registerNativeCloseGuard(
      {
        flushAsync: async () => {
          calls.push('flush');
          return true;
        },
        flushSynchronously: () => {
          calls.push('recovery');
          return true;
        },
        closeRepository: async () => {
          calls.push('repository');
          return true;
        },
        finishClose: async () => {
          calls.push('window');
          return true;
        },
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const prevented = await harness.request();

    expect(prevented).toHaveBeenCalledOnce();
    expect(calls).toEqual(['flush', 'window']);
    expect(unregister).toBe(harness.unlisten);
  });

  it('uses the synchronous journal after an async failure before closing', async () => {
    const harness = closeHarness();
    const calls: string[] = [];
    await registerNativeCloseGuard(
      {
        flushAsync: async () => {
          calls.push('flush');
          return false;
        },
        flushSynchronously: () => {
          calls.push('recovery');
          return true;
        },
        closeRepository: () => {
          calls.push('repository');
          return true;
        },
        finishClose: () => {
          calls.push('window');
          return true;
        },
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    await harness.request();

    expect(calls).toEqual(['flush', 'recovery', 'window']);
  });

  it('rejects an older async flush result and journals an edit accepted during list refresh', async () => {
    const storage = new MemoryStorage();
    const repository = new DeferredListRecoveryRepository(storage);
    const store = createStudioStore(repository);

    const projectId = store.getState().project.id;
    store.getState().setTitle('canonical before list');
    repository.deferNextList();
    const flushing = store.getState().flushPendingSave();
    await vi.waitFor(() => expect(repository.listPending).toBe(true));

    store.getState().setTitle('latest edit during list');
    await repository.releaseList();
    await expect(flushing).resolves.toBe(false);
    expect(store.getState().flushPendingSaveSynchronously()).toBe(true);

    expect(store.getState().saveState).toMatchObject({
      phase: 'pending',
      revision: 2,
      persistedRevision: 1,
      protectedRevision: 2,
    });
    await expect(repository.delegate.load(projectId)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'latest edit during list' },
        recovered: true,
        recoveryReason: 'recovery-journal',
      },
    });
  });

  it('fences Store edits before native close starts and releases the fence on failure', async () => {
    const store = createStudioStore(createBrowserProjectRepository(new MemoryStorage()));
    const harness = closeHarness();
    const blocked = vi.fn();
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        tryFenceEdits: () => store.getState().tryBeginNativeClose(),
        releaseEditFence: () => store.getState().cancelNativeClose(),
        flushAsync: async () => false,
        flushSynchronously: () => false,
        finishClose,
        onBlocked: blocked,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const titleBefore = store.getState().project.title;
    const closing = harness.request();
    await vi.waitFor(() => expect(store.getState().projectOperationBusy).toBe(true));
    store.getState().setTitle('must be fenced');
    expect(store.getState().project.title).toBe(titleBefore);
    await closing;

    expect(blocked).toHaveBeenCalledWith('recovery');
    expect(finishClose).not.toHaveBeenCalled();
    expect(store.getState().projectOperationBusy).toBe(false);
    store.getState().setTitle('editable after blocked close');
    expect(store.getState().project.title).toBe('editable after blocked close');
  });

  it('synchronously finalizes runtime capture before the edit fence and blocks on failure', async () => {
    const harness = closeHarness();
    const order: string[] = [];
    const blocked = vi.fn();
    const claimCloseRequest = vi.fn();
    await registerNativeCloseGuard(
      {
        finalizeRuntimeEdits: () => {
          order.push('finalize');
          return false;
        },
        tryFenceEdits: () => {
          order.push('fence');
          return true;
        },
        claimCloseRequest,
        flushAsync: async () => true,
        flushSynchronously: () => true,
        finishClose: async () => true,
        onBlocked: blocked,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    await harness.request();

    expect(order).toEqual(['finalize']);
    expect(blocked).toHaveBeenCalledWith('runtime-finalization');
    expect(claimCloseRequest).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('idle');
  });

  it('fails closed before native authorization when the Store mutation fence is busy', async () => {
    const harness = closeHarness();
    const claimCloseRequest = vi.fn(async () => 'close-0000000000000002');
    const blocked = vi.fn();
    await registerNativeCloseGuard(
      {
        tryFenceEdits: () => false,
        claimCloseRequest,
        flushAsync: async () => true,
        flushSynchronously: () => true,
        finishClose: async () => true,
        onBlocked: blocked,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    await harness.request();

    expect(blocked).toHaveBeenCalledWith('edit-fence');
    expect(claimCloseRequest).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('idle');
  });

  it('keeps the window open when neither canonical save nor recovery is durable', async () => {
    const harness = closeHarness();
    const blocked = vi.fn();
    const closeRepository = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        flushAsync: async () => false,
        flushSynchronously: () => false,
        closeRepository,
        finishClose,
        onBlocked: blocked,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    await harness.request();

    expect(blocked).toHaveBeenCalledWith('recovery');
    expect(closeRepository).not.toHaveBeenCalled();
    expect(finishClose).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('idle');
    expect(harness.lifecycleGate.tryClaimErase()).toBe(true);
  });

  it('suppresses duplicate close requests while an async flush is in flight', async () => {
    const harness = closeHarness();
    let release!: (value: boolean) => void;
    const flush = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const closeRepository = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        flushAsync: () => flush,
        flushSynchronously: () => true,
        closeRepository,
        finishClose,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const first = harness.request();
    await Promise.resolve();
    const secondPrevented = await harness.request();
    release(true);
    await first;

    expect(secondPrevented).toHaveBeenCalledOnce();
    expect(closeRepository).not.toHaveBeenCalled();
    expect(finishClose).toHaveBeenCalledOnce();
  });

  it('falls back to recovery when the async flush does not settle in time', async () => {
    const harness = closeHarness();
    const recovery = vi.fn(() => true);
    await registerNativeCloseGuard(
      {
        flushAsync: () => new Promise<boolean>(() => undefined),
        flushSynchronously: recovery,
        closeRepository: () => true,
        finishClose: () => true,
      },
      {
        window: harness.window,
        lifecycleGate: harness.lifecycleGate,
        timeoutMs: 5,
      },
    );

    await harness.request();

    expect(recovery).toHaveBeenCalledOnce();
  });

  it('synchronously blocks normal close without touching storage while erase is non-idle', async () => {
    const harness = closeHarness();
    const flushAsync = vi.fn(async () => true);
    const flushSynchronously = vi.fn(() => true);
    const closeRepository = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        isEraseInProgress: () => true,
        flushAsync,
        flushSynchronously,
        closeRepository,
        finishClose,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const prevented = await harness.request();

    expect(prevented).toHaveBeenCalledOnce();
    expect(flushAsync).not.toHaveBeenCalled();
    expect(flushSynchronously).not.toHaveBeenCalled();
    expect(closeRepository).not.toHaveBeenCalled();
    expect(finishClose).not.toHaveBeenCalled();
  });

  it('rechecks erase state after a deferred flush before repository close', async () => {
    const harness = closeHarness();
    const flush = deferred<boolean>();
    let erasing = false;
    const closeRepository = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    const blocked = vi.fn();
    const flushAsync = vi.fn(() => flush.promise);
    await registerNativeCloseGuard(
      {
        isEraseInProgress: () => erasing,
        flushAsync,
        flushSynchronously: vi.fn(() => true),
        closeRepository,
        finishClose,
        onBlocked: blocked,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const closing = harness.request();
    await vi.waitFor(() => expect(flushAsync).toHaveBeenCalledOnce());
    erasing = true;
    flush.resolve(true);
    await closing;

    expect(blocked).toHaveBeenCalledWith('erase');
    expect(closeRepository).not.toHaveBeenCalled();
    expect(finishClose).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('idle');
  });

  it('rechecks erase state after synchronous recovery before repository close', async () => {
    const harness = closeHarness();
    let erasing = false;
    const closeRepository = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        isEraseInProgress: () => erasing,
        flushAsync: async () => false,
        flushSynchronously: () => {
          erasing = true;
          return true;
        },
        closeRepository,
        finishClose,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    await harness.request();

    expect(closeRepository).not.toHaveBeenCalled();
    expect(finishClose).not.toHaveBeenCalled();
  });

  it('rechecks erase state after a deferred native authorization claim', async () => {
    const harness = closeHarness();
    const claimed = deferred<string | null>();
    let erasing = false;
    const flushAsync = vi.fn(async () => true);
    const finishClose = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        isEraseInProgress: () => erasing,
        claimCloseRequest: () => claimed.promise,
        flushAsync,
        flushSynchronously: () => true,
        finishClose,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const closing = harness.request();
    await Promise.resolve();
    erasing = true;
    claimed.resolve('close-0000000000000001');
    await closing;

    expect(flushAsync).not.toHaveBeenCalled();
    expect(finishClose).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('idle');
  });

  it('cannot claim normal close after erase owns the shared lifecycle gate', async () => {
    const harness = closeHarness();
    expect(harness.lifecycleGate.tryClaimErase()).toBe(true);
    const flushAsync = vi.fn(async () => true);
    await registerNativeCloseGuard(
      {
        // Model a stale UI snapshot: the gate remains authoritative.
        isEraseInProgress: () => false,
        flushAsync,
        flushSynchronously: () => true,
        closeRepository: () => true,
        finishClose: () => true,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    await harness.request();

    expect(flushAsync).not.toHaveBeenCalled();
    expect(harness.lifecycleGate.owner()).toBe('erase');
  });

  it('keeps normal-close ownership through the final async handoff', async () => {
    const harness = closeHarness();
    const finish = deferred<boolean>();
    const finishClose = vi.fn(() => finish.promise);
    await registerNativeCloseGuard(
      {
        isEraseInProgress: () => false,
        flushAsync: async () => true,
        flushSynchronously: () => true,
        closeRepository: async () => true,
        finishClose,
      },
      { window: harness.window, lifecycleGate: harness.lifecycleGate },
    );

    const closing = harness.request();
    await vi.waitFor(() => expect(finishClose).toHaveBeenCalledOnce());
    expect(harness.lifecycleGate.owner()).toBe('normal-close');
    expect(harness.lifecycleGate.tryClaimErase()).toBe(false);
    finish.resolve(true);
    await closing;
    expect(harness.lifecycleGate.owner()).toBe('normal-close');
  });

  it('never releases lifecycle after a timed-out final handoff may have been dispatched', async () => {
    const harness = closeHarness();
    const finishClose = vi.fn(() => new Promise<boolean>(() => undefined));
    const blocked = vi.fn();
    await registerNativeCloseGuard(
      {
        isEraseInProgress: () => false,
        flushAsync: async () => true,
        flushSynchronously: () => true,
        closeRepository: async () => true,
        finishClose,
        onBlocked: blocked,
      },
      {
        window: harness.window,
        lifecycleGate: harness.lifecycleGate,
        timeoutMs: 5,
      },
    );

    await harness.request();
    expect(blocked).toHaveBeenCalledWith('window-close');
    expect(harness.lifecycleGate.owner()).toBe('normal-close');
    expect(harness.lifecycleGate.tryClaimErase()).toBe(false);

    await harness.request();
    expect(finishClose).toHaveBeenCalledOnce();
  });
});
