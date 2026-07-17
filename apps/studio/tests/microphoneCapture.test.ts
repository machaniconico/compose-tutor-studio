import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AudioResourceReservationError,
  HeavyAudioResourceReservationLedger,
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
} from '../src/audio/audioResourceReservation';
import {
  MAX_MICROPHONE_CAPTURE_SAMPLE_RATE,
  MAX_MICROPHONE_CAPTURE_PCM_BYTES,
  MICROPHONE_CAPTURE_RESERVATION_BYTES,
  MIN_MICROPHONE_CAPTURE_SECONDS,
  MicrophoneCaptureError,
  isMicrophoneCaptureSupported,
  startMicrophoneCapture,
  type MicrophoneCapturePlatform,
  type MicrophoneCaptureSession,
  type StartMicrophoneCaptureOptions,
} from '../src/audio/microphoneCapture';

type GraphHandlers = Parameters<MicrophoneCapturePlatform['createGraph']>[2];

class FakeClock {
  private currentTime = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<
    number,
    Readonly<{ callback: () => void; dueAt: number }>
  >();

  readonly now = vi.fn(() => this.currentTime);

  readonly setTimer = vi.fn((callback: () => void, milliseconds: number) => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, { callback, dueAt: this.currentTime + milliseconds });
    return id as unknown as ReturnType<typeof setTimeout>;
  });

  readonly clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  });

  advance(milliseconds: number): void {
    const targetTime = this.currentTime + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort(([leftId, left], [rightId, right]) =>
          left.dueAt === right.dueAt ? leftId - rightId : left.dueAt - right.dueAt,
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.dueAt;
      timer.callback();
    }
    this.currentTime = targetTime;
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }
}

class FakeAudioTrack extends EventTarget {
  readonly stop = vi.fn();
  readyState: MediaStreamTrackState = 'live';

  constructor(private readonly channelCount: number | undefined = 1) {
    super();
  }

  getSettings(): MediaTrackSettings {
    return this.channelCount === undefined ? {} : { channelCount: this.channelCount };
  }

