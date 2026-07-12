import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, type Project } from '@cts/project-model';
import {
  createLegacyStorageSnapshot,
  DEFAULT_STORAGE_BOUND_BYTES,
  LEGACY_PERSISTENCE_PREFIX,
  LEGACY_PROJECT_PREFIX,
  NativeRecoveryJournal,
  nativeRecoveryKey,
  NATIVE_RECOVERY_NAMESPACE,
  type NativeRecoveryEntry,
  type SaveRequest,
} from '../src/index';
import { crc32 } from '../src/checksum';
import { makeProject, TestStorage } from './helpers';

const now = () => new Date('2026-07-10T12:00:00.000Z');

function request(
  title = 'Native recovery',
  overrides: Partial<SaveRequest> = {},
): SaveRequest {
  return {
    project: makeProject(title),
    activationId: 'activation-a',
    revision: 1,
    writeId: 'write-1',
    expectedHeadVersion: '1:active:base',
    predecessorWriteId: 'write-base',
    ...overrides,
  };
}

function onlyEntry(entries: readonly NativeRecoveryEntry[]): NativeRecoveryEntry {
  const entry = entries[0];
  if (!entry) throw new Error('expected one entry');
  return entry;
}

describe('NativeRecoveryJournal', () => {
  it('round-trips a canonical synchronous journal with explicit causal metadata', () => {
    const storage = new TestStorage();
    const journal = new NativeRecoveryJournal({ storage, now });
    const saveRequest = request();

    expect(journal.saveRecoverySynchronously(saveRequest)).toEqual({
      ok: true,
      value: {
        projectId: saveRequest.project.id,
        activationId: 'activation-a',
        revision: 1,
        writeId: 'write-1',
        savedAt: '2026-07-10T12:00:00.000Z',
        bytes: expect.any(Number),
      },
    });

    const key = nativeRecoveryKey(saveRequest.project.id, 'activation-a');
    expect(key).toBe(`${NATIVE_RECOVERY_NAMESPACE}${encodeURIComponent(saveRequest.project.id)}.activation-a`);
    const listed = journal.list(saveRequest.project.id);
    expect(listed).toMatchObject({
      ok: true,
      value: [
        {
          status: 'ready',
          storageKey: key,
          projectId: saveRequest.project.id,
          activationId: 'activation-a',
          revision: 1,
          writeId: 'write-1',
          baseHeadKnown: true,
          baseHeadVersion: '1:active:base',
          predecessorWriteId: 'write-base',
          project: { title: 'Native recovery' },
        },
      ],
    });
    expect((listed.ok && listed.value[0]?.status === 'ready' && listed.value[0].project) || null)
      .not.toBe(saveRequest.project);
  });

  it('distinguishes an unknown base head from a known empty head', () => {
    const storage = new TestStorage();
    const journal = new NativeRecoveryJournal({ storage, now });
    const unknown = request('unknown', {
      activationId: 'unknown',
      writeId: 'write-unknown',
      expectedHeadVersion: undefined,
      predecessorWriteId: undefined,
    });
    const empty = request('empty', {
      activationId: 'empty',
      writeId: 'write-empty',
      expectedHeadVersion: null,
      predecessorWriteId: undefined,
    });

    expect(journal.saveRecoverySynchronously(unknown).ok).toBe(true);
    expect(journal.saveRecoverySynchronously(empty).ok).toBe(true);
    const listed = journal.list();
    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          activationId: 'unknown',
          baseHeadKnown: false,
          baseHeadVersion: null,
        }),
        expect.objectContaining({
          activationId: 'empty',
          baseHeadKnown: true,
          baseHeadVersion: null,
        }),
      ]),
    });
  });

  it('makes equal-revision retries idempotent and rejects changed or stale revisions', () => {
    const storage = new TestStorage();
    const journal = new NativeRecoveryJournal({ storage, now });
    const initial = request();
    const first = journal.saveRecoverySynchronously(initial);
    expect(first.ok).toBe(true);
    expect(journal.saveRecoverySynchronously(initial)).toEqual(first);

    expect(
      journal.saveRecoverySynchronously({
        ...initial,
        project: { ...initial.project, title: 'same revision, changed bytes' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict', retry: 'manual' } });

    const newer = request('revision two', {
      project: { ...initial.project, title: 'revision two' },
      revision: 2,
      writeId: 'write-2',
    });
    expect(journal.saveRecoverySynchronously(newer).ok).toBe(true);
    expect(journal.saveRecoverySynchronously(initial)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(journal.list()).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ revision: 2, writeId: 'write-2' })],
    });
  });

  it('removes only the exact raw entry that was listed', () => {
    const storage = new TestStorage();
    const journal = new NativeRecoveryJournal({ storage, now });
    const initial = request();
    expect(journal.saveRecoverySynchronously(initial).ok).toBe(true);
    const firstList = journal.list();
    if (!firstList.ok) throw new Error('list failed');
    const staleIdentity = onlyEntry(firstList.value);

    expect(
      journal.saveRecoverySynchronously(
        request('newer', {
          project: { ...initial.project, title: 'newer' },
          revision: 2,
          writeId: 'write-2',
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(journal.removeExact(staleIdentity)).toEqual({ ok: true, value: false });
    const currentList = journal.list();
    if (!currentList.ok) throw new Error('list failed');
    const currentIdentity = onlyEntry(currentList.value);
    expect(currentIdentity).toMatchObject({ status: 'ready', revision: 2 });
    expect(journal.removeExact(currentIdentity)).toEqual({ ok: true, value: true });
    expect(journal.list()).toEqual({ ok: true, value: [] });
  });

  it('lists corrupt, unknown-key, and future records without deleting them', () => {
    const storage = new TestStorage();
    const journal = new NativeRecoveryJournal({ storage, now });
    const project = makeProject();
    const corruptKey = nativeRecoveryKey(project.id, 'corrupt');
    const unknownKey = nativeRecoveryKey(project.id, 'unknown-key');
    const futureKey = nativeRecoveryKey(project.id, 'future');
    storage.setItem(corruptKey, '{bad json');
    storage.setItem(
      unknownKey,
      JSON.stringify({ storageVersion: 1, projectId: project.id, unexpected: true }),
    );
    storage.setItem(futureKey, JSON.stringify({ storageVersion: 2, projectId: project.id }));

    expect(journal.list()).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ storageKey: corruptKey, errorCode: 'corrupt-data' }),
        expect.objectContaining({ storageKey: unknownKey, errorCode: 'corrupt-data' }),
        expect.objectContaining({ storageKey: futureKey, errorCode: 'unsupported-version' }),
      ]),
    });
    expect(storage.getItem(corruptKey)).toBe('{bad json');
  });

  it('diagnoses a checksummed future project schema instead of opening it', () => {
    const storage = new TestStorage();
    const journal = new NativeRecoveryJournal({ storage, now });
    const saveRequest = request();
    expect(journal.saveRecoverySynchronously(saveRequest).ok).toBe(true);
    const key = nativeRecoveryKey(saveRequest.project.id, saveRequest.activationId);
    const value = JSON.parse(storage.getItem(key) ?? '') as Record<string, unknown>;
    const project = JSON.parse(String(value.projectJson)) as Record<string, unknown>;
    project.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    const projectJson = JSON.stringify(project);
    value.projectJson = projectJson;
    value.bytes = new TextEncoder().encode(projectJson).byteLength;
    const { checksum: _checksum, ...content } = value;
    value.checksum = crc32(JSON.stringify(content));
    storage.setItem(key, JSON.stringify(value));

    expect(journal.list()).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ status: 'unreadable', errorCode: 'unsupported-version' })],
    });
  });

  it('fails closed on unavailable, denied, and quota-limited storage', () => {
    const unavailable = new NativeRecoveryJournal({ storage: null, now });
    expect(unavailable.list()).toMatchObject({
      ok: false,
      error: { code: 'storage-unavailable', retry: 'never' },
    });

    const denied = new TestStorage();
    denied.failEnumerate = Object.assign(new Error('denied'), { name: 'SecurityError' });
    expect(new NativeRecoveryJournal({ storage: denied, now }).list()).toMatchObject({
      ok: false,
      error: { code: 'access-denied', retry: 'manual' },
    });

    const full = new TestStorage();
    full.failSet = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    expect(new NativeRecoveryJournal({ storage: full, now }).saveRecoverySynchronously(request()))
      .toMatchObject({ ok: false, error: { code: 'quota-exceeded', retry: 'manual' } });
  });

  it('bounds project JSON, entry count, total bytes, and hostile enumeration', () => {
    const project = makeProject('bounded project');
    const encodedBytes = new TextEncoder().encode(JSON.stringify(project)).byteLength;
    const tooSmall = new NativeRecoveryJournal({
      storage: new TestStorage(),
      now,
      maxProjectBytes: encodedBytes - 1,
    });
    expect(tooSmall.saveRecoverySynchronously(request('bounded project', { project })))
      .toMatchObject({ ok: false, error: { code: 'too-large', retry: 'never' } });

    const countStorage = new TestStorage();
    const countBound = new NativeRecoveryJournal({ storage: countStorage, now, maxEntries: 1 });
    expect(countBound.saveRecoverySynchronously(request()).ok).toBe(true);
    expect(
      countBound.saveRecoverySynchronously(
        request('other activation', {
          activationId: 'activation-b',
          writeId: 'write-b',
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'quota-exceeded' } });

    const totalBound = new NativeRecoveryJournal({
      storage: new TestStorage(),
      now,
      maxTotalBytes: 128,
    });
    expect(totalBound.saveRecoverySynchronously(request())).toMatchObject({
      ok: false,
      error: { code: 'quota-exceeded' },
    });

    const hostile = {
      length: Number.MAX_SAFE_INTEGER,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(new NativeRecoveryJournal({ storage: hostile, now }).list()).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    });
    expect(DEFAULT_STORAGE_BOUND_BYTES).toBe(64 * 1024 * 1024);
  });

  it('enforces the fixed 16 MiB ceiling even when the caller raises its option', () => {
    const base = makeProject('large but structurally valid');
    const oversized: Project = {
      ...base,
      chordTrack: Array.from({ length: 4_096 }, (_, index) => ({
        id: `large-chord-${index}`,
        startBeat: 0,
        durationBeats: 1,
        symbol: 'X'.repeat(4_096),
        root: 'C',
        quality: 'custom',
        notes: [],
      })),
    };
    const journal = new NativeRecoveryJournal({
      storage: new TestStorage(),
      now,
      maxProjectBytes: 32 * 1024 * 1024,
    });

    expect(journal.saveRecoverySynchronously(request('oversized', { project: oversized })))
      .toMatchObject({ ok: false, error: { code: 'too-large', retry: 'never' } });
  });
});

