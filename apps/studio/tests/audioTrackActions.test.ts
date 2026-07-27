import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ReadyAudioAsset } from '@cts/project-model';
import {
  AudioAssetRepositoryError,
  MemoryAudioAssetRepository,
  type AudioAssetRepository,
} from '../src/platform/audioAssetRepository';
import {
  canonicalizeAudioAsset,
  type CanonicalAudioAssetResult,
  type CanonicalAudioResampleJob,
} from '../src/audio/canonicalAudioAsset';
import { getAudioAssetPlaybackCache } from '../src/audio/audioAssetResolver';
import {
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  getReservedHeavyAudioResourceBytes,
  reserveHeavyAudioResources,
} from '../src/audio/audioResourceReservation';
import type { SourceAudioDescriptor } from '../src/audio/sourceAudio';
import {
  MICROPHONE_CAPTURE_RESERVATION_BYTES,
  type MicrophonePcmCapture,
} from '../src/audio/microphoneCapture';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/audioTrackActions');

const descriptor: SourceAudioDescriptor = {
  format: 'wav',
  mimeType: 'audio/wav',
  sampleRate: 48_000,
  channelCount: 1,
  decodeChannelCountUpperBound: 1,
  containerDurationSeconds: 2,
  decodeDurationSeconds: 2,
};

const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

function canonicalResult(): CanonicalAudioAssetResult {
  return {
    sampleRate: 48_000,
    channelCount: 1,
    frameCount: 96_000,
    byteLength: bytes.byteLength,
    requiresResample: false,
    bytes,
  };
}

function audioBufferShape(length: number, sampleRate: number, channels = 1): AudioBuffer {
  const channelData = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    getChannelData: (channel: number) => channelData[channel]!,
  } as AudioBuffer;
}

function microphoneCaptureShape(
  length = 96_000,
  sampleRate = 48_000,
  channels = 1,
): MicrophonePcmCapture {
  const channelData = Array.from(
    { length: channels },
    (_, channel) => new Float32Array(length).fill(channel === 0 ? 0.25 : -0.25),
  );
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    durationSeconds: length / sampleRate,
    stopReason: 'manual',
    contextGeneration: 1,
    firstContextFrame: 0,
    endContextFrameExclusive: length,
    inputLatencySeconds: null,
    getChannelData: (channel) => channelData[channel]!,
  };
}

function input(signal?: AbortSignal) {
  return {
    fileName: 'reference take.wav',
    blob: new Blob([bytes], { type: 'audio/wav' }),
    byteLength: bytes.byteLength,
    descriptor,
    trackName: 'Reference',
    ...(signal ? { signal } : {}),
  } as const;
}

function fingerprint(project: Project): string {
  return JSON.stringify(project);
}

function contentFingerprint(project: Project): string {
  return JSON.stringify({ ...project, updatedAt: '<ignored>' });
}

async function importFixture(repository = new MemoryAudioAssetRepository()) {
  const result = await actions.importStudioAudioTrack(input(), {
    repository,
    decodeSource: async () => ({}) as AudioBuffer,
    canonicalize: async () => canonicalResult(),
    createAssetId: () => 'asset-audio-action',
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return { result, repository };
}

function beginRecordingHandle() {
  const result = actions.beginStudioAudioTrackRecording();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.handle;
}

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/audioTrackActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('オーディオ操作検証')).toBe(true);
  expect(useStore.getState().clearRecordingLatencyCalibration()).toBe(true);
  expect(useStore.getState().setPreferredMicrophoneInputDeviceId(null)).toBe(true);
  expect(useStore.getState().setRecordingLatencyCompensationMode('estimated')).toBe(true);
  expect(useStore.getState().setRecordingLatencyAdjustmentMs(0)).toBe(true);
});

