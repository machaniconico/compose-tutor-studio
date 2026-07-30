import {
  appendAudioTrackClip,
  addAudioClipTimingPoint,
  adoptRecordedAudioPunch,
  createRecordedAudioTakeFolder,
  createAudioTrackClip,
  deleteAudioClip,
  duplicateAudioClip,
  moveAudioClip,
  moveAudioClipTimingPoint,
  mergeAudioClipPitchRegions,
  removeAudioClipTimingPoint,
  replaceAudioClipPitchRegions,
  resetAudioClipPitchRegions,
  resetAudioClipTimingPoints,
  retargetAudioClipPitchRegion,
  setAudioClipWarp,
  setAudioClipFades,
  setAudioClipGain,
  setAudioClipLoop,
  splitAudioClip,
  splitAudioClipPitchRegion,
  inspectAudioPunchTarget,
  trimAudioClipLeft,
  trimAudioClipRight,
  type AudioClipMutationErrorCode,
  type AudioClipMutationResult,
  type AudioPitchRegion,
  type AudioWarp,
  type AudioWarpMarker,
  type Project,
  type ReadyAudioAsset,
  type SplitAudioClipResult,
  compileMusicalTime,
  secondsBetweenBeats,
  MAX_AUDIO_ASSETS,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_CLIPS_PER_TRACK,
  MAX_PROJECT_TRACKS,
} from '@cts/project-model';
import {
  CanonicalAudioAssetError,
  canonicalizeAudioAsset,
  type CanonicalAudioAssetProgress,
  type CanonicalAudioAssetResult,
  type CanonicalAudioResampleJob,
} from '../audio/canonicalAudioAsset';
import { getAudioAssetPlaybackCache } from '../audio/audioAssetResolver';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from '../audio/masterBus';
import {
  stopRuntimePlaybackAudio,
  type SynchronizedRecordingPlaybackClock,
} from '../audio/playback';
import { planSynchronizedRecordingPlacement } from '../audio/recordingAlignment';
import {
  planCycleRecording,
  type CycleRecordingPassWindow,
  type CycleRecordingPlan,
} from '../audio/cycleRecording';
import {
  extractPunchRecording,
  planPunchRecording,
  type PunchRecordingPlan,
} from '../audio/punchRecording';
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
  MIN_MICROPHONE_CAPTURE_SECONDS,
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
import {
  MAX_RECORDING_LATENCY_ADJUSTMENT_MS,
  MAX_RECORDING_LATENCY_CALIBRATION_SECONDS,
  MIN_RECORDING_LATENCY_ADJUSTMENT_MS,
  useStore,
  type RecordingLatencyCalibration,
  type RecordingLatencyCompensationMode,
} from './store';

export type StudioAudioActionErrorCode =
  | AudioClipMutationErrorCode
  | 'cancelled'
  | 'project-busy'
  | 'input-device-required'
  | 'source-invalid'
  | 'source-too-large'
  | 'decode-busy'
  | 'decode-failed'
  | 'channel-limit-exceeded'
  | 'resource-limit-exceeded'
  | 'canonicalize-failed'
  | 'asset-store-failed'
  | 'transport-loop-enabled'
  | 'transport-punch-enabled'
  | 'cycle-recording-invalid'
  | 'punch-recording-invalid'
  | 'punch-target-ineligible'
  | 'take-folder-limit'
  | 'take-limit'
  | 'recording-window-too-short'
  | 'recording-alignment-failed'
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

/** The exact destination frozen before microphone permission is requested. */
export type StudioAudioTrackRecordingTarget =
  | Readonly<{ kind: 'new-track'; trackName?: string }>
  | Readonly<{ kind: 'existing-audio-track'; trackId: string }>;

export type BeginStudioAudioTrackRecordingOptions = Readonly<{
  target?: StudioAudioTrackRecordingTarget;
  /** Omit for the existing one-shot path. Requires an enabled explicit loop. */
  cyclePassCount?: number;
}>;

export type RecordStudioAudioTrackDependencies = Readonly<{
  repository?: AudioAssetRepository;
  createAudioBuffer?: (capture: MicrophonePcmCapture) => AudioBuffer;
  canonicalize?: ImportStudioAudioTrackDependencies['canonicalize'];
  createAssetId?: () => string;
}>;

export type RecordStudioAudioTrackResult =
  | Extract<ImportStudioAudioTrackResult, { ok: true }>
  | Readonly<{
      ok: true;
      changed: true;
      trackId: string;
      trackName: string;
      folderId: string;
      audioAssetIds: readonly string[];
      takeCount: number;
      deduplicated: boolean;
      playbackStopped: boolean;
      /** Absent on a cycle result; retained as optional for source compatibility. */
      clipId?: undefined;
      audioAssetId?: undefined;
    }>
  | Readonly<{ ok: false; code: StudioAudioActionErrorCode }>;

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

export type StudioAudioCycleRecording = Readonly<{
  loopStartBeat: number;
  loopEndBeat: number;
  passCount: number;
}>;

export type StudioAudioPunchRecording = Readonly<{
  targetTrackId: string;
  playbackStartBeat: number;
  punchInBeat: number;
  punchOutBeat: number;
  playbackEndBeat: number;
}>;

type PreparedStudioAudioCycleRecording = Readonly<{
  contextGeneration: number;
  inputLatencySeconds: number;
  plan: CycleRecordingPlan;
}>;

type PreparedStudioAudioPunchRecording = Readonly<{
  contextGeneration: number;
  inputLatencySeconds: number;
  plan: PunchRecordingPlan;
}>;

type StudioAudioTrackRecordingOwnership = {
  lease: AudioTrackImportLease;
  snapshot: Project;
  operationId: number;
  startBeat: number;
  target: StudioAudioTrackRecordingTarget;
  cycle: StudioAudioCycleRecording | null;
  preparedCycle: PreparedStudioAudioCycleRecording | null;
  punch: StudioAudioPunchRecording | null;
  preparedPunch: PreparedStudioAudioPunchRecording | null;
  punchPostrollCompletedRequestId: number | null;
  playbackStopped: boolean;
  latencyPolicy: Readonly<{
    compensationMode: RecordingLatencyCompensationMode;
    calibration: RecordingLatencyCalibration | null;
    manualAdjustmentMs: number;
  }>;
  synchronization: StudioAudioTrackRecordingSynchronization | null;
  finalizing: boolean;
  finished: boolean;
};

type StudioAudioTrackRecordingSynchronization = Readonly<{
  contextGeneration: number;
  sampleRate: number;
  anchorContextFrame: number;
  anchorBeat: number;
  requestId: number;
  compensationMode: RecordingLatencyCompensationMode;
  manualAdjustmentMs: number;
  estimatedPlaybackLatencySeconds: number;
  calibratedRoundTripLatencySeconds: number | null;
  cyclePlan: CycleRecordingPlan | null;
  punchPlan: PunchRecordingPlan | null;
}>;

const studioAudioTrackRecordingOwnership = new WeakMap<
  StudioAudioTrackRecordingHandle,
  StudioAudioTrackRecordingOwnership
>();

const studioRecordingLatencyCalibrationHandleBrand: unique symbol = Symbol(
  'studio-recording-latency-calibration-handle',
);

/** Opaque ownership for a project-fenced physical loopback measurement. */
export type StudioRecordingLatencyCalibrationHandle = Readonly<{
  operationId: number;
  [studioRecordingLatencyCalibrationHandleBrand]: true;
}>;

type StudioRecordingLatencyCalibrationOwnership = {
  lease: AudioTrackImportLease;
  snapshot: Project;
  operationId: number;
  inputDeviceId: string;
  finished: boolean;
};

const studioRecordingLatencyCalibrationOwnership = new WeakMap<
  StudioRecordingLatencyCalibrationHandle,
  StudioRecordingLatencyCalibrationOwnership
>();

export type BeginStudioRecordingLatencyCalibrationResult =
  | Readonly<{
      ok: true;
      handle: StudioRecordingLatencyCalibrationHandle;
      inputDeviceId: string;
      playbackStopped: boolean;
    }>
  | Readonly<{
      ok: false;
      code:
        | 'decode-busy'
        | 'project-busy'
        | 'input-device-required'
        | 'resource-limit-exceeded';
    }>;

export type BeginStudioRecordingLatencyCalibrationDependencies = Readonly<{
  /** Synchronously dispose active and naturally draining shared-Master graphs. */
  stopRuntimePlaybackAudio: () => void;
}>;

const defaultRecordingLatencyCalibrationDependencies:
  BeginStudioRecordingLatencyCalibrationDependencies = {
    stopRuntimePlaybackAudio,
  };

