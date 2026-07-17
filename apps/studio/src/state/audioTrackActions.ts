import {
  createAudioTrackClip,
  deleteAudioClip,
  duplicateAudioClip,
  moveAudioClip,
  setAudioClipFades,
  setAudioClipGain,
  setAudioClipLoop,
  splitAudioClip,
  trimAudioClipLeft,
  trimAudioClipRight,
  type AudioClipMutationErrorCode,
  type AudioClipMutationResult,
  type Project,
  type ReadyAudioAsset,
  type SplitAudioClipResult,
} from '@cts/project-model';
import {
  CanonicalAudioAssetError,
  canonicalizeAudioAsset,
  type CanonicalAudioAssetProgress,
  type CanonicalAudioAssetResult,
  type CanonicalAudioResampleJob,
} from '../audio/canonicalAudioAsset';
import { getAudioAssetPlaybackCache } from '../audio/audioAssetResolver';
import {
  AudioResourceReservationError,
  MAX_HEAVY_AUDIO_RESOURCE_BYTES,
  checkedHeavyAudioResourceTotal,
  reserveHeavyAudioResources,
  type HeavyAudioResourceReservation,
} from '../audio/audioResourceReservation';
import {
  SourceAudioDecodeBusyError,
  awaitSourceAudioDecodeOrCancel,
  startExclusiveSourceAudioDecode,
  type SourceAudioDecodeJob,
} from '../audio/sourceAudioDecode';
import {
  SourceAudioFileError,
  inspectSourceAudioBlob,
  validateSourceAudioBlobSize,
  type SourceAudioDescriptor,
} from '../audio/sourceAudio';
import {
  MAX_MICROPHONE_CAPTURE_CHANNELS,
  MAX_MICROPHONE_CAPTURE_PCM_BYTES,
  MAX_MICROPHONE_CAPTURE_SAMPLE_RATE,
  MAX_MICROPHONE_CAPTURE_SECONDS,
  MICROPHONE_CAPTURE_RESERVATION_BYTES,
  type MicrophonePcmCapture,
} from '../audio/microphoneCapture';
import { reserveMicrophoneCaptureResources } from '../audio/microphoneCaptureReservation';
import {
  AudioAssetRepositoryError,
  MAX_AUDIO_ASSET_BYTES,
  storeAudioAssetBytes,
  type AudioAssetRepository,
  type AudioAssetStoreReceipt,
} from '../platform/audioAssetRepository';
import { studioRuntime } from '../platform/runtime';
import { uid } from './ids';
import { useStore } from './store';

export type StudioAudioActionErrorCode =
  | AudioClipMutationErrorCode
  | 'cancelled'
  | 'project-busy'
  | 'source-invalid'
  | 'source-too-large'
  | 'decode-busy'
  | 'decode-failed'
  | 'channel-limit-exceeded'
  | 'resource-limit-exceeded'
  | 'canonicalize-failed'
  | 'asset-store-failed'
  | 'commit-rejected';

export type StudioAudioClipCommandResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      trackId: string;
      clipId: string;
      rightClipId?: string;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioAudioActionErrorCode }>;

export type ImportStudioAudioTrackResult =
  | Readonly<{
      ok: true;
      changed: true;
      trackId: string;
      trackName: string;
      clipId: string;
      audioAssetId: string;
      deduplicated: boolean;
      playbackStopped: boolean;
    }>
  | Readonly<{ ok: false; code: StudioAudioActionErrorCode }>;

export type ImportStudioAudioTrackInput = Readonly<{
  fileName: string;
  blob: Blob;
  byteLength: number;
  trackName?: string;
  startBeat?: number;
  descriptor?: SourceAudioDescriptor;
  signal?: AbortSignal;
  onProgress?: (progress: CanonicalAudioAssetProgress) => void;
}>;

export type RecordStudioAudioTrackInput = Readonly<{
  /** Opaque ownership acquired before microphone permission/count-in starts. */
  recordingHandle: StudioAudioTrackRecordingHandle;
  capture: MicrophonePcmCapture;
  trackName?: string;
  fileName?: string;
  signal?: AbortSignal;
  onProgress?: (progress: CanonicalAudioAssetProgress) => void;
}>;

export type RecordStudioAudioTrackDependencies = Readonly<{
  repository?: AudioAssetRepository;
  createAudioBuffer?: (capture: MicrophonePcmCapture) => AudioBuffer;
  canonicalize?: ImportStudioAudioTrackDependencies['canonicalize'];
  createAssetId?: () => string;
}>;

export type RecordStudioAudioTrackResult = ImportStudioAudioTrackResult;

export type ImportStudioAudioTrackDependencies = Readonly<{
  repository?: AudioAssetRepository;
  inspectSource?: (
    fileName: string,
    blob: Blob,
    byteLength: number,
  ) => Promise<SourceAudioDescriptor>;
  decodeSource?: (
    blob: Blob,
    signal: AbortSignal,
    descriptor: SourceAudioDescriptor,
  ) => Promise<AudioBuffer>;
  canonicalize?: (
    source: AudioBuffer,
    options: Readonly<{
      signal: AbortSignal;
      onProgress?: (progress: CanonicalAudioAssetProgress) => void;
      onResampleJob?: (job: CanonicalAudioResampleJob) => void;
    }>,
  ) => Promise<CanonicalAudioAssetResult>;
  createAssetId?: () => string;
}>;

export type StudioNativeAudioSelectionReservation = Readonly<{
  /**
   * Materialize the Blob, then retain only the native response envelope in
   * this lease. The caller must start descriptor-known import in the same
   * JavaScript turn so its planner reservation takes over Blob/cache bytes.
   */
  createBlobForImmediateImport: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Blob;
  /** Idempotent across cancel, failure, unmount and completed import paths. */
  release: () => void;
}>;

type SuccessfulMutation = Extract<AudioClipMutationResult, { ok: true }>;
type SuccessfulSplitMutation = Extract<SplitAudioClipResult, { ok: true }>;

type AudioTrackImportLeaseWork = {
  settled: boolean;
};

type AudioTrackImportLease = {
  finished: boolean;
  released: boolean;
  work: Set<AudioTrackImportLeaseWork>;
  resourceReservation: HeavyAudioResourceReservation | null;
  releaseCallbacks: Set<() => void>;
};