  emitEnded(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

type HarnessOptions = Readonly<{
  secureContext?: boolean;
  workletSupported?: boolean;
  mediaDevices?: 'available' | 'missing';
  sampleRate?: number | (() => number);
  contextState?: AudioContextState;
  resume?: () => Promise<void>;
  addWorkletModule?: () => Promise<void>;
  audioTracks?: readonly FakeAudioTrack[];
  allTracks?: readonly FakeAudioTrack[];
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}>;

function createHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const audioTracks = options.audioTracks ?? [new FakeAudioTrack()];
  const allTracks = options.allTracks ?? audioTracks;
  const stream = {
    getAudioTracks: () => [...audioTracks] as unknown as MediaStreamTrack[],
    getTracks: () => [...allTracks] as unknown as MediaStreamTrack[],
  } as unknown as MediaStream;
  const resume = vi.fn(options.resume ?? (async () => undefined));
  const close = vi.fn(async () => undefined);
  const context = {
    state: options.contextState ?? 'running',
    resume,
    close,
  } as unknown as AudioContext;
  Object.defineProperty(context, 'sampleRate', {
    configurable: true,
    enumerable: true,
    get: typeof options.sampleRate === 'function'
      ? options.sampleRate
      : () => options.sampleRate ?? 8_000,
  });

  const getUserMedia = vi.fn(
    options.getUserMedia ?? (async () => stream),
  );
  const addWorkletModule = vi.fn(
    options.addWorkletModule ?? (async () => undefined),
  );
  const flush = vi.fn();
  const disconnect = vi.fn();
  let handlers: GraphHandlers | null = null;
  const createGraph = vi.fn(
    (_context: AudioContext, _stream: MediaStream, nextHandlers: GraphHandlers) => {
      handlers = nextHandlers;
      return { flush, disconnect };
    },
  );
  const platform: MicrophoneCapturePlatform = {
    secureContext: options.secureContext ?? true,
    mediaDevices: options.mediaDevices === 'missing'
      ? null
      : { getUserMedia: getUserMedia as MediaDevices['getUserMedia'] },
    workletSupported: options.workletSupported ?? true,
    workletModuleUrl: 'test://microphone-capture-worklet',
    createAudioContext: vi.fn(() => context),
    addWorkletModule,
    createGraph,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };

  const graphHandlers = (): GraphHandlers => {
    if (!handlers) throw new Error('capture graph has not been created');
    return handlers;
  };

  return {
    platform,
    clock,
    context,
    resume,
    close,
    stream,
    audioTracks,
    getUserMedia,
    addWorkletModule,
    createGraph,
    flush,
    disconnect,
    emitChunk(channels: readonly Float32Array[], peak = 0.5): void {
      graphHandlers().onChunk(channels, peak);
    },
    emitFlushed(): void {
      graphHandlers().onFlushed();
    },
    emitWorkletError(code?: string): void {
      graphHandlers().onError(code);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const sessions = new Set<MicrophoneCaptureSession>();

async function beginCapture(
  harness: ReturnType<typeof createHarness>,
  options: Omit<StartMicrophoneCaptureOptions, 'platform'> = {},
): Promise<MicrophoneCaptureSession> {
  const session = await startMicrophoneCapture({
    countdownSeconds: 0,
    maxDurationSeconds: 1,
    ...options,
    platform: harness.platform,
  });
  sessions.add(session);
  return session;
}

afterEach(async () => {
  const cleanup = [...sessions].map((session) => {
    session.cancel();
    return session.result.catch(() => undefined);
  });
  sessions.clear();
  await Promise.all(cleanup);
});

describe('microphone capture support and ownership', () => {
  it('reserves for both chunk storage and the final contiguous PCM copy', () => {
    expect(MICROPHONE_CAPTURE_RESERVATION_BYTES).toBeGreaterThan(
      MAX_MICROPHONE_CAPTURE_PCM_BYTES * 2,
    );
    const ledger = new HeavyAudioResourceReservationLedger();
    ledger.reserve(MICROPHONE_CAPTURE_RESERVATION_BYTES);
    ledger.reserve(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - MICROPHONE_CAPTURE_RESERVATION_BYTES,
    );
    expect(() => ledger.reserve(1)).toThrow(AudioResourceReservationError);
  });

  it('requires a secure context, media devices, and AudioWorklet support', async () => {
    const supported = createHarness();
    const insecure = createHarness({ secureContext: false });
    const missingMedia = createHarness({ mediaDevices: 'missing' });
    const missingWorklet = createHarness({ workletSupported: false });

    expect(isMicrophoneCaptureSupported(supported.platform)).toBe(true);
    expect(isMicrophoneCaptureSupported(insecure.platform)).toBe(false);
    expect(isMicrophoneCaptureSupported(missingMedia.platform)).toBe(false);
    expect(isMicrophoneCaptureSupported(missingWorklet.platform)).toBe(false);
    await expect(beginCapture(insecure)).rejects.toMatchObject({ code: 'insecure-context' });
    await expect(beginCapture(missingMedia)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(beginCapture(missingWorklet)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('allows only one active permission/capture owner and releases it after cleanup', async () => {
    const firstHarness = createHarness();
    const secondHarness = createHarness();
    const first = await beginCapture(firstHarness);

    await expect(beginCapture(secondHarness)).rejects.toMatchObject({ code: 'busy' });

    first.cancel();
    await expect(first.result).rejects.toMatchObject({ code: 'cancelled' });
    const second = await beginCapture(secondHarness);
    second.cancel();
    await expect(second.result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('validates options before taking ownership of the global capture lease', async () => {
    const invalidHarness = createHarness();
    await expect(
      beginCapture(invalidHarness, { maxDurationSeconds: MIN_MICROPHONE_CAPTURE_SECONDS - 0.01 }),
    ).rejects.toMatchObject({ code: 'capture-failed' });

    const validHarness = createHarness();
    const session = await beginCapture(validHarness);
    session.cancel();
    await expect(session.result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('keeps live monitoring off by default and passes through explicit opt-in', async () => {
    const mutedHarness = createHarness();
    const muted = await beginCapture(mutedHarness);
    expect(mutedHarness.createGraph).toHaveBeenCalledWith(
      mutedHarness.context,
      mutedHarness.stream,
      expect.any(Object),
      { monitorInput: false },
    );
    muted.cancel();
    await expect(muted.result).rejects.toMatchObject({ code: 'cancelled' });

    const monitoredHarness = createHarness();
    const monitored = await beginCapture(monitoredHarness, { monitorInput: true });
    expect(monitoredHarness.createGraph).toHaveBeenCalledWith(
      monitoredHarness.context,
      monitoredHarness.stream,
      expect.any(Object),
      { monitorInput: true },
    );
    monitored.cancel();
    await expect(monitored.result).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('microphone capture completion', () => {
  it('truncates the final chunk at the exact maximum frame and reports duration-limit', async () => {
    const harness = createHarness();
    const onLevel = vi.fn();
    const session = await beginCapture(harness, { onLevel });
    harness.emitChunk([Float32Array.from({ length: 5_000 }, (_, index) => index)], 0.25);
    harness.emitChunk([new Float32Array(5_000).fill(-1)], 0.75);

    expect(harness.flush).toHaveBeenCalledTimes(1);
    harness.emitFlushed();
    const capture = await session.result;

    expect(capture).toMatchObject({
      numberOfChannels: 1,
      length: 8_000,
      sampleRate: 8_000,
      durationSeconds: 1,
      stopReason: 'duration-limit',
    });
    expect(Array.from(capture.getChannelData(0).slice(4_998, 5_003))).toEqual([
      4_998,
      4_999,
      -1,
      -1,
      -1,
    ]);
    expect(capture.getChannelData(0).at(-1)).toBe(-1);
    expect(onLevel).toHaveBeenNthCalledWith(1, 0.25);
    expect(onLevel).toHaveBeenNthCalledWith(2, 0.75);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('uses the timer fallback as a duration-limit stop', async () => {
    const harness = createHarness();
    const session = await beginCapture(harness);
    harness.emitChunk([new Float32Array(4_000).fill(0.2)]);

    harness.clock.advance(1_000);
    expect(harness.flush).toHaveBeenCalledTimes(1);
    harness.emitFlushed();

    await expect(session.result).resolves.toMatchObject({
      length: 4_000,
      durationSeconds: 0.5,
      stopReason: 'duration-limit',
    });
  });

  it('manually stops stereo capture and keeps stop/cleanup idempotent', async () => {
    const harness = createHarness({
      audioTracks: [new FakeAudioTrack(2)],
    });
    const session = await beginCapture(harness);
    harness.emitChunk([
      new Float32Array(4_000).fill(0.1),
      new Float32Array(4_000).fill(-0.1),
    ]);
    harness.clock.advance(250);
    expect(session.elapsedSeconds()).toBe(0.25);

    const firstStop = session.stop();
    const secondStop = session.stop();
    expect(secondStop).toBe(firstStop);
    expect(harness.flush).toHaveBeenCalledTimes(1);
    harness.emitFlushed();
    const capture = await firstStop;

    expect(capture).toMatchObject({
      numberOfChannels: 2,
      length: 4_000,
      stopReason: 'manual',
    });
    expect(capture.getChannelData(1)[0]).toBeCloseTo(-0.1);
    expect(() => capture.getChannelData(2)).toThrow(MicrophoneCaptureError);
    session.cancel();
    await session.stop();
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.audioTracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('rejects a manually stopped recording shorter than the minimum', async () => {
    const harness = createHarness();
    const session = await beginCapture(harness);
    harness.emitChunk([new Float32Array(3_999)]);

    const result = session.stop();
    harness.emitFlushed();
    await expect(result).rejects.toMatchObject({ code: 'too-short' });
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.audioTracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });
});

describe('microphone capture permission and device failures', () => {
  it.each(['resume', 'worklet'] as const)(
    'cancels while the %s setup step is still pending and releases ownership',
    async (pendingStep) => {
      const gate = deferred<void>();
      const controller = new AbortController();
      const harness = createHarness({
        contextState: pendingStep === 'resume' ? 'suspended' : 'running',
        ...(pendingStep === 'resume'
          ? { resume: () => gate.promise }
          : { addWorkletModule: () => gate.promise }),
      });
      const attempt = startMicrophoneCapture({
        countdownSeconds: 0,
        maxDurationSeconds: 1,
        signal: controller.signal,
        platform: harness.platform,
      });
      const pendingCall = pendingStep === 'resume' ? harness.resume : harness.addWorkletModule;
      await vi.waitFor(() => expect(pendingCall).toHaveBeenCalledTimes(1));

      controller.abort();
      await expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
      expect(harness.close).toHaveBeenCalledTimes(1);

      const nextHarness = createHarness();
      const next = await beginCapture(nextHarness);
      next.cancel();
      await expect(next.result).rejects.toMatchObject({ code: 'cancelled' });
      gate.resolve();
    },
  );

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'device-not-found'],
    ['OverconstrainedError', 'device-not-found'],
    ['NotReadableError', 'device-busy'],
    ['AbortError', 'device-busy'],
    ['SecurityError', 'insecure-context'],
  ] as const)('maps %s from getUserMedia to %s', async (name, code) => {
    const harness = createHarness({
      getUserMedia: async () => {
        throw new DOMException('test failure', name);
      },
    });

    await expect(beginCapture(harness)).rejects.toMatchObject({ code });
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('maps unknown setup failures to capture-failed and closes the context', async () => {
    const harness = createHarness({
      getUserMedia: async () => {
        throw new Error('unknown failure');
      },
    });

    await expect(beginCapture(harness)).rejects.toMatchObject({ code: 'capture-failed' });
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('aborts while permission is pending, stops a late stream, then releases ownership', async () => {
    const permission = deferred<MediaStream>();
    const lateTrack = new FakeAudioTrack();
    const lateHarness = createHarness({
      audioTracks: [lateTrack],
      getUserMedia: () => permission.promise,
    });
    const controller = new AbortController();
    const attempt = startMicrophoneCapture({
      countdownSeconds: 0,
      maxDurationSeconds: 1,
      signal: controller.signal,
      platform: lateHarness.platform,
    });
    await vi.waitFor(() => expect(lateHarness.getUserMedia).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
    expect(lateHarness.close).toHaveBeenCalledTimes(1);

    const nextHarness = createHarness();
    await expect(beginCapture(nextHarness)).rejects.toMatchObject({ code: 'busy' });

    permission.resolve(lateHarness.stream);
    await vi.waitFor(() => expect(lateTrack.stop).toHaveBeenCalledTimes(1));

    const next = await beginCapture(nextHarness);
    next.cancel();
    await expect(next.result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects when the active input device ends and cleans up once', async () => {
    const track = new FakeAudioTrack();
    const harness = createHarness({ audioTracks: [track] });
    const session = await beginCapture(harness);

    track.emitEnded();
    await expect(session.result).rejects.toMatchObject({ code: 'device-ended' });
    track.emitEnded();
    session.cancel();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a device that ends during the countdown before building a graph', async () => {
    const track = new FakeAudioTrack();
    const harness = createHarness({ audioTracks: [track] });
    const attempt = startMicrophoneCapture({
      countdownSeconds: 3,
      maxDurationSeconds: 1,
      platform: harness.platform,
    });
    await vi.waitFor(() => expect(harness.clock.pendingTimerCount).toBe(1));
    track.emitEnded();

    for (let tick = 0; tick < 3; tick += 1) {
      harness.clock.advance(1_000);
      await Promise.resolve();
    }

    await expect(attempt).rejects.toMatchObject({ code: 'device-ended' });
    expect(harness.createGraph).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });
});

describe('microphone capture validation and worklet failures', () => {
  it.each([
    ['no channels', () => [] as readonly Float32Array[], 'capture-failed'],
    [
      'unequal channel lengths',
      () => [new Float32Array(10), new Float32Array(11)],
      'capture-failed',
    ],
  ] as const)('rejects invalid chunks: %s', async (_label, channels, code) => {
    const harness = createHarness();
    const session = await beginCapture(harness);

    harness.emitChunk(channels());
    await expect(session.result).rejects.toMatchObject({ code });
  });

  it('rejects a channel layout change between chunks', async () => {
    const harness = createHarness();
    const session = await beginCapture(harness);
    harness.emitChunk([new Float32Array(10)]);
    harness.emitChunk([new Float32Array(10), new Float32Array(10)]);

    await expect(session.result).rejects.toMatchObject({ code: 'channel-limit-exceeded' });
  });

  it.each([
    ['channel-limit-exceeded', 'channel-limit-exceeded'],
    ['channel-layout-changed', 'channel-limit-exceeded'],
    ['processor-error', 'worklet-failed'],
    [undefined, 'worklet-failed'],
  ] as const)('maps worklet error %s to %s', async (workletCode, captureCode) => {
    const harness = createHarness();
    const session = await beginCapture(harness);

    harness.emitWorkletError(workletCode);
    await expect(session.result).rejects.toMatchObject({ code: captureCode });
  });

  it('fails closed when requesting a worklet flush throws', async () => {
    const harness = createHarness();
    harness.flush.mockImplementationOnce(() => {
      throw new Error('port closed');
    });
    const session = await beginCapture(harness);

    await expect(session.stop()).rejects.toMatchObject({ code: 'worklet-failed' });
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the worklet does not acknowledge flush', async () => {
    const harness = createHarness();
    const session = await beginCapture(harness);

    const result = session.stop();
    harness.clock.advance(2_000);

    await expect(result).rejects.toMatchObject({ code: 'worklet-failed' });
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it.each([7_999, MAX_MICROPHONE_CAPTURE_SAMPLE_RATE + 1, 8_000.5])(
    'rejects invalid context sample rate %s',
    async (sampleRate) => {
      const harness = createHarness({ sampleRate });

      await expect(beginCapture(harness)).rejects.toMatchObject({
        code: 'sample-rate-out-of-range',
      });
      expect(harness.getUserMedia).not.toHaveBeenCalled();
      expect(harness.close).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects unsafe PCM allocation arithmetic before requesting permission', async () => {
    let sampleRateReads = 0;
    const harness = createHarness({
      sampleRate: () => {
        sampleRateReads += 1;
        return sampleRateReads <= 3 ? MAX_MICROPHONE_CAPTURE_SAMPLE_RATE : 500_000;
      },
    });

    await expect(beginCapture(harness, { maxDurationSeconds: 60 })).rejects.toMatchObject({
      code: 'resource-limit-exceeded',
    });
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('rejects missing audio tracks and declared device channel counts above the cap', async () => {
    const noAudio = createHarness({ audioTracks: [], allTracks: [] });
    await expect(beginCapture(noAudio)).rejects.toMatchObject({ code: 'device-not-found' });

    const tooManyChannels = createHarness({ audioTracks: [new FakeAudioTrack(3)] });
    await expect(beginCapture(tooManyChannels)).rejects.toMatchObject({
      code: 'channel-limit-exceeded',
    });
    expect(tooManyChannels.audioTracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(tooManyChannels.close).toHaveBeenCalledTimes(1);
  });

  it('runs cancellation cleanup only once across repeated cancel and stop calls', async () => {
    const harness = createHarness();
    const session = await beginCapture(harness);
    const result = session.result;

    session.cancel();
    session.cancel();
    const stopped = session.stop();
    expect(stopped).toBe(result);
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });

    session.cancel();
    await expect(session.stop()).rejects.toMatchObject({ code: 'cancelled' });
    expect(harness.flush).not.toHaveBeenCalled();
    expect(harness.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.audioTracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});
