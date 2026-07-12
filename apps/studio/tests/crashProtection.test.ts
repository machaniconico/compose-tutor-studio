import { describe, expect, it, vi } from 'vitest';
import { encodeProjectJson } from '@cts/project-model';
import {
  MemoryProjectRepository,
  type CrashDraftReceipt,
  type RepositoryResult,
  type SaveRequest,
} from '@cts/project-persistence';
import { createStudioStore } from '../src/state/store';

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

class DeferredCrashRepository extends MemoryProjectRepository {
  readonly draftRequests: SaveRequest[] = [];
  readonly drafts: Array<Deferred<RepositoryResult<CrashDraftReceipt>>> = [];
  canonicalSaveCount = 0;

  stageCrashDraft(request: SaveRequest): Promise<RepositoryResult<CrashDraftReceipt>> {
    this.draftRequests.push(request);
    const pending = deferred<RepositoryResult<CrashDraftReceipt>>();
    this.drafts.push(pending);
    return pending.promise;
  }

  override async save(request: SaveRequest) {
    this.canonicalSaveCount += 1;
    return super.save(request);
  }
}

function protectedReceipt(request: SaveRequest): RepositoryResult<CrashDraftReceipt> {
  const encoded = encodeProjectJson(request.project);
  if (!encoded.ok) throw new Error('fixture project must encode');
  return {
    ok: true,
    value: {
      projectId: request.project.id,
      activationId: request.activationId,
      revision: request.revision,
      writeId: request.writeId,
      protectedAt: '2026-07-11T00:00:00.000Z',
      bytes: encoded.bytes,
    },
  };
}

describe('native crash protection status', () => {
  it('acknowledges a draft before the canonical debounce fires', async () => {
    const repository = new DeferredCrashRepository();
    const store = createStudioStore(repository);

    store.getState().setTitle('Protected before debounce');
    expect(store.getState().saveState).toMatchObject({
      phase: 'pending',
      revision: 1,
      protectedRevision: -1,
      crashProtectionAvailable: true,
      protectionFailed: false,
    });
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));
    expect(repository.canonicalSaveCount).toBe(0);
    const request = repository.draftRequests[0];
    if (!request) throw new Error('draft request missing');
    repository.drafts[0]?.resolve(protectedReceipt(request));

    await vi.waitFor(() =>
      expect(store.getState().saveState).toMatchObject({
        phase: 'pending',
        protectedRevision: 1,
        protectionFailed: false,
      }),
    );
    expect(repository.canonicalSaveCount).toBe(0);

    await expect(store.getState().flushPendingSave()).resolves.toBe(true);
    expect(store.getState().saveState).toMatchObject({
      phase: 'saved',
      persistedRevision: 1,
      protectedRevision: 1,
    });
  });

  it('surfaces protection failure and clears it after a canonical retry', async () => {
    const repository = new DeferredCrashRepository();
    const store = createStudioStore(repository);

    store.getState().setTitle('Protection failure');
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));
    repository.drafts[0]?.resolve({
      ok: false,
      error: {
        operation: 'save',
        code: 'write-failed',
        retry: 'automatic',
        projectId: store.getState().project.id,
      },
    });
    await vi.waitFor(() =>
      expect(store.getState().saveState).toMatchObject({
        phase: 'error',
        protectionFailed: true,
        failure: 'write-failed',
      }),
    );

    await expect(store.getState().saveToLocalStorage()).resolves.toBe(true);
    expect(store.getState().saveState).toMatchObject({
      phase: 'saved',
      persistedRevision: 1,
      protectedRevision: 1,
      protectionFailed: false,
      failure: null,
    });
  });

  it('does not announce a protection failure after the same revision saved canonically', async () => {
    const repository = new DeferredCrashRepository();
    const store = createStudioStore(repository);
    const observedProtectionFailures: boolean[] = [];
    const unsubscribe = store.subscribe((state) => {
      if (state.saveState.protectionFailed) observedProtectionFailures.push(true);
    });

    store.getState().setTitle('Canonical wins the race');
    await vi.waitFor(() => expect(repository.draftRequests).toHaveLength(1));
    const saving = store.getState().saveToLocalStorage();
    await vi.waitFor(() => expect(repository.canonicalSaveCount).toBe(1));
    repository.drafts[0]?.resolve({
      ok: false,
      error: {
        operation: 'save',
        code: 'conflict',
        retry: 'manual',
        projectId: store.getState().project.id,
      },
    });

    await expect(saving).resolves.toBe(true);
    expect(observedProtectionFailures).toEqual([]);
    expect(store.getState().saveState).toMatchObject({
      phase: 'saved',
      persistedRevision: 1,
      protectedRevision: 1,
      protectionFailed: false,
      failure: null,
    });
    unsubscribe();
  });
});