let activeAudioTrackImportLease: AudioTrackImportLease | null = null;

function tryAcquireAudioTrackImportLease(): AudioTrackImportLease | null {
  if (activeAudioTrackImportLease) return null;
  const lease: AudioTrackImportLease = {
    finished: false,
    released: false,
    work: new Set(),
    resourceReservation: null,
    releaseCallbacks: new Set(),
  };
  activeAudioTrackImportLease = lease;
  return lease;
}

function releaseAudioTrackImportLeaseIfSettled(lease: AudioTrackImportLease): void {
  if (
    lease.finished
    && [...lease.work].every((work) => work.settled)
    && activeAudioTrackImportLease === lease
  ) {
    lease.resourceReservation?.release();
    lease.resourceReservation = null;
    activeAudioTrackImportLease = null;
    lease.released = true;
    const callbacks = [...lease.releaseCallbacks];
    lease.releaseCallbacks.clear();
    for (const callback of callbacks) callback();
  }
}

function trackAudioTrackImportWork(
  lease: AudioTrackImportLease,
  settled: Promise<void>,
): void {
  const work: AudioTrackImportLeaseWork = { settled: false };
  lease.work.add(work);
  void settled.then(
    () => {
      work.settled = true;
      releaseAudioTrackImportLeaseIfSettled(lease);
    },
    () => {
      work.settled = true;
      releaseAudioTrackImportLeaseIfSettled(lease);
    },
  );
}

function finishAudioTrackImportLease(lease: AudioTrackImportLease): void {
  lease.finished = true;
  releaseAudioTrackImportLeaseIfSettled(lease);
}

function onAudioTrackImportLeaseReleased(
  lease: AudioTrackImportLease,
  callback: () => void,
): void {
  if (lease.released) {
    callback();
    return;
  }
  lease.releaseCallbacks.add(callback);
}

const studioAudioTrackRecordingHandleBrand: unique symbol = Symbol(
  'studio-audio-track-recording-handle',
);

/** Opaque proof that capture and finalization own one continuous app-wide lease. */
export type StudioAudioTrackRecordingHandle = Readonly<{
  operationId: number;
  [studioAudioTrackRecordingHandleBrand]: true;
}>;

type StudioAudioTrackRecordingOwnership = {
  lease: AudioTrackImportLease;
  snapshot: Project;
  operationId: number;
  startBeat: number;
  playbackStopped: boolean;
  finalizing: boolean;
  finished: boolean;
};

const studioAudioTrackRecordingOwnership = new WeakMap<
  StudioAudioTrackRecordingHandle,
  StudioAudioTrackRecordingOwnership
>();

export type BeginStudioAudioTrackRecordingResult =
  | Readonly<{
      ok: true;
      handle: StudioAudioTrackRecordingHandle;
      startBeat: number;
      playbackStopped: boolean;
    }>
  | Readonly<{
      ok: false;
      code: 'decode-busy' | 'project-busy' | 'resource-limit-exceeded';
    }>;

function finishStudioAudioTrackRecordingOwnership(
  handle: StudioAudioTrackRecordingHandle,
  ownership: StudioAudioTrackRecordingOwnership,
): void {
  if (ownership.finished) return;
  ownership.finished = true;
  studioAudioTrackRecordingOwnership.delete(handle);
  onAudioTrackImportLeaseReleased(ownership.lease, () => {
    useStore.getState().finishAudioRecordingOperation(ownership.operationId);
  });
  finishAudioTrackImportLease(ownership.lease);
}

/**
 * Acquire every recording fence synchronously before asking for microphone
 * permission. The returned snapshot remains the only valid CAS base.
 */
export function beginStudioAudioTrackRecording(): BeginStudioAudioTrackRecordingResult {
  const lease = tryAcquireAudioTrackImportLease();
  if (!lease) return { ok: false, code: 'decode-busy' };

  const state = useStore.getState();
  const operationId = state.tryBeginAudioRecordingOperation();
  if (operationId === null) {
    finishAudioTrackImportLease(lease);
    return { ok: false, code: 'project-busy' };
  }

  const snapshot = state.project;
  const startBeat = state.transport.positionBeat;
  const playbackStopped = state.transport.phase !== 'stopped';
  try {
    if (playbackStopped) state.stop();
    lease.resourceReservation = reserveMicrophoneCaptureResources();
  } catch (error) {
    state.finishAudioRecordingOperation(operationId);
    finishAudioTrackImportLease(lease);
    if (error instanceof AudioResourceReservationError) {
      return { ok: false, code: 'resource-limit-exceeded' };
    }
    return { ok: false, code: 'project-busy' };
  }

  const handle: StudioAudioTrackRecordingHandle = Object.freeze({
    operationId,
    [studioAudioTrackRecordingHandleBrand]: true as const,
  });
  studioAudioTrackRecordingOwnership.set(handle, {
    lease,
    snapshot,
    operationId,
    startBeat,
    playbackStopped,
    finalizing: false,
    finished: false,
  });
  return { ok: true, handle, startBeat, playbackStopped };
}

/** Release a take that never transferred into finalization. Idempotent. */
export function discardStudioAudioTrackRecording(
  handle: StudioAudioTrackRecordingHandle,
): void {
  const ownership = studioAudioTrackRecordingOwnership.get(handle);
  if (!ownership || ownership.finalizing) return;
  finishStudioAudioTrackRecordingOwnership(handle, ownership);
}

export const MAX_STUDIO_AUDIO_DECODE_BYTES = 256 * 1024 * 1024;
export const MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES = MAX_HEAVY_AUDIO_RESOURCE_BYTES;
const CANONICAL_SAMPLE_RATE = 48_000;
const CANONICAL_WAV_HEADER_BYTES = 44;
const PCM16_BYTES_PER_SAMPLE = 2;
const FLOAT32_BYTES_PER_SAMPLE = 4;
/**
 * Conservative cross-runtime envelope for canonical bytes retained while Web
 * IndexedDB or Tauri IPC validates, copies, serializes, and reads back an
 * object. This deliberately exceeds the five explicit Web dedupe copies.
 */
export const STUDIO_AUDIO_PERSIST_WAV_COPY_FACTOR = 8;