describe('Studio Audio Track import', () => {
  it('stores canonical bytes and adopts metadata, track and selection in one Undo step', async () => {
    const historyBefore = useStore.getState().past.length;
    const revisionBefore = useStore.getState().saveState.revision;
    const { result, repository } = await importFixture();
    const state = useStore.getState();
    const asset = state.project.audioAssets.find((candidate) => candidate.id === result.audioAssetId);
    const track = state.project.tracks.find((candidate) => candidate.id === result.trackId);

    expect(asset).toMatchObject({
      availability: 'ready',
      originalName: 'reference take.wav',
      mediaType: 'audio/wav',
      byteLength: bytes.byteLength,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 96_000,
    });
    expect(track).toMatchObject({ type: 'audio', name: 'Reference' });
    expect(track?.clips[0]).toMatchObject({
      id: result.clipId,
      type: 'audio',
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
      gainDb: 0,
      loop: false,
    });
    expect(state.editor).toMatchObject({
      selectedTrackId: result.trackId,
      selectedClipId: result.clipId,
      activeView: 'arranger',
    });
    expect(state.past).toHaveLength(historyBefore + 1);
    expect(state.saveState.revision).toBe(revisionBefore + 1);
    if (asset?.availability !== 'ready') throw new Error('ready asset missing');
    await expect(repository.read(asset)).resolves.toEqual(bytes);

    state.undo();
    expect(useStore.getState().project.audioAssets).not.toContainEqual(asset);
    expect(useStore.getState().project.tracks.some((candidate) => candidate.id === result.trackId)).toBe(false);
    useStore.getState().redo();
    expect(useStore.getState().project.tracks.some((candidate) => candidate.id === result.trackId)).toBe(true);
  });

  it('deduplicates identical canonical bytes while creating an independent track history step', async () => {
    const repository = new MemoryAudioAssetRepository();
    const first = await importFixture(repository);
    const historyBefore = useStore.getState().past.length;
    const second = await actions.importStudioAudioTrack(
      { ...input(), trackName: 'Reference Copy' },
      {
        repository,
        decodeSource: async () => ({}) as AudioBuffer,
        canonicalize: async () => canonicalResult(),
        createAssetId: () => 'asset-audio-action-copy',
      },
    );

    expect(first.result.deduplicated).toBe(false);
    expect(second).toMatchObject({ ok: true, deduplicated: true, trackName: 'Reference Copy' });
    expect(useStore.getState().past).toHaveLength(historyBefore + 1);
    expect(useStore.getState().project.audioAssets).toHaveLength(2);
    expect(new Set(useStore.getState().project.audioAssets.map((asset) =>
      asset.availability === 'ready' ? asset.checksumSha256 : asset.id,
    )).size).toBe(1);
  });

  it('keeps the project byte-for-byte unchanged when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = useStore.getState();
    const projectBefore = fingerprint(before.project);
    const result = await actions.importStudioAudioTrack(input(controller.signal), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: async () => {
        throw new Error('decode must not start');
      },
      canonicalize: async () => canonicalResult(),
    });

    expect(result).toEqual({ ok: false, code: 'cancelled' });
    expect(fingerprint(useStore.getState().project)).toBe(projectBefore);
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });

  it('accepts the descriptor-known shared reservation boundary and rejects one byte beyond it before inspect or decode', async () => {
    const importPeak = actions.planStudioAudioImportResources(
      bytes.byteLength,
      descriptor,
      48_000,
    ).peakBytes;
    const inspectSource = vi.fn(async () => descriptor);
    const decodeSource = vi.fn(async () => ({}) as AudioBuffer);
    const boundary = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - importPeak,
    );
    try {
      await expect(actions.importStudioAudioTrack(input(), {
        repository: new MemoryAudioAssetRepository(),
        inspectSource,
        decodeSource,
        canonicalize: async () => canonicalResult(),
        createAssetId: () => 'asset-known-reservation-boundary',
      })).resolves.toMatchObject({
        ok: true,
        audioAssetId: 'asset-known-reservation-boundary',
      });
      expect(inspectSource).not.toHaveBeenCalled();
      expect(decodeSource).toHaveBeenCalledOnce();
    } finally {
      boundary.release();
    }

    inspectSource.mockClear();
    decodeSource.mockClear();
    const overBoundary = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - importPeak + 1,
    );
    try {
      await expect(actions.importStudioAudioTrack(input(), {
        repository: new MemoryAudioAssetRepository(),
        inspectSource,
        decodeSource,
        canonicalize: async () => canonicalResult(),
      })).resolves.toEqual({ ok: false, code: 'resource-limit-exceeded' });
      expect(inspectSource).not.toHaveBeenCalled();
      expect(decodeSource).not.toHaveBeenCalled();
    } finally {
      overBoundary.release();
    }
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('reserves the descriptor inspection copy before reading the Blob at boundary plus one', async () => {
    const descriptorUnknownInput = { ...input(), descriptor: undefined };
    const inspectionPeak = 2 * descriptorUnknownInput.byteLength;
    const inspectSource = vi.fn(async () => descriptor);
    const decodeSource = vi.fn(async () => ({}) as AudioBuffer);

    const boundary = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - inspectionPeak,
    );
    try {
      await expect(actions.importStudioAudioTrack(descriptorUnknownInput, {
        repository: new MemoryAudioAssetRepository(),
        inspectSource,
        decodeSource,
        canonicalize: async () => canonicalResult(),
      })).resolves.toEqual({ ok: false, code: 'resource-limit-exceeded' });
      expect(inspectSource).toHaveBeenCalledOnce();
      expect(decodeSource).not.toHaveBeenCalled();
    } finally {
      boundary.release();
    }

    inspectSource.mockClear();
    const overBoundary = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - inspectionPeak + 1,
    );
    try {
      await expect(actions.importStudioAudioTrack(descriptorUnknownInput, {
        repository: new MemoryAudioAssetRepository(),
        inspectSource,
        decodeSource,
        canonicalize: async () => canonicalResult(),
      })).resolves.toEqual({ ok: false, code: 'resource-limit-exceeded' });
      expect(inspectSource).not.toHaveBeenCalled();
      expect(decodeSource).not.toHaveBeenCalled();
    } finally {
      overBoundary.release();
    }
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('holds the native response envelope through immediate Blob handoff and releases idempotently', () => {
    const sourceReservation = actions.reserveStudioNativeAudioSelection(bytes.byteLength);
    expect(getReservedHeavyAudioResourceBytes()).toBe(2 * bytes.byteLength);

    const blob = sourceReservation.createBlobForImmediateImport(bytes, 'audio/wav');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(bytes.byteLength);
    expect(getReservedHeavyAudioResourceBytes()).toBe(bytes.byteLength);

    sourceReservation.release();
    sourceReservation.release();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('reserves the native open callback boundary before invoking picker work', async () => {
    const maximumEnvelopeBytes = bytes.byteLength;
    const openWork = vi.fn(async () => 'opened');
    const boundary = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - 2 * maximumEnvelopeBytes,
    );
    try {
      await expect(actions.withStudioNativeAudioSelection(
        maximumEnvelopeBytes,
        openWork,
      )).resolves.toBe('opened');
      expect(openWork).toHaveBeenCalledOnce();
    } finally {
      boundary.release();
    }

    openWork.mockClear();
    const overBoundary = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - 2 * maximumEnvelopeBytes + 1,
    );
    try {
      await expect(actions.withStudioNativeAudioSelection(
        maximumEnvelopeBytes,
        openWork,
      )).rejects.toMatchObject({ code: 'resource-limit' });
      expect(openWork).not.toHaveBeenCalled();
    } finally {
      overBoundary.release();
    }
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('releases native selection memory when its callback returns early, throws or reports import rejection', async () => {
    await expect(actions.withStudioNativeAudioSelection(
      bytes.byteLength,
      async (reservation) => reservation.createBlobForImmediateImport(bytes, 'audio/wav').size,
    )).resolves.toBe(bytes.byteLength);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    await expect(actions.withStudioNativeAudioSelection(
      bytes.byteLength,
      async () => 'cancelled',
    )).resolves.toBe('cancelled');
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    await expect(actions.withStudioNativeAudioSelection(
      bytes.byteLength,
      async () => 'unmounted',
    )).resolves.toBe('unmounted');
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    await expect(actions.withStudioNativeAudioSelection(
      bytes.byteLength,
      async () => { throw new Error('gateway failed'); },
    )).rejects.toThrow('gateway failed');
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    await expect(actions.withStudioNativeAudioSelection(
      bytes.byteLength,
      async (reservation) => {
        reservation.createBlobForImmediateImport(bytes, 'audio/wav');
        return { ok: false, code: 'resource-limit-exceeded' } as const;
      },
    )).resolves.toEqual({ ok: false, code: 'resource-limit-exceeded' });
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('retains the app import lease until an aborted offline render actually settles', async () => {
    let releaseRender: ((value: AudioBuffer) => void) | undefined;
    let resampleJob: CanonicalAudioResampleJob | undefined;
    const rendering = new Promise<AudioBuffer>((resolve) => {
      releaseRender = resolve;
    });
    const startRendering = vi.fn(() => rendering);
    const createOfflineContext = vi.fn(() => ({
      destination: {},
      createBufferSource: () => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      }),
      startRendering,
    }) as unknown as OfflineAudioContext);
    const controller = new AbortController();
    const firstDecode = vi.fn(async () => audioBufferShape(88_200, 44_100));
    const first = actions.importStudioAudioTrack(input(controller.signal), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: firstDecode,
      canonicalize: (source, options) => canonicalizeAudioAsset(source, {
        ...options,
        createOfflineContext,
        onResampleJob: (job) => {
          resampleJob = job;
          options.onResampleJob?.(job);
        },
      }),
    });

    await vi.waitFor(() => expect(startRendering).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(getReservedHeavyAudioResourceBytes()).toBeGreaterThan(0);

    expect(actions.beginStudioAudioTrackRecording()).toEqual({
      ok: false,
      code: 'decode-busy',
    });
    expect(useStore.getState().audioRecordingOperationId).toBeNull();

    const secondDecode = vi.fn(async () => ({}) as AudioBuffer);
    await expect(actions.importStudioAudioTrack(input(), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: secondDecode,
      canonicalize: async () => canonicalResult(),
    })).resolves.toEqual({ ok: false, code: 'decode-busy' });
    expect(secondDecode).not.toHaveBeenCalled();

    if (!releaseRender || !resampleJob) throw new Error('resample job was not started');
    releaseRender(audioBufferShape(96_000, 48_000));
    await resampleJob.settled;
    await Promise.resolve();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    const recordingAfterSettlement = actions.beginStudioAudioTrackRecording();
    expect(recordingAfterSettlement.ok).toBe(true);
    if (!recordingAfterSettlement.ok) throw new Error(recordingAfterSettlement.code);
    actions.discardStudioAudioTrackRecording(recordingAfterSettlement.handle);

    const thirdDecode = vi.fn(async () => ({}) as AudioBuffer);
    await expect(actions.importStudioAudioTrack(input(), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: thirdDecode,
      canonicalize: async () => canonicalResult(),
      createAssetId: () => 'asset-after-render-settled',
    })).resolves.toMatchObject({ ok: true, audioAssetId: 'asset-after-render-settled' });
    expect(thirdDecode).toHaveBeenCalledOnce();
  });

  it('rejects a stale async result without overwriting an intervening edit', async () => {
    let release!: (buffer: AudioBuffer) => void;
    const decoded = new Promise<AudioBuffer>((resolve) => { release = resolve; });
    const pending = actions.importStudioAudioTrack(input(), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: () => decoded,
      canonicalize: async () => canonicalResult(),
      createAssetId: () => 'asset-stale-import',
    });
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      title: '同時編集を保持',
    }))).toBe(true);
    release({} as AudioBuffer);

    await expect(pending).resolves.toEqual({ ok: false, code: 'commit-rejected' });
    expect(useStore.getState().project.title).toBe('同時編集を保持');
    expect(useStore.getState().project.tracks.some((track) => track.type === 'audio')).toBe(false);
  });

  it('turns a throwing asset id factory into a typed failure after safe orphan storage', async () => {
    const before = useStore.getState();
    const projectBefore = fingerprint(before.project);
    const result = await actions.importStudioAudioTrack(input(), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: async () => ({}) as AudioBuffer,
      canonicalize: async () => canonicalResult(),
      createAssetId: () => { throw new Error('factory failure'); },
    });

    expect(result).toEqual({ ok: false, code: 'id-factory-failed' });
    expect(fingerprint(useStore.getState().project)).toBe(projectBefore);
    expect(useStore.getState().past).toHaveLength(before.past.length);
  });

  it.each([
    {
      label: 'decoder channel upper bound',
      hostile: { decodeChannelCountUpperBound: 3 },
      code: 'channel-limit-exceeded' as const,
    },
    {
      label: 'compressed duration expansion',
      hostile: {
        containerDurationSeconds: 2_000,
        decodeDurationSeconds: 2_000,
      },
      code: 'resource-limit-exceeded' as const,
    },
  ])('rejects hostile $label before decode allocation', async ({ hostile, code }) => {
    const decodeSource = vi.fn(async () => ({}) as AudioBuffer);
    const before = fingerprint(useStore.getState().project);
    const result = await actions.importStudioAudioTrack({
      ...input(),
      descriptor: { ...descriptor, ...hostile },
    }, {
      repository: new MemoryAudioAssetRepository(),
      decodeSource,
      canonicalize: async () => canonicalResult(),
    });

    expect(result).toEqual({ ok: false, code });
    expect(decodeSource).not.toHaveBeenCalled();
    expect(fingerprint(useStore.getState().project)).toBe(before);
  });

  it('re-budgets against a host decode context sample rate', () => {
    const shorterDescriptor = {
      ...descriptor,
      containerDurationSeconds: 300,
      decodeDurationSeconds: 300,
    };
    expect(() => actions.preflightStudioAudioDecode(
      shorterDescriptor,
      48_000,
      bytes.byteLength,
    )).not.toThrow();
    expect(() => actions.preflightStudioAudioDecode(
      shorterDescriptor,
      384_000,
      bytes.byteLength,
    )).toThrowError(
      expect.objectContaining({ code: 'resource-limit-exceeded' }),
    );
  });

  it('rejects an actual 384 kHz decode rate before decodeAudioData and releases its reservation', async () => {
    const decodeAudioData = vi.fn(async () => audioBufferShape(1, 384_000));
    const close = vi.fn(async () => undefined);
    const canonicalize = vi.fn(async () => canonicalResult());
    const originalAudioContext = globalThis.AudioContext;
    vi.stubGlobal('AudioContext', class {
      readonly sampleRate = 384_000;
      readonly decodeAudioData = decodeAudioData;
      readonly close = close;
    });
    try {
      const longDescriptor = {
        ...descriptor,
        containerDurationSeconds: 300,
        decodeDurationSeconds: 300,
      };
      await expect(actions.importStudioAudioTrack({
        ...input(),
        descriptor: longDescriptor,
      }, {
        repository: new MemoryAudioAssetRepository(),
        canonicalize,
      })).resolves.toEqual({ ok: false, code: 'resource-limit-exceeded' });

      expect(decodeAudioData).not.toHaveBeenCalled();
      expect(canonicalize).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    } finally {
      if (originalAudioContext === undefined) vi.unstubAllGlobals();
      else vi.stubGlobal('AudioContext', originalAudioContext);
    }
  });

  it('plans bounded decode, canonicalization and persistence peaks without resampling', () => {
    expect(actions.planStudioAudioImportResources(bytes.byteLength, descriptor, 48_000)).toEqual({
      sourceBytes: 8,
      channelCount: 1,
      decodedFrameCount: 96_000,
      decodedFloat32Bytes: 384_000,
      canonicalFrameCount: 96_000,
      canonicalFloat32Bytes: 384_000,
      canonicalPcm16WavBytes: 192_044,
      requiresCanonicalResample: false,
      decodePeakBytes: 384_016,
      canonicalPeakBytes: 576_052,
      persistPeakBytes: 1_920_360,
      peakBytes: 1_920_360,
    });
  });

  it('includes both decoded and canonical Float32 buffers when the host must resample', () => {
    expect(actions.planStudioAudioImportResources(
      bytes.byteLength,
      { ...descriptor, sampleRate: 44_100 },
      44_100,
    ))
      .toMatchObject({
        decodedFrameCount: 88_200,
        decodedFloat32Bytes: 352_800,
        canonicalFloat32Bytes: 384_000,
        canonicalPcm16WavBytes: 192_044,
        requiresCanonicalResample: true,
        decodePeakBytes: 352_816,
        canonicalPeakBytes: 928_852,
        persistPeakBytes: 1_889_160,
        peakBytes: 1_889_160,
      });
  });

  it('accepts the conservative persistence-copy boundary and rejects one byte beyond it', () => {
    const frameCount = 20_000_000;
    const canonicalWavBytes = 44 + frameCount * 2;
    const decodedBytes = frameCount * Float32Array.BYTES_PER_ELEMENT;
    const boundaryInputBytes = actions.MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES
      - decodedBytes
      - actions.STUDIO_AUDIO_PERSIST_WAV_COPY_FACTOR * canonicalWavBytes;
    const longMono = {
      ...descriptor,
      containerDurationSeconds: frameCount / 48_000,
      decodeDurationSeconds: frameCount / 48_000,
    };

    expect(actions.planStudioAudioImportResources(
      boundaryInputBytes,
      longMono,
      48_000,
    ).persistPeakBytes).toBe(actions.MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES);
    expect(() => actions.planStudioAudioImportResources(
      boundaryInputBytes + 1,
      longMono,
      48_000,
    )).toThrowError(expect.objectContaining({ code: 'resource-limit-exceeded' }));
  });

  it('accepts the 384 MiB phase boundary and rejects one byte beyond it', () => {
    const oneSecond = {
      ...descriptor,
      containerDurationSeconds: 1,
      decodeDurationSeconds: 1,
    };
    const decodedBytes = 48_000 * 4;
    const boundary = (actions.MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES - decodedBytes) / 2;

    expect(actions.planStudioAudioImportResources(boundary, oneSecond, 48_000).peakBytes)
      .toBe(actions.MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES);
    expect(() => actions.planStudioAudioImportResources(boundary + 1, oneSecond, 48_000))
      .toThrowError(expect.objectContaining({ code: 'resource-limit-exceeded' }));
  });

  it.each([
    { inputByteLength: Number.MAX_SAFE_INTEGER, descriptor },
    {
      inputByteLength: bytes.byteLength,
      descriptor: { ...descriptor, decodeDurationSeconds: Number.POSITIVE_INFINITY },
    },
  ])('rejects invalid or overflowing planner arithmetic', ({ inputByteLength, descriptor: source }) => {
    expect(() => actions.planStudioAudioImportResources(inputByteLength, source, 48_000))
      .toThrowError(expect.objectContaining({ code: 'resource-limit-exceeded' }));
  });

  it('rejects a 600-second stereo PCM source before calling the decoder', async () => {
    const inputByteLength = 105_840_044;
    const decodeSource = vi.fn(async () => ({}) as AudioBuffer);
    const sourceBlob = {
      size: inputByteLength,
      slice: vi.fn(),
    } as unknown as Blob;
    const projectBefore = fingerprint(useStore.getState().project);
    const result = await actions.importStudioAudioTrack({
      ...input(),
      blob: sourceBlob,
      byteLength: inputByteLength,
      descriptor: {
        ...descriptor,
        sampleRate: 44_100,
        channelCount: 2,
        decodeChannelCountUpperBound: 2,
        containerDurationSeconds: 600,
        decodeDurationSeconds: 600,
      },
    }, {
      repository: new MemoryAudioAssetRepository(),
      decodeSource,
      canonicalize: async () => canonicalResult(),
    });

    expect(result).toEqual({ ok: false, code: 'resource-limit-exceeded' });
    expect(decodeSource).not.toHaveBeenCalled();
    expect(sourceBlob.slice).not.toHaveBeenCalled();
    expect(fingerprint(useStore.getState().project)).toBe(projectBefore);
  });
});

