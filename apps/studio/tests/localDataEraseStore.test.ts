import { describe, expect, it, vi } from 'vitest';
import {
  MemoryProjectRepository,
  type RecoveryReceipt,
  type RepositoryResult,
  type SaveReceipt,
  type SaveRequest,
} from '@cts/project-persistence';
import {
  createStudioStore,
} from '../src/state/store';
import { createNativeLifecycleGate } from '../src/platform/nativeLifecycleGate';

const ERASE_ID = 'erase-12345678-1234-4234-9234-123456789abc';

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

class DeferredSaveRepository extends MemoryProjectRepository {
  pendingRequest: SaveRequest | null = null;
  private gate: Deferred<RepositoryResult<SaveReceipt>> | null = null;

  override save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    this.pendingRequest = request;
    this.gate = deferred<RepositoryResult<SaveReceipt>>();
    return this.gate.promise;
  }

  release(): void {
    const request = this.pendingRequest;
    const gate = this.gate;
    if (!request || !gate) throw new Error('no pending save');
    void super.save(request).then((result) => gate.resolve(result));
    this.pendingRequest = null;
    this.gate = null;
  }
}

class RecoveryRecordingRepository extends MemoryProjectRepository {
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
        savedAt: '2026-07-11T00:00:00.000Z',
        bytes: 1,
      },
    };
  }
}

function eraseDependencies(calls: string[] = []) {
  const dependencies = {
    createEraseId: vi.fn(() => ERASE_ID),
    fenceWrites: vi.fn(() => calls.push('fence')),
    gateway: {
      getStatus: vi.fn(async () => ({ state: 'idle' as const })),
      prepare: vi.fn(async (eraseId: string) => {
        calls.push(`prepare:${eraseId}`);
        return { eraseId, nativeDataRemoved: true as const };
      }),
      complete: vi.fn(async (eraseId: string) => {
        calls.push(`complete:${eraseId}`);
      }),
    },
    clearRendererData: vi.fn(async () => {
      calls.push('clear');
    }),
    finishClose: vi.fn(async () => {
      calls.push('finish');
      return true;
    }),
  };
  return dependencies;
}