export type StudioAudioImportResourcePlan = Readonly<{
  sourceBytes: number;
  channelCount: number;
  decodedFrameCount: number;
  decodedFloat32Bytes: number;
  canonicalFrameCount: number;
  canonicalFloat32Bytes: number;
  canonicalPcm16WavBytes: number;
  requiresCanonicalResample: boolean;
  decodePeakBytes: number;
  canonicalPeakBytes: number;
  persistPeakBytes: number;
  peakBytes: number;
}>;

export type StudioAudioRecordingResourcePlan = Readonly<{
  captureChunkFloat32Bytes: number;
  capturedFloat32Bytes: number;
  audioBufferFloat32Bytes: number;
  captureRuntimeOverheadBytes: number;
  canonicalFrameCount: number;
  canonicalFloat32Bytes: number;
  canonicalPcm16WavBytes: number;
  requiresCanonicalResample: boolean;
  conversionPeakBytes: number;
  canonicalPeakBytes: number;
  persistPeakBytes: number;
  peakBytes: number;
}>;

function failed(code: StudioAudioActionErrorCode): StudioAudioClipCommandResult {
  return { ok: false, code };
}

function importFailed(code: StudioAudioActionErrorCode): ImportStudioAudioTrackResult {
  return { ok: false, code };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

function createDecodeContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 48_000 });
  } catch {
    return new AudioContext();
  }
}

function resourceLimitExceeded(): CanonicalAudioAssetError {
  return new CanonicalAudioAssetError('resource-limit-exceeded');
}

function checkedResourceProduct(...factors: readonly number[]): number {
  let product = 1;
  for (const factor of factors) {
    if (!Number.isSafeInteger(factor) || factor < 0) throw resourceLimitExceeded();
    if (factor !== 0 && product > Number.MAX_SAFE_INTEGER / factor) {
      throw resourceLimitExceeded();
    }
    product *= factor;
  }
  if (!Number.isSafeInteger(product)) throw resourceLimitExceeded();
  return product;
}

function checkedResourceSum(...terms: readonly number[]): number {
  let sum = 0;
  for (const term of terms) {
    if (!Number.isSafeInteger(term) || term < 0 || sum > Number.MAX_SAFE_INTEGER - term) {
      throw resourceLimitExceeded();
    }
    sum += term;
  }
  return sum;
}

/**
 * Reserve the largest native response envelope and its prospective Blob copy
 * before opening the picker. The exact response is re-budgeted synchronously
 * before Blob allocation; its envelope remains counted until import returns.
 */
export function reserveStudioNativeAudioSelection(
  maximumEnvelopeBytes: number,
): StudioNativeAudioSelectionReservation {
  if (!Number.isSafeInteger(maximumEnvelopeBytes) || maximumEnvelopeBytes <= 0) {
    throw new AudioResourceReservationError('Native audio envelope limit is invalid.');
  }
  const audioAssetCache = getAudioAssetPlaybackCache();
  audioAssetCache.clearUnused();
  const reservation = reserveHeavyAudioResources(checkedHeavyAudioResourceTotal([
    maximumEnvelopeBytes,
    maximumEnvelopeBytes,
    audioAssetCache.retainedDecodedBytes,
  ]));
  let blobCreated = false;

  return {
    createBlobForImmediateImport: (bytes, mimeType): Blob => {
      if (reservation.released || blobCreated) {
        throw new AudioResourceReservationError(
          'Native audio selection reservation is no longer available.',
        );
      }
      const envelopeBytes = bytes.buffer.byteLength;
      if (
        !Number.isSafeInteger(envelopeBytes)
        || envelopeBytes <= 0
        || envelopeBytes > maximumEnvelopeBytes
        || bytes.byteLength <= 0
      ) {
        throw new AudioResourceReservationError('Native audio envelope is invalid.');
      }

      let blobBytes: Uint8Array<ArrayBuffer>;
      let retainedEnvelopeBytes = envelopeBytes;
      if (bytes.buffer instanceof ArrayBuffer) {
        blobBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } else {
        // A SharedArrayBuffer-backed response is outside the Tauri production
        // contract, but account for the required normalization copy before use.
        blobBytes = Uint8Array.from(bytes);
        retainedEnvelopeBytes = checkedHeavyAudioResourceTotal([
          retainedEnvelopeBytes,
          blobBytes.byteLength,
        ]);
      }

      audioAssetCache.clearUnused();
      reservation.resize(checkedHeavyAudioResourceTotal([
        retainedEnvelopeBytes,
        blobBytes.byteLength,
        audioAssetCache.retainedDecodedBytes,
      ]));
      const blob = new Blob([blobBytes], { type: mimeType });
      // No await/event boundary is allowed between this handoff and import's
      // synchronous planner reservation. Keep the extra native envelope only;
      // the import reservation takes over Blob and decoded-cache accounting.
      reservation.resize(retainedEnvelopeBytes);
      blobCreated = true;
      return blob;
    },
    release: () => reservation.release(),
  };
}

/** Keep native picker/response memory reserved across every return and throw path. */
export async function withStudioNativeAudioSelection<T>(
  maximumEnvelopeBytes: number,
  work: (reservation: StudioNativeAudioSelectionReservation) => Promise<T>,
): Promise<T> {
  const reservation = reserveStudioNativeAudioSelection(maximumEnvelopeBytes);
  try {
    return await work(reservation);
  } finally {
    reservation.release();
  }
}

/** Blob storage plus the full ArrayBuffer copy materialized by source inspection. */
function studioAudioImportInspectionPeakBytes(inputByteLength: number): number {
  return checkedResourceProduct(2, inputByteLength);
}

function upperBoundFrames(durationSeconds: number, sampleRate: number): number {
  if (
    !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || !Number.isSafeInteger(sampleRate)
    || sampleRate < 8_000
    || sampleRate > 384_000
  ) {
    throw resourceLimitExceeded();
  }
  const exactFrames = durationSeconds * sampleRate;
  if (!Number.isFinite(exactFrames) || exactFrames > Number.MAX_SAFE_INTEGER) {
    throw resourceLimitExceeded();
  }
  const frames = Math.ceil(exactFrames);
  if (!Number.isSafeInteger(frames) || frames <= 0) throw resourceLimitExceeded();
  return frames;
}

