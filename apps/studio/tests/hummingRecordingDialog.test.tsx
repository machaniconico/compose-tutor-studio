import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  index: 0,
  overrides: new Map<number, unknown>(),
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
}));

const storeState = vi.hoisted(() => ({
  project: null as unknown,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      hookState.effects.push(effect);
    }),
    useMemo: vi.fn((factory: () => unknown) => factory()),
    useRef: vi.fn((initialValue: unknown) => {
      const ref = { current: initialValue };
      hookState.refs.push(ref);
      return ref;
    }),
    useState: vi.fn((initialValue: unknown) => {
      const index = hookState.index++;
      return [
        hookState.overrides.has(index)
          ? hookState.overrides.get(index)
          : initialValue,
        vi.fn(),
      ];
    }),
  };
});

vi.mock('../src/state/store', () => {
  const useStore = Object.assign(
    vi.fn((selector: (state: { project: unknown }) => unknown) =>
      selector({ project: storeState.project }),
    ),
    {
      getState: vi.fn(() => ({
        project: storeState.project,
        selectTrack: vi.fn(),
        selectClip: vi.fn(),
        setActiveView: vi.fn(),
      })),
    },
  );
  return { useStore };
});

import { AudioResourceReservationError } from '../src/audio/audioResourceReservation';
import { MicrophoneCaptureError } from '../src/audio/microphoneCapture';
import { HummingMelodyAssistant } from '../src/features/hummingToMelody/HummingMelodyAssistant';
import {
  HummingRecordingDialog,
  microphoneCaptureFailureMessage,
} from '../src/features/hummingToMelody/HummingRecordingDialog';
import { createDefaultProject } from '../src/state/defaultProject';

type ElementProps = {
  children?: ReactNode;
  role?: string;
  tabIndex?: number;
  'aria-label'?: string;
  'aria-live'?: string;
  'aria-valuemin'?: number;
  'aria-valuemax'?: number;
  'aria-valuenow'?: number;
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

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!isValidElement<ElementProps>(node)) return '';
  return textContent(node.props.children);
}

function renderDialog(overrides: ReadonlyMap<number, unknown> = new Map()) {
  hookState.index = 0;
  hookState.overrides = new Map(overrides);
  hookState.effects = [];
  hookState.refs = [];
  return HummingRecordingDialog({
    onClose: vi.fn(),
    onCaptured: vi.fn(),
    onChooseFile: vi.fn(),
  });
}

beforeEach(() => {
  hookState.index = 0;
  hookState.overrides = new Map();
  hookState.effects = [];
  hookState.refs = [];
  storeState.project = createDefaultProject('録音テスト');
});

describe('microphone capture failure copy', () => {
  it.each([
    [
      new MicrophoneCaptureError('permission-denied'),
      'マイクの使用が許可されませんでした。OSまたはブラウザの設定でこのアプリのマイクを許可してください。',
    ],
    [
      new MicrophoneCaptureError('device-not-found'),
      '使用できるマイクが見つかりません。マイクを接続してから再試行してください。',
    ],
    [
      new MicrophoneCaptureError('device-busy'),
      'マイクがほかの録音処理で使用中です。ほかの録音を終了してから再試行してください。',
    ],
    [
      new MicrophoneCaptureError('unsupported'),
      'この環境は直接録音に対応していません。録音済みの音声ファイルを選んでください。',
    ],
    [
      new MicrophoneCaptureError('resource-limit-exceeded'),
      'この端末では録音用のメモリを安全に確保できませんでした。ほかの音声処理を終了してください。',
    ],
    [
      new AudioResourceReservationError(),
      '別の音声処理が使用中です。処理が終わってから、もう一度録音してください。',
    ],
  ])('maps a recoverable microphone failure to actionable copy', (error, expected) => {
    expect(microphoneCaptureFailureMessage(error)).toBe(expected);
  });
});

describe('HummingRecordingDialog accessibility and recovery', () => {
  it('restores its mounted guard during the StrictMode effect replay', () => {
    renderDialog();
    const mountedRef = hookState.refs[0];
    const lifecycleEffect = hookState.effects.at(-1);
    if (!mountedRef || !lifecycleEffect) throw new Error('Lifecycle hooks were not registered.');

    const firstCleanup = lifecycleEffect();
    expect(mountedRef.current).toBe(true);
    if (typeof firstCleanup !== 'function') throw new Error('Lifecycle cleanup was not registered.');
    firstCleanup();
    expect(mountedRef.current).toBe(false);

    const secondCleanup = lifecycleEffect();
    expect(mountedRef.current).toBe(true);
    if (typeof secondCleanup === 'function') secondCleanup();
  });

  it('explains local-only capture, the 60-second limit, and file fallback before permission', () => {
    const tree = renderDialog();
    const text = textContent(tree);
    const initialFocus = findElement(
      tree,
      (element) => element.props['data-modal-initial-focus'] === true,
    );

    expect(text).toContain('録音と解析は端末内だけで行い');
    expect(text).toContain('録音データはプロジェクトへ保存しません');
    expect(text).toContain('最大60秒です');
    expect(text).toContain('録音を開始');
    expect(text).toContain('音声ファイルを使う');
    expect(initialFocus?.props.children).toBe('録音を開始');
  });

  it('exposes permission errors as alerts and puts retry in the initial focus order', () => {
    const message = microphoneCaptureFailureMessage(
      new MicrophoneCaptureError('permission-denied'),
    );
    const tree = renderDialog(new Map<number, unknown>([
      [0, 'error'],
      [4, message],
    ]));
    const alert = findElement(tree, (element) => element.props.role === 'alert');
    const initialFocus = findElement(
      tree,
      (element) => element.props['data-modal-initial-focus'] === true,
    );

    expect(textContent(alert)).toBe(message);
    expect(initialFocus?.props.children).toBe('マイクを再試行');
    expect(textContent(tree)).toContain('音声ファイルを使う');
  });

  it('announces recording state while exposing a bounded timer and input meter', () => {
    const tree = renderDialog(new Map<number, unknown>([
      [0, 'recording'],
      [2, 60],
      [3, 0.42],
    ]));
    const status = findElement(tree, (element) => element.props.role === 'status');
    const timer = findElement(tree, (element) => element.props.role === 'timer');
    const meter = findElement(tree, (element) => element.props.role === 'meter');

    expect(textContent(status)).toContain('録音中');
    expect(status?.props['aria-live']).toBe('polite');
    expect(timer?.props['aria-label']).toBe('録音時間');
    expect(textContent(timer)).toBe('1:00 / 1:00');
    expect(meter?.props['aria-label']).toBe('マイク入力レベル');
    expect(meter?.props['aria-valuemin']).toBe(0);
    expect(meter?.props['aria-valuemax']).toBe(100);
    expect(meter?.props['aria-valuenow']).toBe(42);
    expect(meter?.props.tabIndex).toBeUndefined();
  });
});

describe('humming result apply boundary', () => {
  it('keeps the destructive replacement warning and Undo promise in the result preview', () => {
    hookState.overrides = new Map<number, unknown>([
      [8, {
        fileName: 'take.wav',
        durationSeconds: 1,
        notes: [{
          startSeconds: 0,
          durationSeconds: 1,
          midi: 60,
          confidence: 1,
        }],
      }],
    ]);

    const tree = HummingMelodyAssistant();
    const text = textContent(tree);

    expect(text).toContain('反映すると対象クリップの既存音符を置き換えます');
    expect(text).toContain('元に戻す操作に対応しています');
    expect(text).toContain('メロディクリップへ反映');
  });
});
