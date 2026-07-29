import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '@cts/project-model';
import type { AudioAssetBufferLease } from '../src/audio/audioAssetResolver';

const engineHarness = vi.hoisted(() => {
  const harness = {
    currentTime: 10,
    contextState: 'running',
    generation: 7,
    listeners: new Set<(state: string) => void>(),
    context: null as unknown as AudioContext,
    master: null as unknown as GainNode,
    ensureContext: vi.fn(),
  };
  harness.context = {
    sampleRate: 48_000,
    get currentTime() {
      return harness.currentTime;
    },
    get state() {
      return harness.contextState;
    },
  } as unknown as AudioContext;
  harness.master = {} as GainNode;
  return harness;
});

const assetHarness = vi.hoisted(() => ({
  acquire: vi.fn(),
  clearUnused: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    get audioContext() {
      return engineHarness.context;
    },
    get contextGeneration() {
      return engineHarness.generation;
    },
    ensureContext: engineHarness.ensureContext,
    now: () => engineHarness.currentTime,
    subscribeStateChange: (listener: (state: string) => void) => {
      engineHarness.listeners.add(listener);
      return () => engineHarness.listeners.delete(listener);
    },
  }),
}));

vi.mock('../src/audio/audioAssetResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/audioAssetResolver')>();
  return {
    ...actual,
    getAudioAssetPlaybackCache: () => ({
      clearUnused: assetHarness.clearUnused,
      retainedDecodedBytes: 0,
    }),
    projectHasReferencedReadyAudioAssets: () => false,
    acquireProjectAudioBuffers: assetHarness.acquire,
  };
});

vi.mock('../src/audio/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/graph')>();
  return {
    ...actual,
    assertRoutingGraphNodeBudget: vi.fn(),
    buildTrackGraphs: vi.fn(() => new Map()),
  };
});

vi.mock('../src/audio/mixState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/mixState')>();
  return {
    ...actual,
    applyMasterMix: vi.fn(),
  };
});