/**
 * Pure upper-bound planner for every large allocation retained by Audio Track import.
 * The phase peaks include browser Blob/ArrayBuffer copies and repository hashing copies.
 */
export function planStudioAudioImportResources(
  inputByteLength: number,
  descriptor: SourceAudioDescriptor,
  decodeSampleRate = CANONICAL_SAMPLE_RATE,
): StudioAudioImportResourcePlan {
  if (!Number.isSafeInteger(inputByteLength) || inputByteLength <= 0) {
    throw resourceLimitExceeded();
  }
  if (
    !Number.isSafeInteger(descriptor.channelCount)
    || descriptor.channelCount <= 0
    || descriptor.channelCount > 2
    || !Number.isSafeInteger(descriptor.decodeChannelCountUpperBound)
    || descriptor.decodeChannelCountUpperBound <= 0
    || descriptor.decodeChannelCountUpperBound > 2
  ) {
    throw new CanonicalAudioAssetError('channel-limit-exceeded');
  }
  if (
    !Number.isSafeInteger(descriptor.sampleRate)
    || descriptor.sampleRate < 8_000
    || descriptor.sampleRate > 384_000
    || !Number.isFinite(descriptor.containerDurationSeconds)
    || descriptor.containerDurationSeconds <= 0
  ) {
    throw resourceLimitExceeded();
  }

  const channelCount = Math.max(
    descriptor.channelCount,
    descriptor.decodeChannelCountUpperBound,
  );
  const decodedFrameCount = upperBoundFrames(
    descriptor.decodeDurationSeconds,
    decodeSampleRate,
  );
  const canonicalFrameCount = upperBoundFrames(
    descriptor.decodeDurationSeconds,
    CANONICAL_SAMPLE_RATE,
  );
  const decodedFloat32Bytes = checkedResourceProduct(
    decodedFrameCount,
    channelCount,
    FLOAT32_BYTES_PER_SAMPLE,
  );
  const canonicalFloat32Bytes = checkedResourceProduct(
    canonicalFrameCount,
    channelCount,
    FLOAT32_BYTES_PER_SAMPLE,
  );
  const canonicalPcm16WavBytes = checkedResourceSum(
    CANONICAL_WAV_HEADER_BYTES,
    checkedResourceProduct(
      canonicalFrameCount,
      channelCount,
      PCM16_BYTES_PER_SAMPLE,
    ),
  );
  const requiresCanonicalResample = decodeSampleRate !== CANONICAL_SAMPLE_RATE;
  const decodePeakBytes = checkedResourceSum(
    checkedResourceProduct(2, inputByteLength),
    decodedFloat32Bytes,
  );
  const canonicalPeakBytes = checkedResourceSum(
    inputByteLength,
    decodedFloat32Bytes,
    requiresCanonicalResample ? canonicalFloat32Bytes : 0,
    canonicalPcm16WavBytes,
  );
  const persistPeakBytes = checkedResourceSum(
    inputByteLength,
    decodedFloat32Bytes,
    checkedResourceProduct(
      STUDIO_AUDIO_PERSIST_WAV_COPY_FACTOR,
      canonicalPcm16WavBytes,
    ),
  );
  const peakBytes = Math.max(decodePeakBytes, canonicalPeakBytes, persistPeakBytes);

  if (
    decodedFloat32Bytes > MAX_STUDIO_AUDIO_DECODE_BYTES
    || canonicalPcm16WavBytes > MAX_AUDIO_ASSET_BYTES
    || peakBytes > MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES
  ) {
    throw resourceLimitExceeded();
  }
  return {
    sourceBytes: inputByteLength,
    channelCount,
    decodedFrameCount,
    decodedFloat32Bytes,
    canonicalFrameCount,
    canonicalFloat32Bytes,
    canonicalPcm16WavBytes,
    requiresCanonicalResample,
    decodePeakBytes,
    canonicalPeakBytes,
    persistPeakBytes,
    peakBytes,
  };
}

/**
 * Pure peak-memory planner for an in-memory microphone take through canonical
 * WAV persistence. The source capture remains retained while a real
 * AudioBuffer copy, optional resample buffer, and repository copies exist.
 */
