import { describe, expect, it, vi } from 'vitest';
import {
  RecordingLatencyCalibrationError,
  startRecordingLatencyCalibrationWithDependencies,
  type RecordingLatencyCalibrationDependencies,
} from '../src/audio/recordingLatencyCalibration';
import {
  MicrophoneCaptureError,
  type MicrophoneCaptureSession,
  type MicrophonePcmCapture,
  type StartMicrophoneCaptureOptions,
} from '../src/audio/microphoneCapture';

type FakeSource = Readonly<{
  node: AudioBufferSourceNode;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  bufferData: () => Float32Array | null;
}>;

function createFakeAudioGraph(
  sampleRate = 48_000,
  sourceStart: () => void = () => undefined,
  currentTimeSeconds = 0,
): Readonly<{
  context: AudioContext;
  master: GainNode;
  source: FakeSource;
  masterGain: AudioParam;
  setMasterGain: ReturnType<typeof vi.fn>;
}> {
  let bufferData: Float32Array | null = null;
  const createBuffer = vi.fn(
    (numberOfChannels: number, length: number, bufferSampleRate: number) => {
      bufferData = new Float32Array(length);
      return {
        numberOfChannels,
        length,
        sampleRate: bufferSampleRate,
        duration: length / bufferSampleRate,
        copyToChannel: (source: Float32Array) => bufferData?.set(source),
        getChannelData: () => bufferData,
      } as unknown as AudioBuffer;
    },
  );
  const connect = vi.fn();
  const start = vi.fn(sourceStart);
  const stop = vi.fn();
  const disconnect = vi.fn();
  const sourceNode = {
    buffer: null,
    connect,
    start,
    stop,
    disconnect,
  } as unknown as AudioBufferSourceNode;
  const createBufferSource = vi.fn(() => sourceNode);
  const context = {
    sampleRate,
    state: 'running',
    currentTime: currentTimeSeconds,
    createBuffer,
    createBufferSource,
  } as unknown as AudioContext;
  const masterGain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
  } as unknown as AudioParam;
  const setMasterGain = vi.fn((value: number) => {
    masterGain.value = value;
    return masterGain;
  });
  Object.assign(masterGain, { setValueAtTime: setMasterGain });
  const master = {
    gain: masterGain,
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as GainNode;
  return {
    context,
    master,
    masterGain,
    setMasterGain,
    source: {
      node: sourceNode,
      connect,
      start,
      stop,
      disconnect,
      bufferData: () => bufferData,
    },
  };
}

function pcmCapture(
  channels: readonly Float32Array[],
  sampleRate: number,
  firstContextFrame: number,
  contextGeneration = 7,
): MicrophonePcmCapture {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    durationSeconds: length / sampleRate,
    stopReason: 'duration-limit',
    contextGeneration,
    firstContextFrame,
    endContextFrameExclusive: firstContextFrame + length,
    inputLatencySeconds: null,
    getChannelData: (channel) => {
      const data = channels[channel];
      if (!data) throw new Error('test channel missing');
      return data;
    },
  };
}

function captureSession(
  result: Promise<MicrophonePcmCapture>,
): MicrophoneCaptureSession {
  return {
    startedAt: 0,
    maxDurationSeconds: 1,
    result,
    elapsedSeconds: () => 1,
    stop: () => result,
    cancel: vi.fn(),
  };
}

type CaptureBehavior = Readonly<{
  delayFrames?: number;
  armError?: MicrophoneCaptureError;
  captureError?: MicrophoneCaptureError;
  silence?: boolean;
  afterSynchronize?: () => void;
  currentTimeSeconds?: number;
  masterGain?: number;
}>;

