import { describe, expect, it } from 'vitest';
import {
  deleteProject,
  installBeforeUnloadFlush,
  listSavedProjects,
  loadMostRecentProject,
  loadProject,
  projectKey,
  saveProject,
} from '../src/state/persistence';
import { createDefaultProject } from '../src/state/defaultProject';
import { MemoryStorage } from './localStorageStub';

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

function makeBeforeUnloadTarget() {
  const listeners = new Set<() => void>();
  return {
    target: {
      addEventListener(type: string, listener: () => void): void {
        if (type === 'beforeunload') listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'beforeunload') listeners.delete(listener);
      },
    } as Window,
    dispatchBeforeUnload(): void {
      for (const listener of listeners) listener();
    },
  };
}

describe('persistence', () => {
  it('round-trips a project through storage', () => {
    const storage = new MemoryStorage();
    const project = createDefaultProject('テスト曲');

    expect(saveProject(project, storage)).toBe(true);
    const loaded = loadProject(project.id, storage);

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(project.id);
    expect(loaded?.title).toBe('テスト曲');
    expect(loaded?.tracks.length).toBe(project.tracks.length);
    expect(loaded?.chordTrack.length).toBe(project.chordTrack.length);
  });

  it('uses the cts.project.<id> key format', () => {
    const storage = new MemoryStorage();
    const project = createDefaultProject();
    saveProject(project, storage);
    expect(storage.getItem(projectKey(project.id))).not.toBeNull();
    expect(projectKey(project.id)).toBe(`cts.project.${project.id}`);
  });

  it('lists saved projects newest first', () => {
    const storage = new MemoryStorage();
    const older = { ...createDefaultProject('古い'), updatedAt: '2020-01-01T00:00:00.000Z' };
    const newer = { ...createDefaultProject('新しい'), updatedAt: '2030-01-01T00:00:00.000Z' };
    saveProject(older, storage);
    saveProject(newer, storage);

    const list = listSavedProjects(storage);
    expect(list.length).toBe(2);
    expect(list[0]?.title).toBe('新しい');
    expect(loadMostRecentProject(storage)?.id).toBe(newer.id);
  });

  it('returns null for corrupt JSON without throwing', () => {
    const storage = new MemoryStorage();
    storage.setItem('cts.project.broken', '{ this is not json');
    expect(loadProject('broken', storage)).toBeNull();
    expect(listSavedProjects(storage)).toEqual([]);
  });

  it('deletes a project', () => {
    const storage = new MemoryStorage();
    const project = createDefaultProject();
    saveProject(project, storage);
    expect(deleteProject(project.id, storage)).toBe(true);
    expect(loadProject(project.id, storage)).toBeNull();
  });

  it('returns false when storage rejects a save', () => {
    const project = createDefaultProject();
    expect(saveProject(project, new FailingStorage())).toBe(false);
  });

  it('installs a beforeunload flush handler and removes it cleanly', () => {
    const { target, dispatchBeforeUnload } = makeBeforeUnloadTarget();
    let flushes = 0;

    const dispose = installBeforeUnloadFlush(() => {
      flushes += 1;
      return true;
    }, target);

    dispatchBeforeUnload();
    expect(flushes).toBe(1);

    dispose();
    dispatchBeforeUnload();
    expect(flushes).toBe(1);
  });
});
