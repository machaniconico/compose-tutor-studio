import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  stateOverrides: new Map<number, unknown>(),
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
}));

const actionMocks = vi.hoisted(() => ({
  handle: { operationId: 41 },
  begin: vi.fn(),
  bind: vi.fn(),
  discard: vi.fn(),
  record: vi.fn(),
  pushToast: vi.fn(),
}));

const microphoneMocks = vi.hoisted(() => ({
  start: vi.fn(),
}));

const audioMocks = vi.hoisted(() => ({
  context: {
    sampleRate: 48_000,
    state: 'running',
    baseLatency: 0.01,
    outputLatency: 0.02,
  },
  ensureContext: vi.fn(),
  startPlayback: vi.fn(),
  stopPlayback: vi.fn(),
}));

const inputDeviceMocks = vi.hoisted(() => ({
  enumerate: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  onDeviceChange: null as (() => void) | null,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      hookState.effects.push(effect);
    }),
    useRef: vi.fn((initialValue: unknown) => {
      const index = hookState.refIndex++;
      const ref = hookState.refs[index] ?? { current: initialValue };
      hookState.refs[index] = ref;
      return ref;
    }),
    useState: vi.fn((initialValue: unknown) => {
      const index = hookState.stateIndex++;
      const setter = vi.fn();
      hookState.stateSetters[index] = setter;
      return [
        hookState.stateOverrides.has(index)
          ? hookState.stateOverrides.get(index)
          : initialValue,
        setter,
      ];
    }),
  };
});

vi.mock('../src/audio/microphoneCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/microphoneCapture')>();
  return { ...actual, startMicrophoneCapture: microphoneMocks.start };
});

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({ ensureContext: audioMocks.ensureContext }),
}));

vi.mock('../src/audio/playback', () => ({
  startSynchronizedRecordingPlayback: audioMocks.startPlayback,
  stopSynchronizedRecordingPlayback: audioMocks.stopPlayback,
}));

vi.mock('../src/audio/microphoneInputDevices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/microphoneInputDevices')>();
  return {
    ...actual,
    enumerateMicrophoneInputDevices: inputDeviceMocks.enumerate,
    subscribeToMicrophoneInputDeviceChanges: inputDeviceMocks.subscribe,
  };
});

vi.mock('../src/state/audioTrackActions', () => ({
  beginStudioAudioTrackRecording: actionMocks.begin,
  bindStudioAudioTrackRecordingToPlayback: actionMocks.bind,
  discardStudioAudioTrackRecording: actionMocks.discard,
  recordStudioAudioTrack: actionMocks.record,
  studioAudioActionErrorMessage: (code: string) => `action:${code}`,
}));

vi.mock('../src/state/tutorialBridge', () => ({ pushToast: actionMocks.pushToast }));

import { MicrophoneCaptureError } from '../src/audio/microphoneCapture';
import { AudioTrackRecordingDialog } from '../src/features/audioTrack/AudioTrackRecordingDialog';