function calibrationHarness(behavior: CaptureBehavior = {}) {
  const graph = createFakeAudioGraph(
    48_000,
    () => undefined,
    behavior.currentTimeSeconds ?? 0,
  );
  graph.masterGain.value = behavior.masterGain ?? 1;
  const generation = 7;
  const earliestStartFrame = 1_024;
  const expectedStartFrame = Math.ceil(
    Math.max(
      earliestStartFrame,
      Math.ceil((behavior.currentTimeSeconds ?? 0) * graph.context.sampleRate)
        + Math.ceil(graph.context.sampleRate * 0.05),
    ) / 128,
  ) * 128;
  let current = true;
  let armedFrame: number | null = null;
  const armAtFrame = vi.fn(async (startFrame: number) => {
    armedFrame = startFrame;
    if (behavior.armError) throw behavior.armError;
  });
  let observedCaptureOptions: StartMicrophoneCaptureOptions | null = null;
  const startCapture = vi.fn(async (options: StartMicrophoneCaptureOptions) => {
    observedCaptureOptions = options;
    await options.synchronize?.({
      context: graph.context,
      contextGeneration: generation,
      sampleRate: graph.context.sampleRate,
      renderQuantumSize: 128,
      earliestStartFrame,
      armAtFrame,
    });
    behavior.afterSynchronize?.();
    if (behavior.captureError) {
      return captureSession(Promise.reject(behavior.captureError));
    }
    const probe = graph.source.bufferData();
    if (!probe) throw new Error('probe was not scheduled');
    const delayFrames = behavior.delayFrames ?? 960;
    const channel = new Float32Array(delayFrames + probe.length + 32);
    if (!behavior.silence) {
      for (let frame = 0; frame < probe.length; frame += 1) {
        channel[delayFrames + frame] = (probe[frame] ?? 0) * -0.45;
      }
    }
    return captureSession(Promise.resolve(
      pcmCapture(
        [channel],
        graph.context.sampleRate,
        armedFrame ?? earliestStartFrame,
        generation,
      ),
    ));
  });
  const ensureContext = vi.fn(async () => ({
    context: graph.context,
    master: graph.master,
    contextGeneration: generation,
  }));
  const isContextCurrent = vi.fn(
    (context: AudioContext, contextGeneration: number) =>
      current && context === graph.context && contextGeneration === generation,
  );
  const dependencies: RecordingLatencyCalibrationDependencies = {
    ensureContext,
    startCapture,
    isContextCurrent,
  };
  return {
    ...graph,
    generation,
    earliestStartFrame,
    expectedStartFrame,
    armAtFrame,
    startCapture,
    ensureContext,
    isContextCurrent,
    dependencies,
    captureOptions: () => observedCaptureOptions,
    invalidateContext: () => {
      current = false;
    },
  };
}