export type BeginStudioAudioTrackRecordingResult =
  | Readonly<{
      ok: true;
      handle: StudioAudioTrackRecordingHandle;
      startBeat: number;
      playbackStopped: boolean;
      cycle: StudioAudioCycleRecording | null;
      punch: StudioAudioPunchRecording | null;
    }>
  | Readonly<{
      ok: false;
      code:
        | 'decode-busy'
        | 'project-busy'
        | 'resource-limit-exceeded'
        | 'track-not-found'
        | 'unsupported-track-type'
        | 'audio-asset-limit'
        | 'track-limit'
        | 'clip-limit'
        | 'transport-loop-enabled'
        | 'transport-punch-enabled'
        | 'cycle-recording-invalid'
        | 'punch-recording-invalid'
        | 'punch-target-ineligible'
        | 'take-folder-limit'
        | 'take-limit'
        | 'recording-window-too-short';
    }>;

type BeginStudioAudioTrackRecordingFailure = Extract<
  BeginStudioAudioTrackRecordingResult,
  { ok: false }
>;

export type PrepareStudioAudioTrackCycleCaptureResult =
  | Readonly<{
      ok: true;
      cycle: StudioAudioCycleRecording;
      effectiveCaptureFrameCount: number;
      durationSeconds: number;
    }>
  | Readonly<{
      ok: false;
      code: 'commit-rejected' | 'recording-alignment-failed';
    }>;

export type PrepareStudioAudioTrackCycleCaptureInput = Readonly<{
  context: AudioContext;
  contextGeneration: number;
  /** Frozen input-track estimate supplied by the microphone graph. */
  inputLatencySeconds: number | null;
}>;

export type PrepareStudioAudioTrackPunchCaptureResult =
  | Readonly<{
      ok: true;
      punch: StudioAudioPunchRecording;
      effectiveCaptureFrameCount: number;
      durationSeconds: number;
    }>
  | Readonly<{
      ok: false;
      code: 'commit-rejected' | 'recording-alignment-failed';
    }>;

export type PrepareStudioAudioTrackPunchCaptureInput =
  PrepareStudioAudioTrackCycleCaptureInput;

function recordingTargetPreflight(
  project: Project,
  target: StudioAudioTrackRecordingTarget,
  options: Readonly<{
    audioAssetCount: number;
    createsClip: boolean;
    createsTakeFolder: boolean;
  }> = {
    audioAssetCount: 1,
    createsClip: true,
    createsTakeFolder: false,
  },
): BeginStudioAudioTrackRecordingFailure | null {
  if (
    !Number.isSafeInteger(options.audioAssetCount)
    || options.audioAssetCount <= 0
    || project.audioAssets.length + options.audioAssetCount > MAX_AUDIO_ASSETS
  ) {
    return { ok: false, code: 'audio-asset-limit' };
  }
  if (options.createsTakeFolder && project.audioTakeFolders.length >= MAX_AUDIO_TAKE_FOLDERS) {
    return { ok: false, code: 'take-folder-limit' };
  }
  if (target.kind === 'new-track') {
    return project.tracks.length >= MAX_PROJECT_TRACKS
      ? { ok: false, code: 'track-limit' }
      : null;
  }
  const track = project.tracks.find((candidate) => candidate.id === target.trackId);
  if (!track) return { ok: false, code: 'track-not-found' };
  if (track.type !== 'audio') return { ok: false, code: 'unsupported-track-type' };
  return options.createsClip && track.clips.length >= MAX_CLIPS_PER_TRACK
    ? { ok: false, code: 'clip-limit' }
    : null;
}

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

function finishStudioRecordingLatencyCalibrationOwnership(
  handle: StudioRecordingLatencyCalibrationHandle,
  ownership: StudioRecordingLatencyCalibrationOwnership,
): void {
  if (ownership.finished) return;
  ownership.finished = true;
  studioRecordingLatencyCalibrationOwnership.delete(handle);
  onAudioTrackImportLeaseReleased(ownership.lease, () => {
    useStore.getState().finishAudioRecordingOperation(ownership.operationId);
  });
  finishAudioTrackImportLease(ownership.lease);
}

/**
 * Fence project/import/close work before requesting a loopback input. Unlike a
 * take, calibration does not depend on song length, Track capacity or looping.
 */
export function beginStudioRecordingLatencyCalibration(
  dependencies: BeginStudioRecordingLatencyCalibrationDependencies =
    defaultRecordingLatencyCalibrationDependencies,
): BeginStudioRecordingLatencyCalibrationResult {
  const state = useStore.getState();
  const inputDeviceId = state.preferredMicrophoneInputDeviceId;
  if (inputDeviceId === null) {
    return { ok: false, code: 'input-device-required' };
  }
  const lease = tryAcquireAudioTrackImportLease();
  if (!lease) return { ok: false, code: 'decode-busy' };

  const operationId = state.tryBeginAudioRecordingOperation();
  if (operationId === null) {
    finishAudioTrackImportLease(lease);
    return { ok: false, code: 'project-busy' };
  }

  const playbackStopped = state.transport.phase !== 'stopped';
  try {
    if (playbackStopped) state.stop();
    // Natural tails can still own and automate Master after transport reaches
    // stopped. Dispose them before calibration normalizes that shared gain.
    dependencies.stopRuntimePlaybackAudio();
    lease.resourceReservation = reserveMicrophoneCaptureResources();
  } catch (error) {
    state.finishAudioRecordingOperation(operationId);
    finishAudioTrackImportLease(lease);
    if (error instanceof AudioResourceReservationError) {
      return { ok: false, code: 'resource-limit-exceeded' };
    }
    return { ok: false, code: 'project-busy' };
  }

  const handle: StudioRecordingLatencyCalibrationHandle = Object.freeze({
    operationId,
    [studioRecordingLatencyCalibrationHandleBrand]: true as const,
  });
  studioRecordingLatencyCalibrationOwnership.set(handle, {
    lease,
    snapshot: state.project,
    operationId,
    inputDeviceId,
    finished: false,
  });
  return { ok: true, handle, inputDeviceId, playbackStopped };
}

/** Preserve the previous calibration while releasing every failed/cancelled fence. */
export function discardStudioRecordingLatencyCalibration(
  handle: StudioRecordingLatencyCalibrationHandle,
): void {
  const ownership = studioRecordingLatencyCalibrationOwnership.get(handle);
  if (!ownership) return;
  finishStudioRecordingLatencyCalibrationOwnership(handle, ownership);
}

/**
 * Adopt one measured profile against the exact project/input/operation snapshot.
 * The capture PCM and probe are intentionally discarded and never become assets.
 */
export function commitStudioRecordingLatencyCalibration(
  handle: StudioRecordingLatencyCalibrationHandle,
  measurement: Readonly<{
    latencyFrames: number;
    sampleRate: number;
    contextGeneration: number;
    confidence: number;
  }>,
): boolean {
  const ownership = studioRecordingLatencyCalibrationOwnership.get(handle);
  if (!ownership || ownership.finished || ownership.lease !== activeAudioTrackImportLease) {
    return false;
  }
  const state = useStore.getState();
  let committed = false;
  if (
    state.project === ownership.snapshot
    && state.audioRecordingOperationId === ownership.operationId
  ) {
    committed = state.commitRecordingLatencyCalibration(
      ownership.operationId,
      {
        inputDeviceId: ownership.inputDeviceId,
        contextGeneration: measurement.contextGeneration,
        sampleRate: measurement.sampleRate,
        latencyFrames: measurement.latencyFrames,
        confidence: measurement.confidence,
      },
    );
  }
  finishStudioRecordingLatencyCalibrationOwnership(handle, ownership);
  return committed;
}

/**
 * Acquire every recording fence synchronously before asking for microphone
 * permission. The returned snapshot remains the only valid CAS base.
 */
