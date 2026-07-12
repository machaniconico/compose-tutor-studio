import { describe, expect, it } from 'vitest';
import { decodeProjectJson } from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  createBrowserProjectRepository,
  projectKey,
  toSaveFailure,
} from '../src/state/persistence';
import { MemoryStorage } from './localStorageStub';

describe('studio persistence composition', () => {
  it('wires browser storage through the versioned repository and legacy mirror', async () => {
    const storage = new MemoryStorage();
    const repository = createBrowserProjectRepository(storage);
    const project = createDefaultProject('保存結果');

    const saved = await repository.save({
      project,
      activationId: 'activation',
      revision: 1,
      writeId: 'write-1',
      expectedHeadVersion: null,
    });

    expect(saved.ok).toBe(true);
    const legacy = storage.getItem(projectKey(project.id));
    expect(legacy).not.toBeNull();
    const decoded = decodeProjectJson(legacy ?? '');
    expect(decoded.ok && decoded.project).toEqual(project);
    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: '保存結果' }, recovered: false },
    });
  });

  it('resolves the current global storage lazily instead of capturing it at import', async () => {
    const repository = createBrowserProjectRepository();
    const first = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: first,
      configurable: true,
      writable: true,
    });
    expect((await repository.initialize()).ok).toBe(true);

    const second = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: second,
      configurable: true,
      writable: true,
    });
    const project = createDefaultProject('遅延解決');
    const saved = await repository.save({
      project,
      activationId: 'activation',
      revision: 0,
      writeId: 'write-lazy',
      expectedHeadVersion: null,
    });

    expect(saved.ok).toBe(true);
    expect(first.length).toBe(0);
    expect(second.getItem(projectKey(project.id))).not.toBeNull();
  });

  it('preserves repository retry policy for the save UI', () => {
    expect(
      toSaveFailure({
        operation: 'save',
        code: 'quota-exceeded',
        retry: 'manual',
        projectId: 'project',
      }),
    ).toEqual({ code: 'quota-exceeded', retry: 'manual' });
  });
});