describe('createLegacyStorageSnapshot', () => {
  it('captures only legacy CTS namespaces with exact sorted key/value content', () => {
    const storage = new TestStorage();
    const generationKey = `${LEGACY_PERSISTENCE_PREFIX}project.p.gen.000000000001.write`;
    const mirrorKey = `${LEGACY_PROJECT_PREFIX}p`;
    const generationValue = 'envelope\u0000日本語';
    const mirrorValue = '{"title":"exact"}\n';
    storage.setItem('unrelated', 'do not migrate');
    storage.setItem(NATIVE_RECOVERY_NAMESPACE + 'p.a', 'do not archive here');
    storage.setItem(mirrorKey, mirrorValue);
    storage.setItem(generationKey, generationValue);

    const snapshot = createLegacyStorageSnapshot({ storage, now });
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        storageVersion: 1,
        createdAt: '2026-07-10T12:00:00.000Z',
        entries: [
          { key: generationKey, value: generationValue },
          { key: mirrorKey, value: mirrorValue },
        ],
        totalBytes: expect.any(Number),
        contentChecksum: expect.stringMatching(/^crc32:/),
        checksum: expect.stringMatching(/^crc32:/),
      },
    });
    if (!snapshot.ok) throw new Error('snapshot failed');
    expect(snapshot.value.entries.map(({ key, value }) => [key, value])).toEqual([
      [generationKey, generationValue],
      [mirrorKey, mirrorValue],
    ]);
  });

  it('uses a stable content checksum while keeping createdAt in the envelope checksum', () => {
    const storage = new TestStorage();
    storage.setItem(`${LEGACY_PROJECT_PREFIX}stable`, '{"stable":true}');
    const first = createLegacyStorageSnapshot({
      storage,
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });
    const second = createLegacyStorageSnapshot({
      storage,
      now: () => new Date('2026-07-11T00:00:00.000Z'),
    });
    if (!first.ok || !second.ok) throw new Error('snapshot failed');

    expect(second.value.contentChecksum).toBe(first.value.contentChecksum);
    expect(second.value.checksum).not.toBe(first.value.checksum);
  });

  it('bounds raw snapshot count/bytes and detects a changing source', () => {
    const countStorage = new TestStorage();
    countStorage.setItem(`${LEGACY_PROJECT_PREFIX}a`, 'a');
    countStorage.setItem(`${LEGACY_PROJECT_PREFIX}b`, 'b');
    expect(createLegacyStorageSnapshot({ storage: countStorage, maxEntries: 1 })).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    });
    expect(createLegacyStorageSnapshot({ storage: countStorage, maxTotalBytes: 1 })).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    });

    let reads = 0;
    const changing = {
      length: 1,
      key: () => `${LEGACY_PROJECT_PREFIX}changing`,
      getItem: () => (++reads === 1 ? 'first' : 'second'),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(createLegacyStorageSnapshot({ storage: changing })).toMatchObject({
      ok: false,
      error: { code: 'conflict', retry: 'manual' },
    });
  });

  it('contains storage provider and enumeration exceptions', () => {
    expect(
      createLegacyStorageSnapshot({
        storage: () => {
          throw Object.assign(new Error('denied'), { name: 'SecurityError' });
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'access-denied' } });

    const storage = new TestStorage();
    storage.failEnumerate = new Error('enumeration failed');
    expect(createLegacyStorageSnapshot({ storage })).toMatchObject({
      ok: false,
      error: { code: 'read-failed', retry: 'automatic' },
    });
  });
});
