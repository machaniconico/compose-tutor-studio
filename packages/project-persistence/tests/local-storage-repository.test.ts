import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalStorageProjectRepository,
  legacyProjectKey,
  projectGenerationKey,
  projectHeadKey,
  projectIntentKey,
  projectRecoveryKey,
  type ProjectLockManager,
  type SaveRequest,
} from '../src/index';
import { crc32 } from '../src/checksum';
import { makeProject, TestStorage } from './helpers';

const now = () => new Date('2026-07-10T12:00:00.000Z');

function request(
  project: ReturnType<typeof makeProject>,
  revision: number,
  writeId: string,
  expectedHeadVersion: string | null | undefined,
): SaveRequest {
  return {
    project,
    activationId: 'activation-a',
    revision,
    writeId,
    expectedHeadVersion,
  };
}

function activeGenerationKey(storage: TestStorage, projectId: string): string {
  const raw = storage.getItem(projectHeadKey(projectId));
  if (!raw) throw new Error('head missing');
  const head = JSON.parse(raw) as { generationKey?: string };
  if (!head.generationKey) throw new Error('active generation missing');
  return head.generationKey;
}

class SerialProbeLockManager implements ProjectLockManager {
  readonly calls: Array<{ name: string; mode: string }> = [];
  active = 0;
  maxActive = 0;
  private readonly tails = new Map<string, Promise<void>>();

