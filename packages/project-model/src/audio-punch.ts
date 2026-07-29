// Pure, immutable adoption for one bounded recorded Auto Punch window.
// Binary persistence and runtime arm ownership stay outside this package.

import type { Clock } from './clock';
import { nowIso, systemClock } from './clock';
import { collectProjectEntityIds, DEFAULT_AUDIO_TAKE_CROSSFADE_MS } from './audio-take-comp';
import { makeId } from './ids';
import {
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_CLIPS_PER_TRACK,
  MIN_EVENT_DURATION_BEATS,
} from './limits';
import {
  MAX_PROJECT_STRING_LENGTH,
  encodeProjectJson,
  type ProjectCodecIssue,
} from './project-codec';
import { compileMusicalTime, secondsBetweenBeats } from './time';
import type {
  AudioClip,
  AudioTake,
  AudioTakeFolder,
  Project,
  ReadyAudioAsset,
  Track,
} from './types';
import { MAX_AUDIO_ASSETS } from './validation';

export const MIN_AUDIO_PUNCH_SECONDS = 0.5;
export const MAX_AUDIO_PUNCH_SECONDS = 60;

export type AudioPunchMode =
  | 'empty-window'
  | 'created-folder'
  | 'appended-folder';

export type AudioPunchEntityIdKind = 'clip' | 'folder' | 'take' | 'segment';
export type AudioPunchIdFactory = (kind: AudioPunchEntityIdKind) => string;

export type AudioPunchMutationErrorCode =
  | 'project-not-adoptable'
  | 'track-not-found'
  | 'unsupported-track-type'
  | 'invalid-range'
  | 'audio-asset-not-ready'
  | 'audio-asset-limit'
  | 'clip-limit'
  | 'folder-limit'
  | 'take-limit'
  | 'ambiguous-overlap'
  | 'ineligible-source'
  | 'mismatched-folder'
  | 'source-too-short'
  | 'invalid-id'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'unexpected';

export type AudioPunchMutationError = Readonly<{
  code: AudioPunchMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type AudioPunchMutationFailure = Readonly<{
  ok: false;
  error: AudioPunchMutationError;
}>;

export type InspectAudioPunchTargetInput = Readonly<{
  trackId: string;
  punchInBeat: number;
  punchOutBeat: number;
}>;

export type AudioPunchTargetInspection = Readonly<{
  ok: true;
  mode: AudioPunchMode;
  trackId: string;
  punchInBeat: number;
  punchOutBeat: number;
  folderId: string | null;
  sourceClipId: string | null;
}>;

export type AudioPunchInspectionResult =
  | AudioPunchTargetInspection
  | AudioPunchMutationFailure;

export type AdoptRecordedAudioPunchInput = Readonly<
  InspectAudioPunchTargetInput & {
    asset: ReadyAudioAsset;
    idFactory?: AudioPunchIdFactory;
  }
>;

export type AudioPunchMutationSuccess = Readonly<{
  ok: true;
  project: Project;
  changed: true;
  mode: AudioPunchMode;
  trackId: string;
  audioAssetId: string;
  folderId: string | null;
  createdClipId: string | null;
  createdTakeId: string | null;
  preservedOuterClipIds: readonly string[];
}>;

/** Store-facing name for the immutable adoption proof. */
export type AdoptRecordedAudioPunchSuccess = AudioPunchMutationSuccess;

export type AudioPunchMutationResult =
  | AudioPunchMutationSuccess
  | AudioPunchMutationFailure;

type AllocatedId =
  | Readonly<{ ok: true; id: string }>
  | AudioPunchMutationFailure;

type SpanningSource = Readonly<{
  clip: AudioClip;
  asset: ReadyAudioAsset;
  punchStartOffsetFrames: number;
  punchEndOffsetFrames: number;
}>;

const BEAT_EPSILON = 1e-9;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AUDIO_MEDIA_TYPES = new Set([
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
]);
const defaultIdFactory: AudioPunchIdFactory = (kind) => makeId(kind);

function sameBeat(left: number, right: number): boolean {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= BEAT_EPSILON;
}

function rangeOverlaps(
  leftStart: number,
  leftLength: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  const leftEnd = leftStart + leftLength;
  return leftStart < rightEnd - BEAT_EPSILON
    && leftEnd > rightStart + BEAT_EPSILON;
}

function failure(
  code: AudioPunchMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): AudioPunchMutationFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(issues !== undefined ? { issues } : {}),
    },
  };
}