export function beginStudioAudioTrackRecording(
  options: BeginStudioAudioTrackRecordingOptions = {},
): BeginStudioAudioTrackRecordingResult {
  const state = useStore.getState();
  const snapshot = state.project;
  const requestedTarget = options.target ?? { kind: 'new-track' as const };
  const target: StudioAudioTrackRecordingTarget = requestedTarget.kind === 'existing-audio-track'
    ? Object.freeze({ kind: requestedTarget.kind, trackId: requestedTarget.trackId })
    : Object.freeze({
        kind: requestedTarget.kind,
        ...(requestedTarget.trackName !== undefined
          ? { trackName: requestedTarget.trackName }
          : {}),
      });
  let cycle: StudioAudioCycleRecording | null = null;
  let punch: StudioAudioPunchRecording | null = null;
  let startBeat: number;
  if (options.cyclePassCount === undefined) {
    if (state.transport.loopEnabled && state.transport.punchEnabled) {
      return { ok: false, code: 'cycle-recording-invalid' };
    }
    if (state.transport.loopEnabled) {
      return { ok: false, code: 'transport-loop-enabled' };
    } else if (state.transport.punchEnabled) {
      if (target.kind !== 'existing-audio-track') {
        return { ok: false, code: 'punch-target-ineligible' };
      }
      const punchInBeat = state.transport.punchInBeat;
      const punchOutBeat = state.transport.punchOutBeat;
      const playbackStartBeat = Math.max(
        0,
        punchInBeat - state.transport.punchPreRollBeats,
      );
      const playbackEndBeat = Math.min(
        snapshot.lengthBeats,
        punchOutBeat + state.transport.punchPostRollBeats,
      );
      if (
        state.armedAudioTrackId !== target.trackId
        || !Number.isFinite(punchInBeat)
        || !Number.isFinite(punchOutBeat)
        || !Number.isFinite(playbackStartBeat)
        || !Number.isFinite(playbackEndBeat)
        || punchInBeat < 0
        || punchOutBeat <= punchInBeat
        || punchOutBeat > snapshot.lengthBeats
        || playbackStartBeat > punchInBeat
        || playbackEndBeat < punchOutBeat
      ) {
        return { ok: false, code: 'punch-recording-invalid' };
      }
      const eligibility = inspectAudioPunchTarget(snapshot, {
        trackId: target.trackId,
        punchInBeat,
        punchOutBeat,
      });
      if (!eligibility.ok) {
        return { ok: false, code: 'punch-target-ineligible' };
      }
      const targetTrack = snapshot.tracks.find(
        (candidate) => candidate.id === target.trackId && candidate.type === 'audio',
      );
      const requiredSourceAssetIds = eligibility.mode === 'created-folder'
        ? targetTrack?.clips.flatMap((clip) => (
            clip.id === eligibility.sourceClipId
              && clip.type === 'audio'
              && typeof clip.audioAssetId === 'string'
              ? [clip.audioAssetId]
              : []
          )) ?? []
        : eligibility.mode === 'appended-folder'
          ? snapshot.audioTakeFolders.find(
              (folder) => folder.id === eligibility.folderId,
            )?.takes.map((take) => take.audioAssetId) ?? []
          : [];
      if (
        (eligibility.mode !== 'empty-window' && requiredSourceAssetIds.length === 0)
        || requiredSourceAssetIds.some(
          (audioAssetId) => state.audioAssetIssues[audioAssetId] !== undefined,
        )
      ) {
        return { ok: false, code: 'punch-target-ineligible' };
      }
      punch = Object.freeze({
        targetTrackId: target.trackId,
        playbackStartBeat,
        punchInBeat,
        punchOutBeat,
        playbackEndBeat,
      });
      startBeat = playbackStartBeat;
    } else {
      startBeat = state.transport.positionBeat;
    }
  } else {
    const passCount = options.cyclePassCount;
    const loopStartBeat = state.transport.loopStartBeat;
    const loopEndBeat = state.transport.loopEndBeat;
    if (
      !state.transport.loopEnabled
      || !Number.isSafeInteger(passCount)
      || passCount < 2
      || passCount > MAX_AUDIO_TAKES_PER_FOLDER
      || !Number.isFinite(loopStartBeat)
      || !Number.isFinite(loopEndBeat)
      || loopStartBeat < 0
      || loopEndBeat <= loopStartBeat
      || loopEndBeat > snapshot.lengthBeats
    ) {
      return { ok: false, code: 'cycle-recording-invalid' };
    }
    cycle = Object.freeze({ loopStartBeat, loopEndBeat, passCount });
    startBeat = loopStartBeat;
  }
  const preflight = recordingTargetPreflight(snapshot, target, {
    audioAssetCount: cycle?.passCount ?? 1,
    createsClip: cycle === null && punch === null,
    createsTakeFolder: cycle !== null,
  });
  if (preflight) return preflight;
  try {
    const musicalTime = compileMusicalTime(snapshot);
    const availableSeconds = punch !== null
      ? secondsBetweenBeats(
          musicalTime,
          punch.punchInBeat,
          punch.punchOutBeat,
        )
      : cycle === null
        ? secondsBetweenBeats(musicalTime, startBeat, snapshot.lengthBeats)
      : secondsBetweenBeats(
          musicalTime,
          cycle.loopStartBeat,
          cycle.loopEndBeat,
        ) * cycle.passCount;
    if (
      !Number.isFinite(startBeat)
      || !Number.isFinite(availableSeconds)
      || startBeat < 0
      || startBeat >= snapshot.lengthBeats
      || availableSeconds < MIN_MICROPHONE_CAPTURE_SECONDS
      || (
        punch !== null
        && availableSeconds > MAX_MICROPHONE_CAPTURE_SECONDS
      )
      || (
        cycle !== null
        && (
          availableSeconds > MAX_MICROPHONE_CAPTURE_SECONDS
          || (
            target.kind === 'existing-audio-track'
            && snapshot.audioTakeFolders.some((folder) => (
              folder.trackId === target.trackId
              && Math.abs(folder.startBeat - cycle.loopStartBeat) <= 1e-9
              && Math.abs(
                folder.lengthBeats
                  - (cycle.loopEndBeat - cycle.loopStartBeat),
              ) <= 1e-9
            ))
          )
        )
      )
    ) {
      return {
        ok: false,
        code: availableSeconds < MIN_MICROPHONE_CAPTURE_SECONDS
          ? 'recording-window-too-short'
          : punch !== null
            ? 'punch-recording-invalid'
            : 'cycle-recording-invalid',
      };
    }
  } catch {
    return {
      ok: false,
      code: punch !== null
        ? 'punch-recording-invalid'
        : cycle === null
          ? 'recording-window-too-short'
          : 'cycle-recording-invalid',
    };
  }

  const lease = tryAcquireAudioTrackImportLease();
  if (!lease) return { ok: false, code: 'decode-busy' };

  const operationId = state.tryBeginAudioRecordingOperation();
  if (operationId === null) {
    finishAudioTrackImportLease(lease);
    return { ok: false, code: 'project-busy' };
  }

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
    target,
    cycle,
    preparedCycle: null,
    punch,
    preparedPunch: null,
    punchPostrollCompletedRequestId: null,
    playbackStopped,
    latencyPolicy: Object.freeze({
      compensationMode: state.recordingLatencyCompensationMode,
      calibration: state.recordingLatencyCalibration,
      manualAdjustmentMs: state.recordingLatencyAdjustmentMs,
    }),
    synchronization: null,
    finalizing: false,
    finished: false,
  });
  return { ok: true, handle, startBeat, playbackStopped, cycle, punch };
}

