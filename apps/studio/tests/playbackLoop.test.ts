import { describe, expect, it, vi } from 'vitest';
import {
  ScheduleEventLimitError,
  createAudioTrackClip,
  createEmptyProject,
  type ReadyAudioAsset,
} from '@cts/project-model';
import {
  AudioAssetPlaybackError,
  setAudioAssetBytesResolver,
  sha256Hex,
} from '../src/audio/audioAssetResolver';
import { AudioClipPlanLimitError } from '../src/audio/audioClipPlanner';
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
