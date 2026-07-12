import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@cts/project-model';
import { cloneProjectForImport } from '../src/features/export/projectImport';

describe('project-file import cloning', () => {
  it('preserves the composition and title under a fresh project id', () => {
    const source = createEmptyProject({ title: '読み込み元' });
    const cloned = cloneProjectForImport(source, 'project_imported_copy');

    expect(cloned).toEqual({ ...source, id: 'project_imported_copy' });
    expect(cloned).not.toBe(source);
    expect(cloned.id).not.toBe(source.id);
    expect(source.id).not.toBe('project_imported_copy');
  });

  it('rejects an empty or reused project id', () => {
    const source = createEmptyProject({ title: '読み込み元' });

    expect(() => cloneProjectForImport(source, '')).toThrow(/fresh project id/);
    expect(() => cloneProjectForImport(source, source.id)).toThrow(/fresh project id/);
  });
});