export function planStudioAudioRecordingResources(
  capture: Pick<
    MicrophonePcmCapture,
    'numberOfChannels' | 'length' | 'sampleRate' | 'durationSeconds'
  >,
): StudioAudioRecordingResourcePlan {
  if (
    !Number.isSafeInteger(capture.numberOfChannels)
    || capture.numberOfChannels < 1
    || capture.numberOfChannels > MAX_MICROPHONE_CAPTURE_CHANNELS
  ) {
    throw new CanonicalAudioAssetError('channel-limit-exceeded');
  }
  if (
    !Number.isSafeInteger(capture.length)
    || capture.length <= 0
    || !Number.isSafeInteger(capture.sampleRate)
    || capture.sampleRate < 8_000
    || capture.sampleRate > MAX_MICROPHONE_CAPTURE_SAMPLE_RATE
    || !Number.isFinite(capture.durationSeconds)
    || capture.durationSeconds <= 0
    || capture.durationSeconds > MAX_MICROPHONE_CAPTURE_SECONDS
    || Math.abs(capture.durationSeconds - capture.length / capture.sampleRate)
      > Math.max(1 / capture.sampleRate, 1e-6)
  ) {
    throw resourceLimitExceeded();
  }

  const capturedFloat32Bytes = checkedResourceProduct(
    capture.length,
    capture.numberOfChannels,
    FLOAT32_BYTES_PER_SAMPLE,
  );
  if (capturedFloat32Bytes > MAX_MICROPHONE_CAPTURE_PCM_BYTES) {
    throw resourceLimitExceeded();
  }
  const canonicalFrameCount = Math.max(
    1,
    Math.round((capture.length * CANONICAL_SAMPLE_RATE) / capture.sampleRate),
  );
  if (!Number.isSafeInteger(canonicalFrameCount)) throw resourceLimitExceeded();
  const canonicalFloat32Bytes = checkedResourceProduct(
    canonicalFrameCount,
    capture.numberOfChannels,
    FLOAT32_BYTES_PER_SAMPLE,
  );
  const canonicalPcm16WavBytes = checkedResourceSum(
    CANONICAL_WAV_HEADER_BYTES,
    checkedResourceProduct(
      canonicalFrameCount,
      capture.numberOfChannels,
      PCM16_BYTES_PER_SAMPLE,
    ),
  );
  const requiresCanonicalResample = capture.sampleRate !== CANONICAL_SAMPLE_RATE;
  // The worklet chunks have been dereferenced when the result resolves, but
  // JavaScript cannot prove they were physically collected before the next
  // AudioBuffer allocation. Keep one exact chunk-set copy plus the capture
  // runtime envelope counted through the handoff.
  const captureChunkFloat32Bytes = capturedFloat32Bytes;
  const captureRuntimeOverheadBytes =
    MICROPHONE_CAPTURE_RESERVATION_BYTES - 2 * MAX_MICROPHONE_CAPTURE_PCM_BYTES;
  const audioBufferFloat32Bytes = capturedFloat32Bytes;
  const conversionPeakBytes = checkedResourceSum(
    captureChunkFloat32Bytes,
    capturedFloat32Bytes,
    audioBufferFloat32Bytes,
    captureRuntimeOverheadBytes,
  );
  const canonicalPeakBytes = checkedResourceSum(
    captureChunkFloat32Bytes,
    capturedFloat32Bytes,
    audioBufferFloat32Bytes,
    requiresCanonicalResample ? canonicalFloat32Bytes : 0,
    canonicalPcm16WavBytes,
    captureRuntimeOverheadBytes,
  );
  const persistPeakBytes = checkedResourceSum(
    captureChunkFloat32Bytes,
    capturedFloat32Bytes,
    audioBufferFloat32Bytes,
    requiresCanonicalResample ? canonicalFloat32Bytes : 0,
    checkedResourceProduct(
      STUDIO_AUDIO_PERSIST_WAV_COPY_FACTOR,
      canonicalPcm16WavBytes,
    ),
    captureRuntimeOverheadBytes,
  );
  const peakBytes = Math.max(
    conversionPeakBytes,
    canonicalPeakBytes,
    persistPeakBytes,
  );
  if (
    canonicalPcm16WavBytes > MAX_AUDIO_ASSET_BYTES
    || peakBytes > MAX_STUDIO_AUDIO_IMPORT_PEAK_BYTES
  ) {
    throw resourceLimitExceeded();
  }
  return {
    captureChunkFloat32Bytes,
    capturedFloat32Bytes,
    audioBufferFloat32Bytes,
    captureRuntimeOverheadBytes,
    canonicalFrameCount,
    canonicalFloat32Bytes,
    canonicalPcm16WavBytes,
    requiresCanonicalResample,
    conversionPeakBytes,
    canonicalPeakBytes,
    persistPeakBytes,
    peakBytes,
  };
}

/** Reject hostile compressed-audio expansion before decodeAudioData allocates PCM. */
export function preflightStudioAudioDecode(
  descriptor: SourceAudioDescriptor,
  decodeSampleRate = CANONICAL_SAMPLE_RATE,
  inputByteLength?: number,
): void {
  planStudioAudioImportResources(
    inputByteLength ?? 1,
    descriptor,
    decodeSampleRate,
  );
}

async function decodeSourceAudio(
  blob: Blob,
  signal: AbortSignal,
  descriptor: SourceAudioDescriptor,
  inputByteLength: number,
  onDecodeJob: (job: SourceAudioDecodeJob) => void,
  onDecodeSampleRate: (sampleRate: number) => void,
): Promise<AudioBuffer> {
  let context: AudioContext;
  try {
    context = createDecodeContext();
  } catch {
    throw new Error('decode-failed');
  }
  let settled: Promise<void> | null = null;
  try {
    // Hosts may ignore the requested 48 kHz. Re-budget against the actual
    // decode allocation rate before handing compressed bytes to the decoder.
    onDecodeSampleRate(context.sampleRate);
    preflightStudioAudioDecode(descriptor, context.sampleRate, inputByteLength);
    const job = startExclusiveSourceAudioDecode(context, blob);
    onDecodeJob(job);
    settled = job.settled;
    return await awaitSourceAudioDecodeOrCancel(job, signal);
  } finally {
    const close = (): void => {
      void context.close().catch(() => undefined);
    };
    if (settled) void settled.finally(close);
    else close();
  }
}

function normalizedAssetName(fileName: string): string {
  const trimmed = fileName.trim();
  return trimmed.length > 0 ? trimmed : 'audio.wav';
}

function createRecordingAudioBuffer(capture: MicrophonePcmCapture): AudioBuffer {
  try {
    const buffer = new AudioBuffer({
      length: capture.length,
      numberOfChannels: capture.numberOfChannels,
      sampleRate: capture.sampleRate,
    });
    for (let channel = 0; channel < capture.numberOfChannels; channel += 1) {
      const source = capture.getChannelData(channel);
      if (source.length !== capture.length) {
        throw new CanonicalAudioAssetError('invalid-audio');
      }
      buffer.getChannelData(channel).set(source);
    }
    return buffer;
  } catch (error) {
    if (error instanceof CanonicalAudioAssetError) throw error;
    throw new CanonicalAudioAssetError('render-failed');
  }
}

function mutationFailureCode(
  result: Exclude<AudioClipMutationResult | SplitAudioClipResult, { ok: true }>,
): StudioAudioActionErrorCode {
  return result.error.code;
}

function playbackWasStopped(wasActive: boolean, changed: boolean): boolean {
  return changed && wasActive && useStore.getState().transport.phase === 'stopped';
}

function commitAudioMutation(
  snapshot: Project,
  result: SuccessfulMutation | SuccessfulSplitMutation,
  selectClipId: string | null = result.clipId,
): StudioAudioClipCommandResult {
  const state = useStore.getState();
  const wasActive = state.transport.phase !== 'stopped';
  if (!result.changed) {
    return {
      ok: true,
      changed: false,
      trackId: result.trackId,
      clipId: result.clipId,
      ...('rightClipId' in result ? { rightClipId: result.rightClipId } : {}),
      playbackStopped: false,
    };
  }
  if (state.projectOperationBusy || state.project !== snapshot) return failed('commit-rejected');
  const committed = state.applyProjectChange((current) =>
    current === snapshot ? result.project : current,
  );
  if (!committed || useStore.getState().project === snapshot) return failed('commit-rejected');
  const adopted = useStore.getState();
  adopted.selectTrack(result.trackId);
  adopted.selectClip(selectClipId);
  adopted.selectChord(null);
  adopted.selectNotes([]);
  adopted.setActiveView('arranger');
  return {
    ok: true,
    changed: true,
    trackId: result.trackId,
    clipId: result.clipId,
    ...('rightClipId' in result ? { rightClipId: result.rightClipId } : {}),
    playbackStopped: playbackWasStopped(wasActive, true),
  };
}