  async request<T>(
    name: string,
    options: Readonly<{ mode: 'exclusive' }>,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.calls.push({ name, mode: options.mode });
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(name, tail);
    await previous;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await Promise.resolve();
      return await callback();
    } finally {
      this.active -= 1;
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

describe('LocalStorageProjectRepository', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('times out a pending Web Lock request without running the commit later', async () => {
    vi.useFakeTimers();
    const storage = new TestStorage();
    let commitCallback: (() => unknown) | null = null;
    const lockManager: ProjectLockManager = {
      request: (_name, options, callback) =>
        new Promise((_resolve, reject) => {
          commitCallback = callback;
          const abort = () => {
            commitCallback = null;
            reject(Object.assign(new Error('lock wait aborted'), { name: 'AbortError' }));
          };
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        }),
    };
    const repository = new LocalStorageProjectRepository({
      storage,
      now,
      lockManager,
      lockTimeoutMs: 25,
    });
    const project = makeProject('lock-timeout');
    const saving = repository.save(request(project, 1, 'write-timeout', null));

    await vi.advanceTimersByTimeAsync(25);
    await expect(saving).resolves.toMatchObject({
      ok: false,
      error: { code: 'write-failed', retry: 'automatic' },
    });
    expect(storage.getItem(projectHeadKey(project.id))).toBeNull();

    // A conforming Web Locks implementation drops the request on abort, so the
    // queued callback can never become a delayed ghost commit.
    expect(commitCallback).toBeNull();
  });

  it('classifies unavailable and denied storage initialization', async () => {
    const unavailable = new LocalStorageProjectRepository({ storage: null });
    await expect(unavailable.initialize()).resolves.toMatchObject({
      ok: false,
      error: { code: 'storage-unavailable', retry: 'never' },
    });

    const denied = new LocalStorageProjectRepository({
      storage: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      },
    });
    await expect(denied.initialize()).resolves.toMatchObject({
      ok: false,
      error: { code: 'access-denied', retry: 'manual' },
    });
  });

  it('commits a verified generation before head and round-trips it', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('First save');

    const saved = await repository.save(request(project, 1, 'write-1', null));

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value).toMatchObject({
      projectId: project.id,
      revision: 1,
      writeId: 'write-1',
      retainedGenerations: 1,
      legacyMirrorWritten: true,
    });
    expect(storage.getItem(activeGenerationKey(storage, project.id))).not.toBeNull();
    expect(storage.getItem(legacyProjectKey(project.id))).not.toBeNull();

    const loaded = await repository.load(project.id);
    expect(loaded).toEqual({
      ok: true,
      value: {
        project,
        headVersion: saved.value.headVersion,
        source: 'generation',
        recovered: false,
        recoveryReason: null,
      },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          status: 'ready',
          id: project.id,
          title: 'First save',
          recovered: false,
        },
      ],
    });
  });

  it('keeps exactly three verified generations after repeated saves', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now, retainGenerations: 3 });
    const base = makeProject();
    let expected: string | null = null;

    for (let revision = 1; revision <= 6; revision += 1) {
      const project = {
        ...base,
        title: `revision ${revision}`,
        updatedAt: `2026-07-10T00:00:0${revision}.000Z`,
      };
      const saved = await repository.save(request(project, revision, `write-${revision}`, expected));
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expected = saved.value.headVersion;
    }

    const generations = storage.rawKeys().filter((key) => key.includes('.gen.'));
    expect(generations).toHaveLength(3);
    const loaded = await repository.load(base.id);
    expect(loaded.ok && loaded.value?.project.title).toBe('revision 6');
  });

  it('recovers the latest generation when the head is corrupt', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('recover me');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    expect(saved.ok).toBe(true);
    storage.setItem(projectHeadKey(project.id), '{broken');

    const loaded = await repository.load(project.id);

    expect(loaded).toMatchObject({
      ok: true,
      value: {
        project: { title: 'recover me' },
        headVersion: null,
        recovered: true,
        recoveryReason: 'head-corrupt',
      },
    });
  });

  it('recovers the committed payload mirror when the pointed generation is corrupt', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const first = makeProject('good generation', '2026-07-10T00:00:01.000Z');
    const saved1 = await repository.save(request(first, 1, 'write-1', null));
    if (!saved1.ok) throw new Error('fixture save failed');
    const second = { ...first, title: 'corrupt generation', updatedAt: '2026-07-10T00:00:02.000Z' };
    const saved2 = await repository.save(
      request(second, 2, 'write-2', saved1.value.headVersion),
    );
    if (!saved2.ok) throw new Error('fixture save failed');
    storage.setItem(activeGenerationKey(storage, first.id), '{"storageVersion":1}');

    const loaded = await repository.load(first.id);

    expect(loaded).toMatchObject({
      ok: true,
      value: {
        project: { title: 'corrupt generation' },
        headVersion: saved2.value.headVersion,
        source: 'legacy',
        recovered: true,
        recoveryReason: 'generation-corrupt',
      },
    });
  });

  it('never mistakes an uncommitted lower-ordinal sibling for the corrupt committed generation', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    storage.failSet = (key) =>
      key === projectHeadKey(base.id) ? new Error('failed sibling head') : null;
    await repository.save(
      request(
        { ...base, title: 'failed sibling', updatedAt: '2026-07-10T00:00:02.000Z' },
        2,
        'write-2-failed',
        first.value.headVersion,
      ),
    );
    storage.failSet = null;
    const committed = {
      ...base,
      title: 'committed sibling',
      updatedAt: '2026-07-10T00:00:03.000Z',
    };
    const third = await repository.save(
      request(committed, 3, 'write-3-committed', first.value.headVersion),
    );
    if (!third.ok) throw new Error('fixture save failed');
    storage.setItem(activeGenerationKey(storage, base.id), '{corrupt');

    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'committed sibling' },
        source: 'legacy',
        recoveryReason: 'generation-corrupt',
      },
    });
  });

  it('recovers an orphan generation after a head-write failure', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('orphan generation');
    storage.failSet = (key) =>
      key === projectHeadKey(project.id)
        ? Object.assign(new Error('head failed'), { name: 'QuotaExceededError' })
        : null;

    await expect(repository.save(request(project, 1, 'write-orphan', null))).resolves.toMatchObject({
      ok: false,
      error: { code: 'quota-exceeded' },
    });
    storage.failSet = null;

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'orphan generation' },
        recovered: true,
        recoveryReason: 'head-missing',
      },
    });
  });

  it('does not invalidate a verified commit when the legacy mirror fails', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('canonical only');
    storage.failSet = (key) =>
      key === legacyProjectKey(project.id)
        ? Object.assign(new Error('legacy quota'), { name: 'QuotaExceededError' })
        : null;

    const saved = await repository.save(request(project, 1, 'write-1', null));

    expect(saved).toMatchObject({ ok: true, value: { legacyMirrorWritten: false } });
    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'canonical only' } },
    });
  });

  it('replays the exact synchronous recovery journal and clears it after canonical save', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('head', '2026-07-10T00:00:01.000Z');
    const saved = await repository.save(request(base, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    const latest = { ...base, title: 'pagehide latest', updatedAt: '2026-07-10T00:00:02.000Z' };
    const recoveryRequest = request(latest, 2, 'write-2', saved.value.headVersion);

    expect(repository.saveRecoverySynchronously(recoveryRequest)).toMatchObject({
      ok: true,
      value: { revision: 2, writeId: 'write-2' },
    });
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'pagehide latest' },
        recoveryReason: 'recovery-journal',
      },
    });

    const canonical = await repository.save(recoveryRequest);
    expect(canonical.ok).toBe(true);
    expect(storage.getItem(projectRecoveryKey(base.id, 'activation-a'))).toBeNull();
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'pagehide latest' }, recovered: false },
    });
  });

  it('keeps first-save recovery idempotent and lets the same pending save become canonical', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('first pagehide');
    const pending = request(project, 1, 'write-first', null);

    const firstRecovery = repository.saveRecoverySynchronously(pending);
    const recoveryRaw = storage.getItem(projectRecoveryKey(project.id, 'activation-a'));
    const retryRecovery = repository.saveRecoverySynchronously(pending);
    expect(firstRecovery.ok).toBe(true);
    expect(retryRecovery).toEqual(firstRecovery);
    expect(storage.getItem(projectRecoveryKey(project.id, 'activation-a'))).toBe(recoveryRaw);

    expect(
      repository.saveRecoverySynchronously({
        ...pending,
        project: { ...project, title: 'changed same revision' },
        writeId: 'changed-write',
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(storage.getItem(projectRecoveryKey(project.id, 'activation-a'))).toBe(recoveryRaw);

    await expect(repository.save(pending)).resolves.toMatchObject({ ok: true });
    expect(storage.getItem(projectRecoveryKey(project.id, 'activation-a'))).toBeNull();
  });

  it('retains a stale-base emergency write as a branch after another head advances', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    const current = await repository.save(
      {
        ...request({ ...base, title: 'current' }, 1, 'write-current', first.value.headVersion),
        activationId: 'current-tab',
      },
    );
    if (!current.ok) throw new Error('fixture advance failed');

    expect(
      repository.saveRecoverySynchronously({
        ...request({ ...base, title: 'stale draft' }, 2, 'write-stale', first.value.headVersion),
        activationId: 'stale-tab',
      }),
    ).toMatchObject({ ok: true });
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'current' } },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ status: 'ready', branches: [expect.any(Object)] })],
    });
  });

  it('detects optimistic head conflicts before writing a new head', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject();
    const first = await repository.save(request(project, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');

    const conflicting = await repository.save(
      request({ ...project, title: 'stale writer' }, 2, 'write-2', 'stale:head'),
    );

    expect(conflicting).toMatchObject({ ok: false, error: { code: 'conflict', retry: 'manual' } });
    const loaded = await repository.load(project.id);
    expect(loaded.ok && loaded.value?.project.title).toBe(project.title);
  });

  it.each(['missing', 'corrupt'] as const)(
    'distinguishes Empty from Repair for a %s active head',
    async (headState) => {
      const saveStorage = new TestStorage();
      const saveRepository = new LocalStorageProjectRepository({ storage: saveStorage, now });
      const project = makeProject(`repair save ${headState}`);
      const saved = await saveRepository.save(request(project, 1, 'write-1', null));
      if (!saved.ok) throw new Error('fixture save failed');
      if (headState === 'missing') saveStorage.removeItem(projectHeadKey(project.id));
      else saveStorage.setItem(projectHeadKey(project.id), '{corrupt');

      await expect(
        saveRepository.save(request({ ...project, title: 'wrong empty' }, 2, 'write-null', null)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
      await expect(
        saveRepository.save(
          request({ ...project, title: 'repaired' }, 2, 'write-repair', undefined),
        ),
      ).resolves.toMatchObject({ ok: true });

      const removeStorage = new TestStorage();
      const removeRepository = new LocalStorageProjectRepository({ storage: removeStorage, now });
      const removable = makeProject(`repair remove ${headState}`);
      const removableSaved = await removeRepository.save(
        request(removable, 1, 'write-remove', null),
      );
      if (!removableSaved.ok) throw new Error('fixture save failed');
      if (headState === 'missing') removeStorage.removeItem(projectHeadKey(removable.id));
      else removeStorage.setItem(projectHeadKey(removable.id), '{corrupt');

      await expect(
        removeRepository.remove({
          projectId: removable.id,
          deleteId: 'delete-null',
          expectedHeadVersion: null,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
      await expect(
        removeRepository.remove({
          projectId: removable.id,
          deleteId: 'delete-repair',
          expectedHeadVersion: undefined,
        }),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it('accepts Empty only for a truly empty project id', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('empty tri-state');

    await expect(
      repository.save(request(project, 1, 'repair-cannot-create', undefined)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(repository.save(request(project, 1, 'empty-create', null))).resolves.toMatchObject({
      ok: true,
    });
  });

  it('reuses an orphan generation with the same writeId on retry', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('idempotent retry');
    let failHead = true;
    storage.failSet = (key) =>
      failHead && key === projectHeadKey(project.id) ? new Error('head unavailable') : null;
    const saveRequest = request(project, 1, 'stable-write-id', null);
    expect((await repository.save(saveRequest)).ok).toBe(false);
    const before = storage.rawKeys().filter((key) => key.includes('.gen.'));

    failHead = false;
    const retry = await repository.save(saveRequest);
    const after = storage.rawKeys().filter((key) => key.includes('.gen.'));

    expect(retry.ok).toBe(true);
    expect(after).toEqual(before);
  });

  it('returns the original receipt when a committed response is retried', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('response retry');
    const saveRequest = request(project, 1, 'stable-response-id', null);
    const first = await repository.save(saveRequest);
    if (!first.ok) throw new Error('fixture save failed');
    const generationCount = storage.rawKeys().filter((key) => key.includes('.gen.')).length;

    const retry = await repository.save(saveRequest);

    expect(retry).toEqual(first);
    expect(storage.rawKeys().filter((key) => key.includes('.gen.'))).toHaveLength(generationCount);
  });

  it('ignores an uncommitted generation when no matching intent exists', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('committed');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    const committedKey = activeGenerationKey(storage, project.id);
    const committedRaw = storage.getItem(committedKey);
    if (!committedRaw) throw new Error('generation missing');
    const orphan = JSON.parse(committedRaw) as Record<string, unknown>;
    const orphanProject = { ...project, title: 'must not win', updatedAt: '2026-07-10T00:00:02.000Z' };
    orphan.ordinal = 2;
    orphan.writeId = 'conflict-loser';
    orphan.projectJson = JSON.stringify(orphanProject);
    orphan.bytes = new TextEncoder().encode(orphan.projectJson as string).byteLength;
    const { checksum: _checksum, ...content } = orphan;
    orphan.checksum = crc32(JSON.stringify(content));
    storage.setItem(projectGenerationKey(project.id, 2, 'conflict-loser'), JSON.stringify(orphan));

    const loaded = await repository.load(project.id);

    expect(loaded.ok && loaded.value?.project.title).toBe('committed');
    expect(loaded.ok && loaded.value?.recovered).toBe(false);
  });

  it('never falls back to an older generation when the committed head is future schema', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const first = makeProject('old', '2026-07-10T00:00:01.000Z');
    const saved1 = await repository.save(request(first, 1, 'write-1', null));
    if (!saved1.ok) throw new Error('fixture save failed');
    const second = { ...first, title: 'future', updatedAt: '2026-07-10T00:00:02.000Z' };
    const saved2 = await repository.save(request(second, 2, 'write-2', saved1.value.headVersion));
    if (!saved2.ok) throw new Error('fixture save failed');
    const currentKey = activeGenerationKey(storage, first.id);
    const raw = storage.getItem(currentKey);
    if (!raw) throw new Error('generation missing');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.projectJson = JSON.stringify({ ...second, schemaVersion: 999 });
    envelope.bytes = new TextEncoder().encode(envelope.projectJson as string).byteLength;
    const { checksum: _checksum, ...content } = envelope;
    envelope.checksum = crc32(JSON.stringify(content));
    storage.setItem(currentKey, JSON.stringify(envelope));

    await expect(repository.load(first.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
  });

  it('never falls back when an intent-owned interrupted generation has future schema', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('committed old', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    storage.failSet = (key) =>
      key === projectHeadKey(base.id) ? new Error('head failed') : null;
    await repository.save(
      request(
        { ...base, title: 'interrupted', updatedAt: '2026-07-10T00:00:02.000Z' },
        2,
        'write-future-intent',
        first.value.headVersion,
      ),
    );
    storage.failSet = null;
    const key = projectGenerationKey(base.id, 2, 'write-future-intent');
    const raw = storage.getItem(key);
    if (!raw) throw new Error('interrupted generation missing');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.projectJson = JSON.stringify({ ...base, schemaVersion: 999 });
    envelope.bytes = new TextEncoder().encode(envelope.projectJson as string).byteLength;
    const { checksum: _checksum, ...content } = envelope;
    envelope.checksum = crc32(JSON.stringify(content));
    storage.setItem(key, JSON.stringify(envelope));

    const before = new Map(
      storage.rawKeys().map((storageKey) => [storageKey, storage.getItem(storageKey)]),
    );

    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
    await expect(
      repository.save(request({ ...base, title: 'old writer' }, 3, 'write-old', undefined)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    expect(
      repository.saveRecoverySynchronously(
        request({ ...base, title: 'old recovery' }, 3, 'recovery-old', undefined),
      ),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    await expect(
      repository.remove({ projectId: base.id, deleteId: 'delete-old' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    expect(
      new Map(storage.rawKeys().map((storageKey) => [storageKey, storage.getItem(storageKey)])),
    ).toEqual(before);
  });

  it('rejects corrupted generation metadata and recovers the committed mirror', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('metadata');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    const currentKey = activeGenerationKey(storage, project.id);
    const raw = storage.getItem(currentKey);
    if (!raw) throw new Error('generation missing');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.savedAt = '2030-01-01T00:00:00.000Z';
    storage.setItem(currentKey, JSON.stringify(envelope));

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'metadata' },
        source: 'legacy',
        recovered: true,
        recoveryReason: 'generation-corrupt',
      },
    });
  });

  it('commits a tombstone before cleanup so residual generations never resurrect', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('delete me');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    storage.failRemove = (key) => (key.includes('.gen.') ? new Error('cleanup failed') : null);

    const removed = await repository.remove({
      projectId: project.id,
      deleteId: 'delete-1',
      expectedHeadVersion: saved.value.headVersion,
    });

    expect(removed).toMatchObject({
      ok: true,
      value: { removed: true, cleanupComplete: false },
    });
    expect(storage.rawKeys().some((key) => key.includes('.gen.'))).toBe(true);
    await expect(repository.load(project.id)).resolves.toEqual({ ok: true, value: null });
    const listed = await repository.list();
    expect(listed.ok && listed.value).toEqual([]);
  });

  it.each(['missing', 'corrupt'] as const)(
    'does not resurrect through an empty/repair expected head when a verified tombstone has a %s head',
    async (headState) => {
      const storage = new TestStorage();
      const repository = new LocalStorageProjectRepository({ storage, now });
      const project = makeProject(`deleted with ${headState} head`);
      const saved = await repository.save(request(project, 1, 'write-1', null));
      if (!saved.ok) throw new Error('fixture save failed');
      const removed = await repository.remove({
        projectId: project.id,
        deleteId: 'delete-1',
        expectedHeadVersion: saved.value.headVersion,
      });
      if (!removed.ok) throw new Error('fixture remove failed');
      const generationKeys = storage.rawKeys().filter((key) => key.includes('.gen.'));
      expect(generationKeys).toHaveLength(1);

      if (headState === 'missing') storage.removeItem(projectHeadKey(project.id));
      else storage.setItem(projectHeadKey(project.id), '{corrupt');

      await expect(
        repository.save(
          request(
            { ...project, title: 'must not resurrect' },
            2,
            'resurrection-write',
            undefined,
          ),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
      await expect(
        repository.save(
          request(
            { ...project, title: 'must not resurrect with null' },
            2,
            'resurrection-write-null',
            null,
          ),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(storage.rawKeys().filter((key) => key.includes('.gen.'))).toEqual(generationKeys);
    },
  );

  it('makes deletion idempotent and blocks a stale writer from clearing the tombstone', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('deleted');
    const originalRequest = request(project, 1, 'write-1', null);
    const saved = await repository.save(originalRequest);
    if (!saved.ok) throw new Error('fixture save failed');
    const removeRequest = {
      projectId: project.id,
      deleteId: 'delete-stable',
      expectedHeadVersion: saved.value.headVersion,
    } as const;
    const firstDelete = await repository.remove(removeRequest);
    if (!firstDelete.ok) throw new Error('fixture delete failed');

    await expect(repository.remove(removeRequest)).resolves.toEqual(firstDelete);
    await expect(
      repository.save({ ...originalRequest, writeId: 'stale-write', expectedHeadVersion: saved.value.headVersion }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(
      repository.save({ ...originalRequest, writeId: 'repair-write', expectedHeadVersion: undefined }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(
      repository.saveRecoverySynchronously({
        ...originalRequest,
        writeId: 'late-recovery',
        revision: 2,
        expectedHeadVersion: undefined,
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(repository.load(project.id)).resolves.toEqual({ ok: true, value: null });
  });

  it('retries the same first-delete after the tombstone commit but before the head commit', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const projectId = makeProject('first delete retry').id;
    const removeRequest = {
      projectId,
      deleteId: 'delete-first',
      expectedHeadVersion: null,
    } as const;
    storage.failSet = (key) =>
      key === projectHeadKey(projectId) ? new Error('head write interrupted') : null;

    await expect(repository.remove(removeRequest)).resolves.toMatchObject({
      ok: false,
      error: { code: 'delete-failed' },
    });
    expect(storage.getItem(projectIntentKey(projectId))).not.toBeNull();
    expect(storage.rawKeys().some((key) => key.includes('.gen.'))).toBe(true);

    storage.failSet = null;
    const retry = await repository.remove(removeRequest);
    expect(retry).toMatchObject({
      ok: true,
      value: { projectId, deleteId: 'delete-first', removed: true },
    });
    await expect(repository.remove(removeRequest)).resolves.toEqual(retry);
    await expect(repository.load(projectId)).resolves.toEqual({ ok: true, value: null });
  });

  it('allows explicit Repair removal of corrupt legacy-only evidence', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const projectId = makeProject('corrupt legacy repair').id;
    storage.setItem(legacyProjectKey(projectId), '{corrupt');

    await expect(
      repository.remove({
        projectId,
        deleteId: 'delete-repair',
        expectedHeadVersion: undefined,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(storage.getItem(legacyProjectKey(projectId))).toBeNull();
    await expect(repository.load(projectId)).resolves.toEqual({ ok: true, value: null });
  });

  it('never adopts a bare tombstone when a deleted head is damaged', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('deleted recovery');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    await repository.remove({
      projectId: project.id,
      deleteId: 'delete-1',
      expectedHeadVersion: saved.value.headVersion,
    });
    storage.setItem(projectHeadKey(project.id), '{broken');

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt-data' },
    });
  });

  it.each(['missing', 'corrupt'] as const)(
    'keeps a valid deleted head idempotent when its tombstone is %s',
    async (tombstoneState) => {
      const storage = new TestStorage();
      const repository = new LocalStorageProjectRepository({ storage, now });
      const project = makeProject(`deleted retry ${tombstoneState}`);
      const saved = await repository.save(request(project, 1, 'write-1', null));
      if (!saved.ok) throw new Error('fixture save failed');
      const removeRequest = {
        projectId: project.id,
        deleteId: 'delete-stable',
        expectedHeadVersion: saved.value.headVersion,
      } as const;
      const removed = await repository.remove(removeRequest);
      if (!removed.ok) throw new Error('fixture delete failed');
      const headRaw = storage.getItem(projectHeadKey(project.id));
      if (!headRaw) throw new Error('deleted head missing');
      const tombstoneKey = (JSON.parse(headRaw) as { generationKey: string }).generationKey;
      if (tombstoneState === 'missing') storage.removeItem(tombstoneKey);
      else storage.setItem(tombstoneKey, '{corrupt');

      await expect(repository.remove(removeRequest)).resolves.toMatchObject({
        ok: true,
        value: { headVersion: removed.value.headVersion, removed: true },
      });
      await expect(repository.load(project.id)).resolves.toEqual({ ok: true, value: null });
    },
  );

  it('lets a verified deleted head dominate visibility without deleting auxiliary future bytes', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('deleted future cleanup');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    const removeRequest = {
      projectId: project.id,
      deleteId: 'delete-stable',
      expectedHeadVersion: saved.value.headVersion,
    } as const;
    const removed = await repository.remove(removeRequest);
    if (!removed.ok) throw new Error('fixture delete failed');
    const futureEntries = new Map([
      [legacyProjectKey(project.id), JSON.stringify({ ...project, schemaVersion: 999 })],
      [projectGenerationKey(project.id, 99, 'future'), JSON.stringify({ storageVersion: 2 })],
      [projectIntentKey(project.id), JSON.stringify({ storageVersion: 2 })],
      [projectRecoveryKey(project.id, 'future'), JSON.stringify({ storageVersion: 2 })],
    ]);
    for (const [key, raw] of futureEntries) storage.setItem(key, raw);

    await expect(repository.load(project.id)).resolves.toEqual({ ok: true, value: null });
    await expect(
      repository.save(request(project, 2, 'resurrection', undefined)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(repository.saveRecoverySynchronously(request(project, 2, 'recovery', undefined))).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    await expect(repository.remove(removeRequest)).resolves.toMatchObject({
      ok: true,
      value: { cleanupComplete: false },
    });
    for (const [key, raw] of futureEntries) expect(storage.getItem(key)).toBe(raw);
  });

  it('loads a valid legacy key and reports explicit recovery', async () => {
    const storage = new TestStorage();
    const project = makeProject('legacy');
    storage.setItem(legacyProjectKey(project.id), JSON.stringify(project));
    const repository = new LocalStorageProjectRepository({ storage, now });

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'legacy' },
        source: 'legacy',
        recovered: true,
        recoveryReason: 'legacy-project',
      },
    });
  });

  it('keeps corrupt and future-schema entries visible as diagnostics', async () => {
    const storage = new TestStorage();
    storage.setItem(legacyProjectKey('broken'), '{bad');
    const future = makeProject('future');
    storage.setItem(
      legacyProjectKey(future.id),
      JSON.stringify({ ...future, schemaVersion: 999 }),
    );
    const repository = new LocalStorageProjectRepository({ storage, now });

    const listed = await repository.list();

    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        { status: 'unreadable', id: 'broken', errorCode: 'corrupt-data', branches: [] },
        {
          status: 'unreadable',
          id: future.id,
          errorCode: 'unsupported-version',
          branches: [],
        },
      ]),
    });
  });

  it('does not promote a known-empty recovery across a present corrupt legacy mirror', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('recovery behind corrupt mirror');
    expect(repository.saveRecoverySynchronously(request(project, 1, 'write-1', null))).toMatchObject({
      ok: true,
    });
    const recoveryKey = projectRecoveryKey(project.id, 'activation-a');
    const recoveryRaw = storage.getItem(recoveryKey);
    storage.setItem(legacyProjectKey(project.id), '{corrupt');

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt-data' },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: project.id,
          errorCode: 'corrupt-data',
          branches: [expect.objectContaining({ source: 'recovery-journal' })],
        },
      ],
    });
    expect(storage.getItem(recoveryKey)).toBe(recoveryRaw);
    expect(storage.getItem(legacyProjectKey(project.id))).toBe('{corrupt');
  });

  it('classifies quota errors during immutable generation creation', async () => {
    const storage = new TestStorage();
    storage.failSet = (key) =>
      key.includes('.gen.')
        ? Object.assign(new Error('full'), { name: 'QuotaExceededError' })
        : null;
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject();

    await expect(repository.save(request(project, 1, 'write-1', null))).resolves.toMatchObject({
      ok: false,
      error: { code: 'quota-exceeded', retry: 'manual' },
    });
    expect(storage.getItem(projectHeadKey(project.id))).toBeNull();
  });

  it('does not adopt an orphan generation without a matching intent when the head is missing', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now, lockManager: null });
    const project = makeProject('unowned orphan');
    storage.failSet = (key) =>
      key === projectHeadKey(project.id) ? new Error('head unavailable') : null;

    await expect(repository.save(request(project, 1, 'orphan-write', null))).resolves.toMatchObject({
      ok: false,
      error: { code: 'write-failed' },
    });
    storage.failSet = null;
    storage.removeItem(projectIntentKey(project.id));

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt-data' },
    });
  });

  it('uses the legacy mirror as explicit commit evidence instead of a higher unowned orphan', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const committed = makeProject('committed evidence', '2026-07-10T00:00:01.000Z');
    const saved = await repository.save(request(committed, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    const committedKey = activeGenerationKey(storage, committed.id);
    const raw = storage.getItem(committedKey);
    if (!raw) throw new Error('generation missing');
    const orphan = JSON.parse(raw) as Record<string, unknown>;
    const orphanProject = {
      ...committed,
      title: 'conflict loser',
      updatedAt: '2026-07-10T00:00:02.000Z',
    };
    orphan.ordinal = 2;
    orphan.writeId = 'loser';
    orphan.projectJson = JSON.stringify(orphanProject);
    orphan.bytes = new TextEncoder().encode(orphan.projectJson as string).byteLength;
    const { checksum: _checksum, ...content } = orphan;
    orphan.checksum = crc32(JSON.stringify(content));
    storage.setItem(projectGenerationKey(committed.id, 2, 'loser'), JSON.stringify(orphan));
    storage.setItem(projectHeadKey(committed.id), '{corrupt');

    await expect(repository.load(committed.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'committed evidence' },
        recovered: true,
        recoveryReason: 'head-corrupt',
      },
    });
  });

  it('prefers a later canonical revision over a stale same-timestamp recovery journal', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    const recovery = { ...base, title: 'stale recovery', updatedAt: '2026-07-10T00:00:02.000Z' };
    repository.saveRecoverySynchronously(
      request(recovery, 2, 'write-2', first.value.headVersion),
    );
    storage.failRemove = (key) =>
      key === projectRecoveryKey(base.id, 'activation-a') ? new Error('journal cleanup failed') : null;
    const canonical = { ...base, title: 'canonical latest', updatedAt: recovery.updatedAt };

    await expect(
      repository.save(request(canonical, 3, 'write-3', first.value.headVersion)),
    ).resolves.toMatchObject({ ok: true });
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'canonical latest' }, recovered: false },
    });
  });

  it('prefers a newer intent-owned generation over an older recovery journal', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously(
      request(
        { ...base, title: 'recovery revision 2', updatedAt: '2026-07-10T00:00:02.000Z' },
        2,
        'write-2',
        first.value.headVersion,
      ),
    );
    storage.failSet = (key) =>
      key === projectHeadKey(base.id) ? new Error('head write failed') : null;
    await expect(
      repository.save(
        request(
          { ...base, title: 'intent revision 3', updatedAt: '2026-07-10T00:00:03.000Z' },
          3,
          'write-3',
          first.value.headVersion,
        ),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'write-failed' } });
    storage.failSet = null;

    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'intent revision 3' }, recoveryReason: 'head-stale' },
    });
  });

  it('does not replay a recovery journal after another activation advances its base head', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    const stale = { ...base, title: 'other tab draft', updatedAt: '2026-07-10T00:00:03.000Z' };
    repository.saveRecoverySynchronously({
      ...request(stale, 2, 'write-2', first.value.headVersion),
      activationId: 'activation-old',
    });
    const committed = { ...base, title: 'other tab commit', updatedAt: '2026-07-10T00:00:02.000Z' };
    await repository.save({
      ...request(committed, 1, 'write-new-activation', first.value.headVersion),
      activationId: 'activation-new',
    });

    expect(storage.getItem(projectRecoveryKey(base.id, 'activation-old'))).not.toBeNull();
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'other tab commit' }, recovered: false },
    });

    const listed = await repository.list();
    expect(listed).toMatchObject({
      ok: true,
      value: [
        {
          status: 'ready',
          id: base.id,
          title: 'other tab commit',
          branches: [
            {
              source: 'recovery-journal',
              activationId: 'activation-old',
              revision: 2,
              writeId: 'write-2',
              title: 'other tab draft',
            },
          ],
        },
      ],
    });
    if (!listed.ok || listed.value[0]?.status !== 'ready') {
      throw new Error('branch summary fixture failed');
    }
    const [branchSummary] = listed.value[0].branches;
    if (!branchSummary) throw new Error('recovery branch missing');
    expect(branchSummary.branchId).toMatch(/^branch-v1-[0-9a-f]{16}$/);
    expect(branchSummary.branchId).not.toContain('activation-old');
    const recoveryRaw = storage.getItem(projectRecoveryKey(base.id, 'activation-old'));
    await expect(repository.loadProjectBranch(base.id, branchSummary.branchId)).resolves.toMatchObject({
      ok: true,
      value: {
        ...branchSummary,
        project: { title: 'other tab draft' },
      },
    });
    expect(storage.getItem(projectRecoveryKey(base.id, 'activation-old'))).toBe(recoveryRaw);
  });

  it('returns the observed head token so recovery repair cannot overwrite a later tab commit', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously({
      ...request({ ...base, title: 'recovery A' }, 2, 'recovery-a', first.value.headVersion),
      activationId: 'tab-a',
    });
    const recovered = await repository.load(base.id);
    expect(recovered).toMatchObject({
      ok: true,
      value: { project: { title: 'recovery A' }, headVersion: first.value.headVersion },
    });
    if (!recovered.ok || !recovered.value) throw new Error('recovery fixture failed');
    const committedB = await repository.save({
      ...request(
        { ...base, title: 'commit B', updatedAt: '2026-07-10T00:00:02.000Z' },
        1,
        'commit-b',
        first.value.headVersion,
      ),
      activationId: 'tab-b',
    });
    if (!committedB.ok) throw new Error('tab B fixture failed');

    await expect(
      repository.save({
        project: recovered.value.project,
        activationId: 'repair-a',
        revision: 0,
        writeId: 'repair-a',
        expectedHeadVersion: recovered.value.headVersion,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'commit B' }, recovered: false },
    });
  });

  it('preserves concurrent pagehide journals from different activations', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const saved = await repository.save(request(base, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');

    const first = repository.saveRecoverySynchronously({
      ...request({ ...base, title: 'draft A' }, 2, 'draft-a', saved.value.headVersion),
      activationId: 'tab-a',
    });
    const second = repository.saveRecoverySynchronously({
      ...request({ ...base, title: 'draft B' }, 2, 'draft-b', saved.value.headVersion),
      activationId: 'tab-b',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const rawA = storage.getItem(projectRecoveryKey(base.id, 'tab-a'));
    const rawB = storage.getItem(projectRecoveryKey(base.id, 'tab-b'));
    expect(rawA).not.toBeNull();
    expect(rawB).not.toBeNull();
    expect(rawA).not.toBe(rawB);
    expect(rawA).toContain('draft A');
    expect(rawB).toContain('draft B');
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    const listed = await repository.list();
    expect(listed).toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: base.id,
          errorCode: 'conflict',
          branches: expect.arrayContaining([
            expect.objectContaining({ source: 'recovery-journal', title: 'draft A' }),
            expect.objectContaining({ source: 'recovery-journal', title: 'draft B' }),
          ]),
        },
      ],
    });
    if (!listed.ok || listed.value[0]?.status !== 'unreadable') {
      throw new Error('conflict branch summary fixture failed');
    }
    expect(listed.value[0].branches).toHaveLength(2);
    const draftA = listed.value[0].branches.find((branch) => branch.title === 'draft A');
    if (!draftA) throw new Error('draft A branch missing');
    await expect(repository.loadProjectBranch(base.id, draftA.branchId)).resolves.toMatchObject({
      ok: true,
      value: { source: 'recovery-journal', project: { title: 'draft A' } },
    });
  });

  it('surfaces divergent recovery and interrupted branches instead of choosing by clock', async () => {
    const storage = new TestStorage();
    const times = [
      new Date('2026-07-10T12:00:00.000Z'),
      new Date('2026-07-10T12:00:01.000Z'),
      new Date('2026-07-10T12:00:02.000Z'),
    ];
    const repository = new LocalStorageProjectRepository({
      storage,
      now: () => times.shift() ?? new Date('2026-07-10T12:00:03.000Z'),
    });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously({
      ...request({ ...base, title: 'tab B recovery' }, 2, 'recovery-b', first.value.headVersion),
      activationId: 'tab-b',
    });
    storage.failSet = (key) =>
      key === projectHeadKey(base.id) ? new Error('head response interrupted') : null;
    await repository.save({
      ...request({ ...base, title: 'tab A intent' }, 2, 'intent-a', first.value.headVersion),
      activationId: 'tab-a',
    });
    storage.failSet = null;

    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(storage.getItem(projectRecoveryKey(base.id, 'tab-b'))).not.toBeNull();
    expect(storage.getItem(projectIntentKey(base.id))).not.toBeNull();
    const listed = await repository.list();
    expect(listed).toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: base.id,
          errorCode: 'conflict',
          branches: expect.arrayContaining([
            expect.objectContaining({ source: 'recovery-journal', title: 'tab B recovery' }),
            expect.objectContaining({ source: 'interrupted-save', title: 'tab A intent' }),
          ]),
        },
      ],
    });
    if (!listed.ok || listed.value[0]?.status !== 'unreadable') {
      throw new Error('mixed conflict branch summary fixture failed');
    }
    expect(listed.value[0].branches).toHaveLength(2);
    for (const branch of listed.value[0].branches) {
      const loadedBranch = await repository.loadProjectBranch(base.id, branch.branchId);
      expect(loadedBranch).toMatchObject({
        ok: true,
        value: { source: branch.source, project: { title: branch.title } },
      });
    }
    expect(storage.getItem(projectRecoveryKey(base.id, 'tab-b'))).not.toBeNull();
    expect(storage.getItem(projectIntentKey(base.id))).not.toBeNull();
  });

  it('recovers the proven committed parent when newer mirrors lag', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const firstProject = makeProject('H1', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(firstProject, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    storage.failSet = (key) =>
      key === legacyProjectKey(firstProject.id) ? new Error('mirror unavailable') : null;
    const secondProject = {
      ...firstProject,
      title: 'H2',
      updatedAt: '2026-07-10T00:00:02.000Z',
    };
    const second = await repository.save(
      request(secondProject, 2, 'write-2', first.value.headVersion),
    );
    if (!second.ok) throw new Error('fixture save failed');
    const third = await repository.save(
      request(
        { ...secondProject, title: 'H3', updatedAt: '2026-07-10T00:00:03.000Z' },
        3,
        'write-3',
        second.value.headVersion,
      ),
    );
    if (!third.ok) throw new Error('fixture save failed');
    storage.failSet = null;
    storage.setItem(activeGenerationKey(storage, firstProject.id), '{corrupt');

    await expect(repository.load(firstProject.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'H2' },
        source: 'generation',
        recoveryReason: 'generation-corrupt',
        headVersion: third.value.headVersion,
      },
    });
  });

  it('prunes failed siblings before the committed ancestry backup', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now, retainGenerations: 3 });
    const base = makeProject('parent H1', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    storage.failSet = (key) =>
      key === projectHeadKey(base.id) ? new Error('failed sibling head') : null;
    await repository.save(
      request({ ...base, title: 'sibling 2' }, 2, 'failed-2', first.value.headVersion),
    );
    await repository.save(
      request({ ...base, title: 'sibling 3' }, 3, 'failed-3', first.value.headVersion),
    );
    storage.failSet = (key) =>
      key === legacyProjectKey(base.id) ? new Error('mirror unavailable') : null;
    const committed = await repository.save(
      request(
        { ...base, title: 'committed H4', updatedAt: '2026-07-10T00:00:04.000Z' },
        4,
        'write-4',
        first.value.headVersion,
      ),
    );
    if (!committed.ok) throw new Error('fixture save failed');
    expect(storage.getItem(projectGenerationKey(base.id, 1, 'write-1'))).not.toBeNull();
    const failedKeys = ['failed-2', 'failed-3'].filter(
      (id, index) => storage.getItem(projectGenerationKey(base.id, index + 2, id)) !== null,
    );
    expect(failedKeys).toHaveLength(1);
    storage.failSet = null;
    storage.setItem(activeGenerationKey(storage, base.id), '{corrupt');

    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'parent H1' }, source: 'generation' },
    });
  });

  it('accepts a newer recovery snapshot that causally follows its just-committed predecessor', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('predecessor', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    const latest = { ...base, title: 'pagehide latest', updatedAt: '2026-07-10T00:00:02.000Z' };

    expect(
      repository.saveRecoverySynchronously({
        ...request(latest, 2, 'write-2', null),
        predecessorWriteId: 'write-1',
      }),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: {
        project: { title: 'pagehide latest' },
        recoveryReason: 'recovery-journal',
      },
    });
  });

  it('reports a corrupt recovery-only record instead of treating it as an empty repository', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    storage.setItem(projectRecoveryKey('recovery-only'), '{corrupt');

    await expect(repository.load('recovery-only')).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt-data' },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [{ status: 'unreadable', id: 'recovery-only', errorCode: 'corrupt-data' }],
    });
  });

  it('never resurrects an older project when a committed tombstone is corrupt and cleanup was incomplete', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('deleted secret');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    storage.failRemove = (key) => (key.includes('.gen.') ? new Error('cleanup failed') : null);
    const removed = await repository.remove({
      projectId: project.id,
      deleteId: 'delete-1',
      expectedHeadVersion: saved.value.headVersion,
    });
    if (!removed.ok) throw new Error('fixture remove failed');
    storage.failRemove = null;
    storage.setItem(activeGenerationKey(storage, project.id), '{corrupt');

    await expect(repository.load(project.id)).resolves.toEqual({ ok: true, value: null });
  });

  it('never resurrects stale recovery bytes after a deleted head is damaged', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('must stay deleted');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously(
      request({ ...project, title: 'stale recovery' }, 2, 'write-2', saved.value.headVersion),
    );
    const beforeDelete = await repository.list();
    if (!beforeDelete.ok) throw new Error('branch fixture list failed');
    const staleBranch = beforeDelete.value.find((entry) => entry.id === project.id)?.branches[0];
    if (!staleBranch) throw new Error('stale branch fixture missing');
    storage.failRemove = () => new Error('cleanup failed');
    const removed = await repository.remove({
      projectId: project.id,
      deleteId: 'delete-sticky',
      expectedHeadVersion: saved.value.headVersion,
    });
    if (!removed.ok) throw new Error('fixture remove failed');
    storage.failRemove = null;
    await expect(repository.loadProjectBranch(project.id, staleBranch.branchId)).resolves.toEqual({
      ok: true,
      value: null,
    });
    storage.setItem(projectHeadKey(project.id), '{corrupt');

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'corrupt-data' },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [{ status: 'unreadable', id: project.id, branches: [] }],
    });
    await expect(repository.loadProjectBranch(project.id, staleBranch.branchId)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it('prefers later legacy commit evidence over a stale recovery when the head is damaged', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const base = makeProject('base', '2026-07-10T00:00:01.000Z');
    const first = await repository.save(request(base, 1, 'write-1', null));
    if (!first.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously(
      request({ ...base, title: 'stale draft' }, 2, 'write-2', first.value.headVersion),
    );
    storage.failRemove = (key) =>
      key === projectRecoveryKey(base.id, 'activation-a') ? new Error('journal cleanup failed') : null;
    const latest = { ...base, title: 'later canonical', updatedAt: '2026-07-10T00:00:02.000Z' };
    const second = await repository.save({
      ...request(latest, 1, 'write-new-activation', first.value.headVersion),
      activationId: 'activation-new',
    });
    if (!second.ok) throw new Error('fixture save failed');
    storage.failRemove = null;
    storage.setItem(projectHeadKey(base.id), '{corrupt');

    await expect(repository.load(base.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'later canonical' }, recoveryReason: 'head-corrupt' },
    });
  });

  it.each(['head', 'generation', 'intent', 'recovery'] as const)(
    'treats a future %s storageVersion as sticky and blocks load, save, and remove',
    async (recordKind) => {
      const storage = new TestStorage();
      const repository = new LocalStorageProjectRepository({ storage, now });
      const project = makeProject(`future ${recordKind}`);
      const saved = await repository.save(request(project, 1, 'write-1', null));
      if (!saved.ok) throw new Error('fixture save failed');
      const key =
        recordKind === 'head'
          ? projectHeadKey(project.id)
          : recordKind === 'generation'
            ? activeGenerationKey(storage, project.id)
            : recordKind === 'intent'
              ? projectIntentKey(project.id)
              : projectRecoveryKey(project.id, 'activation-a');
      const original = storage.getItem(key);
      const envelope = original ? (JSON.parse(original) as Record<string, unknown>) : {};
      storage.setItem(key, JSON.stringify({ ...envelope, storageVersion: 2 }));

      await expect(repository.load(project.id)).resolves.toMatchObject({
        ok: false,
        error: { code: 'unsupported-version' },
      });
      await expect(
        repository.save(request({ ...project, title: 'must not write' }, 2, 'write-2', undefined)),
      ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
      await expect(
        repository.remove({ projectId: project.id, deleteId: 'delete-1' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
      expect(storage.getItem(key)).toBe(JSON.stringify({ ...envelope, storageVersion: 2 }));
    },
  );

  it('treats a future legacy mirror beside a valid active head as sticky and immutable', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('current with future mirror');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    storage.setItem(
      legacyProjectKey(project.id),
      JSON.stringify({ ...project, title: 'future mirror', schemaVersion: 999 }),
    );
    const before = new Map(
      storage.rawKeys().map((storageKey) => [storageKey, storage.getItem(storageKey)]),
    );

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
    await expect(
      repository.save(request({ ...project, title: 'old writer' }, 2, 'write-old', undefined)),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    expect(
      repository.saveRecoverySynchronously(
        request({ ...project, title: 'old recovery' }, 2, 'recovery-old', undefined),
      ),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    await expect(
      repository.remove({ projectId: project.id, deleteId: 'delete-old' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    expect(
      new Map(storage.rawKeys().map((storageKey) => [storageKey, storage.getItem(storageKey)])),
    ).toEqual(before);
  });

  it('preserves a future project schema inside a checksummed recovery journal', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('current');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously(
      request({ ...project, title: 'future recovery' }, 2, 'write-2', saved.value.headVersion),
    );
    const key = projectRecoveryKey(project.id, 'activation-a');
    const raw = storage.getItem(key);
    if (!raw) throw new Error('recovery fixture missing');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope.projectJson = JSON.stringify({ ...project, schemaVersion: 999 });
    envelope.bytes = new TextEncoder().encode(envelope.projectJson as string).byteLength;
    const { checksum: _checksum, ...content } = envelope;
    envelope.checksum = crc32(JSON.stringify(content));
    const futureRaw = JSON.stringify(envelope);
    storage.setItem(key, futureRaw);

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
    expect(
      repository.saveRecoverySynchronously(
        request({ ...project, title: 'old app overwrite' }, 3, 'write-3', saved.value.headVersion),
      ),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    await expect(
      repository.remove({ projectId: project.id, deleteId: 'delete-old-app' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
    expect(storage.getItem(key)).toBe(futureRaw);
  });

  it('does not expose an older recovery branch through a future-schema project boundary', async () => {
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('current');
    const saved = await repository.save(request(project, 1, 'write-1', null));
    if (!saved.ok) throw new Error('fixture save failed');
    repository.saveRecoverySynchronously(
      request({ ...project, title: 'older branch' }, 2, 'branch-write', saved.value.headVersion),
    );
    const before = await repository.list();
    if (!before.ok) throw new Error('fixture list failed');
    const branch = before.value.find((entry) => entry.id === project.id)?.branches[0];
    if (!branch) throw new Error('branch fixture missing');
    const headRaw = storage.getItem(projectHeadKey(project.id));
    if (!headRaw) throw new Error('head fixture missing');
    storage.setItem(
      projectHeadKey(project.id),
      JSON.stringify({ ...(JSON.parse(headRaw) as object), storageVersion: 2 }),
    );

    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          status: 'unreadable',
          id: project.id,
          errorCode: 'unsupported-version',
          branches: [],
        },
      ],
    });
    await expect(repository.loadProjectBranch(project.id, branch.branchId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
  });

  it('serializes concurrent repositories with the deterministic in-process fallback', async () => {
    const storage = new TestStorage();
    const firstRepository = new LocalStorageProjectRepository({ storage, now, lockManager: null });
    const secondRepository = new LocalStorageProjectRepository({ storage, now, lockManager: null });
    const project = makeProject('first writer');

    const [first, second] = await Promise.all([
      firstRepository.save(request(project, 1, 'write-1', null)),
      secondRepository.save(
        request({ ...project, title: 'second writer' }, 1, 'write-2', null),
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(firstRepository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'first writer' } },
    });
  });

  it('uses one exclusive Web Lock namespace for save and remove across repository instances', async () => {
    const storage = new TestStorage();
    const locks = new SerialProbeLockManager();
    const firstRepository = new LocalStorageProjectRepository({ storage, now, lockManager: locks });
    const secondRepository = new LocalStorageProjectRepository({ storage, now, lockManager: locks });
    const project = makeProject('locked writer');

    const [saved, removed] = await Promise.all([
      firstRepository.save(request(project, 1, 'write-1', null)),
      secondRepository.remove({ projectId: project.id, deleteId: 'delete-1', expectedHeadVersion: null }),
    ]);

    expect(saved.ok).toBe(true);
    expect(removed).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(locks.calls).toHaveLength(2);
    expect(new Set(locks.calls.map((call) => call.name)).size).toBe(1);
    expect(locks.calls.every((call) => call.mode === 'exclusive')).toBe(true);
    expect(locks.maxActive).toBe(1);
  });

  it('fails closed in browsers that do not provide cross-context Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const storage = new TestStorage();
    const repository = new LocalStorageProjectRepository({ storage, now });
    const project = makeProject('unsafe browser');

    await expect(repository.save(request(project, 1, 'write-1', null))).resolves.toMatchObject({
      ok: false,
      error: { code: 'lock-unavailable', retry: 'never' },
    });
    await expect(
      repository.remove({ projectId: project.id, deleteId: 'delete-1', expectedHeadVersion: null }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'lock-unavailable', retry: 'never' },
    });
    expect(storage.rawKeys()).toEqual([]);
  });
});
