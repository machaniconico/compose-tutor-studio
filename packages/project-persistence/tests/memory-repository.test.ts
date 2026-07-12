import { describe, expect, it } from 'vitest';
import { MemoryProjectRepository } from '../src/index';
import { makeProject } from './helpers';

describe('MemoryProjectRepository contract', () => {
  it('saves, loads, lists, conflicts, and removes projects', async () => {
    const repository = new MemoryProjectRepository(
      () => new Date('2026-07-10T12:00:00.000Z'),
    );
    const project = makeProject('memory');
    const saved = await repository.save({
      project,
      activationId: 'a',
      revision: 1,
      writeId: 'w1',
      expectedHeadVersion: null,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    await expect(repository.load(project.id)).resolves.toMatchObject({
      ok: true,
      value: { project: { title: 'memory' }, headVersion: saved.value.headVersion },
    });
    await expect(repository.list()).resolves.toMatchObject({
      ok: true,
      value: [{ status: 'ready', id: project.id, title: 'memory', branches: [] }],
    });
    await expect(repository.loadProjectBranch(project.id, 'branch-v1-unknown')).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(
      repository.save({
        project: { ...project, title: 'stale' },
        activationId: 'a',
        revision: 2,
        writeId: 'w2',
        expectedHeadVersion: 'stale',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(
      repository.remove({
        projectId: project.id,
        deleteId: 'delete-1',
        expectedHeadVersion: saved.value.headVersion,
      }),
    ).resolves.toMatchObject({ ok: true, value: { removed: true } });
    await expect(repository.load(project.id)).resolves.toEqual({ ok: true, value: null });
    await expect(
      repository.save({
        project,
        activationId: 'repair',
        revision: 2,
        writeId: 'repair-after-delete',
        expectedHeadVersion: undefined,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});