function runAudioMutation(
  build: (project: Project) => AudioClipMutationResult,
): StudioAudioClipCommandResult {
  const snapshot = useStore.getState().project;
  const result = build(snapshot);
  if (!result.ok) return failed(mutationFailureCode(result));
  return commitAudioMutation(snapshot, result);
}

function importErrorCode(error: unknown, signal: AbortSignal): StudioAudioActionErrorCode {
  if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return 'cancelled';
  }
  if (error instanceof SourceAudioDecodeBusyError) return 'decode-busy';
  if (error instanceof SourceAudioFileError) {
    return error.code === 'file-too-large' ? 'source-too-large' : 'source-invalid';
  }
  if (error instanceof CanonicalAudioAssetError) {
    if (error.code === 'cancelled') return 'cancelled';
    if (error.code === 'channel-limit-exceeded') return 'channel-limit-exceeded';
    if (error.code === 'resource-limit-exceeded') return 'resource-limit-exceeded';
    return 'canonicalize-failed';
  }
  if (error instanceof AudioAssetRepositoryError) {
    // The canonical planner already proved the output is within the asset
    // byte cap. A repository "too large" here is a storage/quota failure.
    return 'asset-store-failed';
  }
  if (error instanceof AudioResourceReservationError) return 'resource-limit-exceeded';
  if (error instanceof Error && error.message === 'decode-failed') return 'decode-failed';
  return 'decode-failed';
}

function recordingErrorCode(error: unknown, signal: AbortSignal): StudioAudioActionErrorCode {
  if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return 'cancelled';
  }
  if (error instanceof CanonicalAudioAssetError) {
    if (error.code === 'cancelled') return 'cancelled';
    if (error.code === 'channel-limit-exceeded') return 'channel-limit-exceeded';
    if (error.code === 'resource-limit-exceeded') return 'resource-limit-exceeded';
    return 'canonicalize-failed';
  }
  if (error instanceof AudioAssetRepositoryError) {
    return 'asset-store-failed';
  }
  if (error instanceof AudioResourceReservationError) return 'resource-limit-exceeded';
  return 'canonicalize-failed';
}

type AdoptCanonicalAudioTrackInput = Readonly<{
  snapshot: Project;
  recordingOperationId?: number;
  playbackStopped?: boolean;
  canonical: CanonicalAudioAssetResult;
  receipt: AudioAssetStoreReceipt;
  fileName: string;
  trackName?: string;
  startBeat?: number;
  createAssetId?: () => string;
}>;

function adoptCanonicalAudioTrack(
  input: AdoptCanonicalAudioTrackInput,
): ImportStudioAudioTrackResult {
  const latest = useStore.getState();
  if (
    latest.projectOperationBusy
    || latest.project !== input.snapshot
    || (
      input.recordingOperationId !== undefined
      && latest.audioRecordingOperationId !== input.recordingOperationId
    )
  ) {
    return importFailed('commit-rejected');
  }
  let assetId: string;
  try {
    assetId = (input.createAssetId ?? (() => uid('audio-asset')))();
  } catch {
    return importFailed('id-factory-failed');
  }
  const asset: ReadyAudioAsset = {
    id: assetId,
    availability: 'ready',
    checksumSha256: input.receipt.checksumSha256,
    originalName: normalizedAssetName(input.fileName),
    mediaType: 'audio/wav',
    byteLength: input.receipt.byteLength,
    sampleRate: input.canonical.sampleRate,
    channelCount: input.canonical.channelCount,
    frameCount: input.canonical.frameCount,
  };
  const mutation = createAudioTrackClip(input.snapshot, asset, {
    ...(input.trackName !== undefined ? { trackName: input.trackName } : {}),
    ...(input.startBeat !== undefined ? { startBeat: input.startBeat } : {}),
  });
  if (!mutation.ok) return importFailed(mutation.error.code);

  const wasActive = latest.transport.phase !== 'stopped';
  const committed = latest.applyVerifiedAudioAssetAddition(
    (current) => (current === input.snapshot ? mutation.project : current),
    mutation.audioAssetId,
  );
  if (!committed || useStore.getState().project === input.snapshot) {
    return importFailed('commit-rejected');
  }
  const adoptedState = useStore.getState();
  const track = adoptedState.project.tracks.find((candidate) => candidate.id === mutation.trackId);
  if (!track) return importFailed('commit-rejected');
  adoptedState.selectTrack(mutation.trackId);
  adoptedState.selectClip(mutation.clipId);
  adoptedState.selectChord(null);
  adoptedState.selectNotes([]);
  adoptedState.setActiveView('arranger');
  return {
    ok: true,
    changed: true,
    trackId: mutation.trackId,
    trackName: track.name,
    clipId: mutation.clipId,
    audioAssetId: mutation.audioAssetId,
    deduplicated: input.receipt.deduplicated,
    playbackStopped: input.playbackStopped ?? playbackWasStopped(wasActive, true),
  };
}

/**
 * Decode and canonicalize locally, persist immutable bytes, then adopt the
 * metadata and Audio Track in one compare-and-swap project history step.
 */