function finiteNonNegativeLatency(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Freeze the browser's output-path estimate without claiming physical
 * calibration. The master limiter has the Web Audio compressor's fixed
 * look-ahead in addition to the host-reported device values.
 */
export function estimateStudioRecordingPlaybackLatencySeconds(
  context: AudioContext,
): number {
  let baseLatency = 0;
  let outputLatency = 0;
  try {
    baseLatency = finiteNonNegativeLatency(context.baseLatency);
  } catch {
    // A host property getter is advisory; the known graph delay still applies.
  }
  try {
    outputLatency = finiteNonNegativeLatency(context.outputLatency);
  } catch {
    // Older Web Audio hosts may not expose an output-device estimate.
  }
  return baseLatency + outputLatency + MASTER_LIMITER_LOOKAHEAD_SECONDS;
}

/**
 * Freeze the frame-exact finite-cycle plan before either playback or capture
 * starts. This is deliberately separate from begin(): only the shared
 * AudioContext can supply the real sample rate and device-latency snapshot.
 */
export function prepareStudioAudioTrackCycleCapture(
  handle: StudioAudioTrackRecordingHandle,
  input: PrepareStudioAudioTrackCycleCaptureInput,
): PrepareStudioAudioTrackCycleCaptureResult {
  const ownership = studioAudioTrackRecordingOwnership.get(handle);
  const state = useStore.getState();
  if (
    !ownership
    || ownership.finished
    || ownership.finalizing
    || ownership.cycle === null
    || ownership.preparedCycle !== null
    || ownership.synchronization !== null
    || ownership.lease !== activeAudioTrackImportLease
    || state.project !== ownership.snapshot
    || state.audioRecordingOperationId !== ownership.operationId
    || state.transport.phase !== 'stopped'
    || !Number.isSafeInteger(input.contextGeneration)
    || input.contextGeneration <= 0
    || !Number.isSafeInteger(input.context.sampleRate)
    || input.context.sampleRate <= 0
  ) {
    return { ok: false, code: 'commit-rejected' };
  }

  const {
    compensationMode,
    calibration,
    manualAdjustmentMs,
  } = ownership.latencyPolicy;
  const inputLatencySeconds = finiteNonNegativeLatency(input.inputLatencySeconds);
  let automaticLatencySeconds: number;
  if (compensationMode === 'calibrated') {
    if (
      calibration === null
      || calibration.inputDeviceId !== state.preferredMicrophoneInputDeviceId
      || calibration.contextGeneration !== input.contextGeneration
      || calibration.sampleRate !== input.context.sampleRate
      || !Number.isSafeInteger(calibration.latencyFrames)
      || calibration.latencyFrames < 0
      || calibration.latencyFrames
        > calibration.sampleRate * MAX_RECORDING_LATENCY_CALIBRATION_SECONDS
    ) {
      return { ok: false, code: 'recording-alignment-failed' };
    }
    automaticLatencySeconds = calibration.latencyFrames / calibration.sampleRate;
  } else if (compensationMode === 'estimated') {
    automaticLatencySeconds = estimateStudioRecordingPlaybackLatencySeconds(
      input.context,
    ) + inputLatencySeconds;
  } else if (compensationMode === 'off') {
    automaticLatencySeconds = 0;
  } else {
    return { ok: false, code: 'recording-alignment-failed' };
  }
  if (
    !Number.isSafeInteger(manualAdjustmentMs)
    || manualAdjustmentMs < MIN_RECORDING_LATENCY_ADJUSTMENT_MS
    || manualAdjustmentMs > MAX_RECORDING_LATENCY_ADJUSTMENT_MS
  ) {
    return { ok: false, code: 'recording-alignment-failed' };
  }

  let planned: ReturnType<typeof planCycleRecording>;
  try {
    planned = planCycleRecording({
      musicalTime: compileMusicalTime(ownership.snapshot),
      loopStartBeat: ownership.cycle.loopStartBeat,
      loopEndBeat: ownership.cycle.loopEndBeat,
      passCount: ownership.cycle.passCount,
      sampleRate: input.context.sampleRate,
      latencyCompensationSeconds:
        automaticLatencySeconds + manualAdjustmentMs / 1_000,
    });
  } catch {
    return { ok: false, code: 'recording-alignment-failed' };
  }
  if (!planned.ok) {
    return { ok: false, code: 'recording-alignment-failed' };
  }
  ownership.preparedCycle = Object.freeze({
    contextGeneration: input.contextGeneration,
    inputLatencySeconds,
    plan: planned.plan,
  });
  return {
    ok: true,
    cycle: ownership.cycle,
    effectiveCaptureFrameCount: planned.plan.effectiveCaptureFrameCount,
    durationSeconds:
      planned.plan.effectiveCaptureFrameCount / planned.plan.sampleRate,
  };
}

/** Freeze the exact delayed capture arm and latency-trimmed Auto Punch window. */
export function prepareStudioAudioTrackPunchCapture(
  handle: StudioAudioTrackRecordingHandle,
  input: PrepareStudioAudioTrackPunchCaptureInput,
): PrepareStudioAudioTrackPunchCaptureResult {
  const ownership = studioAudioTrackRecordingOwnership.get(handle);
  const state = useStore.getState();
  if (
    !ownership
    || ownership.finished
    || ownership.finalizing
    || ownership.cycle !== null
    || ownership.preparedCycle !== null
    || ownership.punch === null
    || ownership.preparedPunch !== null
    || ownership.synchronization !== null
    || ownership.lease !== activeAudioTrackImportLease
    || state.project !== ownership.snapshot
    || state.audioRecordingOperationId !== ownership.operationId
    || state.transport.phase !== 'stopped'
    || !Number.isSafeInteger(input.contextGeneration)
    || input.contextGeneration <= 0
    || !Number.isSafeInteger(input.context.sampleRate)
    || input.context.sampleRate <= 0
  ) {
    return { ok: false, code: 'commit-rejected' };
  }

  const {
    compensationMode,
    calibration,
    manualAdjustmentMs,
  } = ownership.latencyPolicy;
  const inputLatencySeconds = finiteNonNegativeLatency(input.inputLatencySeconds);
  let automaticLatencySeconds: number;
  if (compensationMode === 'calibrated') {
    if (
      calibration === null
      || calibration.inputDeviceId !== state.preferredMicrophoneInputDeviceId
      || calibration.contextGeneration !== input.contextGeneration
      || calibration.sampleRate !== input.context.sampleRate
      || !Number.isSafeInteger(calibration.latencyFrames)
      || calibration.latencyFrames < 0
      || calibration.latencyFrames
        > calibration.sampleRate * MAX_RECORDING_LATENCY_CALIBRATION_SECONDS
    ) {
      return { ok: false, code: 'recording-alignment-failed' };
    }
    automaticLatencySeconds = calibration.latencyFrames / calibration.sampleRate;
  } else if (compensationMode === 'estimated') {
    automaticLatencySeconds = estimateStudioRecordingPlaybackLatencySeconds(
      input.context,
    ) + inputLatencySeconds;
  } else if (compensationMode === 'off') {
    automaticLatencySeconds = 0;
  } else {
    return { ok: false, code: 'recording-alignment-failed' };
  }
  if (
    !Number.isSafeInteger(manualAdjustmentMs)
    || manualAdjustmentMs < MIN_RECORDING_LATENCY_ADJUSTMENT_MS
    || manualAdjustmentMs > MAX_RECORDING_LATENCY_ADJUSTMENT_MS
  ) {
    return { ok: false, code: 'recording-alignment-failed' };
  }

  let planned: ReturnType<typeof planPunchRecording>;
  try {
    planned = planPunchRecording({
      musicalTime: compileMusicalTime(ownership.snapshot),
      playbackStartBeat: ownership.punch.playbackStartBeat,
      punchInBeat: ownership.punch.punchInBeat,
      punchOutBeat: ownership.punch.punchOutBeat,
      playbackEndBeat: ownership.punch.playbackEndBeat,
      sampleRate: input.context.sampleRate,
      latencyCompensationSeconds:
        automaticLatencySeconds + manualAdjustmentMs / 1_000,
    });
  } catch {
    return { ok: false, code: 'recording-alignment-failed' };
  }
  if (!planned.ok) {
    return { ok: false, code: 'recording-alignment-failed' };
  }
  ownership.preparedPunch = Object.freeze({
    contextGeneration: input.contextGeneration,
    inputLatencySeconds,
    plan: planned.plan,
  });
  return {
    ok: true,
    punch: ownership.punch,
    effectiveCaptureFrameCount: planned.plan.effectiveCaptureFrameCount,
    durationSeconds:
      planned.plan.effectiveCaptureFrameCount / planned.plan.sampleRate,
  };
}

/**
 * Bind an owned take to the one playback/capture clock selected by the audio
 * bridge. The binding is one-shot and remains immutable through finalization.
 */
export function bindStudioAudioTrackRecordingToPlayback(
  handle: StudioAudioTrackRecordingHandle,
  clock: SynchronizedRecordingPlaybackClock,
): boolean {
  const ownership = studioAudioTrackRecordingOwnership.get(handle);
  const state = useStore.getState();
  if (
    !ownership
    || ownership.finished
    || ownership.finalizing
    || ownership.synchronization !== null
    || ownership.lease !== activeAudioTrackImportLease
    || state.project !== ownership.snapshot
    || state.audioRecordingOperationId !== ownership.operationId
    || state.transport.phase !== 'playing'
    || state.transport.playbackRequestId !== clock.requestId
    || clock.projectSnapshot !== ownership.snapshot
    || clock.anchorBeat !== ownership.startBeat
    || clock.context.sampleRate !== clock.sampleRate
    || !Number.isSafeInteger(clock.contextGeneration)
    || clock.contextGeneration <= 0
    || !Number.isSafeInteger(clock.sampleRate)
    || clock.sampleRate <= 0
    || !Number.isSafeInteger(clock.anchorContextFrame)
    || clock.anchorContextFrame < 0
    || !Number.isSafeInteger(clock.requestId)
    || clock.requestId < 0
    || !(
      (
        ownership.cycle === null
        && ownership.punch === null
        && ownership.preparedCycle === null
        && ownership.preparedPunch === null
        && clock.cycle === undefined
        && clock.cycleEndBeat === undefined
        && clock.punch === undefined
        && clock.captureStartContextFrame === undefined
        && clock.punchEndContextFrame === undefined
      )
      || (
        ownership.cycle !== null
        && ownership.punch === null
        && ownership.preparedPunch === null
        && ownership.preparedCycle !== null
        && ownership.preparedCycle.contextGeneration === clock.contextGeneration
        && ownership.preparedCycle.plan.sampleRate === clock.sampleRate
        && clock.punch === undefined
        && clock.captureStartContextFrame === undefined
        && clock.punchEndContextFrame === undefined
        && clock.cycle !== undefined
        && clock.cycle.loopStartBeat === ownership.cycle.loopStartBeat
        && clock.cycle.loopEndBeat === ownership.cycle.loopEndBeat
        && clock.cycle.passCount === ownership.cycle.passCount
        && clock.cycleEndBeat === (
          ownership.cycle.loopStartBeat
            + (
              ownership.cycle.loopEndBeat - ownership.cycle.loopStartBeat
            ) * ownership.cycle.passCount
        )
      )
      || (
        ownership.cycle === null
        && ownership.punch !== null
        && ownership.preparedCycle === null
        && ownership.preparedPunch !== null
        && ownership.preparedPunch.contextGeneration === clock.contextGeneration
        && ownership.preparedPunch.plan.sampleRate === clock.sampleRate
        && clock.cycle === undefined
        && clock.cycleEndBeat === undefined
        && clock.punch !== undefined
        && clock.punch.targetTrackId === ownership.punch.targetTrackId
        && clock.punch.punchInBeat === ownership.punch.punchInBeat
        && clock.punch.punchOutBeat === ownership.punch.punchOutBeat
        && clock.punch.playbackEndBeat === ownership.punch.playbackEndBeat
        && clock.captureStartContextFrame === (
          clock.anchorContextFrame
          + ownership.preparedPunch.plan.captureStartOffsetFrames
        )
        && clock.punchEndContextFrame === (
          clock.anchorContextFrame
          + ownership.preparedPunch.plan.punchEndOffsetFrames
        )
      )
    )
  ) {
    return false;
  }
  const {
    compensationMode,
    calibration,
    manualAdjustmentMs,
  } = ownership.latencyPolicy;
  if (
    state.recordingLatencyCompensationMode !== compensationMode
    || state.recordingLatencyCalibration !== calibration
    || state.recordingLatencyAdjustmentMs !== manualAdjustmentMs
    ||
    (
      compensationMode !== 'calibrated'
      && compensationMode !== 'estimated'
      && compensationMode !== 'off'
    )
    || !Number.isSafeInteger(manualAdjustmentMs)
    || manualAdjustmentMs < MIN_RECORDING_LATENCY_ADJUSTMENT_MS
    || manualAdjustmentMs > MAX_RECORDING_LATENCY_ADJUSTMENT_MS
    || (
      compensationMode === 'calibrated'
      && (
        calibration === null
        || calibration.inputDeviceId !== state.preferredMicrophoneInputDeviceId
        || calibration.contextGeneration !== clock.contextGeneration
        || calibration.sampleRate !== clock.sampleRate
        || !Number.isSafeInteger(calibration.latencyFrames)
        || calibration.latencyFrames < 0
        || calibration.latencyFrames
          > calibration.sampleRate * MAX_RECORDING_LATENCY_CALIBRATION_SECONDS
      )
    )
  ) {
    return false;
  }
  const estimatedPlaybackLatencySeconds =
    estimateStudioRecordingPlaybackLatencySeconds(clock.context);
  if (ownership.preparedCycle !== null) {
    const automaticLatencySeconds = compensationMode === 'calibrated'
      ? calibration!.latencyFrames / calibration!.sampleRate
      : compensationMode === 'estimated'
        ? estimatedPlaybackLatencySeconds + ownership.preparedCycle.inputLatencySeconds
        : 0;
    const reboundLatencyFrames = Math.round(
      (
        automaticLatencySeconds
        + manualAdjustmentMs / 1_000
      ) * clock.sampleRate,
    );
    if (
      !Number.isSafeInteger(reboundLatencyFrames)
      || reboundLatencyFrames
        !== ownership.preparedCycle.plan.latencyCompensationFrames
    ) {
      return false;
    }
  }
  if (ownership.preparedPunch !== null) {
    const automaticLatencySeconds = compensationMode === 'calibrated'
      ? calibration!.latencyFrames / calibration!.sampleRate
      : compensationMode === 'estimated'
        ? estimatedPlaybackLatencySeconds + ownership.preparedPunch.inputLatencySeconds
        : 0;
    const reboundLatencyFrames = Math.round(
      (
        automaticLatencySeconds
        + manualAdjustmentMs / 1_000
      ) * clock.sampleRate,
    );
    if (
      !Number.isSafeInteger(reboundLatencyFrames)
      || reboundLatencyFrames !== ownership.preparedPunch.plan.latencyFrames
    ) {
      return false;
    }
  }
  ownership.synchronization = Object.freeze({
    contextGeneration: clock.contextGeneration,
    sampleRate: clock.sampleRate,
    anchorContextFrame: clock.anchorContextFrame,
    anchorBeat: clock.anchorBeat,
    requestId: clock.requestId,
    compensationMode,
    manualAdjustmentMs,
    estimatedPlaybackLatencySeconds,
    calibratedRoundTripLatencySeconds:
      compensationMode === 'calibrated' && calibration !== null
        ? calibration.latencyFrames / calibration.sampleRate
        : null,
    cyclePlan: ownership.preparedCycle?.plan ?? null,
    punchPlan: ownership.preparedPunch?.plan ?? null,
  });
  return true;
}

/**
 * Record the owned scheduler's natural Auto Punch post-roll boundary.
 *
 * This proof is separate from the UI coordinator so a direct or replayed
 * finalization call cannot adopt captured PCM before the exact finite playback
 * generation has reached its end.
 */
export function markStudioAudioTrackPunchPostrollComplete(
  handle: StudioAudioTrackRecordingHandle,
  requestId: number,
): boolean {
  const ownership = studioAudioTrackRecordingOwnership.get(handle);
  const state = useStore.getState();
  if (
    !ownership
    || ownership.finished
    || ownership.finalizing
    || ownership.punch === null
    || ownership.preparedPunch === null
    || ownership.synchronization === null
    || ownership.synchronization.punchPlan === null
    || ownership.punchPostrollCompletedRequestId !== null
    || ownership.synchronization.requestId !== requestId
    || ownership.lease !== activeAudioTrackImportLease
    || state.project !== ownership.snapshot
    || state.audioRecordingOperationId !== ownership.operationId
    || state.transport.phase !== 'playing'
    || state.transport.playbackRequestId !== requestId
  ) {
    return false;
  }
  ownership.punchPostrollCompletedRequestId = requestId;
  return true;
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

/**
 * Materialize one compensated pass without allowing samples from an adjacent
 * lap to leak into it. Positive compensation trims the pass source window;
 * negative compensation prepends explicit zeroes.
 */
export function createCycleRecordingPassCapture(
  capture: MicrophonePcmCapture,
  pass: CycleRecordingPassWindow,
): MicrophonePcmCapture {
  if (
    !Number.isSafeInteger(pass.outputFrameCount)
    || pass.outputFrameCount <= 0
    || !Number.isSafeInteger(pass.leadingSilenceFrames)
    || pass.leadingSilenceFrames < 0
    || !Number.isSafeInteger(pass.captureSourceStartFrame)
    || !Number.isSafeInteger(pass.captureSourceEndFrameExclusive)
    || pass.captureSourceStartFrame < 0
    || pass.captureSourceEndFrameExclusive > capture.length
    || pass.captureSourceEndFrameExclusive <= pass.captureSourceStartFrame
    || pass.captureSourceFrameCount
      !== pass.captureSourceEndFrameExclusive - pass.captureSourceStartFrame
    || pass.outputFrameCount
      !== pass.leadingSilenceFrames + pass.captureSourceFrameCount
  ) {
    throw new CanonicalAudioAssetError('invalid-audio');
  }

  const channels = Array.from(
    { length: capture.numberOfChannels },
    (_, channel) => {
      const source = capture.getChannelData(channel);
      if (source.length !== capture.length) {
        throw new CanonicalAudioAssetError('invalid-audio');
      }
      const output = new Float32Array(pass.outputFrameCount);
      output.set(
        source.subarray(
          pass.captureSourceStartFrame,
          pass.captureSourceEndFrameExclusive,
        ),
        pass.leadingSilenceFrames,
      );
      return output;
    },
  );
  const firstContextFrame = capture.firstContextFrame + pass.cycleStartFrame;
  return Object.freeze({
    numberOfChannels: capture.numberOfChannels,
    length: pass.outputFrameCount,
    sampleRate: capture.sampleRate,
    durationSeconds: pass.outputFrameCount / capture.sampleRate,
    stopReason: capture.stopReason,
    contextGeneration: capture.contextGeneration,
    firstContextFrame,
    endContextFrameExclusive: firstContextFrame + pass.outputFrameCount,
    inputLatencySeconds: capture.inputLatencySeconds,
    getChannelData: (channel: number): Float32Array => {
      const data = channels[channel];
      if (data === undefined) {
        throw new CanonicalAudioAssetError('invalid-audio');
      }
      return data;
    },
  });
}

/** Materialize the latency-compensated exact Auto Punch window for WAV conversion. */
export function createPunchRecordingCapture(
  capture: MicrophonePcmCapture,
  plan: PunchRecordingPlan,
): MicrophonePcmCapture {
  const extracted = extractPunchRecording(
    plan,
    Array.from(
      { length: capture.numberOfChannels },
      (_, channel) => capture.getChannelData(channel),
    ),
  );
  if (!extracted.ok) {
    throw new CanonicalAudioAssetError('invalid-audio');
  }
  const channels = extracted.output.channels;
  return Object.freeze({
    numberOfChannels: channels.length,
    length: extracted.output.frameCount,
    sampleRate: extracted.output.sampleRate,
    durationSeconds: extracted.output.durationSeconds,
    stopReason: capture.stopReason,
    contextGeneration: capture.contextGeneration,
    firstContextFrame: capture.firstContextFrame,
    endContextFrameExclusive:
      capture.firstContextFrame + extracted.output.frameCount,
    inputLatencySeconds: capture.inputLatencySeconds,
    getChannelData: (channel: number): Float32Array => {
      const data = channels[channel];
      if (data === undefined) {
        throw new CanonicalAudioAssetError('invalid-audio');
      }
      return data;
    },
  });
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
  targetTrackId?: string;
  canonical: CanonicalAudioAssetResult;
  receipt: AudioAssetStoreReceipt;
  fileName: string;
  trackName?: string;
  startBeat?: number;
  sourceStartFrame?: number;
  sourceFrameCount?: number;
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
  const mutation = input.targetTrackId === undefined
    ? createAudioTrackClip(input.snapshot, asset, {
        ...(input.trackName !== undefined ? { trackName: input.trackName } : {}),
        ...(input.startBeat !== undefined ? { startBeat: input.startBeat } : {}),
        ...(input.sourceStartFrame !== undefined ? { sourceStartFrame: input.sourceStartFrame } : {}),
        ...(input.sourceFrameCount !== undefined ? { sourceFrameCount: input.sourceFrameCount } : {}),
      })
    : appendAudioTrackClip(input.snapshot, input.targetTrackId, asset, {
        ...(input.startBeat !== undefined ? { startBeat: input.startBeat } : {}),
        ...(input.sourceStartFrame !== undefined ? { sourceStartFrame: input.sourceStartFrame } : {}),
        ...(input.sourceFrameCount !== undefined ? { sourceFrameCount: input.sourceFrameCount } : {}),
      });
  if (!mutation.ok) return importFailed(mutation.error.code);

  const wasActive = latest.transport.phase !== 'stopped';
  const committed = input.recordingOperationId === undefined
    ? latest.applyVerifiedAudioAssetAddition(
        (current) => (current === input.snapshot ? mutation.project : current),
        mutation.audioAssetId,
      )
    : latest.applyVerifiedRecordingAudioAssetAddition({
        operationId: input.recordingOperationId,
        expectedSnapshot: input.snapshot,
        verifiedAudioAssetId: mutation.audioAssetId,
        nextProject: mutation.project,
      });
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

function cycleTakeFileName(
  fileName: string | undefined,
  passIndex: number,
): string {
  const normalized = normalizedAssetName(fileName ?? 'cycle-recording.wav');
  const extensionIndex = normalized.lastIndexOf('.');
  const stem = extensionIndex > 0
    ? normalized.slice(0, extensionIndex)
    : normalized;
  return `${stem}-take-${String(passIndex + 1).padStart(2, '0')}.wav`;
}

function cycleTakeMutationFailureCode(
  code: string,
): StudioAudioActionErrorCode {
  if (code === 'folder-limit') return 'take-folder-limit';
  if (code === 'take-limit') return 'take-limit';
  if (
    code === 'audio-asset-limit'
    || code === 'track-limit'
    || code === 'track-not-found'
    || code === 'unsupported-track-type'
    || code === 'id-factory-failed'
  ) {
    return code;
  }
  return 'commit-rejected';
}

function punchMutationFailureCode(
  code: string,
): StudioAudioActionErrorCode {
  if (code === 'folder-limit') return 'take-folder-limit';
  if (code === 'take-limit') return 'take-limit';
  if (
    code === 'audio-asset-limit'
    || code === 'clip-limit'
    || code === 'track-not-found'
    || code === 'unsupported-track-type'
    || code === 'id-factory-failed'
  ) {
    return code;
  }
  if (
    code === 'ambiguous-overlap'
    || code === 'ineligible-source'
    || code === 'mismatched-folder'
    || code === 'source-too-short'
  ) {
    return 'punch-target-ineligible';
  }
  return 'commit-rejected';
}

async function recordStudioAudioPunchWithLease(
  input: RecordStudioAudioTrackInput,
  dependencies: RecordStudioAudioTrackDependencies,
  ownership: StudioAudioTrackRecordingOwnership,
  synchronization: StudioAudioTrackRecordingSynchronization & Readonly<{
    punchPlan: PunchRecordingPlan;
  }>,
): Promise<RecordStudioAudioTrackResult> {
  const {
    lease,
    snapshot,
    operationId,
    target,
    punch,
    preparedPunch,
    playbackStopped,
  } = ownership;
  if (
    target.kind !== 'existing-audio-track'
    || punch === null
    || preparedPunch === null
    || ownership.punchPostrollCompletedRequestId !== synchronization.requestId
    || input.capture.stopReason !== 'duration-limit'
    || input.capture.contextGeneration !== synchronization.contextGeneration
    || input.capture.sampleRate !== synchronization.sampleRate
    || input.capture.firstContextFrame !== (
      synchronization.anchorContextFrame
      + synchronization.punchPlan.captureStartOffsetFrames
    )
    || input.capture.length
      !== synchronization.punchPlan.effectiveCaptureFrameCount
    || input.capture.endContextFrameExclusive
      !== input.capture.firstContextFrame + input.capture.length
    || finiteNonNegativeLatency(input.capture.inputLatencySeconds)
      !== preparedPunch.inputLatencySeconds
  ) {
    return importFailed('recording-alignment-failed');
  }

  const signal = input.signal ?? new AbortController().signal;
  const canonicalize = dependencies.canonicalize ?? canonicalizeAudioAsset;
  const repository = dependencies.repository ?? studioRuntime.audioAssets;
  const createAudioBuffer = dependencies.createAudioBuffer ?? createRecordingAudioBuffer;
  let canonical: CanonicalAudioAssetResult;
  let receipt: AudioAssetStoreReceipt;
  try {
    throwIfCancelled(signal);
    const exactCapture = createPunchRecordingCapture(
      input.capture,
      synchronization.punchPlan,
    );
    const resourcePlan = planStudioAudioRecordingResources(input.capture);
    const audioAssetCache = getAudioAssetPlaybackCache();
    audioAssetCache.clearUnused();
    const reservationBytes = checkedHeavyAudioResourceTotal([
      resourcePlan.peakBytes,
      audioAssetCache.retainedDecodedBytes,
    ]);
    if (lease.resourceReservation) lease.resourceReservation.resize(reservationBytes);
    else lease.resourceReservation = reserveHeavyAudioResources(reservationBytes);
    const source = createAudioBuffer(exactCapture);
    canonical = await canonicalize(source, {
      signal,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      onResampleJob: (job) => trackAudioTrackImportWork(lease, job.settled),
    });
    const expectedCanonicalFrames = Math.round(
      synchronization.punchPlan.outputFrameCount
        / synchronization.punchPlan.sampleRate
        * canonical.sampleRate,
    );
    if (
      !Number.isSafeInteger(expectedCanonicalFrames)
      || expectedCanonicalFrames <= 0
      || Math.abs(canonical.frameCount - expectedCanonicalFrames) > 1
    ) {
      throw new CanonicalAudioAssetError('invalid-audio');
    }
    throwIfCancelled(signal);
    receipt = await storeAudioAssetBytes(repository, canonical.bytes);
    throwIfCancelled(signal);
  } catch (error) {
    return importFailed(recordingErrorCode(error, signal));
  }

  const latest = useStore.getState();
  if (
    latest.projectOperationBusy
    || latest.project !== snapshot
    || latest.audioRecordingOperationId !== operationId
  ) {
    return importFailed('commit-rejected');
  }
  const assetId = (dependencies.createAssetId ?? (() => uid('audio-asset')))();
  const asset: ReadyAudioAsset = {
    id: assetId,
    availability: 'ready',
    checksumSha256: receipt.checksumSha256,
    originalName: normalizedAssetName(input.fileName ?? 'auto-punch.wav'),
    mediaType: 'audio/wav',
    byteLength: receipt.byteLength,
    sampleRate: canonical.sampleRate,
    channelCount: canonical.channelCount,
    frameCount: canonical.frameCount,
  };
  const mutation = adoptRecordedAudioPunch(snapshot, {
    trackId: target.trackId,
    asset,
    punchInBeat: punch.punchInBeat,
    punchOutBeat: punch.punchOutBeat,
  });
  if (!mutation.ok) {
    return importFailed(punchMutationFailureCode(mutation.error.code));
  }
  const committed = latest.applyVerifiedPunchRecordingAddition({
    operationId,
    expectedSnapshot: snapshot,
    verifiedAudioAssetId: mutation.audioAssetId,
    proof: {
      mode: mutation.mode,
      trackId: mutation.trackId,
      folderId: mutation.folderId,
      createdClipId: mutation.createdClipId,
      createdTakeId: mutation.createdTakeId,
      preservedOuterClipIds: mutation.preservedOuterClipIds,
      punchInBeat: punch.punchInBeat,
      punchOutBeat: punch.punchOutBeat,
    },
    nextProject: mutation.project,
  });
  if (!committed || useStore.getState().project === snapshot) {
    return importFailed('commit-rejected');
  }
  const adopted = useStore.getState();
  const track = adopted.project.tracks.find(
    (candidate) => candidate.id === mutation.trackId,
  );
  if (!track) return importFailed('commit-rejected');
  adopted.selectTrack(mutation.trackId);
  adopted.selectClip(mutation.createdClipId);
  adopted.selectTakeFolder(mutation.folderId);
  adopted.selectChord(null);
  adopted.selectNotes([]);
  adopted.setActiveView(mutation.folderId === null ? 'arranger' : 'comping');
  if (mutation.folderId === null) {
    return {
      ok: true,
      changed: true,
      trackId: mutation.trackId,
      trackName: track.name,
      clipId: mutation.createdClipId!,
      audioAssetId: mutation.audioAssetId,
      deduplicated: receipt.deduplicated,
      playbackStopped,
    };
  }
  const folder = adopted.project.audioTakeFolders.find(
    (candidate) => candidate.id === mutation.folderId,
  );
  if (!folder) return importFailed('commit-rejected');
  return {
    ok: true,
    changed: true,
    trackId: mutation.trackId,
    trackName: track.name,
    folderId: mutation.folderId,
    audioAssetIds: [mutation.audioAssetId],
    takeCount: folder.takes.length,
    deduplicated: receipt.deduplicated,
    playbackStopped,
  };
}

async function recordStudioAudioCycleWithLease(
  input: RecordStudioAudioTrackInput,
  dependencies: RecordStudioAudioTrackDependencies,
  ownership: StudioAudioTrackRecordingOwnership,
  synchronization: StudioAudioTrackRecordingSynchronization & Readonly<{
    cyclePlan: CycleRecordingPlan;
  }>,
): Promise<RecordStudioAudioTrackResult> {
  const {
    lease,
    snapshot,
    operationId,
    target,
    cycle,
    preparedCycle,
    playbackStopped,
  } = ownership;
  if (
    cycle === null
    || preparedCycle === null
    || input.capture.stopReason !== 'duration-limit'
    || input.capture.contextGeneration !== synchronization.contextGeneration
    || input.capture.sampleRate !== synchronization.sampleRate
    || input.capture.firstContextFrame !== synchronization.anchorContextFrame
    || input.capture.length !== synchronization.cyclePlan.effectiveCaptureFrameCount
    || input.capture.endContextFrameExclusive
      !== input.capture.firstContextFrame + input.capture.length
    || finiteNonNegativeLatency(input.capture.inputLatencySeconds)
      !== preparedCycle.inputLatencySeconds
  ) {
    return importFailed('recording-alignment-failed');
  }

  const signal = input.signal ?? new AbortController().signal;
  const canonicalize = dependencies.canonicalize ?? canonicalizeAudioAsset;
  const repository = dependencies.repository ?? studioRuntime.audioAssets;
  const createAudioBuffer = dependencies.createAudioBuffer ?? createRecordingAudioBuffer;
  const assets: ReadyAudioAsset[] = [];
  const receipts: AudioAssetStoreReceipt[] = [];

  try {
    throwIfCancelled(signal);
    // Keep the full continuous capture plus the worst conversion envelope
    // reserved while passes are materialized and persisted sequentially.
    const resourcePlan = planStudioAudioRecordingResources(input.capture);
    const audioAssetCache = getAudioAssetPlaybackCache();
    audioAssetCache.clearUnused();
    const reservationBytes = checkedHeavyAudioResourceTotal([
      resourcePlan.peakBytes,
      audioAssetCache.retainedDecodedBytes,
    ]);
    if (lease.resourceReservation) lease.resourceReservation.resize(reservationBytes);
    else lease.resourceReservation = reserveHeavyAudioResources(reservationBytes);

    for (const pass of synchronization.cyclePlan.passes) {
      throwIfCancelled(signal);
      const source = createAudioBuffer(
        createCycleRecordingPassCapture(input.capture, pass),
      );
      const canonical = await canonicalize(source, {
        signal,
        ...(input.onProgress
          ? {
              onProgress: (progress: CanonicalAudioAssetProgress) => {
                input.onProgress?.({
                  phase: progress.phase,
                  fraction: Math.min(
                    1,
                    (pass.passIndex + progress.fraction)
                      / synchronization.cyclePlan.passCount,
                  ),
                });
              },
            }
          : {}),
        onResampleJob: (job) => trackAudioTrackImportWork(lease, job.settled),
      });
      throwIfCancelled(signal);
      const receipt = await storeAudioAssetBytes(repository, canonical.bytes);
      throwIfCancelled(signal);
      const assetId = (dependencies.createAssetId ?? (() => uid('audio-asset')))();
      assets.push({
        id: assetId,
        availability: 'ready',
        checksumSha256: receipt.checksumSha256,
        originalName: cycleTakeFileName(input.fileName, pass.passIndex),
        mediaType: 'audio/wav',
        byteLength: receipt.byteLength,
        sampleRate: canonical.sampleRate,
        channelCount: canonical.channelCount,
        frameCount: canonical.frameCount,
      });
      receipts.push(receipt);
    }
  } catch (error) {
    return importFailed(recordingErrorCode(error, signal));
  }

  const latest = useStore.getState();
  if (
    latest.projectOperationBusy
    || latest.project !== snapshot
    || latest.audioRecordingOperationId !== operationId
    || assets.length !== cycle.passCount
  ) {
    return importFailed('commit-rejected');
  }
  const requestedTrackName = target.kind === 'new-track'
    ? target.trackName ?? input.trackName
    : undefined;
  const mutationTarget = target.kind === 'new-track'
    ? {
        kind: 'new-track' as const,
        ...(requestedTrackName !== undefined
          ? { trackName: requestedTrackName }
          : {}),
      }
    : target;
  const mutation = createRecordedAudioTakeFolder(snapshot, {
    target: mutationTarget,
    assets,
    startBeat: cycle.loopStartBeat,
    lengthBeats: cycle.loopEndBeat - cycle.loopStartBeat,
  });
  if (!mutation.ok) {
    return importFailed(cycleTakeMutationFailureCode(mutation.error.code));
  }
  const committed = latest.applyVerifiedCycleRecordingAddition({
    operationId,
    expectedSnapshot: snapshot,
    verifiedAudioAssetIds: mutation.audioAssetIds,
    folderId: mutation.folderId,
    nextProject: mutation.project,
  });
  if (!committed || useStore.getState().project === snapshot) {
    return importFailed('commit-rejected');
  }
  const adopted = useStore.getState();
  const track = adopted.project.tracks.find(
    (candidate) => candidate.id === mutation.trackId,
  );
  if (!track) return importFailed('commit-rejected');
  adopted.selectTrack(mutation.trackId);
  adopted.selectClip(null);
  adopted.selectTakeFolder(mutation.folderId);
  adopted.selectChord(null);
  adopted.selectNotes([]);
  adopted.setActiveView('comping');
  return {
    ok: true,
    changed: true,
    trackId: mutation.trackId,
    trackName: track.name,
    folderId: mutation.folderId,
    audioAssetIds: mutation.audioAssetIds,
    takeCount: mutation.audioAssetIds.length,
    deduplicated: receipts.every((receipt) => receipt.deduplicated),
    playbackStopped,
  };
}

async function recordStudioAudioTrackWithLease(
  input: RecordStudioAudioTrackInput,
  dependencies: RecordStudioAudioTrackDependencies,
  ownership: StudioAudioTrackRecordingOwnership,
): Promise<RecordStudioAudioTrackResult> {
  const startingState = useStore.getState();
  const {
    lease,
    snapshot,
    operationId,
    startBeat,
    target,
    playbackStopped,
    synchronization,
  } = ownership;
  if (
    startingState.projectOperationBusy
    || startingState.project !== snapshot
    || startingState.audioRecordingOperationId !== operationId
    || (
      ownership.cycle !== null
        ? (
            synchronization?.cyclePlan === null
            || synchronization?.cyclePlan === undefined
            || synchronization.punchPlan !== null
          )
        : ownership.punch !== null
          ? (
              synchronization?.punchPlan === null
              || synchronization?.punchPlan === undefined
              || synchronization.cyclePlan !== null
            )
          : (
              synchronization?.cyclePlan !== null
              && synchronization?.cyclePlan !== undefined
            ) || (
              synchronization?.punchPlan !== null
              && synchronization?.punchPlan !== undefined
            )
    )
  ) {
    return importFailed('commit-rejected');
  }
  if (
    synchronization !== null
    && (
      input.capture.contextGeneration !== synchronization.contextGeneration
      || input.capture.sampleRate !== synchronization.sampleRate
      || !Number.isSafeInteger(input.capture.firstContextFrame)
      || input.capture.firstContextFrame < 0
      || !Number.isSafeInteger(input.capture.endContextFrameExclusive)
      || !Number.isSafeInteger(input.capture.firstContextFrame + input.capture.length)
      || input.capture.endContextFrameExclusive
        !== input.capture.firstContextFrame + input.capture.length
    )
  ) {
    return importFailed('recording-alignment-failed');
  }
  if (synchronization?.cyclePlan !== null && synchronization?.cyclePlan !== undefined) {
    return recordStudioAudioCycleWithLease(
      input,
      dependencies,
      ownership,
      synchronization as StudioAudioTrackRecordingSynchronization & Readonly<{
        cyclePlan: CycleRecordingPlan;
      }>,
    );
  }
  if (synchronization?.punchPlan !== null && synchronization?.punchPlan !== undefined) {
    return recordStudioAudioPunchWithLease(
      input,
      dependencies,
      ownership,
      synchronization as StudioAudioTrackRecordingSynchronization & Readonly<{
        punchPlan: PunchRecordingPlan;
      }>,
    );
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

  const newTrackName = target.kind === 'new-track'
    ? target.trackName ?? input.trackName
    : undefined;
  let placement = {
    startBeat,
    sourceStartFrame: 0,
    sourceFrameCount: canonical.frameCount,
  };
  if (synchronization !== null) {
    const inputLatencySeconds = finiteNonNegativeLatency(
      input.capture.inputLatencySeconds,
    );
    const planned = planSynchronizedRecordingPlacement({
      musicalTime: compileMusicalTime(snapshot),
      playbackAnchorBeat: synchronization.anchorBeat,
      playbackAnchorFrame: synchronization.anchorContextFrame,
      captureFirstFrame: input.capture.firstContextFrame,
      captureFrameCount: input.capture.length,
      captureSampleRate: input.capture.sampleRate,
      canonicalFrameCount: canonical.frameCount,
      canonicalSampleRate: canonical.sampleRate,
      automaticEstimatedLatencySeconds:
        synchronization.compensationMode === 'calibrated'
          ? synchronization.calibratedRoundTripLatencySeconds ?? Number.NaN
          : synchronization.compensationMode === 'estimated'
            ? synchronization.estimatedPlaybackLatencySeconds + inputLatencySeconds
            : 0,
      manualOffsetMilliseconds: synchronization.manualAdjustmentMs,
    });
    if (!planned.ok) return importFailed('recording-alignment-failed');
    placement = {
      startBeat: planned.placement.startBeat,
      sourceStartFrame: planned.placement.sourceStartFrame,
      sourceFrameCount: planned.placement.sourceFrameCount,
    };
  }
  return adoptCanonicalAudioTrack({
    snapshot,
    recordingOperationId: operationId,
    playbackStopped,
    ...(target.kind === 'existing-audio-track'
      ? { targetTrackId: target.trackId }
      : {}),
    canonical,
    receipt,
    fileName: input.fileName ?? 'microphone-recording.wav',
    ...(newTrackName !== undefined ? { trackName: newTrackName } : {}),
    ...placement,
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

export function setStudioAudioClipWarp(
  clipId: string,
  audioWarp: AudioWarp | undefined,
  expected?: Readonly<{
    project: Project;
    clip: Readonly<Project['tracks'][number]['clips'][number]>;
    activationId: string;
    audioAssetId: string;
  }>,
): StudioAudioClipCommandResult {
  if (expected) {
    const state = useStore.getState();
    const currentClip = state.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === clipId);
    if (
      state.project !== expected.project
      || state.saveState.activationId !== expected.activationId
      || state.projectOperationBusy
      || state.audioRecordingOperationId !== null
      || currentClip !== expected.clip
      || currentClip.audioAssetId !== expected.audioAssetId
    ) return failed('commit-rejected');
  }
  return runAudioMutation((project) => setAudioClipWarp(project, clipId, audioWarp));
}

export function addStudioAudioClipTimingPoint(
  clipId: string,
  marker: AudioWarpMarker,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => addAudioClipTimingPoint(project, clipId, marker));
}

export function moveStudioAudioClipTimingPoint(
  clipId: string,
  index: number,
  marker: AudioWarpMarker,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) =>
    moveAudioClipTimingPoint(project, clipId, index, marker));
}

export function removeStudioAudioClipTimingPoint(
  clipId: string,
  index: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => removeAudioClipTimingPoint(project, clipId, index));
}

export function resetStudioAudioClipTimingPoints(
  clipId: string,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => resetAudioClipTimingPoints(project, clipId));
}

export function replaceStudioAudioClipPitchRegions(
  clipId: string,
  regions: readonly AudioPitchRegion[],
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => replaceAudioClipPitchRegions(project, clipId, regions));
}