function codecFailure(project: Project): AudioPunchMutationFailure | null {
  const encoded = encodeProjectJson(project);
  if (encoded.ok) return null;
  const first = encoded.error.issues[0];
  const detail = first ? ` ${first.path}: ${first.message}` : '';
  return failure(
    'project-not-adoptable',
    `Project codec rejected the Audio punch change.${detail}`,
    encoded.error.issues,
  );
}

function inspectRange(
  project: Project,
  punchInBeat: number,
  punchOutBeat: number,
): AudioPunchMutationFailure | null {
  if (
    !Number.isFinite(punchInBeat)
    || !Number.isFinite(punchOutBeat)
    || punchInBeat < 0
    || punchOutBeat <= punchInBeat
    || punchOutBeat > project.lengthBeats
    || punchOutBeat - punchInBeat < MIN_EVENT_DURATION_BEATS
  ) {
    return failure(
      'invalid-range',
      'Auto Punch requires a non-empty range inside the project timeline.',
    );
  }
  const seconds = secondsBetweenBeats(
    compileMusicalTime(project),
    punchInBeat,
    punchOutBeat,
  );
  if (
    !Number.isFinite(seconds)
    || seconds < MIN_AUDIO_PUNCH_SECONDS - Number.EPSILON
    || seconds > MAX_AUDIO_PUNCH_SECONDS + Number.EPSILON
  ) {
    return failure(
      'invalid-range',
      `Auto Punch must be between ${MIN_AUDIO_PUNCH_SECONDS} and ${MAX_AUDIO_PUNCH_SECONDS} seconds.`,
    );
  }
  return null;
}

function frameOffsetBetweenBeats(
  project: Project,
  fromBeat: number,
  toBeat: number,
  sampleRate: number,
): number | null {
  const frames = Math.round(
    secondsBetweenBeats(compileMusicalTime(project), fromBeat, toBeat)
      * sampleRate,
  );
  return Number.isSafeInteger(frames) ? frames : null;
}

function locateSpanningSource(
  project: Project,
  track: Track,
  clip: AudioClip,
  punchInBeat: number,
  punchOutBeat: number,
): SpanningSource | AudioPunchMutationFailure {
  const clipEndBeat = clip.startBeat + clip.lengthBeats;
  if (
    clip.startBeat > punchInBeat + BEAT_EPSILON
    || clipEndBeat < punchOutBeat - BEAT_EPSILON
  ) {
    return failure(
      'ambiguous-overlap',
      'The punch range partially overlaps existing audio. Choose a range fully covered by one clip or an empty range.',
    );
  }
  if (clip.type !== 'audio' || clip.loop) {
    return failure(
      'ineligible-source',
      'Auto Punch can only replace one ready, non-looping Audio Clip.',
    );
  }
  const asset = project.audioAssets.find((candidate) => candidate.id === clip.audioAssetId);
  if (asset?.availability !== 'ready') {
    return failure(
      'ineligible-source',
      'The existing Audio Clip must reference available local audio.',
    );
  }
  const punchStartOffsetFrames = frameOffsetBetweenBeats(
    project,
    clip.startBeat,
    punchInBeat,
    asset.sampleRate,
  );
  const punchEndOffsetFrames = frameOffsetBetweenBeats(
    project,
    clip.startBeat,
    punchOutBeat,
    asset.sampleRate,
  );
  if (
    punchStartOffsetFrames === null
    || punchEndOffsetFrames === null
    || punchStartOffsetFrames < 0
    || punchEndOffsetFrames <= punchStartOffsetFrames
    || punchEndOffsetFrames > clip.sourceFrameCount
    || clip.sourceStartFrame + punchEndOffsetFrames > asset.frameCount
  ) {
    return failure(
      'source-too-short',
      'The existing Audio Clip source does not cover the complete punch range.',
    );
  }
  const leftLengthBeats = punchInBeat - clip.startBeat;
  const rightLengthBeats = clipEndBeat - punchOutBeat;
  if (
    (leftLengthBeats > BEAT_EPSILON && leftLengthBeats < MIN_EVENT_DURATION_BEATS)
    || (rightLengthBeats > BEAT_EPSILON && rightLengthBeats < MIN_EVENT_DURATION_BEATS)
  ) {
    return failure(
      'invalid-range',
      'The punch boundary would leave an Audio Clip fragment that is too short.',
    );
  }
  if (
    (leftLengthBeats > BEAT_EPSILON && punchStartOffsetFrames <= 0)
    || (
      rightLengthBeats > BEAT_EPSILON
      && clip.sourceFrameCount - punchEndOffsetFrames <= 0
    )
  ) {
    return failure(
      'source-too-short',
      'The existing Audio Clip source cannot preserve the material outside the punch range.',
    );
  }
  return {
    clip,
    asset,
    punchStartOffsetFrames,
    punchEndOffsetFrames,
  };
}