async function importStudioAudioTrackWithLease(
  input: ImportStudioAudioTrackInput,
  dependencies: ImportStudioAudioTrackDependencies,
  lease: AudioTrackImportLease,
): Promise<ImportStudioAudioTrackResult> {
  const startingState = useStore.getState();
  const snapshot = startingState.project;
  if (startingState.projectOperationBusy) return importFailed('project-busy');
  const signal = input.signal ?? new AbortController().signal;
  const inspectSource = dependencies.inspectSource ?? inspectSourceAudioBlob;
  let resizeImportReservationForDecodeRate = (_sampleRate: number): void => {};
  const decodeSource = dependencies.decodeSource ?? (
    (blob: Blob, decodeSignal: AbortSignal, descriptor: SourceAudioDescriptor) =>
      decodeSourceAudio(
        blob,
        decodeSignal,
        descriptor,
        input.byteLength,
        (job) => trackAudioTrackImportWork(lease, job.settled),
        (sampleRate) => resizeImportReservationForDecodeRate(sampleRate),
      )
  );
  const canonicalize = dependencies.canonicalize ?? canonicalizeAudioAsset;
  const repository = dependencies.repository ?? studioRuntime.audioAssets;

  let canonical: CanonicalAudioAssetResult;
  let receipt: AudioAssetStoreReceipt;
  try {
    throwIfCancelled(signal);
    validateSourceAudioBlobSize(input.blob.size, input.byteLength);
    const audioAssetCache = getAudioAssetPlaybackCache();
    const reservationBytesForPeak = (peakBytes: number): number => {
      audioAssetCache.clearUnused();
      return checkedHeavyAudioResourceTotal([
        peakBytes,
        audioAssetCache.retainedDecodedBytes,
      ]);
    };
    let initialPlan = input.descriptor
      ? planStudioAudioImportResources(
          input.byteLength,
          input.descriptor,
          CANONICAL_SAMPLE_RATE,
        )
      : null;
    const initialPeakBytes = initialPlan?.peakBytes
      ?? studioAudioImportInspectionPeakBytes(input.byteLength);
    lease.resourceReservation = reserveHeavyAudioResources(
      reservationBytesForPeak(initialPeakBytes),
    );
    const descriptor = input.descriptor
      ?? await inspectSource(input.fileName, input.blob, input.byteLength);
    throwIfCancelled(signal);
    initialPlan ??= planStudioAudioImportResources(
      input.byteLength,
      descriptor,
      CANONICAL_SAMPLE_RATE,
    );
    lease.resourceReservation.resize(reservationBytesForPeak(initialPlan.peakBytes));
    resizeImportReservationForDecodeRate = (sampleRate: number): void => {
      const actualPlan = planStudioAudioImportResources(
        input.byteLength,
        descriptor,
        sampleRate,
      );
      lease.resourceReservation?.resize(reservationBytesForPeak(actualPlan.peakBytes));
    };
    const source = input.blob.slice(0, input.byteLength, descriptor.mimeType);
    const decoded = await decodeSource(source, signal, descriptor);
    throwIfCancelled(signal);
    canonical = await canonicalize(decoded, {
      signal,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      onResampleJob: (job) => trackAudioTrackImportWork(lease, job.settled),
    });
    throwIfCancelled(signal);
    receipt = await storeAudioAssetBytes(repository, canonical.bytes);
    // Persisted bytes may now be an orphan. That is intentionally safe: only
    // the following synchronous CAS can make the project reference them.
    throwIfCancelled(signal);
  } catch (error) {
    return importFailed(importErrorCode(error, signal));
  }

  return adoptCanonicalAudioTrack({
    snapshot,
    canonical,
    receipt,
    fileName: input.fileName,
    ...(input.trackName !== undefined ? { trackName: input.trackName } : {}),
    ...(input.startBeat !== undefined ? { startBeat: input.startBeat } : {}),
    ...(dependencies.createAssetId ? { createAssetId: dependencies.createAssetId } : {}),
  });
}

/**
 * Hold one app-wide Audio Track import lease through decode, resample and persistence.
 * Abort may settle this caller first, but browser work retains the lease until it really ends.
 */
export async function importStudioAudioTrack(
  input: ImportStudioAudioTrackInput,
  dependencies: ImportStudioAudioTrackDependencies = {},
): Promise<ImportStudioAudioTrackResult> {
  const lease = tryAcquireAudioTrackImportLease();
  if (!lease) return importFailed('decode-busy');
  try {
    return await importStudioAudioTrackWithLease(input, dependencies, lease);
  } finally {
    finishAudioTrackImportLease(lease);
  }
}

async function recordStudioAudioTrackWithLease(
  input: RecordStudioAudioTrackInput,
  dependencies: RecordStudioAudioTrackDependencies,
  ownership: StudioAudioTrackRecordingOwnership,
): Promise<RecordStudioAudioTrackResult> {
  const startingState = useStore.getState();
  const { lease, snapshot, operationId, startBeat, playbackStopped } = ownership;
  if (
    startingState.projectOperationBusy
    || startingState.project !== snapshot
    || startingState.audioRecordingOperationId !== operationId
  ) {
    return importFailed('commit-rejected');
  }
  const signal = input.signal ?? new AbortController().signal;
  const canonicalize = dependencies.canonicalize ?? canonicalizeAudioAsset;
  const repository = dependencies.repository ?? studioRuntime.audioAssets;
  const createAudioBuffer = dependencies.createAudioBuffer ?? createRecordingAudioBuffer;

  let canonical: CanonicalAudioAssetResult;
  let receipt: AudioAssetStoreReceipt;
  try {
    throwIfCancelled(signal);
    const plan = planStudioAudioRecordingResources(input.capture);
    const audioAssetCache = getAudioAssetPlaybackCache();
    audioAssetCache.clearUnused();
    const reservationBytes = checkedHeavyAudioResourceTotal([
      plan.peakBytes,
      audioAssetCache.retainedDecodedBytes,
    ]);
    if (lease.resourceReservation) lease.resourceReservation.resize(reservationBytes);
    else lease.resourceReservation = reserveHeavyAudioResources(reservationBytes);

    const source = createAudioBuffer(input.capture);
    throwIfCancelled(signal);
    canonical = await canonicalize(source, {
      signal,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      onResampleJob: (job) => trackAudioTrackImportWork(lease, job.settled),
    });
    throwIfCancelled(signal);
    receipt = await storeAudioAssetBytes(repository, canonical.bytes);
    // Cancellation or a concurrent project fence may leave only a valid,
    // unreferenced content-addressed blob. Never adopt metadata before bytes.
    throwIfCancelled(signal);
  } catch (error) {
    return importFailed(recordingErrorCode(error, signal));
  }

  return adoptCanonicalAudioTrack({
    snapshot,
    recordingOperationId: operationId,
    playbackStopped,
    canonical,
    receipt,
    fileName: input.fileName ?? 'microphone-recording.wav',
    ...(input.trackName !== undefined ? { trackName: input.trackName } : {}),
    startBeat,
    ...(dependencies.createAssetId ? { createAssetId: dependencies.createAssetId } : {}),
  });
}