type ElementProps = {
  children?: ReactNode;
  onClick?: () => void;
  closeDisabled?: boolean;
  busy?: boolean;
  role?: string;
  'aria-live'?: string;
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

const onClose = vi.fn();
const onCreated = vi.fn();

function renderDialog(
  phase: string = 'idle',
  refs: Array<{ current: unknown }> = [],
  stateOverrides: ReadonlyMap<number, unknown> = new Map(),
) {
  hookState.stateIndex = 0;
  hookState.refIndex = 0;
  hookState.stateOverrides = new Map(stateOverrides);
  hookState.stateOverrides.set(0, phase);
  hookState.stateSetters = [];
  hookState.effects = [];
  hookState.refs = refs;
  return AudioTrackRecordingDialog({
    trackName: 'Lead Take',
    onClose,
    onCreated,
  });
}

function button(tree: ReactNode, label: string): ReactElement<ElementProps> {
  const found = findElement(
    tree,
    (element) => element.type === 'button' && textContent(element) === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  onClose.mockReset();
  onCreated.mockReset();
  actionMocks.begin.mockReturnValue({
    ok: true,
    handle: actionMocks.handle,
    startBeat: 4,
    playbackStopped: true,
  });
  actionMocks.record.mockResolvedValue({ ok: false, code: 'cancelled' });
  actionMocks.bind.mockReturnValue(true);
  audioMocks.ensureContext.mockResolvedValue({
    context: audioMocks.context,
    contextGeneration: 7,
    master: {},
  });
  audioMocks.startPlayback.mockResolvedValue({
    context: audioMocks.context,
    contextGeneration: 7,
    sampleRate: 48_000,
    anchorContextFrame: 96_000,
    anchorBeat: 4,
    tempo: {},
    requestId: 42,
    projectSnapshot: {},
  });
  audioMocks.stopPlayback.mockReturnValue(true);
  inputDeviceMocks.enumerate.mockResolvedValue([]);
  inputDeviceMocks.unsubscribe.mockReset();
  inputDeviceMocks.onDeviceChange = null;
  inputDeviceMocks.subscribe.mockImplementation((onChange: () => void) => {
    inputDeviceMocks.onDeviceChange = onChange;
    return inputDeviceMocks.unsubscribe;
  });
});

describe('AudioTrackRecordingDialog interaction boundaries', () => {
  it('synchronously ignores a same-tick double start while permission is pending', async () => {
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));
    const tree = renderDialog();
    const start = button(tree, '録音を開始');

    start.props.onClick?.();
    start.props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(actionMocks.begin).toHaveBeenCalledOnce();
    expect(microphoneMocks.start).toHaveBeenCalledOnce();
  });

  it('cancels a pending audio-context activation without leaking recording ownership', async () => {
    let resolveActivation!: (value: unknown) => void;
    audioMocks.ensureContext.mockReturnValue(new Promise((resolve) => {
      resolveActivation = resolve;
    }));
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs);
    button(idle, '録音を開始').props.onClick?.();

    const requesting = renderDialog('requesting', refs);
    button(requesting, 'キャンセル').props.onClick?.();
    await vi.waitFor(() => {
      expect(actionMocks.discard).toHaveBeenCalledWith(actionMocks.handle);
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(microphoneMocks.start).not.toHaveBeenCalled();

    resolveActivation({
      context: audioMocks.context,
      contextGeneration: 7,
      master: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(microphoneMocks.start).not.toHaveBeenCalled();
  });

  it('passes an explicit monitor opt-in to microphone capture', async () => {
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));
    const tree = renderDialog('idle', [], new Map([[1, true]]));

    button(tree, '録音を開始').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(microphoneMocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ monitorInput: true }),
    );
  });

  it('freezes the selected input and new-track destination before permission', async () => {
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));
    const tree = renderDialog('idle', [], new Map([[10, 'usb-microphone']]));

    button(tree, '録音を開始').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(actionMocks.begin).toHaveBeenCalledWith({
      target: { kind: 'new-track', trackName: 'Lead Take' },
    });
    expect(microphoneMocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ inputDeviceId: 'usb-microphone' }),
    );
  });

  it('borrows the live audio clock and binds capture to the exact playback frame', async () => {
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));
    const tree = renderDialog();

    button(tree, '録音を開始').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    const captureOptions = microphoneMocks.start.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(captureOptions).toEqual(expect.objectContaining({
      borrowedAudioContext: {
        context: audioMocks.context,
        contextGeneration: 7,
      },
      synchronize: expect.any(Function),
    }));
    const synchronize = captureOptions?.synchronize;
    if (typeof synchronize !== 'function') throw new Error('synchronizer missing');
    const armAtFrame = vi.fn(async () => undefined);
    await synchronize({
      context: audioMocks.context,
      contextGeneration: 7,
      sampleRate: 48_000,
      renderQuantumSize: 128,
      earliestStartFrame: 90_000,
      armAtFrame,
    });

    expect(audioMocks.startPlayback).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 41,
      startBeat: 4,
      signal: expect.any(AbortSignal),
      armCapture: expect.any(Function),
    }));
    const playbackOptions = audioMocks.startPlayback.mock.calls[0]?.[0];
    if (!playbackOptions || typeof playbackOptions.armCapture !== 'function') {
      throw new Error('playback arm callback missing');
    }
    await playbackOptions.armCapture(audioMocks.context, 96_000, 7);
    expect(armAtFrame).toHaveBeenCalledWith(96_000);
    expect(actionMocks.bind).toHaveBeenCalledWith(
      actionMocks.handle,
      expect.objectContaining({ requestId: 42, anchorContextFrame: 96_000 }),
    );
  });

  it('labels automatic latency as an estimate and explains manual direction', () => {
    const tree = renderDialog();
    expect(textContent(tree)).toContain('自動（推定）');
    expect(textContent(tree)).toContain('実測校正ではありません');
    expect(textContent(tree)).toContain('正の値で録音を早め、負の値で遅らせます');
  });

  it('keeps only the newest devicechange refresh and unsubscribes on cleanup', async () => {
    let resolveInitial!: (devices: readonly { deviceId: string; label: string }[]) => void;
    let resolveChanged!: (devices: readonly { deviceId: string; label: string }[]) => void;
    inputDeviceMocks.enumerate
      .mockReturnValueOnce(new Promise((resolve) => { resolveInitial = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveChanged = resolve; }));
    renderDialog();
    const deviceEffect = hookState.effects[2];
    if (!deviceEffect) throw new Error('device effect missing');
    const cleanup = deviceEffect();
    inputDeviceMocks.onDeviceChange?.();

    const changedDevices = [{ deviceId: 'usb-new', label: 'New USB Mic' }];
    resolveChanged(changedDevices);
    await Promise.resolve();
    await Promise.resolve();
    expect(hookState.stateSetters[8]).toHaveBeenCalledWith(changedDevices);

    resolveInitial([{ deviceId: 'usb-stale', label: 'Stale USB Mic' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(hookState.stateSetters[8]).not.toHaveBeenCalledWith([
      { deviceId: 'usb-stale', label: 'Stale USB Mic' },
    ]);

    if (typeof cleanup !== 'function') throw new Error('device cleanup missing');
    cleanup();
    expect(inputDeviceMocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps a disappeared explicit input selected and asks for a deliberate recovery', () => {
    const tree = renderDialog('idle', [], new Map<number, unknown>([
      [8, []],
      [9, 'ready'],
      [10, 'missing-usb-microphone'],
    ]));

    expect(textContent(tree)).toContain('前回選択した入力（一覧で未確認）');
    expect(textContent(tree)).toContain('選択した入力を現在の一覧で確認できません');
    expect(textContent(tree)).toContain('システム既定');
  });

  it('aborts permission wait, releases ownership after cancellation settles, and closes', async () => {
    let rejectPermission!: (error: unknown) => void;
    microphoneMocks.start.mockReturnValue(new Promise((_, reject) => {
      rejectPermission = reject;
    }));
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs);
    button(idle, '録音を開始').props.onClick?.();
    await vi.waitFor(() => expect(microphoneMocks.start).toHaveBeenCalledOnce());

    const abort = vi.fn();
    refs[4] = { current: { abort } };
    const requesting = renderDialog('requesting', refs);
    expect(requesting.props.closeDisabled).toBe(true);
    button(requesting, 'キャンセル').props.onClick?.();
    expect(abort).toHaveBeenCalledOnce();

    rejectPermission(new MicrophoneCaptureError('cancelled'));
    await vi.waitFor(() => {
      expect(actionMocks.discard).toHaveBeenCalledWith(actionMocks.handle);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('keeps ownership through unmount until active capture cleanup settles', async () => {
    let rejectCapture!: (error: unknown) => void;
    const cancel = vi.fn();
    const result = new Promise<never>((_, reject) => {
      rejectCapture = reject;
    });
    microphoneMocks.start.mockResolvedValue({
      startedAt: 0,
      maxDurationSeconds: 60,
      result,
      elapsedSeconds: () => 0,
      stop: vi.fn(async () => undefined),
      cancel,
    });
    const refs: Array<{ current: unknown }> = [];
    const tree = renderDialog('idle', refs);
    const lifecycleEffect = hookState.effects.at(-1);
    if (!lifecycleEffect) throw new Error('lifecycle effect missing');
    const cleanup = lifecycleEffect();
    if (typeof cleanup !== 'function') throw new Error('lifecycle cleanup missing');

    button(tree, '録音を開始').props.onClick?.();
    await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());
    cleanup();

    expect(cancel).toHaveBeenCalledOnce();
    expect(actionMocks.discard).not.toHaveBeenCalled();

    rejectCapture(new MicrophoneCaptureError('cancelled'));
    await vi.waitFor(() => {
      expect(actionMocks.discard).toHaveBeenCalledOnce();
      expect(actionMocks.discard).toHaveBeenCalledWith(actionMocks.handle);
    });
  });

  it('offers distinct stop/save and discard controls for an active session', () => {
    const stop = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const refs: Array<{ current: unknown }> = [];
    refs[3] = { current: 42 };
    refs[5] = { current: { stop, cancel } };
    const tree = renderDialog('recording', refs);

    button(tree, '録音を終了して保存').props.onClick?.();
    button(tree, '録音を破棄').props.onClick?.();

    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(audioMocks.stopPlayback).toHaveBeenCalledOnce();
    expect(audioMocks.stopPlayback).toHaveBeenCalledWith(42);
    expect(tree.props.closeDisabled).toBe(true);
  });

  it('never saves a successful late result after the user chose discard', async () => {
    let resolveCapture!: (capture: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      resolveCapture = resolve;
    });
    const cancel = vi.fn();
    microphoneMocks.start.mockResolvedValue({
      startedAt: 0,
      maxDurationSeconds: 60,
      result,
      elapsedSeconds: () => 1,
      stop: vi.fn(async () => undefined),
      cancel,
    });
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs);
    button(idle, '録音を開始').props.onClick?.();
    await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());

    const recording = renderDialog('recording', refs);
    button(recording, '録音を破棄').props.onClick?.();
    resolveCapture({
      numberOfChannels: 1,
      length: 48_000,
      sampleRate: 48_000,
      durationSeconds: 1,
      stopReason: 'manual',
      contextGeneration: 1,
      firstContextFrame: 0,
      endContextFrameExclusive: 48_000,
      inputLatencySeconds: null,
      getChannelData: () => new Float32Array(48_000),
    });
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(actionMocks.discard).toHaveBeenCalledOnce();
      expect(actionMocks.record).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('announces countdown units and moves focus to the stop control', () => {
    const countdown = renderDialog('countdown');
    const status = findElement(countdown, (element) => element.props.role === 'status');
    expect(textContent(status)).toContain('録音開始まで3秒');
    expect(status?.props['aria-live']).toBe('assertive');

    const focus = vi.fn();
    const refs: Array<{ current: unknown }> = [];
    refs[10] = { current: { focus } };
    renderDialog('recording', refs);
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
    try {
      hookState.effects[1]?.();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('announces synchronization preparation after the countdown', () => {
    const preparing = renderDialog('preparing');
    const status = findElement(preparing, (element) => element.props.role === 'status');

    expect(textContent(status)).toContain('伴奏と録音を同期する準備をしています');
    expect(status?.props['aria-live']).toBe('polite');
  });

  it('uses recording-specific recovery copy when capture memory is unavailable', () => {
    actionMocks.begin.mockReturnValue({ ok: false, code: 'resource-limit-exceeded' });
    const tree = renderDialog();

    button(tree, '録音を開始').props.onClick?.();

    expect(hookState.stateSetters[7]).toHaveBeenCalledWith(
      '録音用のメモリを安全に確保できませんでした。ほかの音声処理を終了してから再試行してください。',
    );
    expect(hookState.stateSetters[6]).toHaveBeenCalledWith('録音は開始していません。');
    expect(hookState.stateSetters[0]).toHaveBeenCalledWith('error');
    expect(microphoneMocks.start).not.toHaveBeenCalled();
  });

  it('explains a stale armed destination without requesting microphone permission', () => {
    actionMocks.begin.mockReturnValue({ ok: false, code: 'track-not-found' });
    const tree = renderDialog();

    button(tree, '録音を開始').props.onClick?.();

    expect(hookState.stateSetters[7]).toHaveBeenCalledWith('action:track-not-found');
    expect(hookState.stateSetters[6]).toHaveBeenCalledWith('録音は開始していません。');
    expect(microphoneMocks.start).not.toHaveBeenCalled();
  });
});
