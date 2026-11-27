import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { crc32 } from '../src/checksum';
import {
  legacyProjectKey,
  LocalStorageProjectRepository,
  MemoryProjectRepository,
  NativeRecoveryJournal,
  NativeRecoveryProjectRepository,
  nativeRecoveryKey,
} from '../src/index';
import { makeProject, TestStorage } from './helpers';

const projectJson = readFileSync(
  new URL('../../project-model/tests/fixtures/wave5-v3/project-full.json', import.meta.url),
  'utf8',
);
const id = 'wave5-full';
const request = {
  project: { ...makeProject(), id },
  activationId: 'activation',
  revision: 1,
  writeId: 'write',
  expectedHeadVersion: null,
};

it.each(['generation', 'browser recovery', 'native recovery'] as const)(
  'retains the compatibility reason and bytes for a %s record',
  async (source) => {
    const storage = new TestStorage();
    const browser = new LocalStorageProjectRepository({ storage });
    const journal = new NativeRecoveryJournal({ storage });
    const repository = source === 'native recovery'
      ? new NativeRecoveryProjectRepository({ delegate: new MemoryProjectRepository(), journal })
      : browser;
    const seeded = source === 'generation'
      ? await browser.save(request)
      : (source === 'browser recovery' ? browser : journal).saveRecoverySynchronously(request);
    expect(seeded.ok).toBe(true);

    const marker = source === 'generation' ? '.gen.' : '.recovery.';
    const key = source === 'native recovery'
      ? nativeRecoveryKey(id, request.activationId)
      : Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .find((candidate) => candidate?.includes(marker));
    if (!key) throw new Error('Missing persisted record');
    const { checksum: _checksum, ...content } = JSON.parse(storage.getItem(key)!) as Record<string, unknown>;
    content.projectJson = projectJson;
    content.bytes = new TextEncoder().encode(projectJson).byteLength;
    const raw = JSON.stringify({ ...content, checksum: crc32(JSON.stringify(content)) });
    storage.setItem(key, raw);
    storage.removeItem(legacyProjectKey(id));

    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [{ id, status: 'unreadable', errorCode: 'unsupported-version', reason: 'legacy-wave5-format' }],
    });
    await expect(repository.save(request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported-version', reason: 'legacy-wave5-format', retry: 'never' },
    });
    expect(storage.getItem(key)).toBe(raw);
  },
);