export function splitStudioAudioClipPitchRegion(
  clipId: string,
  index: number,
  sourceFrame: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) =>
    splitAudioClipPitchRegion(project, clipId, index, sourceFrame));
}

export function mergeStudioAudioClipPitchRegions(
  clipId: string,
  index: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => mergeAudioClipPitchRegions(project, clipId, index));
}

export function retargetStudioAudioClipPitchRegion(
  clipId: string,
  index: number,
  targetPitchCents: number,
  correctionAmount?: number,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) =>
    retargetAudioClipPitchRegion(
      project,
      clipId,
      index,
      targetPitchCents,
      correctionAmount,
    ));
}

export function resetStudioAudioClipPitchRegions(
  clipId: string,
): StudioAudioClipCommandResult {
  return runAudioMutation((project) => resetAudioClipPitchRegions(project, clipId));
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
    case 'input-device-required':
      return '実測校正には入力デバイスの明示選択が必要です。入力一覧から接続先を選んでください。';
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
    case 'track-not-found':
      return '録音先のオーディオトラックが見つかりません。録音待機を設定し直してください。';
    case 'unsupported-track-type':
      return '録音先にできるのはオーディオトラックだけです。';
    case 'clip-limit':
      return 'このトラックにはこれ以上クリップを追加できません。';
    case 'transport-loop-enabled':
      return 'ループONではサイクル録音として開始してください。通常の1テイク録音はループをOFFにします。';
    case 'transport-punch-enabled':
      return 'パンチONでは録音待機中のオーディオトラックへオートパンチ録音します。通常録音ではパンチをOFFにしてください。';
    case 'cycle-recording-invalid':
      return 'サイクル録音の範囲またはテイク数を使用できません。ループ範囲と合計0.5〜60秒の設定を確認してください。';
    case 'punch-recording-invalid':
      return 'オートパンチの範囲を使用できません。曲内の0.5〜60秒に設定し、ループをOFFにしてください。';
    case 'punch-target-ineligible':
      return 'この範囲は安全にパンチ録音できません。既存オーディオトラックを録音待機にし、重複・ループ素材・異なるテイク範囲を整理してください。';
    case 'take-folder-limit':
      return 'このプロジェクトのテイクフォルダ数が上限に達しています。不要なテイクフォルダを整理してください。';
    case 'take-limit':
      return '1つのテイクフォルダへ保存できるテイク数は2〜128です。テイク数を減らしてください。';
    case 'recording-window-too-short':
      return '現在位置から曲末までが短すぎます。0.5秒以上手前へ移動してから録音してください。';
    case 'recording-alignment-failed':
      return '録音と伴奏の時間位置を安全に照合できませんでした。入力デバイスを確認して録音し直してください。';
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
    case 'edited-loop-unsupported':
      return '音声のタイミングまたは音程を補正中はループにできません。先に「音声を整える」で補正をリセットしてください。';
    case 'invalid-audio-warp':
      return '音声補正の位置または範囲を安全に反映できません。タイミング点と音程区間を確認してください。';
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