function inspectTargetUnchecked(
  project: Project,
  input: InspectAudioPunchTargetInput,
): AudioPunchInspectionResult {
  const rangeFailure = inspectRange(project, input.punchInBeat, input.punchOutBeat);
  if (rangeFailure) return rangeFailure;
  const track = project.tracks.find((candidate) => candidate.id === input.trackId);
  if (track === undefined) {
    return failure('track-not-found', `Audio Track not found: ${input.trackId}`);
  }
  if (track.type !== 'audio') {
    return failure(
      'unsupported-track-type',
      'Auto Punch requires an armed Audio Track.',
    );
  }
  if (project.audioAssets.length >= MAX_AUDIO_ASSETS) {
    return failure(
      'audio-asset-limit',
      `A project can contain at most ${MAX_AUDIO_ASSETS} audio assets.`,
    );
  }

  const overlappingClips = track.clips.filter((clip) => rangeOverlaps(
    clip.startBeat,
    clip.lengthBeats,
    input.punchInBeat,
    input.punchOutBeat,
  ));
  const overlappingFolders = project.audioTakeFolders.filter((folder) => (
    folder.trackId === track.id
    && rangeOverlaps(
      folder.startBeat,
      folder.lengthBeats,
      input.punchInBeat,
      input.punchOutBeat,
    )
  ));
  if (
    overlappingClips.length > 1
    || overlappingFolders.length > 1
    || (overlappingClips.length > 0 && overlappingFolders.length > 0)
  ) {
    return failure(
      'ambiguous-overlap',
      'The punch range overlaps multiple pieces of audio and cannot be replaced safely.',
    );
  }

  const overlappingClip = overlappingClips[0];
  if (overlappingClip !== undefined) {
    const source = locateSpanningSource(
      project,
      track,
      overlappingClip as AudioClip,
      input.punchInBeat,
      input.punchOutBeat,
    );
    if (!('clip' in source)) return source;
    if (project.audioTakeFolders.length >= MAX_AUDIO_TAKE_FOLDERS) {
      return failure(
        'folder-limit',
        `A project can contain at most ${MAX_AUDIO_TAKE_FOLDERS} Audio take folders.`,
      );
    }
    const clipEndBeat = source.clip.startBeat + source.clip.lengthBeats;
    const outerClipCount = Number(!sameBeat(source.clip.startBeat, input.punchInBeat))
      + Number(!sameBeat(clipEndBeat, input.punchOutBeat));
    if (track.clips.length - 1 + outerClipCount > MAX_CLIPS_PER_TRACK) {
      return failure(
        'clip-limit',
        `An Audio Track can contain at most ${MAX_CLIPS_PER_TRACK} clips.`,
      );
    }
    return {
      ok: true,
      mode: 'created-folder',
      trackId: track.id,
      punchInBeat: input.punchInBeat,
      punchOutBeat: input.punchOutBeat,
      folderId: null,
      sourceClipId: source.clip.id,
    };
  }

  const overlappingFolder = overlappingFolders[0];
  if (overlappingFolder !== undefined) {
    if (
      !sameBeat(overlappingFolder.startBeat, input.punchInBeat)
      || !sameBeat(
        overlappingFolder.startBeat + overlappingFolder.lengthBeats,
        input.punchOutBeat,
      )
    ) {
      return failure(
        'mismatched-folder',
        'An existing take folder must exactly match the complete punch range.',
      );
    }
    if (overlappingFolder.takes.length >= MAX_AUDIO_TAKES_PER_FOLDER) {
      return failure(
        'take-limit',
        `An Audio take folder can contain at most ${MAX_AUDIO_TAKES_PER_FOLDER} takes.`,
      );
    }
    return {
      ok: true,
      mode: 'appended-folder',
      trackId: track.id,
      punchInBeat: input.punchInBeat,
      punchOutBeat: input.punchOutBeat,
      folderId: overlappingFolder.id,
      sourceClipId: null,
    };
  }

  if (track.clips.length >= MAX_CLIPS_PER_TRACK) {
    return failure(
      'clip-limit',
      `An Audio Track can contain at most ${MAX_CLIPS_PER_TRACK} clips.`,
    );
  }
  return {
    ok: true,
    mode: 'empty-window',
    trackId: track.id,
    punchInBeat: input.punchInBeat,
    punchOutBeat: input.punchOutBeat,
    folderId: null,
    sourceClipId: null,
  };
}