describe('Studio local-data erase orchestration', () => {
  it('permanently quiesces before native prepare and runs the strict destructive order', async () => {
    const calls: string[] = [];
    const dependencies = eraseDependencies(calls);
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });
    const phases: string[] = [];
    store.subscribe((state, previous) => {
      if (state.localDataErase.phase !== previous.localDataErase.phase) {
        phases.push(state.localDataErase.phase);
      }
    });
    const originalTitle = store.getState().project.title;
    dependencies.gateway.prepare = vi.fn(async (eraseId: string) => {
      calls.push(`prepare:${eraseId}`);
      store.getState().setTitle('must be blocked before prepare');
      expect(store.getState().project.title).toBe(originalTitle);
      expect(store.getState().flushPendingSaveSynchronously()).toBe(false);
      return { eraseId, nativeDataRemoved: true as const };
    });

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(true);

    expect(calls).toEqual([
      'fence',
      `prepare:${ERASE_ID}`,
      'clear',
      `complete:${ERASE_ID}`,
      'finish',
    ]);
    expect(phases).toEqual([
      'quiescing',
      'native-pending',
      'renderer-clearing',
      'erase-close-pending',
      'erase-close-accepted',
    ]);
    expect(store.getState()).toMatchObject({
      projectOperationBusy: true,
      transport: { isPlaying: false },
      localDataErase: { phase: 'erase-close-accepted', eraseId: ERASE_ID },
    });
    await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
    expect(dependencies.gateway.prepare).toHaveBeenCalledOnce();
    expect(dependencies.gateway.complete).toHaveBeenCalledOnce();
    expect(dependencies.finishClose).toHaveBeenCalledOnce();
    expect(dependencies.finishClose).toHaveBeenCalledWith({
      kind: 'erase',
      eraseId: ERASE_ID,
    });
    await expect(store.getState().saveToLocalStorage()).resolves.toBe(false);
  });

  it('waits for physical in-flight save settlement before native prepare', async () => {
    const calls: string[] = [];
    const repository = new DeferredSaveRepository();
    const dependencies = eraseDependencies(calls);
    const store = createStudioStore(repository, { localDataErase: dependencies });
    store.getState().setTitle('in flight');
    const saving = store.getState().saveToLocalStorage();
    await vi.waitFor(() => expect(repository.pendingRequest).not.toBeNull());

    const erasing = store.getState().eraseAllLocalData();
    await Promise.resolve();
    expect(calls).toEqual(['fence']);

    repository.release();
    await saving;
    await expect(erasing).resolves.toBe(true);
    expect(calls[1]).toBe(`prepare:${ERASE_ID}`);
  });

  it('reuses one erase id across a failed prepare and retry while editing stays sealed', async () => {
    const calls: string[] = [];
    const dependencies = eraseDependencies(calls);
    const prepare = vi
      .fn<(eraseId: string) => Promise<{ eraseId: string; nativeDataRemoved: true }>>()
      .mockRejectedValueOnce(new Error('prepare failed'))
      .mockImplementationOnce(async (eraseId) => ({ eraseId, nativeDataRemoved: true }));
    dependencies.gateway.prepare = prepare;
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      projectOperationBusy: true,
      localDataErase: { phase: 'failed', eraseId: ERASE_ID },
    });
    const title = store.getState().project.title;
    store.getState().setTitle('must remain sealed');
    expect(store.getState().project.title).toBe(title);

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(true);
    expect(dependencies.createEraseId).toHaveBeenCalledOnce();
    expect(prepare.mock.calls).toEqual([[ERASE_ID], [ERASE_ID]]);
  });

  it.each(['prepare', 'clear', 'complete'] as const)(
    'does not run any later boundary after %s failure',
    async (failure) => {
      const calls: string[] = [];
      const dependencies = eraseDependencies(calls);
      if (failure === 'prepare') {
        dependencies.gateway.prepare = vi.fn(async () => {
          calls.push('prepare');
          throw new Error('failed');
        });
      } else if (failure === 'clear') {
        dependencies.clearRendererData = vi.fn(async () => {
          calls.push('clear');
          throw new Error('failed');
        });
      } else {
        dependencies.gateway.complete = vi.fn(async () => {
          calls.push('complete');
          throw new Error('failed');
        });
      }
      const store = createStudioStore(new MemoryProjectRepository(), {
        localDataErase: dependencies,
      });

      await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
      expect(store.getState().localDataErase.phase).toBe('failed');
      if (failure === 'prepare') {
        expect(dependencies.clearRendererData).not.toHaveBeenCalled();
        expect(dependencies.gateway.complete).not.toHaveBeenCalled();
      }
      if (failure === 'clear') expect(dependencies.gateway.complete).not.toHaveBeenCalled();
      expect(dependencies.finishClose).not.toHaveBeenCalled();
    },
  );

  it.each(['false', 'reject', 'timeout'] as const)(
    'treats a dispatched finish-close %s result as terminal and never retries IPC',
    async (outcome) => {
      const dependencies = eraseDependencies();
      dependencies.finishClose =
        outcome === 'false'
          ? vi.fn(async () => false)
          : outcome === 'reject'
            ? vi.fn(async () => {
                throw new Error('response lost');
              })
            : vi.fn(() => new Promise<boolean>(() => undefined));
      const store = createStudioStore(new MemoryProjectRepository(), {
        localDataErase: {
          ...dependencies,
          closeHandoffTimeoutMs: 5,
        },
      });

      await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
      expect(store.getState().localDataErase).toMatchObject({
        phase: 'erase-close-unknown',
        eraseId: ERASE_ID,
        message: expect.stringContaining('応答を確認できませんでした'),
      });
      await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);

      expect(dependencies.gateway.prepare).toHaveBeenCalledOnce();
      expect(dependencies.clearRendererData).toHaveBeenCalledOnce();
      expect(dependencies.gateway.complete).toHaveBeenCalledOnce();
      expect(dependencies.finishClose).toHaveBeenCalledOnce();
    },
  );

  it('rejects while a project operation is active before fencing or sealing', async () => {
    const dependencies = eraseDependencies();
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });
    store.setState({ projectOperationBusy: true });

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
    expect(store.getState().localDataErase).toEqual({
      phase: 'idle',
      eraseId: null,
      message: null,
    });
    expect(dependencies.fenceWrites).not.toHaveBeenCalled();
    expect(dependencies.gateway.prepare).not.toHaveBeenCalled();

    store.setState({ projectOperationBusy: false });
    store.getState().setTitle('still editable');
    expect(store.getState().project.title).toBe('still editable');
  });

  it('prevents pagehide recovery from recreating data after the synchronous seal', async () => {
    const repository = new RecoveryRecordingRepository();
    const dependencies = eraseDependencies();
    const prepareGate = deferred<void>();
    dependencies.gateway.prepare = vi.fn(async (eraseId: string) => {
      await prepareGate.promise;
      return { eraseId, nativeDataRemoved: true as const };
    });
    const store = createStudioStore(repository, { localDataErase: dependencies });
    store.getState().setTitle('queued before erase');

    const erasing = store.getState().eraseAllLocalData();
    expect(store.getState().flushPendingSaveSynchronously()).toBe(false);
    expect(repository.recoveryRequests).toHaveLength(0);
    prepareGate.resolve();
    await expect(erasing).resolves.toBe(true);
    expect(repository.recoveryRequests).toHaveLength(0);
  });

  it('fails before the one-way seal when secure erase id generation is unavailable', async () => {
    const dependencies = {
      ...eraseDependencies(),
      createEraseId: vi.fn(() => null),
    };
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
    expect(store.getState().localDataErase).toMatchObject({
      phase: 'idle',
      eraseId: null,
      message: expect.stringContaining('安全な消去ID'),
    });
    expect(store.getState().projectOperationBusy).toBe(false);
    expect(dependencies.fenceWrites).not.toHaveBeenCalled();
    expect(dependencies.gateway.prepare).not.toHaveBeenCalled();
  });

  it('rejects erase synchronously when normal close claimed lifecycle first', async () => {
    const gate = createNativeLifecycleGate();
    expect(gate.tryClaimNormalClose()).toBe(true);
    const dependencies = {
      ...eraseDependencies(),
      tryClaimErase: () => gate.tryClaimErase(),
    };
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      projectOperationBusy: false,
      localDataErase: { phase: 'idle', eraseId: null },
    });
    expect(store.getState().localDataErase.message).toContain('終了処理が進行中');
    expect(dependencies.fenceWrites).not.toHaveBeenCalled();
    expect(dependencies.gateway.prepare).not.toHaveBeenCalled();

    gate.releaseNormalClose();
    await expect(store.getState().eraseAllLocalData()).resolves.toBe(true);
    expect(gate.owner()).toBe('erase');
  });

  it('seals editing and erase retry when the final normal-close response is unknown', async () => {
    const dependencies = eraseDependencies();
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });
    const originalTitle = store.getState().project.title;

    store.getState().markNativeCloseHandoffUnknown();

    expect(store.getState()).toMatchObject({
      projectOperationBusy: true,
      transport: { isPlaying: false },
      localDataErase: {
        phase: 'close-handoff',
        eraseId: null,
        message: expect.stringContaining('データ消去は開始していません'),
      },
    });
    expect(store.getState().localDataErase.message).toContain('応答を確認できませんでした');
    expect(store.getState().localDataErase.message).toContain('OSからアプリを終了');

    await expect(store.getState().eraseAllLocalData()).resolves.toBe(false);
    store.getState().setTitle('must stay blocked');
    expect(store.getState().project.title).toBe(originalTitle);
    expect(dependencies.createEraseId).not.toHaveBeenCalled();
    expect(dependencies.fenceWrites).not.toHaveBeenCalled();
    expect(dependencies.gateway.prepare).not.toHaveBeenCalled();
  });

  it('claims erase synchronously so normal close cannot start afterward', async () => {
    const gate = createNativeLifecycleGate();
    const prepareGate = deferred<void>();
    const dependencies = {
      ...eraseDependencies(),
      tryClaimErase: () => gate.tryClaimErase(),
    };
    dependencies.gateway.prepare = vi.fn(async (eraseId: string) => {
      await prepareGate.promise;
      return { eraseId, nativeDataRemoved: true as const };
    });
    const store = createStudioStore(new MemoryProjectRepository(), {
      localDataErase: dependencies,
    });

    const erasing = store.getState().eraseAllLocalData();
    expect(store.getState().localDataErase.phase).toBe('quiescing');
    expect(gate.owner()).toBe('erase');
    expect(gate.tryClaimNormalClose()).toBe(false);

    prepareGate.resolve();
    await expect(erasing).resolves.toBe(true);
  });
});