describe('Studio Audio Track microphone recording', () => {
  it('requires an explicit input before acquiring a loopback calibration fence', () => {
    const projectBefore = useStore.getState().project;

    expect(actions.beginStudioRecordingLatencyCalibration()).toEqual({
      ok: false,
      code: 'input-device-required',
    });
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(useStore.getState().project).toBe(projectBefore);
  });

  it('disposes hidden natural-drain audio before calibrating a stopped transport', () => {
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-loopback')).toBe(true);
    expect(useStore.getState().transport.phase).toBe('stopped');
    const stopRuntimeAudio = vi.fn();

    const ownership = actions.beginStudioRecordingLatencyCalibration({
      stopRuntimePlaybackAudio: stopRuntimeAudio,
    });

    expect(stopRuntimeAudio).toHaveBeenCalledOnce();
    expect(ownership.ok).toBe(true);
    if (!ownership.ok) throw new Error(ownership.code);
    actions.discardStudioRecordingLatencyCalibration(ownership.handle);
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
  });

  it('commits loopback evidence under the recording fence without changing the Project', () => {
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-loopback')).toBe(true);
    const before = useStore.getState();
    const projectBefore = fingerprint(before.project);
    const pastBefore = before.past;
    const saveBefore = before.saveState;
    const ownership = actions.beginStudioRecordingLatencyCalibration();
    expect(ownership).toMatchObject({
      ok: true,
      inputDeviceId: 'usb-loopback',
      playbackStopped: false,
    });
    if (!ownership.ok) throw new Error(ownership.code);
    expect(useStore.getState().audioRecordingOperationId).toBe(ownership.handle.operationId);

    expect(actions.commitStudioRecordingLatencyCalibration(ownership.handle, {
      latencyFrames: 4_800,
      sampleRate: 48_000,
      contextGeneration: 7,
      confidence: 0.94,
    })).toBe(true);

    const after = useStore.getState();
    expect(after.audioRecordingOperationId).toBeNull();
    expect(after.recordingLatencyCompensationMode).toBe('calibrated');
    expect(after.recordingLatencyCalibration).toEqual({
      inputDeviceId: 'usb-loopback',
      latencyFrames: 4_800,
      sampleRate: 48_000,
      contextGeneration: 7,
      confidence: 0.94,
    });
    expect(fingerprint(after.project)).toBe(projectBefore);
    expect(after.past).toBe(pastBefore);
    expect(after.saveState).toBe(saveBefore);

    const cancelled = actions.beginStudioRecordingLatencyCalibration();
    if (!cancelled.ok) throw new Error(cancelled.code);
    actions.discardStudioRecordingLatencyCalibration(cancelled.handle);
    expect(useStore.getState().recordingLatencyCalibration).toEqual(
      after.recordingLatencyCalibration,
    );
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
  });

  it('uses calibrated round-trip latency instead of double-counting host estimates', async () => {
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-loopback')).toBe(true);
    const calibration = actions.beginStudioRecordingLatencyCalibration();
    if (!calibration.ok) throw new Error(calibration.code);
    expect(actions.commitStudioRecordingLatencyCalibration(calibration.handle, {
      latencyFrames: 4_800,
      sampleRate: 48_000,
      contextGeneration: 7,
      confidence: 0.9,
    })).toBe(true);
    expect(useStore.getState().setRecordingLatencyAdjustmentMs(20)).toBe(true);
    useStore.getState().setPosition(4);
    const ownership = actions.beginStudioAudioTrackRecording();
    if (!ownership.ok) throw new Error(ownership.code);
    const snapshot = useStore.getState().project;
    const requestId = useStore.getState().startAudioRecordingPlayback(
      ownership.handle.operationId,
      ownership.startBeat,
    );
    if (requestId === null) throw new Error('recording playback request missing');
    useStore.getState().confirmPlaybackStarted(requestId);
    const context = {
      sampleRate: 48_000,
      baseLatency: 0.2,
      outputLatency: 0.2,
    } as AudioContext;
    expect(actions.bindStudioAudioTrackRecordingToPlayback(ownership.handle, {
      context,
      contextGeneration: 7,
      sampleRate: 48_000,
      anchorContextFrame: 96_000,
      anchorBeat: 4,
      tempo: {},
      requestId,
      projectSnapshot: snapshot,
    } as Parameters<typeof actions.bindStudioAudioTrackRecordingToPlayback>[1])).toBe(true);

    const result = await actions.recordStudioAudioTrack({
      recordingHandle: ownership.handle,
      capture: {
        ...microphoneCaptureShape(),
        contextGeneration: 7,
        firstContextFrame: 96_000,
        endContextFrameExclusive: 192_000,
        inputLatencySeconds: 0.3,
      },
      trackName: 'Calibrated Take',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: async () => canonicalResult(),
      createAssetId: () => 'asset-calibrated-recording',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const clip = useStore.getState().project.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === result.clipId);
    expect(clip).toMatchObject({
      type: 'audio',
      startBeat: 3.76,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
    });
  });

  it('fails closed when calibrated evidence belongs to another context generation', () => {
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-loopback')).toBe(true);
    const calibration = actions.beginStudioRecordingLatencyCalibration();
    if (!calibration.ok) throw new Error(calibration.code);
    expect(actions.commitStudioRecordingLatencyCalibration(calibration.handle, {
      latencyFrames: 4_800,
      sampleRate: 48_000,
      contextGeneration: 7,
      confidence: 0.9,
    })).toBe(true);
    useStore.getState().setPosition(4);
    const ownership = actions.beginStudioAudioTrackRecording();
    if (!ownership.ok) throw new Error(ownership.code);
    const snapshot = useStore.getState().project;
    const requestId = useStore.getState().startAudioRecordingPlayback(
      ownership.handle.operationId,
      ownership.startBeat,
    );
    if (requestId === null) throw new Error('recording playback request missing');
    useStore.getState().confirmPlaybackStarted(requestId);

    expect(actions.bindStudioAudioTrackRecordingToPlayback(ownership.handle, {
      context: { sampleRate: 48_000, baseLatency: 0, outputLatency: 0 } as AudioContext,
      contextGeneration: 8,
      sampleRate: 48_000,
      anchorContextFrame: 96_000,
      anchorBeat: 4,
      tempo: {},
      requestId,
      projectSnapshot: snapshot,
    } as Parameters<typeof actions.bindStudioAudioTrackRecordingToPlayback>[1])).toBe(false);
    actions.discardStudioAudioTrackRecording(ownership.handle);
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
  });

  it('fails closed when devicechange invalidates the frozen calibration before clock bind', () => {
    expect(useStore.getState().setPreferredMicrophoneInputDeviceId('usb-loopback')).toBe(true);
    const calibration = actions.beginStudioRecordingLatencyCalibration();
    if (!calibration.ok) throw new Error(calibration.code);
    expect(actions.commitStudioRecordingLatencyCalibration(calibration.handle, {
      latencyFrames: 4_800,
      sampleRate: 48_000,
      contextGeneration: 7,
      confidence: 0.9,
    })).toBe(true);
    useStore.getState().setPosition(4);
    const ownership = actions.beginStudioAudioTrackRecording();
    if (!ownership.ok) throw new Error(ownership.code);
    const snapshot = useStore.getState().project;
    const requestId = useStore.getState().startAudioRecordingPlayback(
      ownership.handle.operationId,
      ownership.startBeat,
    );
    if (requestId === null) throw new Error('recording playback request missing');
    useStore.getState().confirmPlaybackStarted(requestId);

    expect(useStore.getState().clearRecordingLatencyCalibration()).toBe(true);
    expect(actions.bindStudioAudioTrackRecordingToPlayback(ownership.handle, {
      context: { sampleRate: 48_000, baseLatency: 0, outputLatency: 0 } as AudioContext,
      contextGeneration: 7,
      sampleRate: 48_000,
      anchorContextFrame: 96_000,
      anchorBeat: 4,
      tempo: {},
      requestId,
      projectSnapshot: snapshot,
    } as Parameters<typeof actions.bindStudioAudioTrackRecordingToPlayback>[1])).toBe(false);

    actions.discardStudioAudioTrackRecording(ownership.handle);
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(useStore.getState().recordingLatencyCompensationMode).toBe('estimated');
  });

  it('binds one shared clock and applies estimated plus manual latency to placement', async () => {
    useStore.getState().setPosition(4);
    expect(useStore.getState().setRecordingLatencyAdjustmentMs(20)).toBe(true);
    const ownership = actions.beginStudioAudioTrackRecording();
    if (!ownership.ok) throw new Error(ownership.code);
    const snapshot = useStore.getState().project;
    const requestId = useStore.getState().startAudioRecordingPlayback(
      ownership.handle.operationId,
      ownership.startBeat,
    );
    if (requestId === null) throw new Error('recording playback request missing');
    useStore.getState().confirmPlaybackStarted(requestId);
    const context = {
      sampleRate: 48_000,
      baseLatency: 0.01,
      outputLatency: 0.02,
    } as AudioContext;
    const clock = {
      context,
      contextGeneration: 7,
      sampleRate: 48_000,
      anchorContextFrame: 96_000,
      anchorBeat: 4,
      tempo: {},
      requestId,
      projectSnapshot: snapshot,
    } as Parameters<typeof actions.bindStudioAudioTrackRecordingToPlayback>[1];

    expect(actions.estimateStudioRecordingPlaybackLatencySeconds(context)).toBeCloseTo(0.036, 12);
    expect(actions.bindStudioAudioTrackRecordingToPlayback(ownership.handle, clock)).toBe(true);
    expect(actions.bindStudioAudioTrackRecordingToPlayback(ownership.handle, clock)).toBe(false);

    const capture = {
      ...microphoneCaptureShape(),
      contextGeneration: 7,
      firstContextFrame: 96_000,
      endContextFrameExclusive: 192_000,
      inputLatencySeconds: 0.014,
    };
    const result = await actions.recordStudioAudioTrack({
      recordingHandle: ownership.handle,
      capture,
      trackName: 'Aligned Take',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: async () => canonicalResult(),
      createAssetId: () => 'asset-aligned-recording',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const clip = useStore.getState().project.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === result.clipId);
    expect(clip).toMatchObject({
      type: 'audio',
      startBeat: 3.86,
      sourceStartFrame: 0,
      sourceFrameCount: 96_000,
    });
  });

  it('rejects a capture from a replacement audio-context generation before allocation', async () => {
    useStore.getState().setPosition(4);
    const ownership = actions.beginStudioAudioTrackRecording();
    if (!ownership.ok) throw new Error(ownership.code);
    const snapshot = useStore.getState().project;
    const requestId = useStore.getState().startAudioRecordingPlayback(
      ownership.handle.operationId,
      ownership.startBeat,
    );
    if (requestId === null) throw new Error('recording playback request missing');
    useStore.getState().confirmPlaybackStarted(requestId);
    const context = { sampleRate: 48_000, baseLatency: 0, outputLatency: 0 } as AudioContext;
    expect(actions.bindStudioAudioTrackRecordingToPlayback(ownership.handle, {
      context,
      contextGeneration: 7,
      sampleRate: 48_000,
      anchorContextFrame: 96_000,
      anchorBeat: 4,
      tempo: {},
      requestId,
      projectSnapshot: snapshot,
    } as Parameters<typeof actions.bindStudioAudioTrackRecordingToPlayback>[1])).toBe(true);
    const createAudioBuffer = vi.fn(() => audioBufferShape(96_000, 48_000));

    await expect(actions.recordStudioAudioTrack({
      recordingHandle: ownership.handle,
      capture: {
        ...microphoneCaptureShape(),
        contextGeneration: 8,
        firstContextFrame: 96_000,
        endContextFrameExclusive: 192_000,
      },
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer,
      canonicalize: async () => canonicalResult(),
    })).resolves.toEqual({ ok: false, code: 'recording-alignment-failed' });
    expect(createAudioBuffer).not.toHaveBeenCalled();
    expect(useStore.getState().project).toBe(snapshot);
  });

  it('persists canonical bytes and adopts a playhead-positioned track in one Undo step', async () => {
    const repository = new MemoryAudioAssetRepository();
    useStore.getState().setPosition(6);
    const recordingHandle = beginRecordingHandle();
    const historyBefore = useStore.getState().past.length;
    const revisionBefore = useStore.getState().saveState.revision;

    const result = await actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(),
      trackName: 'Lead Take',
      fileName: 'Lead Take.wav',
    }, {
      repository,
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: async () => canonicalResult(),
      createAssetId: () => 'asset-recorded-take',
    });

    expect(result).toMatchObject({
      ok: true,
      trackName: 'Lead Take',
      audioAssetId: 'asset-recorded-take',
    });
    if (!result.ok) throw new Error(result.code);
    const state = useStore.getState();
    const track = state.project.tracks.find((candidate) => candidate.id === result.trackId);
    const asset = state.project.audioAssets.find((candidate) => candidate.id === result.audioAssetId);
    expect(track?.clips[0]).toMatchObject({ type: 'audio', startBeat: 6 });
    expect(asset).toMatchObject({ originalName: 'Lead Take.wav', frameCount: 96_000 });
    expect(state.past).toHaveLength(historyBefore + 1);
    expect(state.saveState.revision).toBe(revisionBefore + 1);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    if (!asset || asset.availability !== 'ready') throw new Error('recorded asset missing');
    await expect(repository.read(asset)).resolves.toEqual(bytes);

    state.undo();
    expect(useStore.getState().project.tracks.some((candidate) => candidate.id === result.trackId))
      .toBe(false);
    useStore.getState().redo();
    expect(useStore.getState().project.tracks.some((candidate) => candidate.id === result.trackId))
      .toBe(true);
  });

  it('appends a take to the frozen existing Audio Track without creating routing', async () => {
    const { result: imported } = await importFixture();
    const before = useStore.getState();
    const targetBefore = before.project.tracks.find((track) => track.id === imported.trackId);
    if (!targetBefore) throw new Error('recording target fixture missing');
    const trackCountBefore = before.project.tracks.length;
    const routingBefore = before.project.audioRouting;
    const historyBefore = before.past.length;
    useStore.getState().setPosition(10);
    const requestedTarget: {
      kind: 'existing-audio-track';
      trackId: string;
    } = { kind: 'existing-audio-track', trackId: imported.trackId };
    const ownership = actions.beginStudioAudioTrackRecording({
      target: requestedTarget,
    });
    if (!ownership.ok) throw new Error(ownership.code);
    requestedTarget.trackId = 'mutated-after-permission-boundary';

    const result = await actions.recordStudioAudioTrack({
      recordingHandle: ownership.handle,
      capture: microphoneCaptureShape(),
      fileName: 'Second Take.wav',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: async () => canonicalResult(),
      createAssetId: () => 'asset-recorded-existing-track',
    });

    expect(result).toMatchObject({
      ok: true,
      trackId: imported.trackId,
      trackName: targetBefore.name,
      audioAssetId: 'asset-recorded-existing-track',
    });
    if (!result.ok) throw new Error(result.code);
    const adopted = useStore.getState();
    const targetAfter = adopted.project.tracks.find((track) => track.id === imported.trackId);
    expect(adopted.project.tracks).toHaveLength(trackCountBefore);
    expect(adopted.project.audioRouting).toBe(routingBefore);
    expect(targetAfter?.clips).toHaveLength(targetBefore.clips.length + 1);
    expect(targetAfter?.clips.at(-1)).toMatchObject({
      id: result.clipId,
      type: 'audio',
      startBeat: 10,
      audioAssetId: 'asset-recorded-existing-track',
    });
    expect(adopted.past).toHaveLength(historyBefore + 1);

    adopted.undo();
    const undoneTarget = useStore.getState().project.tracks.find(
      (track) => track.id === imported.trackId,
    );
    expect(undoneTarget?.clips).toHaveLength(targetBefore.clips.length);
    expect(useStore.getState().project.tracks).toHaveLength(trackCountBefore);
  });

  it('rejects an invalid existing destination before reserving microphone ownership', () => {
    expect(actions.beginStudioAudioTrackRecording({
      target: { kind: 'existing-audio-track', trackId: 'missing-track' },
    })).toEqual({ ok: false, code: 'track-not-found' });

    const instrument = useStore.getState().project.tracks.find(
      (track) => track.type === 'instrument',
    );
    expect(actions.beginStudioAudioTrackRecording({
      target: { kind: 'existing-audio-track', trackId: instrument?.id ?? '' },
    })).toEqual({ ok: false, code: 'unsupported-track-type' });
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('rejects loop recording and a sub-0.5-second song-end window before permission', () => {
    useStore.getState().toggleLoop();
    expect(actions.beginStudioAudioTrackRecording()).toEqual({
      ok: false,
      code: 'transport-loop-enabled',
    });
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);

    useStore.getState().toggleLoop();
    const endBeat = useStore.getState().project.lengthBeats;
    useStore.getState().setPosition(endBeat - 0.01);
    expect(actions.beginStudioAudioTrackRecording()).toEqual({
      ok: false,
      code: 'recording-window-too-short',
    });
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('counts stale capture chunks and rejects a 192 kHz stereo worst case before AudioBuffer allocation', () => {
    const worstCase = microphoneCaptureShape(60 * 192_000, 192_000, 2);
    expect(() => actions.planStudioAudioRecordingResources(worstCase))
      .toThrowError(expect.objectContaining({ code: 'resource-limit-exceeded' }));

    const supported = microphoneCaptureShape(60 * 48_000, 48_000, 2);
    const plan = actions.planStudioAudioRecordingResources(supported);
    expect(plan).toMatchObject({
      captureChunkFloat32Bytes: 23_040_000,
      capturedFloat32Bytes: 23_040_000,
      audioBufferFloat32Bytes: 23_040_000,
      captureRuntimeOverheadBytes: 16 * 1024 * 1024,
      canonicalFrameCount: 2_880_000,
      canonicalFloat32Bytes: 23_040_000,
      canonicalPcm16WavBytes: 11_520_044,
      requiresCanonicalResample: false,
    });
    expect(plan.peakBytes).toBeLessThan(actions.MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES);
  });

  it('keeps the project unchanged on cancellation and releases a transferred reservation', async () => {
    const controller = new AbortController();
    controller.abort();
    const recordingHandle = beginRecordingHandle();
    const before = useStore.getState();
    const result = await actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(),
      signal: controller.signal,
      trackName: 'Cancelled Take',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => {
        throw new Error('must not allocate');
      },
      canonicalize: async () => canonicalResult(),
    });

    expect(result).toEqual({ ok: false, code: 'cancelled' });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('rejects a stale finalization without overwriting an intervening edit', async () => {
    let release!: (result: CanonicalAudioAssetResult) => void;
    const canonical = new Promise<CanonicalAudioAssetResult>((resolve) => { release = resolve; });
    const recordingHandle = beginRecordingHandle();
    const pending = actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(),
      trackName: 'Stale Take',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: () => canonical,
      createAssetId: () => 'asset-stale-recording',
    });
    // Public Project actions are fenced for the whole take. Force a hostile
    // external replacement to keep the exact-snapshot CAS regression covered.
    useStore.setState((state) => ({
      project: { ...state.project, title: '録音中の別編集' },
    }));
    release(canonicalResult());

    await expect(pending).resolves.toEqual({ ok: false, code: 'commit-rejected' });
    expect(useStore.getState().project.title).toBe('録音中の別編集');
    expect(useStore.getState().project.tracks.some((track) => track.type === 'audio')).toBe(false);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('uses the project snapshot from capture start as the only commit base', async () => {
    const recordingHandle = beginRecordingHandle();
    useStore.setState((state) => ({
      project: { ...state.project, title: '録音開始後の外部編集' },
    }));
    const createAudioBuffer = vi.fn(() => audioBufferShape(96_000, 48_000));

    await expect(actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(),
      trackName: 'Snapshot Take',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer,
      canonicalize: async () => canonicalResult(),
    })).resolves.toEqual({ ok: false, code: 'commit-rejected' });

    expect(createAudioBuffer).not.toHaveBeenCalled();
    expect(useStore.getState().project.title).toBe('録音開始後の外部編集');
    expect(useStore.getState().project.tracks.some((track) => track.type === 'audio')).toBe(false);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('reports storage exhaustion without adopting partial recording metadata', async () => {
    const repository: AudioAssetRepository = {
      kind: 'memory',
      store: async () => { throw new AudioAssetRepositoryError('too-large'); },
      read: async () => { throw new AudioAssetRepositoryError('missing'); },
      verify: async () => { throw new AudioAssetRepositoryError('missing'); },
    };
    const before = useStore.getState();
    const recordingHandle = beginRecordingHandle();
    const result = await actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(),
      trackName: 'No Space Take',
    }, {
      repository,
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: async () => canonicalResult(),
    });

    expect(result).toEqual({ ok: false, code: 'asset-store-failed' });
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toHaveLength(before.past.length);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('owns the shared import lease for the entire capture phase', async () => {
    const recordingHandle = beginRecordingHandle();
    const decodeSource = vi.fn(async () => ({}) as AudioBuffer);

    await expect(actions.importStudioAudioTrack(input(), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource,
      canonicalize: async () => canonicalResult(),
    })).resolves.toEqual({ ok: false, code: 'decode-busy' });
    expect(decodeSource).not.toHaveBeenCalled();

    actions.discardStudioAudioTrackRecording(recordingHandle);
    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('fails before microphone permission when the capture-phase memory cannot be reserved', () => {
    const competing = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - MICROPHONE_CAPTURE_RESERVATION_BYTES + 1,
    );
    try {
      expect(actions.beginStudioAudioTrackRecording()).toEqual({
        ok: false,
        code: 'resource-limit-exceeded',
      });
      expect(useStore.getState().audioRecordingOperationId).toBeNull();
    } finally {
      competing.release();
    }
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('counts an active decoded playback cache lease in the capture-phase reservation', async () => {
    const cache = getAudioAssetPlaybackCache();
    cache.clearUnused();
    const asset: ReadyAudioAsset = {
      id: 'active-cache-recording-boundary',
      availability: 'ready',
      checksumSha256: 'e'.repeat(64),
      originalName: 'active-cache.wav',
      mediaType: 'audio/wav',
      byteLength: 4,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 48_000,
    };
    const decodedLease = await cache.acquireDecoded({
      assets: [{ asset, bytes: new Uint8Array(4) }],
      estimatedDecodedBytes: 48_000 * Float32Array.BYTES_PER_ELEMENT,
    }, {
      sampleRate: 48_000,
      decodeAudioData: vi.fn(async () => audioBufferShape(48_000, 48_000)),
    } as unknown as BaseAudioContext);
    const retained = cache.retainedDecodedBytes;
    expect(retained).toBeGreaterThan(0);
    const competing = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES
        - MICROPHONE_CAPTURE_RESERVATION_BYTES
        - retained
        + 1,
    );
    try {
      expect(actions.beginStudioAudioTrackRecording()).toEqual({
        ok: false,
        code: 'resource-limit-exceeded',
      });
      expect(cache.retainedDecodedBytes).toBe(retained);
    } finally {
      competing.release();
      decodedLease.release();
      cache.clearUnused();
    }
    expect(cache.retainedDecodedBytes).toBe(0);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('evicts an unleased decoded cache entry before reserving microphone capture', async () => {
    const cache = getAudioAssetPlaybackCache();
    cache.clearUnused();
    const asset: ReadyAudioAsset = {
      id: 'unused-cache-recording-boundary',
      availability: 'ready',
      checksumSha256: 'd'.repeat(64),
      originalName: 'unused-cache.wav',
      mediaType: 'audio/wav',
      byteLength: 4,
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 48_000,
    };
    const decodedLease = await cache.acquireDecoded({
      assets: [{ asset, bytes: new Uint8Array(4) }],
      estimatedDecodedBytes: 48_000 * Float32Array.BYTES_PER_ELEMENT,
    }, {
      sampleRate: 48_000,
      decodeAudioData: vi.fn(async () => audioBufferShape(48_000, 48_000)),
    } as unknown as BaseAudioContext);
    decodedLease.release();
    expect(cache.retainedDecodedBytes).toBeGreaterThan(0);
    const competing = reserveHeavyAudioResources(
      MAX_HEAVY_AUDIO_RESOURCE_BYTES - MICROPHONE_CAPTURE_RESERVATION_BYTES,
    );
    try {
      const recording = actions.beginStudioAudioTrackRecording();
      expect(recording.ok).toBe(true);
      expect(cache.retainedDecodedBytes).toBe(0);
      if (recording.ok) actions.discardStudioAudioTrackRecording(recording.handle);
    } finally {
      competing.release();
      cache.clearUnused();
    }
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('rejects adoption if the exact recording token is revoked during finalization', async () => {
    let release!: (result: CanonicalAudioAssetResult) => void;
    const canonical = new Promise<CanonicalAudioAssetResult>((resolve) => { release = resolve; });
    const recordingHandle = beginRecordingHandle();
    const projectBefore = useStore.getState().project;
    const pending = actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(),
      trackName: 'Revoked Take',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => audioBufferShape(96_000, 48_000),
      canonicalize: () => canonical,
    });

    useStore.getState().finishAudioRecordingOperation(recordingHandle.operationId);
    release(canonicalResult());

    await expect(pending).resolves.toEqual({ ok: false, code: 'commit-rejected' });
    expect(useStore.getState().project).toBe(projectBefore);
    expect(useStore.getState().past).toHaveLength(0);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('keeps close, import, and another recording fenced until aborted resampling settles', async () => {
    let releaseRender: ((value: AudioBuffer) => void) | undefined;
    let resampleJob: CanonicalAudioResampleJob | undefined;
    const rendering = new Promise<AudioBuffer>((resolve) => {
      releaseRender = resolve;
    });
    const startRendering = vi.fn(() => rendering);
    const createOfflineContext = vi.fn(() => ({
      destination: {},
      createBufferSource: () => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      }),
      startRendering,
    }) as unknown as OfflineAudioContext);
    const controller = new AbortController();
    const recordingHandle = beginRecordingHandle();
    const pending = actions.recordStudioAudioTrack({
      recordingHandle,
      capture: microphoneCaptureShape(88_200, 44_100),
      signal: controller.signal,
      trackName: 'Cancelled Resample',
    }, {
      repository: new MemoryAudioAssetRepository(),
      createAudioBuffer: () => audioBufferShape(88_200, 44_100),
      canonicalize: (source, options) => canonicalizeAudioAsset(source, {
        ...options,
        createOfflineContext,
        onResampleJob: (job) => {
          resampleJob = job;
          options.onResampleJob?.(job);
        },
      }),
    });

    await vi.waitFor(() => expect(startRendering).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(useStore.getState().audioRecordingOperationId).toBe(recordingHandle.operationId);
    expect(actions.beginStudioAudioTrackRecording()).toEqual({ ok: false, code: 'decode-busy' });
    await expect(actions.importStudioAudioTrack(input(), {
      repository: new MemoryAudioAssetRepository(),
      decodeSource: async () => ({}) as AudioBuffer,
      canonicalize: async () => canonicalResult(),
    })).resolves.toEqual({ ok: false, code: 'decode-busy' });
    expect(useStore.getState().tryBeginNativeClose()).toBe(false);
    expect(useStore.getState().persistenceNotice?.message).toContain('マイク録音');

    if (!releaseRender || !resampleJob) throw new Error('resample job was not started');
    releaseRender(audioBufferShape(96_000, 48_000));
    await resampleJob.settled;
    await Promise.resolve();

    expect(useStore.getState().audioRecordingOperationId).toBeNull();
    expect(useStore.getState().persistenceNotice).toBeNull();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    const retry = actions.beginStudioAudioTrackRecording();
    expect(retry.ok).toBe(true);
    if (retry.ok) actions.discardStudioAudioTrackRecording(retry.handle);
  });
});

describe('Studio Audio Clip commands', () => {
  it('moves, trims, adjusts gain/fades/loop and restores each gesture with one Undo', async () => {
    const { result: imported } = await importFixture();
    const clipId = imported.clipId;

    const assertOneStep = (
      operation: () => ReturnType<typeof actions.moveStudioAudioClip>,
      verify: () => void,
    ): void => {
      const before = contentFingerprint(useStore.getState().project);
      const historyBefore = useStore.getState().past.length;
      expect(operation()).toMatchObject({ ok: true, changed: true });
      verify();
      expect(useStore.getState().past).toHaveLength(historyBefore + 1);
      useStore.getState().undo();
      expect(contentFingerprint(useStore.getState().project)).toBe(before);
      useStore.getState().redo();
      verify();
    };

    assertOneStep(
      () => actions.moveStudioAudioClip(clipId, 4),
      () => expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId)?.startBeat).toBe(4),
    );
    assertOneStep(
      () => actions.trimStudioAudioClipLeft(clipId, 5),
      () => expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId)).toMatchObject({ startBeat: 5, sourceStartFrame: 24_000 }),
    );
    assertOneStep(
      () => actions.trimStudioAudioClipRight(clipId, 7),
      () => expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId)?.lengthBeats).toBe(2),
    );
    assertOneStep(
      () => actions.setStudioAudioClipGain(clipId, -6),
      () => expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId)?.gainDb).toBe(-6),
    );
    assertOneStep(
      () => actions.setStudioAudioClipFades(clipId, 1_000, 2_000),
      () => expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId)).toMatchObject({ fadeInFrames: 1_000, fadeOutFrames: 2_000 }),
    );
    assertOneStep(
      () => actions.setStudioAudioClipLoop(clipId, true),
      () => expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId)?.loop).toBe(true),
    );
  });

  it('splits, independently duplicates and deletes without linked aliases', async () => {
    const { result: imported } = await importFixture();
    const clipId = imported.clipId;
    const historyBeforeSplit = useStore.getState().past.length;
    const split = actions.splitStudioAudioClip(clipId, 2);
    expect(split).toMatchObject({ ok: true, changed: true });
    if (!split.ok || !split.rightClipId) throw new Error('split failed');
    expect(useStore.getState().past).toHaveLength(historyBeforeSplit + 1);
    expect(useStore.getState().editor.selectedClipId).toBe(split.rightClipId);

    const right = useStore.getState().project.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === split.rightClipId);
    if (!right) throw new Error('right clip missing');
    const historyBeforeCopy = useStore.getState().past.length;
    const copied = actions.duplicateStudioAudioClip(right.id, 8);
    expect(copied).toMatchObject({ ok: true, changed: true });
    if (!copied.ok) throw new Error('copy failed');
    expect(useStore.getState().past).toHaveLength(historyBeforeCopy + 1);
    expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === copied.clipId)?.aliasOf).toBeUndefined();

    const historyBeforeDelete = useStore.getState().past.length;
    expect(actions.deleteStudioAudioClip(copied.clipId)).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().past).toHaveLength(historyBeforeDelete + 1);
    expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
      .some((clip) => clip.id === copied.clipId)).toBe(false);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks.flatMap((track) => track.clips)
      .some((clip) => clip.id === copied.clipId)).toBe(true);
  });
});
