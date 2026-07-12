import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform/runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('../src/platform/runtime')>();
  return {
    ...runtime,
    studioRuntime: { ...runtime.studioRuntime, kind: 'native' },
  };
});

import {
  ProjectMenuContent,
  canOpenLocalDataErase,
} from '../src/features/projectMenu/ProjectMenuContent';

describe('native project-menu erase entry', () => {
  it('shows the full-device erase entry in the native runtime only', () => {
    const html = renderToStaticMarkup(<ProjectMenuContent onDone={() => undefined} />);

    expect(html).toContain('この端末のデータ');
    expect(html).toContain('この端末のデータをすべて消去');
    expect(html).toContain('通常のプロジェクト削除は保存一覧からの論理削除です');
  });

  it('disables entry during another project operation or an active erase', () => {
    expect(canOpenLocalDataErase(false, 'idle')).toBe(true);
    expect(canOpenLocalDataErase(true, 'idle')).toBe(false);
    expect(canOpenLocalDataErase(false, 'quiescing')).toBe(false);
    expect(canOpenLocalDataErase(false, 'failed')).toBe(false);
    expect(canOpenLocalDataErase(false, 'erase-close-pending')).toBe(false);
    expect(canOpenLocalDataErase(false, 'erase-close-accepted')).toBe(false);
    expect(canOpenLocalDataErase(false, 'erase-close-unknown')).toBe(false);
    expect(canOpenLocalDataErase(false, 'close-handoff')).toBe(false);
  });
});
