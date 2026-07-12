import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useModalDialog = vi.hoisted(() =>
  vi.fn(
    (_options: { onEscape?: () => void; escapeDisabled?: boolean }) => ({
      current: null as HTMLDivElement | null,
    }),
  ),
);

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useId: vi.fn(() => 'dialog-title-test-id'),
  };
});

vi.mock('../src/features/common/useModalDialog', () => ({ useModalDialog }));

import { Dialog } from '../src/features/common/Dialog';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  'aria-busy'?: boolean;
  'data-modal-initial-focus'?: boolean;
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
  useModalDialog.mockClear();
});

describe('Dialog close lock', () => {
  it('keeps the existing Escape, backdrop and close-button paths enabled by default', () => {
    const onClose = vi.fn();
    const tree = Dialog({ title: 'テスト', onClose, children: <p>内容</p> });
    const backdrop = findElement(tree, (element) => element.props.className === 'dialog-backdrop');
    const close = findElement(tree, (element) => element.props.className === 'dialog__close');
    const options = useModalDialog.mock.calls[0]![0];

    backdrop?.props.onClick?.();
    close?.props.onClick?.();
    options.onEscape?.();

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(options.escapeDisabled).toBe(false);
    expect(close?.props.disabled).toBe(false);
  });

  it('blocks Escape, backdrop and X while exposing an accessible busy state', () => {
    const onClose = vi.fn();
    const tree = Dialog({
      title: '消去中',
      onClose,
      closeDisabled: true,
      children: <p role="status">処理中</p>,
    });
    const backdrop = findElement(tree, (element) => element.props.className === 'dialog-backdrop');
    const panel = findElement(tree, (element) => element.props.className === 'dialog');
    const close = findElement(tree, (element) => element.props.className === 'dialog__close');
    const options = useModalDialog.mock.calls[0]![0];

    backdrop?.props.onClick?.();
    close?.props.onClick?.();
    options.onEscape?.();

    expect(onClose).not.toHaveBeenCalled();
    expect(options.escapeDisabled).toBe(true);
    expect(close?.props.disabled).toBe(true);
    expect(panel?.props['aria-busy']).toBe(true);
  });

  it('can remain locked after failure without suppressing its alert as busy', () => {
    const tree = Dialog({
      title: '消去失敗',
      onClose: () => undefined,
      closeDisabled: true,
      busy: false,
      children: <p role="alert">再試行してください</p>,
    });
    const panel = findElement(tree, (element) => element.props.className === 'dialog');

    expect(panel?.props['aria-busy']).toBeUndefined();
  });

  it('preserves the requested non-destructive initial-focus target', () => {
    const tree = Dialog({
      title: '確認',
      onClose: () => undefined,
      children: (
        <button type="button" data-modal-initial-focus>
          キャンセル
        </button>
      ),
    });
    const initialFocus = findElement(
      tree,
      (element) => element.props['data-modal-initial-focus'] === true,
    );

    expect(initialFocus?.props.children).toBe('キャンセル');
  });
});
