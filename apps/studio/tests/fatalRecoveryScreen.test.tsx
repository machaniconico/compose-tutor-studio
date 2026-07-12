import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({ effect: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: hookState.effect,
    useRef: vi.fn(() => ({ current: { focus: vi.fn() } })),
    useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
  };
});

import { FatalRecoveryScreen } from '../src/platform/FatalRecoveryScreen';
import {
  __resetRuntimeDiagnosticsForTest,
  recordRuntimeDiagnostic,
} from '../src/platform/runtimeDiagnostics';

type ElementProps = {
  children?: ReactNode;
  id?: string;
  role?: string;
  tabIndex?: number;
  readOnly?: boolean;
  value?: string;
  'aria-label'?: string;
  onClick?: () => void;
};

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<ElementProps>(node)) return null;
  if (predicate(node)) return node;
  return findElement(node.props.children, predicate);
}

beforeEach(() => {
  __resetRuntimeDiagnosticsForTest();
  hookState.effect.mockClear();
});

describe('FatalRecoveryScreen', () => {
  it('announces the failure and exposes keyboard-safe recovery actions', async () => {
    recordRuntimeDiagnostic({ stage: 'startup', error: new Error('private') });
    const onReload = vi.fn();
    const copyReport = vi.fn(async () => 'copied' as const);
    const tree = FatalRecoveryScreen({ reason: 'startup', onReload, copyReport });

    expect(findElement(tree, (element) => element.props.role === 'alert')).not.toBeNull();
    expect(
      findElement(
        tree,
        (element) =>
          element.props.id === 'fatal-recovery-title' && element.props.tabIndex === -1,
      ),
    ).not.toBeNull();

    const reload = findElement(
      tree,
      (element) => element.props.children === 'アプリを再読み込み',
    );
    const copy = findElement(
      tree,
      (element) => element.props.children === '診断情報をコピー',
    );
    reload?.props.onClick?.();
    copy?.props.onClick?.();
    await Promise.resolve();

    expect(onReload).toHaveBeenCalledOnce();
    expect(copyReport).toHaveBeenCalledOnce();
    expect(hookState.effect).toHaveBeenCalledOnce();
  });

  it('shows no raw exception text in its manual-copy fallback', () => {
    recordRuntimeDiagnostic({
      stage: 'render',
      error: new Error('秘密の曲 /Users/example/song.json'),
    });
    const tree = FatalRecoveryScreen({ reason: 'render' });
    const serialized = JSON.stringify(tree);

    expect(serialized).not.toContain('秘密の曲');
    expect(serialized).not.toContain('/Users/example/song.json');
    expect(serialized).toContain('診断情報を表示');

    const manualCopy = findElement(
      tree,
      (element) => element.props['aria-label'] === 'サポートへ共有する診断情報',
    );
    expect(manualCopy?.type).toBe('textarea');
    expect(manualCopy?.props.readOnly).toBe(true);
    expect(manualCopy?.props.value).toContain('"stage": "render"');
  });
});