describe('recording latency calibration session', () => {
  it('starts context activation synchronously and schedules capture and Master probe together', async () => {
    const harness = calibrationHarness({ delayFrames: 1_234 });
    const onCountdown = vi.fn();
    const onPreparing = vi.fn();
    const onLevel = vi.fn();

    const attempt = startRecordingLatencyCalibrationWithDependencies({
      inputDeviceId: 'input-1',
      onCountdown,
      onPreparing,
      onLevel,
    }, harness.dependencies);
    expect(harness.ensureContext).toHaveBeenCalledTimes(1);

    const result = await attempt;
    expect(result).toEqual({
      latencyFrames: 1_234,
      roundTripLatencySeconds: 1_234 / 48_000,
      confidence: expect.any(Number),
      sampleRate: 48_000,
      contextGeneration: harness.generation,
    });
    expect(result.confidence).toBeGreaterThan(0.9);

    const options = harness.captureOptions();
    expect(options).toMatchObject({
      countdownSeconds: 3,
      inputDeviceId: 'input-1',
      monitorInput: false,
      onCountdown,
      onPreparing,
      onLevel,
      borrowedAudioContext: {
        context: harness.context,
        contextGeneration: harness.generation,
      },
    });
    expect(options?.maxDurationSeconds).toBeGreaterThanOrEqual(0.75);
    expect(options?.maxDurationSeconds).toBeLessThanOrEqual(1.95);
    expect(harness.armAtFrame).toHaveBeenCalledWith(harness.expectedStartFrame);
    expect(harness.source.connect).toHaveBeenCalledWith(harness.master);
    expect(harness.source.start).toHaveBeenCalledWith(
      harness.expectedStartFrame / harness.context.sampleRate,
    );
    expect(harness.source.stop).toHaveBeenCalledTimes(1);
    expect(harness.source.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rechecks the live audio clock and keeps a fresh 50 ms scheduling lead', async () => {
    const currentTimeSeconds = 0.25;
    const harness = calibrationHarness({ currentTimeSeconds, delayFrames: 777 });

    const result = await startRecordingLatencyCalibrationWithDependencies(
      {},
      harness.dependencies,
    );

    expect(result.latencyFrames).toBe(777);
    expect(harness.expectedStartFrame).toBeGreaterThan(harness.earliestStartFrame);
    expect(harness.expectedStartFrame).toBeGreaterThanOrEqual(
      Math.ceil(
        (currentTimeSeconds + 0.05) * harness.context.sampleRate,
      ),
    );
    expect(harness.armAtFrame).toHaveBeenCalledWith(harness.expectedStartFrame);
    expect(harness.source.start).toHaveBeenCalledWith(
      harness.expectedStartFrame / harness.context.sampleRate,
    );
  });

  it.each([0, 2])(
    'uses a fixed low probe level independent of project Master gain %s and restores it',
    async (masterGain) => {
      const harness = calibrationHarness({ masterGain, delayFrames: 777 });

      await startRecordingLatencyCalibrationWithDependencies(
        {},
        harness.dependencies,
      );

      expect(harness.setMasterGain).toHaveBeenNthCalledWith(
        1,
        1,
        harness.context.currentTime,
      );
      expect(harness.setMasterGain).toHaveBeenLastCalledWith(
        masterGain,
        harness.context.currentTime,
      );
      expect(harness.masterGain.value).toBe(masterGain);
    },
  );

  it('stops and disconnects the probe when capture is cancelled', async () => {
    const harness = calibrationHarness({
      captureError: new MicrophoneCaptureError('cancelled'),
    });

    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, harness.dependencies),
    ).rejects.toMatchObject({
      name: 'RecordingLatencyCalibrationError',
      code: 'cancelled',
    });
    expect(harness.source.start).toHaveBeenCalledTimes(1);
    expect(harness.source.stop).toHaveBeenCalledTimes(1);
    expect(harness.source.disconnect).toHaveBeenCalledTimes(1);
  });

  it('stops and disconnects the probe when exact-frame capture arming fails', async () => {
    const harness = calibrationHarness({
      armError: new MicrophoneCaptureError('synchronization-failed'),
    });

    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, harness.dependencies),
    ).rejects.toMatchObject({
      name: 'RecordingLatencyCalibrationError',
      code: 'synchronization-failed',
    });
    expect(harness.source.start).toHaveBeenCalledTimes(1);
    expect(harness.source.stop).toHaveBeenCalledTimes(1);
    expect(harness.source.disconnect).toHaveBeenCalledTimes(1);
  });

  it('stops and disconnects a source whose scheduling call throws', async () => {
    const graph = createFakeAudioGraph(48_000, () => {
      throw new DOMException('start failed', 'InvalidStateError');
    });
    const dependencies: RecordingLatencyCalibrationDependencies = {
      ensureContext: async () => ({
        context: graph.context,
        master: graph.master,
        contextGeneration: 3,
      }),
      isContextCurrent: () => true,
      startCapture: async (options) => {
        await options.synchronize?.({
          context: graph.context,
          contextGeneration: 3,
          sampleRate: 48_000,
          renderQuantumSize: 128,
          earliestStartFrame: 1_024,
          armAtFrame: async () => undefined,
        });
        throw new Error('unreachable');
      },
    };

    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, dependencies),
    ).rejects.toMatchObject({
      name: 'RecordingLatencyCalibrationError',
      code: 'probe-scheduling-failed',
    });
    expect(graph.source.stop).toHaveBeenCalledTimes(1);
    expect(graph.source.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects a context generation that becomes stale after scheduling', async () => {
    const harness = calibrationHarness({
      afterSynchronize: () => harness.invalidateContext(),
    });

    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, harness.dependencies),
    ).rejects.toMatchObject({
      name: 'RecordingLatencyCalibrationError',
      code: 'context-changed',
    });
    expect(harness.source.stop).toHaveBeenCalledTimes(1);
    expect(harness.source.disconnect).toHaveBeenCalledTimes(1);
  });

  it('turns an analyzer failure into a UI-messageable calibration error', async () => {
    const harness = calibrationHarness({ silence: true });

    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, harness.dependencies),
    ).rejects.toEqual(new RecordingLatencyCalibrationError('silence'));
    expect(harness.source.stop).toHaveBeenCalledTimes(1);
    expect(harness.source.disconnect).toHaveBeenCalledTimes(1);
  });

  it('maps activation and microphone failures to stable calibration codes', async () => {
    const activationFailure: RecordingLatencyCalibrationDependencies = {
      ensureContext: () => {
        throw new Error('context construction failed');
      },
      startCapture: vi.fn(),
      isContextCurrent: () => true,
    };
    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, activationFailure),
    ).rejects.toMatchObject({ code: 'audio-context-failed' });

    const harness = calibrationHarness({
      captureError: new MicrophoneCaptureError('permission-denied'),
    });
    await expect(
      startRecordingLatencyCalibrationWithDependencies({}, harness.dependencies),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('cancels before capture setup when its AbortSignal is already aborted', async () => {
    const harness = calibrationHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      startRecordingLatencyCalibrationWithDependencies(
        { signal: controller.signal },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(harness.ensureContext).toHaveBeenCalledTimes(1);
    expect(harness.startCapture).not.toHaveBeenCalled();
    expect(harness.source.stop).not.toHaveBeenCalled();
  });
});
