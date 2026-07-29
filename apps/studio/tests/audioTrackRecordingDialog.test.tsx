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
  prepareCycle: vi.fn(),
  preparePunch: vi.fn(),
  bind: vi.fn(),
  discard: vi.fn(),
  beginCalibration: vi.fn(),
  commitCalibration: vi.fn(),
  discardCalibration: vi.fn(),
  markPostroll: vi.fn(),
  record: vi.fn(),
  pushToast: vi.fn(),
}));

const microphoneMocks = vi.hoisted(() => ({
  start: vi.fn(),
  startCalibration: vi.fn(),
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

vi.mock('../src/audio/recordingLatencyCalibration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/recordingLatencyCalibration')>();
  return {
    ...actual,
    startRecordingLatencyCalibration: microphoneMocks.startCalibration,
  };
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
  beginStudioRecordingLatencyCalibration: actionMocks.beginCalibration,
  bindStudioAudioTrackRecordingToPlayback: actionMocks.bind,
  commitStudioRecordingLatencyCalibration: actionMocks.commitCalibration,
  discardStudioAudioTrackRecording: actionMocks.discard,
  discardStudioRecordingLatencyCalibration: actionMocks.discardCalibration,
  markStudioAudioTrackPunchPostrollComplete: actionMocks.markPostroll,
  prepareStudioAudioTrackCycleCapture: actionMocks.prepareCycle,
  prepareStudioAudioTrackPunchCapture: actionMocks.preparePunch,
  recordStudioAudioTrack: actionMocks.record,
  studioAudioActionErrorMessage: (code: string) => `action:${code}`,
}));

vi.mock('../src/state/tutorialBridge', () => ({ pushToast: actionMocks.pushToast }));

import { MicrophoneCaptureError } from '../src/audio/microphoneCapture';
import { RecordingLatencyCalibrationError } from '../src/audio/recordingLatencyCalibration';
import { AudioTrackRecordingDialog } from '../src/features/audioTrack/AudioTrackRecordingDialog';
import { useStore } from '../src/state/store';