/**
 * Permission-free preflight for an armed Audio Track and frozen punch window.
 * Adoption runs the same inspection again against the exact Project snapshot.
 */
export function inspectAudioPunchTarget(
  project: Project,
  input: InspectAudioPunchTargetInput,
): AudioPunchInspectionResult {
  try {
    return codecFailure(project) ?? inspectTargetUnchecked(project, input);
  } catch {
    return failure(
      'unexpected',
      'The Audio punch target could not be inspected safely.',
    );
  }
}

function allocateId(
  kind: AudioPunchEntityIdKind,
  idFactory: AudioPunchIdFactory,
  reserved: Set<string>,
): AllocatedId {
  let id: unknown;
  try {
    id = idFactory(kind);
  } catch {
    return failure(
      'id-factory-failed',
      `The id factory failed while creating a ${kind} id.`,
    );
  }
  if (
    typeof id !== 'string'
    || id.length === 0
    || id.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return failure(
      'id-factory-failed',
      `The id factory must return a non-empty id of at most ${MAX_PROJECT_STRING_LENGTH} characters.`,
    );
  }
  if (reserved.has(id)) {
    return failure('duplicate-id', `The id factory returned an existing id: ${id}`);
  }
  reserved.add(id);
  return { ok: true, id };
}

function validateRecordedAsset(
  asset: ReadyAudioAsset,
): AudioPunchMutationFailure | null {
  if (
    asset.availability !== 'ready'
    || !SHA256_PATTERN.test(asset.checksumSha256)
    || typeof asset.originalName !== 'string'
    || asset.originalName.length === 0
    || asset.originalName.length > MAX_PROJECT_STRING_LENGTH
    || !AUDIO_MEDIA_TYPES.has(asset.mediaType)
    || !Number.isSafeInteger(asset.byteLength)
    || asset.byteLength <= 0
    || !Number.isSafeInteger(asset.sampleRate)
    || asset.sampleRate < 8_000
    || asset.sampleRate > 384_000
    || !Number.isSafeInteger(asset.channelCount)
    || asset.channelCount < 1
    || asset.channelCount > 32
    || !Number.isSafeInteger(asset.frameCount)
    || asset.frameCount <= 0
  ) {
    return failure(
      'audio-asset-not-ready',
      'Auto Punch requires verified ready AudioAsset metadata.',
    );
  }
  if (
    typeof asset.id !== 'string'
    || asset.id.length === 0
    || asset.id.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return failure(
      'invalid-id',
      'The recorded AudioAsset requires a bounded non-empty id.',
    );
  }
  return null;
}

function recordedAssetCoversPunch(
  project: Project,
  asset: ReadyAudioAsset,
  punchInBeat: number,
  punchOutBeat: number,
): boolean {
  const requiredFrames = secondsBetweenBeats(
    compileMusicalTime(project),
    punchInBeat,
    punchOutBeat,
  ) * asset.sampleRate;
  return Number.isFinite(requiredFrames)
    && requiredFrames > 0
    && asset.frameCount + 1 >= requiredFrames;
}

function recordedTake(
  id: string,
  asset: ReadyAudioAsset,
  lengthBeats: number,
): AudioTake {
  return {
    id,
    audioAssetId: asset.id,
    offsetBeats: 0,
    lengthBeats,
    sourceStartFrame: 0,
    sourceFrameCount: asset.frameCount,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
  };
}

function mutationSuccess(
  project: Project,
  inspection: AudioPunchTargetInspection,
  asset: ReadyAudioAsset,
  proof: Readonly<{
    folderId: string | null;
    createdClipId: string | null;
    createdTakeId: string | null;
    preservedOuterClipIds?: readonly string[];
  }>,
): AudioPunchMutationSuccess {
  return {
    ok: true,
    project,
    changed: true,
    mode: inspection.mode,
    trackId: inspection.trackId,
    audioAssetId: asset.id,
    folderId: proof.folderId,
    createdClipId: proof.createdClipId,
    createdTakeId: proof.createdTakeId,
    preservedOuterClipIds: Object.freeze([...(proof.preservedOuterClipIds ?? [])]),
  };
}

