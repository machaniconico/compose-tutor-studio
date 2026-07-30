import { describe, expect, it, vi } from 'vitest';
import {
  ScheduleEventLimitError,
  createAudioTrackClip,
  createEmptyProject,
  type ReadyAudioAsset,
} from '@cts/project-model';
import {
  AudioAssetPlaybackError,
  assertProjectAudioAssetCombinedResourceBudget,
  getAudioAssetPlaybackCache,
  setAudioAssetBytesResolver,
  sha256Hex,
} from '../src/audio/audioAssetResolver';
import {
  estimateAudioWarpResourcePeakBytes,
  getAudioClipBufferCache,
} from '../src/audio/audioClipBuffers';
import { AudioClipPlanLimitError } from '../src/audio/audioClipPlanner';
import { compileAudioWarpRenderRequests } from '../src/audio/audioWarpPlan';
import {
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  getReservedHeavyAudioResourceBytes,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import {
  AUDIO_RENDER_QUANTUM_FRAMES,
  acquireRuntimeProjectAudioBuffers,
  classifyPlaybackStartFailure,
  finalizeAutomationCycleBoundaryOnce,
  normalizeTransportLoop,
  planSynchronizedRecordingStartFrame,
  shouldRefreshAudioAssetIssuesAfterFailure,
  startSynchronizedRecordingPlayback,
  stopSynchronizedRecordingPlayback,
  synchronizedRecordingCycleEndBeat,
} from '../src/audio/playback';
import { AudioRoutingGraphError } from '../src/audio/graph';
import { useStore } from '../src/state/store';

vi.mock('../src/audio/audioWarpThread', () => ({
  createLocalAudioWarpThread: () => Reflect.construct(
    globalThis.Worker as unknown as new () => Worker,
    [],
  ),
}));

function projectWithReadyAudioAsset(checksumSha256 = '0'.repeat(64)) {
  const asset: ReadyAudioAsset = {
    id: 'live-race-asset',
    availability: 'ready',
    checksumSha256,
    originalName: 'live.wav',
    mediaType: 'audio/wav',
    byteLength: 4,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 48_000,
  };
  const result = createAudioTrackClip(createEmptyProject(), asset);
  if (!result.ok) throw new Error(result.error.code);
  return result.project;
}

function canonicalWav(frameCount: number): Uint8Array {
  const bytes = new Uint8Array(44 + frameCount * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frameCount * 2, true);
  for (let frame = 0; frame < frameCount; frame += 1) {
    view.setInt16(44 + frame * 2, Math.round(Math.sin(frame / 17) * 12_000), true);
  }
  return bytes;
}

async function liveWarpFixture() {
  const frameCount = 9_600;
  const bytes = canonicalWav(frameCount);
  const asset: ReadyAudioAsset = {
    id: 'live-warp-asset',
    availability: 'ready',
    checksumSha256: await sha256Hex(bytes),
    originalName: 'live-warp.wav',
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate: 48_000,
    channelCount: 1,
    frameCount,
  };
  const result = createAudioTrackClip(createEmptyProject(), asset);
  if (!result.ok) throw new Error(result.error.code);
  const clip = result.project.tracks.flatMap((track) => track.clips)
    .find((candidate) => candidate.type === 'audio');
  if (!clip || clip.type !== 'audio') throw new Error('audio clip missing');
  clip.audioWarp = {
    algorithm: 'wsola-v1',
    formantMode: 'preserve',
    timingEnabled: true,
    pitchEnabled: true,
    markers: [
      { sourceFrame: 0, targetBeatOffset: 0 },
      { sourceFrame: frameCount, targetBeatOffset: clip.lengthBeats },
    ],
    pitchRegions: [{
      sourceStartFrame: 0,
      sourceFrameCount: frameCount,
      sourcePitchCents: 6_900,
      targetPitchCents: 7_000,
      correctionAmount: 1,
      transitionFrames: 0,
    }],
  };
  return { project: result.project, bytes };
}

class CpuBoundWorker {
  static instances: CpuBoundWorker[] = [];
  static completeRenders = false;
  readonly messages: unknown[] = [];
  terminateCount = 0;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor() {
    CpuBoundWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    const candidate = message as {
      type?: string;
      id?: number;
      generation?: number;
      request?: { targetSampleRate: number; outputFrameCount: number; channelCount: number };
    };
    if (CpuBoundWorker.completeRenders && candidate.type === 'render' && candidate.request) {
      queueMicrotask(() => {
        const event = {
          data: {
            type: 'rendered',
            id: candidate.id,
            generation: candidate.generation,
            pcm: {
              sampleRate: candidate.request!.targetSampleRate,
              frameCount: candidate.request!.outputFrameCount,
              channelCount: candidate.request!.channelCount,
              channels: Array.from(
                { length: candidate.request!.channelCount },
                () => new ArrayBuffer(candidate.request!.outputFrameCount * 4),
              ),
            },
          },
        } as MessageEvent;
        for (const listener of this.listeners.get('message') ?? []) {
          if (typeof listener === 'function') listener(event);
          else listener.handleEvent(event);
        }
      });
    }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

describe('normalizeTransportLoop', () => {
  it('returns null when looping is disabled or the song has no length', () => {
    expect(normalizeTransportLoop(false, 1, 3, 8)).toBeNull();
    expect(normalizeTransportLoop(true, 0, 0, 0)).toBeNull();
    expect(normalizeTransportLoop(true, 0, 1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps a valid region and clamps finite bounds to the song', () => {
    expect(normalizeTransportLoop(true, 2, 6, 8)).toEqual({
      startBeat: 2,
      endBeat: 6,
    });
    expect(normalizeTransportLoop(true, -3, 12, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
  });

  it('falls back to the whole song for invalid enabled bounds', () => {
    expect(normalizeTransportLoop(true, 0, 0, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
    expect(normalizeTransportLoop(true, 7, 2, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
    expect(normalizeTransportLoop(true, Number.NaN, 4, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
  });
});

describe('automation loop right locator', () => {
  it('retries a rejected finalization and handles the half-open boundary once after success', () => {
    const finalize = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    let handled = false;

    handled = finalizeAutomationCycleBoundaryOnce(handled, true, finalize);
    expect(handled).toBe(false);
    handled = finalizeAutomationCycleBoundaryOnce(handled, true, finalize);
    expect(handled).toBe(true);
    handled = finalizeAutomationCycleBoundaryOnce(handled, true, finalize);

    expect(handled).toBe(true);
    expect(finalize).toHaveBeenCalledTimes(2);
  });
});

describe('synchronized recording playback boundary', () => {
  it('chooses a safely future, render-quantum-aligned integer context frame', () => {
    const sampleRate = 48_000;
    const currentTime = 1.001;
    const frame = planSynchronizedRecordingStartFrame(currentTime, sampleRate);

    expect(Number.isSafeInteger(frame)).toBe(true);
    expect(frame % AUDIO_RENDER_QUANTUM_FRAMES).toBe(0);
    expect(frame).toBeGreaterThan(Math.ceil(currentTime * sampleRate));
  });

  it('plans a finite unwrapped right boundary without changing loop phase bounds', () => {
    expect(synchronizedRecordingCycleEndBeat({
      loopStartBeat: 2,
      loopEndBeat: 6,
      passCount: 3,
    })).toBe(14);
  });

  it('rejects aborted, stale and looped starts before mutating transport', async () => {
    const original = useStore.getState();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(startSynchronizedRecordingPlayback({
        operationId: 1,
        projectSnapshot: original.project,
        startBeat: 0,
        signal: controller.signal,
        armCapture: async () => undefined,
      })).rejects.toMatchObject({ code: 'cancelled' });

      useStore.setState({
        audioRecordingOperationId: 41,
        transport: { ...original.transport, phase: 'stopped', loopEnabled: false },
      });
      await expect(startSynchronizedRecordingPlayback({
        operationId: 41,
        projectSnapshot: { ...original.project },
        startBeat: 0,
        signal: new AbortController().signal,
        armCapture: async () => undefined,
      })).rejects.toMatchObject({ code: 'stale-operation' });

      useStore.setState({
        transport: { ...original.transport, phase: 'stopped', loopEnabled: true },
      });
      await expect(startSynchronizedRecordingPlayback({
        operationId: 41,
        projectSnapshot: original.project,
        startBeat: 0,
        signal: new AbortController().signal,
        armCapture: async () => undefined,
      })).rejects.toMatchObject({ code: 'loop-enabled' });
    } finally {
      useStore.setState({
        project: original.project,
        transport: original.transport,
        audioRecordingOperationId: original.audioRecordingOperationId,
      });
    }
  });

  it('stops only the exact active playback request', () => {
    const original = useStore.getState();
    try {
      useStore.setState({
        transport: {
          ...original.transport,
          phase: 'playing',
          isPlaying: true,
          playbackRequestId: 500,
        },
      });

      expect(stopSynchronizedRecordingPlayback(499)).toBe(false);
      expect(useStore.getState().transport.playbackRequestId).toBe(500);
      expect(stopSynchronizedRecordingPlayback(500)).toBe(true);
      expect(useStore.getState().transport).toMatchObject({
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: 501,
      });
    } finally {
      useStore.setState({ transport: original.transport });
    }
  });

  it('fails closed for malformed or transport-mismatched finite cycles', async () => {
    const original = useStore.getState();
    try {
      useStore.setState({
        audioRecordingOperationId: 91,
        transport: {
          ...original.transport,
          phase: 'stopped',
          loopEnabled: true,
          loopStartBeat: 2,
          loopEndBeat: 6,
        },
      });
      const shared = {
        operationId: 91,
        projectSnapshot: original.project,
        startBeat: 2,
        signal: new AbortController().signal,
        armCapture: async () => undefined,
      } as const;

      await expect(startSynchronizedRecordingPlayback({
        ...shared,
        cycle: { loopStartBeat: 2, loopEndBeat: 6, passCount: 1 },
      })).rejects.toMatchObject({ code: 'invalid-start' });
      await expect(startSynchronizedRecordingPlayback({
        ...shared,
        cycle: { loopStartBeat: 2, loopEndBeat: 5, passCount: 2 },
      })).rejects.toMatchObject({ code: 'stale-request' });
      await expect(startSynchronizedRecordingPlayback({
        ...shared,
        cycle: { loopStartBeat: 2, loopEndBeat: 6, passCount: 2 },
      })).rejects.toMatchObject({ code: 'bridge-unavailable' });
    } finally {
      useStore.setState({
        project: original.project,
        transport: original.transport,
        audioRecordingOperationId: original.audioRecordingOperationId,
      });
    }
  });
});

describe('classifyPlaybackStartFailure', () => {
  it('classifies MIDI/drum and Audio Clip schedule caps consistently', () => {
    expect(classifyPlaybackStartFailure(new ScheduleEventLimitError(10, 11)))
      .toBe('event-limit-exceeded');
    expect(classifyPlaybackStartFailure(new AudioClipPlanLimitError(10, 11)))
      .toBe('event-limit-exceeded');
  });

  it.each([
    ['asset-missing', 'audio-asset-missing'],
    ['asset-changed', 'audio-asset-changed'],
    ['resolver-unavailable', 'audio-asset-unavailable'],
    ['asset-unavailable', 'audio-asset-unavailable'],
    ['decode-failed', 'audio-decode-failed'],
    ['resource-limit', 'audio-resource-limit'],
  ] as const)('maps %s to %s', (code, issue) => {
    expect(classifyPlaybackStartFailure(
      new AudioAssetPlaybackError(code, 'asset-1'),
    )).toBe(issue);
  });

  it('does not surface a cancelled/stale asset wait as a file diagnosis', () => {
    expect(classifyPlaybackStartFailure(
      new AudioAssetPlaybackError('cancelled', 'asset-1'),
    )).toBe('start-failed');
  });

  it('classifies the bounded routing graph ceiling as a resource limit', () => {
    expect(classifyPlaybackStartFailure(
      new AudioRoutingGraphError('graph-node-limit', 'too many nodes', 4_100),
    )).toBe('audio-resource-limit');
  });

  it.each([
    ['asset-missing', true],
    ['asset-changed', true],
    ['asset-unavailable', true],
    ['resolver-unavailable', false],
    ['decode-failed', false],
    ['resource-limit', false],
    ['cancelled', false],
  ] as const)('refreshes repository evidence for %s: %s', (code, expected) => {
    expect(shouldRefreshAudioAssetIssuesAfterFailure(
      new AudioAssetPlaybackError(code, 'asset-1'),
    )).toBe(expected);
  });
});

describe('live heavy-audio reservation', () => {
  it.each(['supersede', 'stop', 'external-abort'] as const)(
    'terminates a CPU-bound formant Worker and leaves no partial live ownership on %s',
    async (operation) => {
      const { project, bytes } = await liveWarpFixture();
      useStore.setState({
        project,
        projectOperationBusy: false,
        audioRecordingOperationId: null,
      });
      useStore.getState().stop();
      const clip = project.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.type === 'audio');
      if (!clip || clip.type !== 'audio' || !clip.audioWarp) {
        throw new Error('audio warp clip missing');
      }
      const accepted = useStore.getState();
      expect(compileAudioWarpRenderRequests(accepted.project)).toHaveLength(1);
      const resolve = vi.fn(async () => bytes);
      const releaseResolver = setAudioAssetBytesResolver({ resolve });
      const external = new AbortController();
      CpuBoundWorker.instances = [];
      CpuBoundWorker.completeRenders = false;
      vi.stubGlobal('Worker', CpuBoundWorker);
      getAudioAssetPlaybackCache().clearUnused();
      getAudioClipBufferCache().clearUnused();
      const context = {
        sampleRate: 48_000,
        state: 'running',
        decodeAudioData: vi.fn(async () => ({
          length: 9_600,
          duration: 0.2,
          sampleRate: 48_000,
          numberOfChannels: 1,
        }) as AudioBuffer),
        createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
          length,
          sampleRate,
          numberOfChannels: 1,
          copyToChannel: vi.fn(),
        }) as unknown as AudioBuffer),
      } as unknown as AudioContext;
      const transport = useStore.getState().transport;
      useStore.setState({
        transport: {
          ...transport,
          phase: 'starting',
          isPlaying: false,
          playbackRequestId: transport.playbackRequestId + 1,
        },
      });
      try {
        const pending = acquireRuntimeProjectAudioBuffers(
          accepted.project,
          context,
          () => true,
          external.signal,
        );
        await vi.waitFor(() => {
          expect(CpuBoundWorker.instances).toHaveLength(1);
          expect(CpuBoundWorker.instances[0]!.messages.some(
            (message) => (message as { type?: string }).type === 'render',
          )).toBe(true);
        });
        if (operation === 'external-abort') {
          external.abort();
        } else if (operation === 'stop') {
          useStore.getState().stop();
        } else {
          const current = useStore.getState().transport;
          useStore.setState({
            transport: {
              ...current,
              playbackRequestId: current.playbackRequestId + 1,
            },
          });
        }
        await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
        expect(CpuBoundWorker.instances[0]!.terminateCount).toBe(1);
        expect(getAudioClipBufferCache().entryCount).toBe(0);
        expect(getAudioClipBufferCache().retainedDerivedBytes).toBe(0);
        expect(getReservedHeavyAudioResourceBytes()).toBe(0);
        expect(useStore.getState().project).toBe(accepted.project);
        expect(useStore.getState().past).toBe(accepted.past);
        expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
          .find((candidate) => candidate.id === clip.id)?.audioWarp?.formantMode)
          .toBe('preserve');

        // A terminated operation Worker never remains reachable through the
        // cache. The next acquisition must create a fresh Worker and may only
        // adopt that fresh operation's result.
        CpuBoundWorker.completeRenders = true;
        const current = useStore.getState().transport;
        useStore.setState({
          transport: {
            ...current,
            phase: 'starting',
            isPlaying: false,
            playbackRequestId: current.playbackRequestId + 1,
          },
        });
        const nextLease = await acquireRuntimeProjectAudioBuffers(
          accepted.project,
          context,
          () => true,
        );
        expect(CpuBoundWorker.instances).toHaveLength(2);
        expect(CpuBoundWorker.instances[1]).not.toBe(CpuBoundWorker.instances[0]);
        nextLease.release();
        getAudioClipBufferCache().clearUnused();
        expect(getAudioClipBufferCache().entryCount).toBe(0);
      } finally {
        releaseResolver();
        getAudioAssetPlaybackCache().clearUnused();
        getAudioClipBufferCache().clearUnused();
        vi.unstubAllGlobals();
        useStore.getState().stop();
      }
    },
  );

  it('uses the production combined T_live boundary before resolver, Worker, and AudioBuffer work', async () => {
    const { project, bytes } = await liveWarpFixture();
    getAudioAssetPlaybackCache().clearUnused();
    getAudioClipBufferCache().clearUnused();
    const warpPeak = estimateAudioWarpResourcePeakBytes(project).estimatedPeakBytes;
    const total = assertProjectAudioAssetCombinedResourceBudget(
      project,
      48_000,
      0,
      warpPeak,
    ).estimatedPeakBytes;
    const createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => ({
      length,
      sampleRate,
      numberOfChannels: 1,
      copyToChannel: vi.fn(),
    }) as unknown as AudioBuffer);
    const context = {
      sampleRate: 48_000,
      state: 'running',
      decodeAudioData: vi.fn(async () => ({
        length: 9_600,
        duration: 0.2,
        sampleRate: 48_000,
        numberOfChannels: 1,
      }) as AudioBuffer),
      createBuffer,
    } as unknown as AudioContext;
    vi.stubGlobal('Worker', CpuBoundWorker);
    for (const remaining of [total, total - 1]) {
      CpuBoundWorker.instances = [];
      CpuBoundWorker.completeRenders = true;
      const resolve = vi.fn(async () => bytes);
      const releaseResolver = setAudioAssetBytesResolver({ resolve });
      const outer = reserveHeavyAudioResources(
        MAX_HEAVY_AUDIO_RESOURCE_BYTES - remaining,
      );
      const transport = useStore.getState().transport;
      useStore.setState({
        project,
        transport: {
          ...transport,
          phase: 'starting',
          isPlaying: false,
          playbackRequestId: transport.playbackRequestId + 1,
        },
      });
      try {
        const createBufferCallsBefore = createBuffer.mock.calls.length;
        const pending = acquireRuntimeProjectAudioBuffers(
          project,
          context,
          () => true,
        );
        if (remaining === total) {
          const lease = await pending;
          expect(resolve).toHaveBeenCalledOnce();
          expect(CpuBoundWorker.instances).toHaveLength(1);
          expect(context.createBuffer).toHaveBeenCalled();
          lease.release();
        } else {
          await expect(pending).rejects.toMatchObject({ code: 'resource-limit' });
          expect(resolve).not.toHaveBeenCalled();
          expect(CpuBoundWorker.instances).toHaveLength(0);
          expect(createBuffer.mock.calls).toHaveLength(createBufferCallsBefore);
        }
      } finally {
        releaseResolver();
        outer.release();
        getAudioAssetPlaybackCache().clearUnused();
        getAudioClipBufferCache().clearUnused();
        useStore.getState().stop();
      }
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    }
    vi.unstubAllGlobals();
  });

  it('rejects a competing startup before resolver I/O', async () => {
    const first = reserveHeavyAudioResources(MAX_HEAVY_AUDIO_RESOURCE_BYTES - 1);
    const resolve = vi.fn(async () => Uint8Array.from([1, 2, 3, 4]));
    const releaseResolver = setAudioAssetBytesResolver({ resolve });
    try {
      await expect(acquireRuntimeProjectAudioBuffers(
        projectWithReadyAudioAsset(),
        { sampleRate: 48_000, state: 'running' } as AudioContext,
        () => true,
      )).rejects.toMatchObject({
        name: 'AudioAssetPlaybackError',
        code: 'resource-limit',
        assetId: 'live-race-asset',
      });
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      releaseResolver();
      first.release();
    }
  });

  it('releases startup reservation once the decoded cache lease is acquired', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const project = projectWithReadyAudioAsset(await sha256Hex(bytes));
    const resolve = vi.fn(async () => bytes);
    const releaseResolver = setAudioAssetBytesResolver({ resolve });
    const context = {
      sampleRate: 48_000,
      state: 'running',
      decodeAudioData: vi.fn(async () => ({
        length: 48_000,
        duration: 1,
        sampleRate: 48_000,
        numberOfChannels: 1,
      }) as AudioBuffer),
    } as unknown as AudioContext;
    try {
      const lease = await acquireRuntimeProjectAudioBuffers(project, context, () => true);
      expect(resolve).toHaveBeenCalledOnce();
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
      lease.release();
    } finally {
      releaseResolver();
    }
  });
});