/**
 * Convert one bounded in-memory microphone take directly to canonical WAV,
 * persist it, then create its Audio Track/Clip in one project history step.
 */
export async function recordStudioAudioTrack(
  input: RecordStudioAudioTrackInput,
  dependencies: RecordStudioAudioTrackDependencies = {},
): Promise<RecordStudioAudioTrackResult> {
  const ownership = studioAudioTrackRecordingOwnership.get(input.recordingHandle);
  if (
    !ownership
    || ownership.finished
    || ownership.finalizing
    || ownership.lease !== activeAudioTrackImportLease
  ) return importFailed('commit-rejected');
  ownership.finalizing = true;
  try {
    return await recordStudioAudioTrackWithLease(input, dependencies, ownership);
  } finally {
    finishStudioAudioTrackRecordingOwnership(input.recordingHandle, ownership);
  }
}

export function moveStudioAudioClip(
  clipId: string,
  startBeat: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => moveAudioClip(project, clipId, startBeat));
}

export function trimStudioAudioClipLeft(
  clipId: string,
  startBeat: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => trimAudioClipLeft(project, clipId, startBeat));
}

export function trimStudioAudioClipRight(
  clipId: string,
  endBeat: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => trimAudioClipRight(project, clipId, endBeat));
}

export function setStudioAudioClipGain(
  clipId: string,
  gainDb: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => setAudioClipGain(project, clipId, gainDb));
}

export function setStudioAudioClipFades(
  clipId: string,
  fadeInFrames: number,
  fadeOutFrames: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) =>
    setAudioClipFades(project, clipId, { fadeInFrames, fadeOutFrames }),
  );
}

export function setStudioAudioClipLoop(
  clipId: string,
  loop: boolean,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => setAudioClipLoop(project, clipId, loop));
}

export function duplicateStudioAudioClip(
  clipId: string,
  startBeat: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => duplicateAudioClip(project, clipId, { startBeat }));
}

export function splitStudioAudioClip(
  clipId: string,
  splitBeat: number,
): StudioAudioClipCommandResult {
  const snapshot = useStore.getState().project;
  const result = splitAudioClip(snapshot, clipId, { splitBeat });
  if (!result.ok) return failed(mutationFailureCode(result));
  return commitAudioMutation(snapshot, result, result.rightClipId);
}

export function deleteStudioAudioClip(clipId: string): StudioAudioClipCommandResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const owner = snapshot.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
  const sourceIndex = owner?.clips.findIndex((clip) => clip.id === clipId) ?? -1;
  const result = deleteAudioClip(snapshot, clipId);
  if (!result.ok) return failed(mutationFailureCode(result));
  const nextClipId = owner
    ? owner.clips[sourceIndex + 1]?.id ?? owner.clips[sourceIndex - 1]?.id ?? null
    : null;
  return commitAudioMutation(snapshot, result, nextClipId);
}

/** Beginner-facing recovery guidance shared by dialogs and the Arranger. */
export function studioAudioActionErrorMessage(code: StudioAudioActionErrorCode): string {
  switch (code) {
    case 'cancelled':
      return '音声の読み込みを中止しました。プロジェクトは変更されていません。';
    case 'project-busy':
      return 'プロジェクトを切り替え中です。完了してからもう一度お試しください。';
    case 'source-invalid':
      return 'この音声ファイルを安全に読み込めません。WAV、MP3、M4A、AACを選び直してください。';
    case 'source-too-large':
    case 'resource-limit-exceeded':
      return '音声が端末内で扱える上限を超えています。短いファイルへ分けてください。';
    case 'decode-busy':
      return '別の音声を読み込み中です。完了してからもう一度お試しください。';
    case 'decode-failed':
      return '音声をデコードできませんでした。別の形式へ変換してからお試しください。';
    case 'channel-limit-exceeded':
      return 'オーディオトラックへ追加できるのはモノラルまたはステレオ音声です。';
    case 'canonicalize-failed':
      return '音声をプロジェクト用の形式へ変換できませんでした。元ファイルは変更されていません。';
    case 'asset-store-failed':
      return '音声素材を端末内へ保存できませんでした。空き容量とアクセス権を確認してください。';
    case 'audio-asset-limit':
      return 'このプロジェクトの音声素材数が上限に達しています。不要な素材を整理してください。';
    case 'track-limit':
      return 'トラック数が上限の128件に達しています。不要なトラックを削除してください。';
    case 'clip-limit':
      return 'このトラックにはこれ以上クリップを追加できません。';
    case 'clip-not-found':
      return '対象のオーディオクリップが見つかりません。選び直してください。';
    case 'unsupported-clip-type':
      return 'この操作はオーディオクリップでだけ利用できます。';
    case 'audio-asset-not-ready':
    case 'audio-asset-not-found':
      return '音声素材を確認できないため編集できません。素材の状態を確認してください。';
    case 'invalid-track-name':
      return '名前は空白以外の128文字以内で入力してください。';
    case 'invalid-position':
    case 'invalid-source-range':
      return 'その位置では音声の再生範囲を保てません。クリップ内の位置を指定してください。';
    case 'invalid-gain':
      return 'クリップゲインは-96 dBから+24 dBの範囲で入力してください。';
    case 'invalid-fades':
      return 'フェードの合計がクリップの再生範囲を超えています。短くしてください。';
    case 'project-length-limit':
      return 'クリップを移動すると曲の長さの上限を超えるため反映できません。';
    case 'looped-left-trim-unsupported':
      return 'ループ中は左端を変更できません。先にループをオフにしてください。';
    case 'looped-split-unsupported':
      return 'ループ中は分割できません。先にループをオフにしてください。';
    case 'duplicate-id':
    case 'id-factory-failed':
      return '安全な識別子を作れませんでした。もう一度お試しください。';
    case 'project-not-adoptable':
      return 'この変更はプロジェクトの保存条件を満たさないため反映しませんでした。';
    case 'commit-rejected':
      return '処理中にプロジェクトが変わったため反映しませんでした。音声素材を選び直してください。';
    case 'unexpected':
      return 'オーディオクリップを変更できませんでした。現在の内容は保持されています。';
  }
}