/**
 * Atomically adopt one verified exact-window recording. The preflight is
 * repeated against this immutable Project value to close the permission-time
 * eligibility / finalization TOCTOU boundary.
 */
export function adoptRecordedAudioPunch(
  project: Project,
  input: AdoptRecordedAudioPunchInput,
  clock: Clock = systemClock,
): AudioPunchMutationResult {
  try {
    const inputCodecFailure = codecFailure(project);
    if (inputCodecFailure) return inputCodecFailure;
    const inspection = inspectTargetUnchecked(project, input);
    if (!inspection.ok) return inspection;
    const assetFailure = validateRecordedAsset(input.asset);
    if (assetFailure) return assetFailure;
    const reserved = collectProjectEntityIds(project);
    if (reserved.has(input.asset.id)) {
      return failure(
        'duplicate-id',
        `The AudioAsset id already exists: ${input.asset.id}`,
      );
    }
    if (!recordedAssetCoversPunch(
      project,
      input.asset,
      input.punchInBeat,
      input.punchOutBeat,
    )) {
      return failure(
        'source-too-short',
        'The recorded AudioAsset does not cover the complete punch range.',
      );
    }
    reserved.add(input.asset.id);
    const idFactory = input.idFactory ?? defaultIdFactory;
    const lengthBeats = input.punchOutBeat - input.punchInBeat;
    let result: AudioPunchMutationSuccess;

    if (inspection.mode === 'empty-window') {
      const clipId = allocateId('clip', idFactory, reserved);
      if (!clipId.ok) return clipId;
      const clip: AudioClip = {
        id: clipId.id,
        trackId: inspection.trackId,
        type: 'audio',
        startBeat: input.punchInBeat,
        lengthBeats,
        loop: false,
        audioAssetId: input.asset.id,
        sourceStartFrame: 0,
        sourceFrameCount: input.asset.frameCount,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      };
      const candidate: Project = {
        ...project,
        audioAssets: [...project.audioAssets, input.asset],
        tracks: project.tracks.map((track) => (
          track.id === inspection.trackId
            ? { ...track, clips: [...track.clips, clip] }
            : track
        )),
        updatedAt: nowIso(clock),
      };
      result = mutationSuccess(candidate, inspection, input.asset, {
        folderId: null,
        createdClipId: clip.id,
        createdTakeId: null,
      });
    } else if (inspection.mode === 'created-folder') {
      const track = project.tracks.find(
        (candidate) => candidate.id === inspection.trackId,
      )!;
      const clip = track.clips.find(
        (candidate) => candidate.id === inspection.sourceClipId,
      ) as AudioClip;
      const source = locateSpanningSource(
        project,
        track,
        clip,
        input.punchInBeat,
        input.punchOutBeat,
      );
      if (!('clip' in source)) return source;
      const clipEndBeat = source.clip.startBeat + source.clip.lengthBeats;
      const hasLeft = !sameBeat(source.clip.startBeat, input.punchInBeat);
      const hasRight = !sameBeat(clipEndBeat, input.punchOutBeat);
      let extraOuterClipId: AllocatedId | null = null;
      if (hasLeft && hasRight) {
        extraOuterClipId = allocateId('clip', idFactory, reserved);
        if (!extraOuterClipId.ok) return extraOuterClipId;
      }
      const folderId = allocateId('folder', idFactory, reserved);
      if (!folderId.ok) return folderId;
      const oldTakeId = allocateId('take', idFactory, reserved);
      if (!oldTakeId.ok) return oldTakeId;
      const newTakeId = allocateId('take', idFactory, reserved);
      if (!newTakeId.ok) return newTakeId;
      const segmentId = allocateId('segment', idFactory, reserved);
      if (!segmentId.ok) return segmentId;

      const outerClips: AudioClip[] = [];
      if (hasLeft) {
        outerClips.push({
          ...source.clip,
          lengthBeats: input.punchInBeat - source.clip.startBeat,
          sourceFrameCount: source.punchStartOffsetFrames,
          fadeInFrames: Math.min(
            source.clip.fadeInFrames,
            source.punchStartOffsetFrames,
          ),
          fadeOutFrames: 0,
        });
      }
      if (hasRight) {
        const rightSourceFrameCount = source.clip.sourceFrameCount
          - source.punchEndOffsetFrames;
        outerClips.push({
          ...source.clip,
          id: hasLeft ? extraOuterClipId!.id : source.clip.id,
          startBeat: input.punchOutBeat,
          lengthBeats: clipEndBeat - input.punchOutBeat,
          sourceStartFrame: source.clip.sourceStartFrame
            + source.punchEndOffsetFrames,
          sourceFrameCount: rightSourceFrameCount,
          fadeInFrames: 0,
          fadeOutFrames: Math.min(
            source.clip.fadeOutFrames,
            rightSourceFrameCount,
          ),
        });
      }
      const oldSourceFrameCount = source.punchEndOffsetFrames
        - source.punchStartOffsetFrames;
      const oldFadeInFrames = sameBeat(source.clip.startBeat, input.punchInBeat)
        ? Math.min(source.clip.fadeInFrames, oldSourceFrameCount)
        : 0;
      const oldTake: AudioTake = {
        id: oldTakeId.id,
        audioAssetId: source.clip.audioAssetId,
        offsetBeats: 0,
        lengthBeats,
        sourceStartFrame: source.clip.sourceStartFrame
          + source.punchStartOffsetFrames,
        sourceFrameCount: oldSourceFrameCount,
        fadeInFrames: oldFadeInFrames,
        fadeOutFrames: sameBeat(clipEndBeat, input.punchOutBeat)
          ? Math.min(
              source.clip.fadeOutFrames,
              oldSourceFrameCount - oldFadeInFrames,
            )
          : 0,
        gainDb: source.clip.gainDb,
      };
      const newTake = recordedTake(newTakeId.id, input.asset, lengthBeats);
      const folder: AudioTakeFolder = {
        id: folderId.id,
        trackId: inspection.trackId,
        startBeat: input.punchInBeat,
        lengthBeats,
        crossfadeMs: DEFAULT_AUDIO_TAKE_CROSSFADE_MS,
        takes: [oldTake, newTake],
        compSegments: [{
          id: segmentId.id,
          takeId: newTake.id,
          offsetBeats: 0,
          lengthBeats,
        }],
      };
      const candidate: Project = {
        ...project,
        audioAssets: [...project.audioAssets, input.asset],
        audioTakeFolders: [...project.audioTakeFolders, folder],
        tracks: project.tracks.map((candidateTrack) => (
          candidateTrack.id === inspection.trackId
            ? {
                ...candidateTrack,
                clips: candidateTrack.clips.flatMap((candidateClip) => (
                  candidateClip.id === source.clip.id ? outerClips : [candidateClip]
                )),
              }
            : candidateTrack
        )),
        updatedAt: nowIso(clock),
      };
      result = mutationSuccess(candidate, inspection, input.asset, {
        folderId: folder.id,
        createdClipId: null,
        createdTakeId: newTake.id,
        preservedOuterClipIds: outerClips.map((outer) => outer.id),
      });
    } else {
      const folder = project.audioTakeFolders.find(
        (candidate) => candidate.id === inspection.folderId,
      )!;
      const takeId = allocateId('take', idFactory, reserved);
      if (!takeId.ok) return takeId;
      const segmentId = allocateId('segment', idFactory, reserved);
      if (!segmentId.ok) return segmentId;
      const take = recordedTake(takeId.id, input.asset, lengthBeats);
      const candidate: Project = {
        ...project,
        audioAssets: [...project.audioAssets, input.asset],
        audioTakeFolders: project.audioTakeFolders.map((candidateFolder) => (
          candidateFolder.id === folder.id
            ? {
                ...candidateFolder,
                takes: [...candidateFolder.takes, take],
                compSegments: [{
                  id: segmentId.id,
                  takeId: take.id,
                  offsetBeats: 0,
                  lengthBeats,
                }],
              }
            : candidateFolder
        )),
        updatedAt: nowIso(clock),
      };
      result = mutationSuccess(candidate, inspection, input.asset, {
        folderId: folder.id,
        createdClipId: null,
        createdTakeId: take.id,
      });
    }

    return codecFailure(result.project) ?? result;
  } catch {
    return failure(
      'unexpected',
      'The recorded Audio punch could not be adopted safely.',
    );
  }
}