import {
  initAudioBridge,
  startSynchronizedRecordingPlayback,
  stopSynchronizedRecordingPlayback,
} from '../src/audio/playback';
import { useStore } from '../src/state/store';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe('synchronized recording playback runtime races', () => {
  let teardownBridge = (): void => undefined;
  let project = createEmptyProject();
  let operationId = 71;

  beforeEach(() => {
    vi.useFakeTimers();
    engineHarness.currentTime = 10;
    engineHarness.contextState = 'running';
    engineHarness.generation = 7;
    engineHarness.listeners.clear();
    engineHarness.ensureContext.mockReset();
    engineHarness.ensureContext.mockResolvedValue({
      context: engineHarness.context,
      master: engineHarness.master,
      contextGeneration: engineHarness.generation,
    });

    assetHarness.acquire.mockReset();
    assetHarness.clearUnused.mockReset();
    assetHarness.release = vi.fn();
    assetHarness.acquire.mockResolvedValue({
      buffersByAssetId: new Map(),
      release: assetHarness.release,
    } satisfies AudioAssetBufferLease);

    project = createEmptyProject();
    operationId += 1;
    const transport = useStore.getState().transport;
    useStore.setState({
      project,
      projectOperationBusy: false,
      audioRecordingOperationId: operationId,
      transport: {
        ...transport,
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: 900,
        audioIssue: null,
        positionBeat: 0,
        loopEnabled: false,
        metronome: false,
      },
    });
    teardownBridge = initAudioBridge();
  });

  afterEach(async () => {
    const transport = useStore.getState().transport;
    stopSynchronizedRecordingPlayback(transport.playbackRequestId);
    teardownBridge();
    await flushMicrotasks();
    vi.useRealTimers();
  });

  it('arms the shared context frame and confirms playback only after the anchor', async () => {
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _startFrame: number,
      _contextGeneration: number,
    ) => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture,
    });
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await flushMicrotasks();

    expect(armCapture).toHaveBeenCalledOnce();
    const [context, anchorFrame, contextGeneration] = armCapture.mock.calls[0]!;
    expect(context).toBe(engineHarness.context);
    expect(contextGeneration).toBe(engineHarness.generation);
    expect(useStore.getState().transport.phase).toBe('starting');

    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate - 0.001;
    await vi.advanceTimersByTimeAsync(4);
    expect(settled).toBe(false);
    expect(useStore.getState().transport.phase).toBe('starting');

    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(clock).toMatchObject({
      context: engineHarness.context,
      contextGeneration: engineHarness.generation,
      sampleRate: 48_000,
      anchorContextFrame: anchorFrame,
      anchorBeat: 0,
      projectSnapshot: project,
    });
    expect(Object.isFrozen(clock)).toBe(true);
    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      playbackRequestId: clock.requestId,
    });
    expect(assetHarness.release).not.toHaveBeenCalled();

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('hard-stops finite cycle playback at the requested right boundary', async () => {
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _startFrame: number,
      _contextGeneration: number,
    ) => undefined);
    const onFiniteCycleComplete = vi.fn();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      onFiniteCycleComplete,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    const [, anchorFrame] = armCapture.mock.calls[0]!;
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(useStore.getState().transport).toMatchObject({
      phase: 'playing',
      loopEnabled: true,
      loopStartBeat: 2,
      loopEndBeat: 4,
      playbackRequestId: clock.requestId,
    });
    expect(clock).toMatchObject({
      anchorBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      cycleEndBeat: 6,
    });
    expect(onFiniteCycleComplete).not.toHaveBeenCalled();

    // The empty project defaults to 120 BPM. Two 2-beat passes end two
    // seconds after the synchronized anchor on the scheduler's raw beat axis.
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate + 2;
    await vi.advanceTimersByTimeAsync(25);

    expect(armCapture).toHaveBeenCalledOnce();
    expect(useStore.getState().transport).toMatchObject({
      phase: 'stopped',
      isPlaying: false,
      loopEnabled: true,
    });
    expect(useStore.getState().transport.playbackRequestId).not.toBe(clock.requestId);
    expect(onFiniteCycleComplete).toHaveBeenCalledOnce();
    expect(onFiniteCycleComplete).toHaveBeenCalledWith(clock.requestId);
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('does not report finite-cycle completion for a manual stop', async () => {
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const armCapture = vi.fn(async (
      _context: AudioContext,
      _startFrame: number,
      _contextGeneration: number,
    ) => undefined);
    const onFiniteCycleComplete = vi.fn();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      onFiniteCycleComplete,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    const [, anchorFrame] = armCapture.mock.calls[0]!;
    engineHarness.currentTime = anchorFrame / engineHarness.context.sampleRate;
    await vi.advanceTimersByTimeAsync(10);
    const clock = await resultPromise;

    expect(stopSynchronizedRecordingPlayback(clock.requestId)).toBe(true);
    expect(onFiniteCycleComplete).not.toHaveBeenCalled();
    expect(useStore.getState().transport.phase).toBe('stopped');
  });

  it('rejects a frozen cycle when its loop or AudioContext generation changes during arm', async () => {
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const loopArm = deferred<void>();
    const loopAttempt = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      signal: new AbortController().signal,
      armCapture: () => loopArm.promise,
    });
    await flushMicrotasks();
    useStore.setState((state) => ({
      transport: { ...state.transport, loopEndBeat: 5 },
    }));
    loopArm.resolve(undefined);
    await expect(loopAttempt).rejects.toMatchObject({ code: 'stale-request' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();

    assetHarness.release.mockClear();
    useStore.setState((state) => ({
      transport: {
        ...state.transport,
        phase: 'stopped',
        loopEnabled: true,
        loopStartBeat: 2,
        loopEndBeat: 4,
        positionBeat: 2,
      },
    }));
    const contextArm = deferred<void>();
    const contextAttempt = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 2,
      cycle: {
        loopStartBeat: 2,
        loopEndBeat: 4,
        passCount: 2,
      },
      signal: new AbortController().signal,
      armCapture: () => contextArm.promise,
    });
    await flushMicrotasks();
    engineHarness.generation += 1;
    contextArm.resolve(undefined);
    await expect(contextAttempt).rejects.toMatchObject({ code: 'context-changed' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('aborts a never-settling capture arm and releases the decoded lease', async () => {
    const abortController = new AbortController();
    const armCapture = vi.fn(() => new Promise<void>(() => undefined));
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: abortController.signal,
      armCapture,
    });
    await flushMicrotasks();
    expect(armCapture).toHaveBeenCalledOnce();

    abortController.abort();
    await expect(resultPromise).rejects.toMatchObject({ code: 'cancelled' });
    await flushMicrotasks();

    expect(useStore.getState().transport.phase).toBe('stopped');
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('rejects a seek during capture arm as a stale request', async () => {
    const arm = deferred<void>();
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture: () => arm.promise,
    });
    await flushMicrotasks();

    useStore.getState().setPosition(2);
    arm.resolve(undefined);

    await expect(resultPromise).rejects.toMatchObject({ code: 'stale-request' });
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('fails a capture arm that misses its scheduling deadline and releases resources', async () => {
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture: () => new Promise<void>(() => undefined),
    });
    await flushMicrotasks();

    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: 'start-deadline-missed',
    });
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    await flushMicrotasks();
    expect(assetHarness.release).toHaveBeenCalledOnce();
  });

  it('releases a decoded lease when the recording operation becomes stale during decode', async () => {
    const decodedLease = deferred<AudioAssetBufferLease>();
    assetHarness.acquire.mockReturnValue(decodedLease.promise);
    const release = vi.fn();
    const armCapture = vi.fn(async () => undefined);
    const resultPromise = startSynchronizedRecordingPlayback({
      operationId,
      projectSnapshot: project,
      startBeat: 0,
      signal: new AbortController().signal,
      armCapture,
    });
    await flushMicrotasks();
    expect(assetHarness.acquire).toHaveBeenCalledOnce();

    useStore.setState({ audioRecordingOperationId: operationId + 1 });
    decodedLease.resolve({
      buffersByAssetId: new Map(),
      release,
    });

    await expect(resultPromise).rejects.toMatchObject({ code: 'stale-operation' });
    await flushMicrotasks();
    expect(armCapture).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