type ElementProps = {
  children?: ReactNode;
  onClick?: () => void;
  onChange?: (event: { currentTarget: { value: string } }) => void;
  disabled?: boolean;
  id?: string;
  value?: unknown;
  min?: unknown;
  max?: unknown;
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
  targetTrackId?: string,
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
    ...(targetTrackId === undefined ? {} : { targetTrackId }),
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

const autoPunch = Object.freeze({
  targetTrackId: 'audio-track-1',
  playbackStartBeat: 0,
  punchInBeat: 1,
  punchOutBeat: 4,
  playbackEndBeat: 5,
});

function enableAutoPunch(
  overrides: Partial<Readonly<{
    punchInBeat: number;
    punchOutBeat: number;
    punchPreRollBeats: number;
    punchPostRollBeats: number;
  }>> = {},
): void {
  useStore.setState({
    transport: {
      ...useStore.getState().transport,
      phase: 'stopped',
      isPlaying: false,
      loopEnabled: false,
      punchEnabled: true,
      punchInBeat: 1,
      punchOutBeat: 4,
      punchPreRollBeats: 2,
      punchPostRollBeats: 1,
      ...overrides,
    },
  });
}

function punchCapture(stopReason: 'manual' | 'duration-limit' = 'duration-limit') {
  return {
    numberOfChannels: 1,
    length: 72_960,
    sampleRate: 48_000,
    durationSeconds: 1.52,
    stopReason,
    contextGeneration: 7,
    firstContextFrame: 96_000,
    endContextFrameExclusive: 168_960,
    inputLatencySeconds: 0.02,
    getChannelData: () => new Float32Array(72_960),
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockAutoPunchOwnership(): void {
  actionMocks.begin.mockReturnValue({
    ok: true,
    handle: actionMocks.handle,
    startBeat: autoPunch.playbackStartBeat,
    playbackStopped: false,
    cycle: null,
    punch: autoPunch,
  });
}

type PunchPlaybackHarnessOptions = Readonly<{
  projectSnapshot: unknown;
  armCapture: (
    context: unknown,
    startFrame: number,
    contextGeneration: number,
  ) => Promise<void>;
  onFinitePunchComplete?: (requestId: number) => void;
}>;

function installSynchronizedPunchSession(
  result: Promise<ReturnType<typeof punchCapture>>,
) {
  const cancel = vi.fn();
  const stop = vi.fn(async () => punchCapture('manual'));
  let playbackOptions: PunchPlaybackHarnessOptions | null = null;

  audioMocks.startPlayback.mockImplementation(async (rawOptions: unknown) => {
    const options = rawOptions as PunchPlaybackHarnessOptions;
    playbackOptions = options;
    await options.armCapture(audioMocks.context, 96_000, 7);
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        phase: 'playing',
        isPlaying: true,
        positionBeat: autoPunch.playbackStartBeat,
        playbackRequestId: 42,
      },
    });
    return {
      context: audioMocks.context,
      contextGeneration: 7,
      sampleRate: 48_000,
      anchorContextFrame: 96_000,
      anchorBeat: autoPunch.playbackStartBeat,
      tempo: {},
      requestId: 42,
      projectSnapshot: options.projectSnapshot,
    };
  });
  microphoneMocks.start.mockImplementation(async (rawOptions: unknown) => {
    const options = rawOptions as Readonly<{
      synchronize: (input: Readonly<{
        context: unknown;
        contextGeneration: number;
        sampleRate: number;
        inputLatencySeconds: number;
        renderQuantumSize: number;
        earliestStartFrame: number;
        armAtFrame: (startFrame: number, maximumFrames?: number) => Promise<void>;
      }>) => Promise<void>;
    }>;
    await options.synchronize({
      context: audioMocks.context,
      contextGeneration: 7,
      sampleRate: 48_000,
      inputLatencySeconds: 0.02,
      renderQuantumSize: 128,
      earliestStartFrame: 90_000,
      armAtFrame: async () => undefined,
    });
    return {
      startedAt: 0,
      maxDurationSeconds: 60,
      result,
      elapsedSeconds: () => 0.5,
      stop,
      cancel,
    };
  });

  return {
    cancel,
    stop,
    getPlaybackOptions: () => playbackOptions,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  onClose.mockReset();
  onCreated.mockReset();
  microphoneMocks.start.mockReset();
  actionMocks.begin.mockReturnValue({
    ok: true,
    handle: actionMocks.handle,
    startBeat: 4,
    playbackStopped: true,
    cycle: null,
    punch: null,
  });
  actionMocks.prepareCycle.mockReturnValue({
    ok: true,
    cycle: { loopStartBeat: 0, loopEndBeat: 4, passCount: 3 },
    effectiveCaptureFrameCount: 288_960,
    durationSeconds: 6.02,
  });
  actionMocks.preparePunch.mockReturnValue({
    ok: true,
    punch: {
      targetTrackId: 'audio-track-1',
      playbackStartBeat: 0,
      punchInBeat: 1,
      punchOutBeat: 4,
      playbackEndBeat: 5,
    },
    effectiveCaptureFrameCount: 72_960,
    durationSeconds: 1.52,
  });
  actionMocks.record.mockResolvedValue({ ok: false, code: 'cancelled' });
  actionMocks.bind.mockReturnValue(true);
  actionMocks.beginCalibration.mockReturnValue({
    ok: true,
    handle: { operationId: 51 },
    inputDeviceId: 'usb-loopback',
    playbackStopped: false,
  });
  actionMocks.commitCalibration.mockReturnValue(true);
  actionMocks.markPostroll.mockReturnValue(true);
  microphoneMocks.startCalibration.mockReturnValue(new Promise(() => undefined));
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
  useStore.setState({
    audioRecordingOperationId: null,
    recordingLatencyCalibration: null,
    recordingLatencyCompensationMode: 'estimated',
    preferredMicrophoneInputDeviceId: null,
    transport: {
      ...useStore.getState().transport,
      phase: 'stopped',
      isPlaying: false,
      positionBeat: 0,
      loopEnabled: false,
      loopStartBeat: 0,
      loopEndBeat: 4,
      punchEnabled: false,
      punchInBeat: 0,
      punchOutBeat: 4,
      punchPreRollBeats: 4,
      punchPostRollBeats: 4,
    },
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

  it('offers a bounded fixed-pass cycle when the transport loop is enabled', async () => {
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        loopEnabled: true,
        loopStartBeat: 0,
        loopEndBeat: 4,
      },
    });
    actionMocks.begin.mockReturnValue({
      ok: true,
      handle: actionMocks.handle,
      startBeat: 0,
      playbackStopped: false,
      cycle: { loopStartBeat: 0, loopEndBeat: 4, passCount: 3 },
      punch: null,
    });
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));

    const tree = renderDialog();
    const passInput = findElement(
      tree,
      (element) => element.type === 'input'
        && element.props.id === 'audio-track-recording-cycle-pass-count',
    );

    expect(passInput?.props.min).toBe(2);
    expect(passInput?.props.value).toBe(3);
    expect(textContent(tree)).toContain('完了後に各周を編集可能なテイクとしてまとめます');
    expect(textContent(tree)).toContain('途中停止・キャンセルでは全テイクを破棄');

    button(tree, '3テイクを録音').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(actionMocks.begin).toHaveBeenCalledWith({
      target: { kind: 'new-track', trackName: 'Lead Take' },
      cyclePassCount: 3,
    });
  });

  it('freezes the cycle plan before playback and arms its exact capture frames', async () => {
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        loopEnabled: true,
        loopStartBeat: 0,
        loopEndBeat: 4,
      },
    });
    const cycle = { loopStartBeat: 0, loopEndBeat: 4, passCount: 3 };
    actionMocks.begin.mockReturnValue({
      ok: true,
      handle: actionMocks.handle,
      startBeat: 0,
      playbackStopped: false,
      cycle,
      punch: null,
    });
    actionMocks.prepareCycle.mockReturnValue({
      ok: true,
      cycle,
      effectiveCaptureFrameCount: 288_960,
      durationSeconds: 6.02,
    });
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));
    const tree = renderDialog();

    button(tree, '3テイクを録音').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    const captureOptions = microphoneMocks.start.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const synchronize = captureOptions?.synchronize;
    if (typeof synchronize !== 'function') throw new Error('synchronizer missing');
    const armAtFrame = vi.fn(async () => undefined);
    await synchronize({
      context: audioMocks.context,
      contextGeneration: 7,
      sampleRate: 48_000,
      inputLatencySeconds: 0.01,
      renderQuantumSize: 128,
      earliestStartFrame: 90_000,
      armAtFrame,
    });

    expect(actionMocks.prepareCycle).toHaveBeenCalledWith(actionMocks.handle, {
      context: audioMocks.context,
      contextGeneration: 7,
      inputLatencySeconds: 0.01,
    });
    expect(audioMocks.startPlayback).toHaveBeenCalledWith(expect.objectContaining({
      startBeat: 0,
      cycle,
      onFiniteCycleComplete: expect.any(Function),
    }));
    const playbackOptions = audioMocks.startPlayback.mock.calls[0]?.[0];
    if (!playbackOptions || typeof playbackOptions.armCapture !== 'function') {
      throw new Error('playback arm callback missing');
    }
    await playbackOptions.armCapture(audioMocks.context, 96_000, 7);
    expect(armAtFrame).toHaveBeenCalledWith(96_000, 288_960);
  });

  it('shows the armed existing-track punch range and disables ineligible targets or ranges', () => {
    enableAutoPunch();
    const eligible = renderDialog('idle', [], new Map(), autoPunch.targetTrackId);

    expect(textContent(eligible)).toContain('既存トラック「Lead Take」');
    expect(textContent(eligible)).toContain('オートパンチ録音');
    expect(textContent(eligible)).toContain('1〜4拍');
    expect(textContent(eligible)).toContain('プリロール 2拍');
    expect(textContent(eligible)).toContain('パンチアウト後も 1拍');
    expect(textContent(eligible)).toContain('既存素材は元テイクとして残し、新しい録音を採用します');
    expect(button(eligible, 'オートパンチを開始').props.disabled).not.toBe(true);

    const newTrack = renderDialog();
    expect(button(newTrack, 'オートパンチを開始').props.disabled).toBe(true);
    expect(textContent(newTrack)).toContain('既存のオーディオトラックをRで録音待機');

    enableAutoPunch({ punchInBeat: 1, punchOutBeat: 1.5 });
    const tooShort = renderDialog('idle', [], new Map(), autoPunch.targetTrackId);
    expect(button(tooShort, 'オートパンチを開始').props.disabled).toBe(true);
    expect(textContent(tooShort)).toContain('パンチ範囲を0.5〜60秒へ設定');
  });

  it('rejects a 60-second punch before permission when latency needs capture tail', () => {
    const currentProject = useStore.getState().project;
    const bpm = currentProject.lengthBeats;
    useStore.setState({
      project: {
        ...currentProject,
        bpm,
        tempoMap: currentProject.tempoMap.map((event, index) => (
          index === 0 ? { ...event, bpm } : event
        )),
      },
      recordingLatencyCompensationMode: 'estimated',
      recordingLatencyAdjustmentMs: 0,
    });
    enableAutoPunch({
      punchInBeat: 0,
      punchOutBeat: currentProject.lengthBeats,
      punchPreRollBeats: 0,
      punchPostRollBeats: 0,
    });

    const estimated = renderDialog(
      'idle',
      [],
      new Map(),
      autoPunch.targetTrackId,
    );
    expect(button(estimated, 'オートパンチを開始').props.disabled).toBe(true);
    expect(textContent(estimated)).toContain(
      '正の録音タイミング補正の末尾収録を含めて最大60秒',
    );

    useStore.setState({
      recordingLatencyCompensationMode: 'off',
      recordingLatencyAdjustmentMs: 0,
    });
    const noTail = renderDialog(
      'idle',
      [],
      new Map(),
      autoPunch.targetTrackId,
    );
    expect(button(noTail, 'オートパンチを開始').props.disabled).not.toBe(true);
    useStore.setState({ project: currentProject });
  });

  it('freezes the punch proof before playback and arms the exact effective frame count', async () => {
    enableAutoPunch();
    actionMocks.begin.mockReturnValue({
      ok: true,
      handle: actionMocks.handle,
      startBeat: autoPunch.playbackStartBeat,
      playbackStopped: false,
      cycle: null,
      punch: autoPunch,
    });
    actionMocks.preparePunch.mockReturnValue({
      ok: true,
      punch: autoPunch,
      effectiveCaptureFrameCount: 72_960,
      durationSeconds: 1.52,
    });
    microphoneMocks.start.mockReturnValue(new Promise(() => undefined));
    const tree = renderDialog('idle', [], new Map(), autoPunch.targetTrackId);

    button(tree, 'オートパンチを開始').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(actionMocks.begin).toHaveBeenCalledWith({
      target: { kind: 'existing-audio-track', trackId: autoPunch.targetTrackId },
    });
    const captureOptions = microphoneMocks.start.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const synchronize = captureOptions?.synchronize;
    if (typeof synchronize !== 'function') throw new Error('punch synchronizer missing');
    const armAtFrame = vi.fn(async () => undefined);
    await synchronize({
      context: audioMocks.context,
      contextGeneration: 7,
      sampleRate: 48_000,
      inputLatencySeconds: 0.02,
      renderQuantumSize: 128,
      earliestStartFrame: 90_000,
      armAtFrame,
    });

    expect(actionMocks.preparePunch).toHaveBeenCalledWith(actionMocks.handle, {
      context: audioMocks.context,
      contextGeneration: 7,
      inputLatencySeconds: 0.02,
    });
    expect(audioMocks.startPlayback).toHaveBeenCalledWith(expect.objectContaining({
      startBeat: autoPunch.playbackStartBeat,
      punch: autoPunch,
      onFinitePunchComplete: expect.any(Function),
    }));
    const playbackOptions = audioMocks.startPlayback.mock.calls[0]?.[0];
    if (!playbackOptions || typeof playbackOptions.armCapture !== 'function') {
      throw new Error('punch playback arm callback missing');
    }
    await playbackOptions.armCapture(audioMocks.context, 96_000, 7);
    expect(armAtFrame).toHaveBeenCalledWith(96_000, 72_960);
  });

  it('announces every Auto Punch wait, capture-tail, and post-roll state in Japanese', () => {
    enableAutoPunch();
    const refs: Array<{ current: unknown }> = [];
    refs[20] = { current: autoPunch };

    const countdown = renderDialog(
      'countdown',
      refs,
      new Map([[2, 2]]),
      autoPunch.targetTrackId,
    );
    expect(textContent(countdown)).toContain('プリロール開始まで2秒');

    const preparing = renderDialog('preparing', refs, new Map(), autoPunch.targetTrackId);
    expect(textContent(preparing)).toContain('パンチイン待機中・プリロールを再生しています');
    expect(textContent(preparing)).toContain('指定範囲 1〜4拍だけを録音します');

    const recording = renderDialog(
      'recording',
      refs,
      new Map([[3, 0.5]]),
      autoPunch.targetTrackId,
    );
    expect(textContent(recording)).toContain('パンチ録音中・伴奏再生中');

    const latencyTail = renderDialog(
      'recording',
      refs,
      new Map([[3, 1.6]]),
      autoPunch.targetTrackId,
    );
    expect(textContent(latencyTail)).toContain('パンチアウト済み・入力遅延の末尾を収録中');

    const postroll = renderDialog('postroll', refs, new Map(), autoPunch.targetTrackId);
    expect(textContent(postroll)).toContain('ポストロール再生中・録音範囲は完了しました');
    expect(textContent(postroll)).toContain('完了後に新しいテイクとして保存します');
  });

  it('labels automatic latency as an estimate and explains manual direction', () => {
    const tree = renderDialog();
    expect(textContent(tree)).toContain('自動（推定）');
    expect(textContent(tree)).toContain('実測校正ではありません');
    expect(textContent(tree)).toContain('実測校正…');
    expect(textContent(tree)).toContain('入力デバイスを明示選択してください');
    expect(textContent(tree)).toContain('正の値で録音を早め、負の値で遅らせます');
    expect(button(tree, '実測校正…').props.disabled).toBe(true);
  });

  it('shows cable, low-volume, no-speaker and output-change guidance before calibration', () => {
    const tree = renderDialog('idle', [], new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));

    expect(textContent(tree)).toContain('出力から「前回選択した入力');
    expect(textContent(tree)).toContain('へ戻る時間');
    expect(textContent(tree)).toContain('ケーブルを接続');
    expect(textContent(tree)).toContain('音量を低め');
    expect(textContent(tree)).toContain('開放スピーカーとマイクでは実行しない');
    expect(textContent(tree)).toContain('Direct Monitor / LoopbackをOFF');
    expect(textContent(tree)).toContain('出力先、入力先、ドライバー設定を変えた場合は再校正');
    expect(textContent(tree)).toContain('プロジェクトも変更しません');
  });

  it('starts calibration for the frozen selected input without enabling monitoring', async () => {
    actionMocks.beginCalibration.mockReturnValue({
      ok: true,
      handle: { operationId: 51 },
      inputDeviceId: 'usb-loopback',
      playbackStopped: false,
    });
    const tree = renderDialog('idle', [], new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));

    button(tree, '3秒後に実測').props.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(actionMocks.beginCalibration).toHaveBeenCalledOnce();
    expect(microphoneMocks.startCalibration).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        inputDeviceId: 'usb-loopback',
        onCountdown: expect.any(Function),
        onPreparing: expect.any(Function),
        onLevel: expect.any(Function),
      }),
    );
    expect(microphoneMocks.startCalibration.mock.calls[0]?.[0]).not.toHaveProperty(
      'monitorInput',
    );
  });

  it('commits a successful calibration once and keeps its runtime profile out of recording assets', async () => {
    microphoneMocks.startCalibration.mockResolvedValue({
      latencyFrames: 4_800,
      roundTripLatencySeconds: 0.1,
      confidence: 0.93,
      sampleRate: 48_000,
      contextGeneration: 7,
    });
    const refs: Array<{ current: unknown }> = [];
    const tree = renderDialog('idle', refs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));

    button(tree, '3秒後に実測').props.onClick?.();
    await vi.waitFor(() => {
      expect(actionMocks.commitCalibration).toHaveBeenCalledWith(
        { operationId: 51 },
        expect.objectContaining({
          latencyFrames: 4_800,
          sampleRate: 48_000,
          contextGeneration: 7,
        }),
      );
    });
    expect(actionMocks.record).not.toHaveBeenCalled();
    expect(actionMocks.discardCalibration).not.toHaveBeenCalled();
  });

  it('discards failed calibration ownership without replacing the previous profile', async () => {
    microphoneMocks.startCalibration.mockRejectedValue(
      new RecordingLatencyCalibrationError('silence'),
    );
    const tree = renderDialog('idle', [], new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));

    button(tree, '3秒後に実測').props.onClick?.();
    await vi.waitFor(() => {
      expect(actionMocks.discardCalibration).toHaveBeenCalledWith({ operationId: 51 });
    });
    expect(actionMocks.commitCalibration).not.toHaveBeenCalled();
    expect(actionMocks.record).not.toHaveBeenCalled();
  });

  it('does not commit a late calibration success after the user cancels', async () => {
    let resolveCalibration!: (value: {
      latencyFrames: number;
      roundTripLatencySeconds: number;
      confidence: number;
      sampleRate: number;
      contextGeneration: number;
    }) => void;
    microphoneMocks.startCalibration.mockReturnValue(new Promise((resolve) => {
      resolveCalibration = resolve;
    }));
    const refs: Array<{ current: unknown }> = [];
    const instructions = renderDialog('idle', refs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));
    button(instructions, '3秒後に実測').props.onClick?.();
    await vi.waitFor(() => expect(microphoneMocks.startCalibration).toHaveBeenCalledOnce());

    const running = renderDialog('idle', refs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'running'],
    ]));
    button(running, '校正を中止').props.onClick?.();
    resolveCalibration({
      latencyFrames: 4_800,
      roundTripLatencySeconds: 0.1,
      confidence: 0.93,
      sampleRate: 48_000,
      contextGeneration: 7,
    });

    await vi.waitFor(() => {
      expect(actionMocks.discardCalibration).toHaveBeenCalledWith({ operationId: 51 });
    });
    expect(actionMocks.commitCalibration).not.toHaveBeenCalled();
  });

  it('preserves a prior profile on user cancel but clears it on devicechange', async () => {
    const priorProfile = Object.freeze({
      inputDeviceId: 'usb-loopback',
      latencyFrames: 2_400,
      sampleRate: 48_000,
      contextGeneration: 7,
      confidence: 0.95,
    });
    useStore.setState({
      recordingLatencyCalibration: priorProfile,
      recordingLatencyCompensationMode: 'calibrated',
      preferredMicrophoneInputDeviceId: 'usb-loopback',
    });
    microphoneMocks.startCalibration.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new RecordingLatencyCalibrationError('cancelled')),
          { once: true },
        );
      })
    );
    const userCancelRefs: Array<{ current: unknown }> = [];
    const userInstructions = renderDialog('idle', userCancelRefs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));
    button(userInstructions, '3秒後に実測').props.onClick?.();
    await vi.waitFor(() => expect(microphoneMocks.startCalibration).toHaveBeenCalledOnce());
    const userRunning = renderDialog('idle', userCancelRefs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'running'],
    ]));
    button(userRunning, '校正を中止').props.onClick?.();
    await vi.waitFor(() => expect(actionMocks.discardCalibration).toHaveBeenCalledOnce());
    expect(useStore.getState().recordingLatencyCalibration).toBe(priorProfile);

    actionMocks.discardCalibration.mockClear();
    microphoneMocks.startCalibration.mockClear();
    const routeChangeRefs: Array<{ current: unknown }> = [];
    const routeInstructions = renderDialog('idle', routeChangeRefs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'instructions'],
    ]));
    button(routeInstructions, '3秒後に実測').props.onClick?.();
    await vi.waitFor(() => expect(microphoneMocks.startCalibration).toHaveBeenCalledOnce());
    renderDialog('idle', routeChangeRefs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [13, 'running'],
    ]));
    const deviceEffect = hookState.effects[3];
    if (!deviceEffect) throw new Error('device effect missing');
    const cleanup = deviceEffect();
    inputDeviceMocks.onDeviceChange?.();

    await vi.waitFor(() => expect(actionMocks.discardCalibration).toHaveBeenCalledOnce());
    expect(useStore.getState().recordingLatencyCalibration).toBeNull();
    expect(useStore.getState().recordingLatencyCompensationMode).toBe('estimated');
    if (typeof cleanup === 'function') cleanup();
  });

  it.each(['instructions', 'running', 'success', 'error'] as const)(
    'moves focus into the %s calibration step',
    (view) => {
      const focus = vi.fn();
      const refs: Array<{ current: unknown }> = [];
      renderDialog('idle', refs, new Map<number, unknown>([
        [10, 'usb-loopback'],
        [13, view],
      ]));
      for (const ref of hookState.refs) ref.current = { focus };
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
    },
  );

  it('restores focus to recording settings after the calibration view closes', () => {
    const startFocus = vi.fn();
    const calibrationFocus = vi.fn();
    const refs: Array<{ current: unknown }> = [];
    renderDialog('idle', refs);
    if (!refs[8] || !refs[17]) throw new Error('focus refs missing');
    refs[8].current = { focus: startFocus };
    refs[17].current = { focus: calibrationFocus };
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
    try {
      hookState.effects[1]?.();
      expect(startFocus).toHaveBeenCalledOnce();
      expect(calibrationFocus).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps only the newest devicechange refresh and unsubscribes on cleanup', async () => {
    let resolveInitial!: (devices: readonly { deviceId: string; label: string }[]) => void;
    let resolveChanged!: (devices: readonly { deviceId: string; label: string }[]) => void;
    inputDeviceMocks.enumerate
      .mockReturnValueOnce(new Promise((resolve) => { resolveInitial = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveChanged = resolve; }));
    renderDialog();
    const deviceEffect = hookState.effects[3];
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

  it('synchronizes a cleared app-wide calibration while the device effect is inactive', () => {
    useStore.setState({
      recordingLatencyCalibration: Object.freeze({
        inputDeviceId: 'usb-loopback',
        latencyFrames: 2_400,
        sampleRate: 48_000,
        contextGeneration: 7,
        confidence: 0.95,
      }),
      recordingLatencyCompensationMode: 'calibrated',
      preferredMicrophoneInputDeviceId: 'usb-loopback',
    });
    renderDialog('requesting', [], new Map<number, unknown>([
      [10, 'usb-loopback'],
      [11, 'calibrated'],
    ]));
    expect(hookState.effects[3]?.()).toBeUndefined();
    const synchronizeEffect = hookState.effects[4];
    if (!synchronizeEffect) throw new Error('latency synchronization effect missing');
    const cleanup = synchronizeEffect();

    expect(useStore.getState().clearRecordingLatencyCalibration()).toBe(true);
    expect(hookState.stateSetters[11]).toHaveBeenLastCalledWith('estimated');

    if (typeof cleanup !== 'function') {
      throw new Error('latency synchronization cleanup missing');
    }
    cleanup();
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

  it('never offers partial-save semantics while a cycle is recording', () => {
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        loopEnabled: true,
        loopStartBeat: 0,
        loopEndBeat: 4,
      },
    });
    const stop = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const refs: Array<{ current: unknown }> = [];
    refs[5] = {
      current: {
        stop,
        cancel,
        elapsedSeconds: () => 1,
      },
    };
    refs[19] = {
      current: { loopStartBeat: 0, loopEndBeat: 4, passCount: 3 },
    };
    const tree = renderDialog('recording', refs);

    expect(textContent(tree)).not.toContain('録音を終了して保存');
    button(tree, 'サイクル録音を中止して破棄').props.onClick?.();

    expect(cancel).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it('atomically discards Auto Punch when the user manually stops it', async () => {
    enableAutoPunch();
    mockAutoPunchOwnership();
    const capture = deferred<ReturnType<typeof punchCapture>>();
    const harness = installSynchronizedPunchSession(capture.promise);
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs, new Map(), autoPunch.targetTrackId);

    button(idle, 'オートパンチを開始').props.onClick?.();
    await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());

    const recording = renderDialog(
      'recording',
      refs,
      new Map([[3, 0.5]]),
      autoPunch.targetTrackId,
    );
    expect(textContent(recording)).not.toContain('録音を終了して保存');
    button(recording, 'パンチ録音を中止して破棄').props.onClick?.();
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.stop).not.toHaveBeenCalled();

    capture.reject(new MicrophoneCaptureError('cancelled'));
    await vi.waitFor(() => {
      expect(actionMocks.discard).toHaveBeenCalledOnce();
      expect(actionMocks.discard).toHaveBeenCalledWith(actionMocks.handle);
      expect(actionMocks.record).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('atomically discards Auto Punch when permission waiting is cancelled', async () => {
    enableAutoPunch();
    mockAutoPunchOwnership();
    audioMocks.ensureContext.mockReturnValue(new Promise(() => undefined));
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs, new Map(), autoPunch.targetTrackId);

    button(idle, 'オートパンチを開始').props.onClick?.();
    const requesting = renderDialog(
      'requesting',
      refs,
      new Map(),
      autoPunch.targetTrackId,
    );
    button(requesting, 'キャンセル').props.onClick?.();

    await vi.waitFor(() => {
      expect(actionMocks.discard).toHaveBeenCalledOnce();
      expect(actionMocks.discard).toHaveBeenCalledWith(actionMocks.handle);
      expect(actionMocks.record).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(microphoneMocks.start).not.toHaveBeenCalled();
  });

  it('discards a completed punch capture when playback stops before post-roll proof', async () => {
    enableAutoPunch();
    mockAutoPunchOwnership();
    const capture = deferred<ReturnType<typeof punchCapture>>();
    installSynchronizedPunchSession(capture.promise);
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs, new Map(), autoPunch.targetTrackId);

    button(idle, 'オートパンチを開始').props.onClick?.();
    await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());
    capture.resolve(punchCapture());
    await vi.waitFor(() => {
      expect(hookState.stateSetters[0]).toHaveBeenCalledWith('postroll');
    });
    expect(actionMocks.record).not.toHaveBeenCalled();

    const postroll = renderDialog(
      'postroll',
      refs,
      new Map(),
      autoPunch.targetTrackId,
    );
    expect(textContent(postroll)).toContain('ポストロール再生中');
    const lifecycleCleanup = hookState.effects.at(-1)?.();
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        phase: 'stopped',
        isPlaying: false,
      },
    });

    expect(actionMocks.discard).toHaveBeenCalledOnce();
    expect(actionMocks.discard).toHaveBeenCalledWith(actionMocks.handle);
    expect(actionMocks.record).not.toHaveBeenCalled();
    if (typeof lifecycleCleanup === 'function') lifecycleCleanup();
    expect(actionMocks.discard).toHaveBeenCalledOnce();
  });

  it('rejects a scheduler post-roll callback that cannot prove the owned playback', async () => {
    enableAutoPunch();
    mockAutoPunchOwnership();
    actionMocks.markPostroll.mockReturnValue(false);
    const capture = deferred<ReturnType<typeof punchCapture>>();
    const harness = installSynchronizedPunchSession(capture.promise);
    const refs: Array<{ current: unknown }> = [];
    const idle = renderDialog('idle', refs, new Map(), autoPunch.targetTrackId);

    button(idle, 'オートパンチを開始').props.onClick?.();
    await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());
    const completePostroll = harness.getPlaybackOptions()?.onFinitePunchComplete;
    if (!completePostroll) throw new Error('finite punch callback missing');
    completePostroll(42);

    expect(actionMocks.markPostroll).toHaveBeenCalledWith(actionMocks.handle, 42);
    expect(harness.cancel).toHaveBeenCalledOnce();
    capture.reject(new MicrophoneCaptureError('cancelled'));
    await vi.waitFor(() => {
      expect(actionMocks.discard).toHaveBeenCalledOnce();
      expect(actionMocks.record).not.toHaveBeenCalled();
    });
  });

  it.each(['capture-first', 'postroll-first'] as const)(
    'finalizes Auto Punch once after both completion signals arrive (%s)',
    async (completionOrder) => {
      enableAutoPunch();
      mockAutoPunchOwnership();
      const capture = deferred<ReturnType<typeof punchCapture>>();
      const harness = installSynchronizedPunchSession(capture.promise);
      actionMocks.record.mockResolvedValue({
        ok: true,
        changed: true,
        trackId: autoPunch.targetTrackId,
        trackName: 'Lead Take',
        folderId: 'take-folder-1',
        audioAssetIds: ['take-1', 'take-2'],
        takeCount: 2,
        deduplicated: false,
        playbackStopped: true,
      });
      const refs: Array<{ current: unknown }> = [];
      const idle = renderDialog('idle', refs, new Map(), autoPunch.targetTrackId);

      button(idle, 'オートパンチを開始').props.onClick?.();
      await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());
      const completePostroll = harness.getPlaybackOptions()?.onFinitePunchComplete;
      if (!completePostroll) throw new Error('finite punch callback missing');
      const completedCapture = punchCapture();

      if (completionOrder === 'capture-first') {
        capture.resolve(completedCapture);
        await vi.waitFor(() => {
          expect(hookState.stateSetters[0]).toHaveBeenCalledWith('postroll');
        });
        expect(actionMocks.record).not.toHaveBeenCalled();
        completePostroll(42);
      } else {
        completePostroll(42);
        await Promise.resolve();
        expect(actionMocks.record).not.toHaveBeenCalled();
        capture.resolve(completedCapture);
      }

      await vi.waitFor(() => {
        expect(actionMocks.record).toHaveBeenCalledOnce();
        expect(onCreated).toHaveBeenCalledOnce();
      });
      expect(actionMocks.markPostroll).toHaveBeenCalledWith(actionMocks.handle, 42);
      expect(actionMocks.record).toHaveBeenCalledWith(expect.objectContaining({
        recordingHandle: actionMocks.handle,
        capture: completedCapture,
      }));

      completePostroll(42);
      await Promise.resolve();
      expect(actionMocks.record).toHaveBeenCalledOnce();
      expect(onCreated).toHaveBeenCalledOnce();
    },
  );

  it('waits for the capture tail after the finite cycle boundary but cancels on manual transport stop', () => {
    const cycle = { loopStartBeat: 0, loopEndBeat: 4, passCount: 3 };
    const naturalStop = vi.fn(async () => undefined);
    const naturalCancel = vi.fn();
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        phase: 'playing',
        isPlaying: true,
        positionBeat: 3,
        loopEnabled: true,
        loopStartBeat: 0,
        loopEndBeat: 4,
      },
    });
    const naturalRefs: Array<{ current: unknown }> = [];
    naturalRefs[5] = {
      current: {
        stop: naturalStop,
        cancel: naturalCancel,
        elapsedSeconds: () => 60,
      },
    };
    naturalRefs[3] = { current: 42 };
    naturalRefs[19] = { current: cycle };
    naturalRefs[25] = { current: 42 };
    renderDialog('recording', naturalRefs);
    const naturalLifecycle = hookState.effects.at(-1)?.();
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        phase: 'stopped',
        isPlaying: false,
        positionBeat: 0,
      },
    });

    expect(naturalStop).not.toHaveBeenCalled();
    expect(naturalCancel).not.toHaveBeenCalled();
    if (typeof naturalLifecycle === 'function') naturalLifecycle();

    const manualCancel = vi.fn();
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        phase: 'playing',
        isPlaying: true,
        positionBeat: 1,
      },
    });
    const manualRefs: Array<{ current: unknown }> = [];
    manualRefs[5] = {
      current: {
        stop: vi.fn(async () => undefined),
        cancel: manualCancel,
        elapsedSeconds: () => 0.5,
      },
    };
    manualRefs[19] = { current: cycle };
    renderDialog('recording', manualRefs);
    const manualLifecycle = hookState.effects.at(-1)?.();
    useStore.setState({
      transport: {
        ...useStore.getState().transport,
        phase: 'stopped',
        isPlaying: false,
        positionBeat: 1,
      },
    });

    expect(manualCancel).toHaveBeenCalledOnce();
    if (typeof manualLifecycle === 'function') manualLifecycle();
  });

  it('reports the latency mode frozen by the take instead of a stale local selection', async () => {
    useStore.setState({
      recordingLatencyCalibration: Object.freeze({
        inputDeviceId: 'usb-loopback',
        latencyFrames: 2_400,
        sampleRate: 48_000,
        contextGeneration: 7,
        confidence: 0.95,
      }),
      recordingLatencyCompensationMode: 'calibrated',
      preferredMicrophoneInputDeviceId: 'usb-loopback',
    });
    let resolveCapture!: (capture: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      resolveCapture = resolve;
    });
    microphoneMocks.start.mockResolvedValue({
      startedAt: 0,
      maxDurationSeconds: 60,
      result,
      elapsedSeconds: () => 1,
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(),
    });
    actionMocks.record.mockResolvedValue({
      ok: true,
      changed: true,
      trackId: 'recorded-track',
      trackName: 'Lead Take',
      clipId: 'recorded-clip',
      audioAssetId: 'recorded-asset',
      deduplicated: false,
      playbackStopped: true,
    });
    const refs: Array<{ current: unknown }> = [];
    const tree = renderDialog('idle', refs, new Map<number, unknown>([
      [10, 'usb-loopback'],
      [11, 'estimated'],
    ]));

    button(tree, '録音を開始').props.onClick?.();
    await vi.waitFor(() => expect(refs[5]?.current).toBeTruthy());
    resolveCapture({
      numberOfChannels: 1,
      length: 48_000,
      sampleRate: 48_000,
      durationSeconds: 1,
      stopReason: 'manual',
      contextGeneration: 7,
      firstContextFrame: 0,
      endContextFrameExclusive: 48_000,
      inputLatencySeconds: null,
      getChannelData: () => new Float32Array(48_000),
    });

    await vi.waitFor(() => expect(actionMocks.pushToast).toHaveBeenCalledOnce());
    expect(actionMocks.pushToast).toHaveBeenCalledWith(
      expect.stringContaining('実測レイテンシ補正を適用しました。'),
      'success',
    );
    expect(actionMocks.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('推定レイテンシ補正を適用しました。'),
      expect.anything(),
    );
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
    renderDialog('recording', refs);
    for (const ref of hookState.refs) ref.current = { focus };
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
    try {
      hookState.effects[2]?.();
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
