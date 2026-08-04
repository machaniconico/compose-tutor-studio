import { describe, expect, it } from 'vitest';
import {
  deleteProject,
  deleteProjectRecoveryIssue,
  deleteProjectRecoveryIssues,
  installBeforeUnloadFlush,
  listProjectRecoveryIssues,
  listSavedProjects,
  loadMostRecentProject,
  loadProject,
  normalizeProjectSummaryTitle,
  projectBackupKey,
  projectKey,
  saveProject,
} from '../src/state/persistence';
import { createDefaultProject } from '../src/state/defaultProject';
import { clearDiagnostics, loadDiagnostics } from '../src/platform/diagnostics';
import { MemoryStorage } from './localStorageStub';

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

class ProjectWriteFailingStorage extends MemoryStorage {
  override setItem(key: string, value: string): void {
    if (key.startsWith('cts.project.')) {
      throw new Error(`QuotaExceededError at C:\\Users\\name\\song.ctsproj.json
        ${'x'.repeat(900)}`);
    }
    super.setItem(key, value);
  }
}

function makeBeforeUnloadTarget() {
  const listeners = new Map<string, Set<() => void>>();
  const addListener = (type: string, listener: () => void): void => {
    const typeListeners = listeners.get(type) ?? new Set<() => void>();
    typeListeners.add(listener);
    listeners.set(type, typeListeners);
  };
  const removeListener = (type: string, listener: () => void): void => {
    listeners.get(type)?.delete(listener);
  };
  const dispatch = (type: string): void => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return {
    target: {
      addEventListener(type: string, listener: () => void): void {
        addListener(type, listener);
      },
      removeEventListener(type: string, listener: () => void): void {
        removeListener(type, listener);
      },
    } as Window,
    dispatchBeforeUnload(): void {
      dispatch('beforeunload');
    },
    dispatchPageHide(): void {
      dispatch('pagehide');
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

  it('recovers from the previous valid backup when the primary saved project is corrupt', () => {
    const storage = new MemoryStorage();
    const first = { ...createDefaultProject('直前の正常版'), updatedAt: '2026-07-01T00:00:00.000Z' };
    const second = { ...first, title: '新しい版', updatedAt: '2026-07-01T00:01:00.000Z' };

    expect(saveProject(first, storage)).toBe(true);
    expect(saveProject(second, storage)).toBe(true);
    storage.setItem(projectKey(first.id), '{ broken project json');

    const recovered = loadProject(first.id, storage);
    expect(recovered?.title).toBe('直前の正常版');
    const repaired = storage.getItem(projectKey(first.id));
    expect(repaired ? JSON.parse(repaired).title : null).toBe('直前の正常版');
    expect(listSavedProjects(storage)[0]).toMatchObject({
      id: first.id,
      title: '直前の正常版',
    });
    expect(listProjectRecoveryIssues(storage)).toEqual([]);

    const diagnostics = loadDiagnostics(storage);
    expect(diagnostics.filter((entry) => entry.message.includes('recovered from backup'))).toHaveLength(1);
    expect(diagnostics.some((entry) => entry.message.includes('invalid-json'))).toBe(true);
    expect(loadProject(first.id, storage)?.title).toBe('直前の正常版');
    expect(listSavedProjects(storage)[0]?.title).toBe('直前の正常版');
    expect(loadDiagnostics(storage).filter((entry) => entry.message.includes('recovered from backup'))).toHaveLength(
      1,
    );
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

  it('normalizes saved project summary titles for reliable lists', () => {
    const storage = new MemoryStorage();
    const blank = { ...createDefaultProject('   \n\t  '), updatedAt: '2030-01-01T00:00:00.000Z' };
    const longTitle = `${'長いタイトル'.repeat(20)}   with   spaces`;
    const long = { ...createDefaultProject(longTitle), updatedAt: '2029-01-01T00:00:00.000Z' };
    saveProject(blank, storage);
    saveProject(long, storage);

    const list = listSavedProjects(storage);
    expect(list[0]?.title).toBe('無題のプロジェクト');
    expect(list[1]?.title.length).toBe(80);
    expect(list[1]?.title.endsWith('...')).toBe(true);
    expect(list[1]?.title).not.toContain('   ');
  });

  it('keeps project summary title normalization pure and predictable', () => {
    expect(normalizeProjectSummaryTitle('  Verse idea  ')).toBe('Verse idea');
    expect(normalizeProjectSummaryTitle('')).toBe('無題のプロジェクト');
    expect(normalizeProjectSummaryTitle('a'.repeat(81))).toBe(`${'a'.repeat(77)}...`);
  });

  it('returns null for corrupt JSON without throwing', () => {
    const storage = new MemoryStorage();
    storage.setItem('cts.project.broken', '{ this is not json');
    expect(loadProject('broken', storage)).toBeNull();
    expect(listSavedProjects(storage)).toEqual([]);
  });

  it('rejects structurally invalid saved projects', () => {
    const storage = new MemoryStorage();
    const invalid = { ...createDefaultProject('壊れた曲'), bpm: 9999 };
    storage.setItem(projectKey(invalid.id), JSON.stringify(invalid));

    expect(loadProject(invalid.id, storage)).toBeNull();
    expect(listSavedProjects(storage)).toEqual([]);
  });

  it('records one local diagnostic for skipped saved projects', () => {
    const storage = new MemoryStorage();
    const invalid = { ...createDefaultProject('診断対象'), bpm: 9999 };
    storage.setItem(projectKey(invalid.id), JSON.stringify(invalid));

    expect(listProjectRecoveryIssues(storage)).toHaveLength(1);
    expect(listProjectRecoveryIssues(storage)).toHaveLength(1);
    expect(listSavedProjects(storage)).toEqual([]);

    const diagnostics = loadDiagnostics(storage);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('storage-recovery');
    expect(diagnostics[0]?.message).toContain('Saved project was skipped');
    expect(diagnostics[0]?.message).toContain('invalid-project');

    expect(clearDiagnostics(storage)).toBe(true);
    expect(listProjectRecoveryIssues(storage)).toHaveLength(1);
    expect(loadDiagnostics(storage)).toHaveLength(1);
  });

  it('keeps skipped saved-project diagnostic keys redacted and single-line', () => {
    const storage = new MemoryStorage();
    const unsafeId = `C:\\Users\\name\\song.ctsproj.json
      ${'x'.repeat(180)}`;
    storage.setItem(projectKey(unsafeId), '{ broken project json');

    expect(listProjectRecoveryIssues(storage)).toHaveLength(1);

    const message = loadDiagnostics(storage)[0]?.message ?? '';
    expect(message).toContain('Saved project was skipped');
    expect(message).toContain('key=cts.project.[local-path]');
    expect(message).not.toContain('C:\\Users\\name');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(400);
  });

  it('deletes only unrecoverable saved project entries', () => {
    const storage = new MemoryStorage();
    const valid = createDefaultProject('残す曲');
    const invalid = { ...createDefaultProject('削除対象'), bpm: 9999 };
    saveProject(valid, storage);
    storage.setItem(projectKey(invalid.id), JSON.stringify(invalid));

    expect(deleteProjectRecoveryIssue(projectKey(valid.id), storage)).toBe(false);
    expect(deleteProjectRecoveryIssues(storage)).toBe(1);
    expect(loadProject(valid.id, storage)?.title).toBe('残す曲');
    expect(loadProject(invalid.id, storage)).toBeNull();
    expect(listProjectRecoveryIssues(storage)).toEqual([]);
  });

  it('ignores unsupported project schema versions', () => {
    const storage = new MemoryStorage();
    const future = { ...createDefaultProject('未来の曲'), schemaVersion: 999 };
    storage.setItem(projectKey(future.id), JSON.stringify(future));

    expect(loadProject(future.id, storage)).toBeNull();
    expect(loadMostRecentProject(storage)).toBeNull();
  });

  it('deletes a project', () => {
    const storage = new MemoryStorage();
    const project = createDefaultProject();
    const edited = { ...project, title: 'バックアップ削除確認' };
    saveProject(project, storage);
    saveProject(edited, storage);
    expect(storage.getItem(projectBackupKey(project.id))).not.toBeNull();
    expect(deleteProject(project.id, storage)).toBe(true);
    expect(loadProject(project.id, storage)).toBeNull();
    expect(storage.getItem(projectBackupKey(project.id))).toBeNull();
  });

  it('returns false when storage rejects a save', () => {
    const project = createDefaultProject();
    expect(saveProject(project, new FailingStorage())).toBe(false);
  });

  it('records a diagnostic when project storage rejects a save', () => {
    const storage = new ProjectWriteFailingStorage();
    const project = createDefaultProject('保存失敗');

    expect(saveProject(project, storage)).toBe(false);

    const diagnostics = loadDiagnostics(storage);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe('storage-save');
    expect(diagnostics[0]?.message).toContain(projectKey(project.id));
    expect(diagnostics[0]?.message).toContain('payloadBytes=');
    expect(diagnostics[0]?.message).toContain('QuotaExceededError');
    expect(diagnostics[0]?.message).toContain('[local-path]');
    expect(diagnostics[0]?.message).not.toContain('C:\\Users\\name');
    expect(diagnostics[0]?.message).not.toContain('\n');
    expect(diagnostics[0]?.message).not.toContain('保存失敗');
  });

  it('installs lifecycle flush handlers and removes them cleanly', () => {
    const { target, dispatchBeforeUnload, dispatchPageHide } = makeBeforeUnloadTarget();
    let flushes = 0;

    const dispose = installBeforeUnloadFlush(() => {
      flushes += 1;
      return true;
    }, target);

    dispatchBeforeUnload();
    expect(flushes).toBe(1);
    dispatchPageHide();
    expect(flushes).toBe(2);

    dispose();
    dispatchBeforeUnload();
    dispatchPageHide();
    expect(flushes).toBe(2);
  });
});
