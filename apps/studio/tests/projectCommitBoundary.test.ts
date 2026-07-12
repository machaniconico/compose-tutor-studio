import { describe, expect, it } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import { updateSection } from '@cts/project-model';
import { createStudioStore } from '../src/state/store';

describe('project commit boundary', () => {
  it('rejects an invalid candidate without poisoning the current save state', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const before = store.getState();
    const section = before.project.sections[0];
    if (!section) throw new Error('default section is missing');

    store
      .getState()
      .applyProjectChange((project) => updateSection(project, section.id, { startBar: 1 }));

    const after = store.getState();
    expect(after.project).toBe(before.project);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
    expect(after.saveState).toEqual(before.saveState);
    expect(after.persistenceNotice).toEqual({
      kind: 'warning',
      message: 'この変更はプロジェクトの範囲外になるため、反映しませんでした。現在の内容はそのままです。',
    });
  });
});
