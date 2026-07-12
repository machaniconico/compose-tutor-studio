import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({ queued: [] as unknown[] }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: vi.fn(),
    useRef: vi.fn((initialValue: unknown) => ({ current: initialValue })),
    useState: vi.fn((initialValue: unknown) => [
      hookState.queued.length > 0 ? hookState.queued.shift() : initialValue,
      vi.fn(),
    ]),
  };
});

import {
  ERASE_ALL_CONFIRMATION_PHRASE,
  LocalDataEraseDialog,
  canConfirmLocalDataErase,
  projectDeleteConfirmation,
} from '../src/features/projectMenu/ProjectMenuContent';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  closeDisabled?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onClose?: () => void;
  role?: string;
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

const idleState = {
  phase: 'idle' as const,
  eraseId: null,
  message: null,
};

beforeEach(() => {
  hookState.queued = [];
});

describe('local-data erase confirmation', () => {
  it('accepts only the exact typed Japanese phrase', () => {
    expect(canConfirmLocalDataErase(ERASE_ALL_CONFIRMATION_PHRASE)).toBe(true);
    expect(canConfirmLocalDataErase(' すべて消去')).toBe(false);
    expect(canConfirmLocalDataErase('すべて消去 ')).toBe(false);
    expect(canConfirmLocalDataErase('全て消去')).toBe(false);
    expect(canConfirmLocalDataErase('')).toBe(false);
  });

  it('describes ordinary project deletion as logical rather than physical erase', () => {
    const nativeMessage = projectDeleteConfirmation('下書き', 2, true);
    const webMessage = projectDeleteConfirmation('下書き', 0, false);

    expect(nativeMessage).toContain('保存一覧から削除');
    expect(nativeMessage).toContain('復旧・互換性確認の記録は端末内に残る場合があります');
    expect(nativeMessage).toContain('未保存分岐 2件');
    expect(nativeMessage).toContain('この端末のデータをすべて消去');
    expect(webMessage).not.toContain('この端末のデータをすべて消去');
  });

  it('starts with cancel as the non-destructive initial-focus target', () => {
    const tree = LocalDataEraseDialog({
      state: idleState,
      onErase: vi.fn(async () => true),
      onRequestClose: vi.fn(),
    });
    const cancel = findElement(
      tree,
      (element) => element.props['data-modal-initial-focus'] === true,
    );
    const confirm = findElement(
      tree,
      (element) => element.props.children === 'すべて消去して終了',
    );

    expect(cancel?.props.children).toBe('キャンセル');
    expect(confirm?.props.disabled).toBe(true);
  });

  it('locks every close path synchronously and prevents duplicate starts', async () => {
    hookState.queued = [ERASE_ALL_CONFIRMATION_PHRASE];
    let completeErase!: (result: boolean) => void;
    const onErase = vi.fn(
      () => new Promise<boolean>((resolve) => {
        completeErase = resolve;
      }),
    );
    const onRequestClose = vi.fn();
    const tree = LocalDataEraseDialog({ state: idleState, onErase, onRequestClose });
    const confirm = findElement(
      tree,
      (element) => element.props.children === 'すべて消去して終了',
    );

    confirm?.props.onClick?.();
    confirm?.props.onClick?.();
    (tree.props as ElementProps).onClose?.();

    expect(onErase).toHaveBeenCalledOnce();
    expect(onRequestClose).not.toHaveBeenCalled();

    completeErase(true);
    await Promise.resolve();
  });

  it('does not lock the modal when a transient project operation blocks starting', () => {
    hookState.queued = [ERASE_ALL_CONFIRMATION_PHRASE];
    const onErase = vi.fn(async () => false);
    const onRequestClose = vi.fn();
    const tree = LocalDataEraseDialog({
      state: idleState,
      onErase,
      onRequestClose,
      startDisabled: true,
    });
    const confirm = findElement(
      tree,
      (element) => element.props.children === 'すべて消去して終了',
    );

    expect(confirm?.props.disabled).toBe(true);
    confirm?.props.onClick?.();
    (tree.props as ElementProps).onClose?.();

    expect(onErase).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('does not locally lock when the lifecycle gate refuses before erase starts', async () => {
    hookState.queued = [ERASE_ALL_CONFIRMATION_PHRASE];
    const onErase = vi.fn(async () => false);
    const onRequestClose = vi.fn();
    const tree = LocalDataEraseDialog({
      state: idleState,
      onErase,
      onRequestClose,
      hasEraseStarted: () => false,
    });
    const confirm = findElement(
      tree,
      (element) => element.props.children === 'すべて消去して終了',
    );

    confirm?.props.onClick?.();
    await Promise.resolve();
    (tree.props as ElementProps).onClose?.();

    expect(onErase).toHaveBeenCalledOnce();
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('keeps a failed erase locked and retries through the same single-flight action', async () => {
    let completeRetry!: (result: boolean) => void;
    const onErase = vi.fn(
      () => new Promise<boolean>((resolve) => {
        completeRetry = resolve;
      }),
    );
    const onRequestClose = vi.fn();
    const tree = LocalDataEraseDialog({
      state: {
        phase: 'failed',
        eraseId: 'erase-1',
        message: '端末の保存領域を消去できませんでした。',
      },
      onErase,
      onRequestClose,
    });
    const dialogProps = tree.props as ElementProps;
    const alert = findElement(tree, (element) => element.props.role === 'alert');
    const retry = findElement(tree, (element) => element.props.children === '消去を再試行');

    expect(dialogProps.closeDisabled).toBe(true);
    expect(dialogProps.busy).toBe(false);
    expect(alert).not.toBeNull();
    expect(retry?.props['data-modal-initial-focus']).toBe(true);

    dialogProps.onClose?.();
    retry?.props.onClick?.();
    retry?.props.onClick?.();

    expect(onRequestClose).not.toHaveBeenCalled();
    expect(onErase).toHaveBeenCalledOnce();

    completeRetry(false);
    await Promise.resolve();
  });

  it('announces in-progress work and never offers a return to the editor', () => {
    const tree = LocalDataEraseDialog({
      state: {
        phase: 'native-pending',
        eraseId: 'erase-2',
        message: null,
      },
      onErase: vi.fn(async () => true),
      onRequestClose: vi.fn(),
    });
    const dialogProps = tree.props as ElementProps;
    const status = findElement(tree, (element) => element.props.role === 'status');

    expect(dialogProps.closeDisabled).toBe(true);
    expect(dialogProps.busy).toBe(true);
    expect(status).not.toBeNull();
    expect(findElement(tree, (element) => element.props.children === 'キャンセル')).toBeNull();
  });

  it('shows accepted window destruction as busy progress without any retry', () => {
    const onErase = vi.fn(async () => false);
    const onRequestClose = vi.fn();
    const tree = LocalDataEraseDialog({
      state: {
        phase: 'erase-close-accepted',
        eraseId: 'erase-accepted',
        message: '終了要求を受け付けました。アプリを終了しています。',
      },
      onErase,
      onRequestClose,
    });
    const dialogProps = tree.props as ElementProps;

    expect(dialogProps.closeDisabled).toBe(true);
    expect(dialogProps.busy).toBe(true);
    expect(findElement(tree, (element) => element.props.role === 'status')).not.toBeNull();
    expect(findElement(tree, (element) => element.props.role === 'alert')).toBeNull();
    expect(
      findElement(
        tree,
        (element) =>
          element.props.children ===
          '終了要求を受け付けました。アプリを終了しています…',
      ),
    ).not.toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === '終了を再試行'),
    ).toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === '消去を再試行'),
    ).toBeNull();

    dialogProps.onClose?.();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(onErase).not.toHaveBeenCalled();
  });

  it('shows an OS-quit-only alert when erase close dispatch is unknown', () => {
    const tree = LocalDataEraseDialog({
      state: {
        phase: 'erase-close-unknown',
        eraseId: 'erase-3',
        message:
          'データは消去済みです。終了要求の応答を確認できないため、OSからアプリを終了してください。',
      },
      onErase: vi.fn(async () => false),
      onRequestClose: vi.fn(),
    });
    const dialogProps = tree.props as ElementProps;

    expect(dialogProps.busy).toBe(false);
    expect(findElement(tree, (element) => element.props.role === 'alert')).not.toBeNull();
    expect(
      findElement(
        tree,
        (element) =>
          element.props.children ===
          'データは消去済みですが、終了結果を確認できません',
      ),
    ).not.toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === '終了を再試行'),
    ).toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === '消去を再試行'),
    ).toBeNull();
  });

  it('shows an OS-quit-only alert when a normal close response is unknown', () => {
    const onErase = vi.fn(async () => false);
    const onRequestClose = vi.fn();
    const tree = LocalDataEraseDialog({
      state: {
        phase: 'close-handoff',
        eraseId: null,
        message:
          'データ消去は開始していません。終了要求の応答を確認できないため、OSからアプリを終了してください。',
      },
      onErase,
      onRequestClose,
    });
    const dialogProps = tree.props as ElementProps;

    expect(dialogProps.closeDisabled).toBe(true);
    expect(dialogProps.busy).toBe(false);
    expect(findElement(tree, (element) => element.props.role === 'alert')).not.toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === 'データ消去は開始していません'),
    ).not.toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === '消去を再試行'),
    ).toBeNull();
    expect(
      findElement(tree, (element) => element.props.children === '終了を再試行'),
    ).toBeNull();

    dialogProps.onClose?.();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(onErase).not.toHaveBeenCalled();
  });
});
