// Pure, immutable Audio take-folder / comp mutations. These operations only
// rearrange persistable metadata; decoding and binary asset ownership remain
// outside this package.

import type { Clock } from './clock';
import { nowIso, systemClock } from './clock';
import { makeId } from './ids';
import {
  MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
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
  AudioCompSegment,
  AudioTake,
  AudioTakeFolder,
  Project,
  ReadyAudioAsset,
  Track,
} from './types';
import {
  MAX_AUDIO_ASSETS,
  MAX_PROJECT_TRACKS,
} from './validation';

export const DEFAULT_AUDIO_TAKE_CROSSFADE_MS = 5;
export const MAX_RECORDED_AUDIO_TRACK_NAME_CODE_POINTS = 128;

export type AudioTakeCompEntityIdKind = 'track' | 'folder' | 'take' | 'segment';
export type AudioTakeCompIdFactory = (kind: AudioTakeCompEntityIdKind) => string;

export type AudioTakeCompMutationErrorCode =
  | 'project-not-adoptable'
  | 'audio-asset-not-ready'
  | 'audio-asset-limit'
  | 'track-limit'
  | 'track-not-found'
  | 'unsupported-track-type'
  | 'invalid-track-name'
  | 'folder-limit'
  | 'take-limit'
  | 'segment-limit'
  | 'folder-not-found'
  | 'take-not-found'
  | 'clip-not-found'
  | 'invalid-clip-selection'
  | 'ineligible-clip'
  | 'edited-clip-unsupported'
  | 'invalid-crossfade'
  | 'invalid-range'
  | 'boundary-not-found'
  | 'take-in-use'
  | 'minimum-takes'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'unexpected';

export type AudioTakeCompMutationError = Readonly<{
  code: AudioTakeCompMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type AudioTakeCompMutationFailure = Readonly<{
  ok: false;
  error: AudioTakeCompMutationError;
}>;

export type AudioTakeCompMutationSuccess = Readonly<{
  ok: true;
  project: Project;
  changed: boolean;
  folderId: string;
}>;

export type AudioTakeCompMutationResult =
  | AudioTakeCompMutationSuccess
  | AudioTakeCompMutationFailure;

export type RecordedAudioTakeFolderTarget =
  | Readonly<{ kind: 'new-track'; trackName?: string }>
  | Readonly<{ kind: 'existing-audio-track'; trackId: string }>;

export type CreateRecordedAudioTakeFolderInput = Readonly<{
  target: RecordedAudioTakeFolderTarget;
  assets: readonly ReadyAudioAsset[];
  startBeat: number;
  lengthBeats: number;
  crossfadeMs?: number;
  idFactory?: AudioTakeCompIdFactory;
}>;

export type CreateRecordedAudioTakeFolderSuccess = Readonly<
  AudioTakeCompMutationSuccess & {
    trackId: string;
    audioAssetIds: readonly string[];
  }
>;

export type CreateRecordedAudioTakeFolderResult =
  | CreateRecordedAudioTakeFolderSuccess
  | AudioTakeCompMutationFailure;

export type GroupAudioClipsIntoTakeFolderOptions = Readonly<{
  crossfadeMs?: number;
  idFactory?: AudioTakeCompIdFactory;
}>;

export type AddAudioClipToTakeFolderOptions = Readonly<{
  idFactory?: AudioTakeCompIdFactory;
}>;

export type PaintAudioCompRangeInput = Readonly<{
  takeId: string;
  offsetBeats: number;
  lengthBeats: number;
  idFactory?: AudioTakeCompIdFactory;
}>;

export type MoveAudioCompBoundaryInput = Readonly<{
  leftSegmentId: string;
  offsetBeats: number;
}>;

type LocatedAudioClip = Readonly<{
  track: Track;
  clip: AudioClip;
  asset: ReadyAudioAsset;
}>;

type AllocatedId =
  | Readonly<{ ok: true; id: string }>
  | AudioTakeCompMutationFailure;

const defaultIdFactory: AudioTakeCompIdFactory = (kind) => makeId(kind);
const BEAT_EPSILON = 1e-9;

function isClipIdArray(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}

function sameBeat(left: number, right: number): boolean {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= BEAT_EPSILON;
}

function failure(
  code: AudioTakeCompMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): AudioTakeCompMutationFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(issues !== undefined ? { issues } : {}),
    },
  };
}

function success(
  project: Project,
  folderId: string,
  changed: boolean,
): AudioTakeCompMutationSuccess {
  return { ok: true, project, changed, folderId };
}

function codecFailure(project: Project): AudioTakeCompMutationFailure | null {
  const encoded = encodeProjectJson(project);
  if (encoded.ok) return null;
  const first = encoded.error.issues[0];
  const detail = first ? ` ${first.path}: ${first.message}` : '';
  return failure(
    'project-not-adoptable',
    `Project codec rejected the Audio take change.${detail}`,
    encoded.error.issues,
  );
}

function runMutation<Success extends AudioTakeCompMutationSuccess>(
  project: Project,
  build: () => Success | AudioTakeCompMutationFailure,
): Success | AudioTakeCompMutationFailure {
  try {
    const inputFailure = codecFailure(project);
    if (inputFailure) return inputFailure;
    const result = build();
    if (!result.ok || !result.changed) return result;
    return codecFailure(result.project) ?? result;
  } catch {
    return failure('unexpected', 'The Audio take change could not be completed safely.');
  }
}

/** Collect every globally unique persisted entity id. */
export function collectProjectEntityIds(project: Project): Set<string> {
  const ids = new Set<string>([project.id]);
  for (const event of project.tempoMap) ids.add(event.id);
  for (const event of project.timeSignatureMap) ids.add(event.id);
  for (const asset of project.audioAssets) ids.add(asset.id);
  for (const folder of project.audioTakeFolders) {
    ids.add(folder.id);
    for (const take of folder.takes) ids.add(take.id);
    for (const segment of folder.compSegments) ids.add(segment.id);
  }
  for (const lane of project.automationLanes) {
    ids.add(lane.id);
    for (const point of lane.points) ids.add(point.id);
  }
  for (const track of project.tracks) {
    ids.add(track.id);
    for (const effect of track.effects) ids.add(effect.id);
    for (const clip of track.clips) {
      ids.add(clip.id);
      for (const note of clip.notes ?? []) ids.add(note.id);
      for (const event of clip.drumEvents ?? []) ids.add(event.id);
    }
  }
  for (const chord of project.chordTrack) ids.add(chord.id);
  for (const section of project.sections) ids.add(section.id);
  for (const send of project.audioRouting.sends) ids.add(send.id);
  return ids;
}

function allocateId(
  kind: AudioTakeCompEntityIdKind,
  idFactory: AudioTakeCompIdFactory,
  reserved: Set<string>,
): AllocatedId {
  let id: unknown;
  try {
    id = idFactory(kind);
  } catch {
    return failure('id-factory-failed', `The id factory failed while creating a ${kind} id.`);
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

function locateReadyAudioClip(
  project: Project,
  clipId: string,
): LocatedAudioClip | AudioTakeCompMutationFailure {
  for (const track of project.tracks) {
    const candidate = track.clips.find((clip) => clip.id === clipId);
    if (candidate === undefined) continue;
    if (track.type !== 'audio' || candidate.type !== 'audio') {
      return failure('ineligible-clip', 'Only clips on an Audio track can become takes.');
    }
    const clip = candidate as AudioClip;
    if (clip.loop) {
      return failure('ineligible-clip', 'Looped Audio Clips cannot become immutable takes.');
    }
    if (clip.audioWarp !== undefined) {
      return failure(
        'edited-clip-unsupported',
        'Reset Elastic Audio edits before adding this Audio Clip to a take folder.',
      );
    }
    const asset = project.audioAssets.find((item) => item.id === clip.audioAssetId);
    if (asset?.availability !== 'ready') {
      return failure('ineligible-clip', 'Every Audio take requires a ready audio asset.');
    }
    return { track, clip, asset };
  }
  return failure('clip-not-found', `Audio Clip not found: ${clipId}`);
}

function clipCoversTimeline(
  project: Project,
  clip: AudioClip,
  asset: ReadyAudioAsset,
  startBeat: number,
  lengthBeats: number,
): boolean {
  const musicalTime = compileMusicalTime(project);
  const requiredFrames = secondsBetweenBeats(
    musicalTime,
    startBeat,
    startBeat + lengthBeats,
  ) * asset.sampleRate;
  return Number.isFinite(requiredFrames)
    && requiredFrames > 0
    && clip.sourceFrameCount + 1 >= requiredFrames;
}

function clipMatchesWindow(
  project: Project,
  located: LocatedAudioClip,
  trackId: string,
  startBeat: number,
  lengthBeats: number,
): boolean {
  return located.track.id === trackId
    && sameBeat(located.clip.startBeat, startBeat)
    && sameBeat(located.clip.lengthBeats, lengthBeats)
    && clipCoversTimeline(project, located.clip, located.asset, startBeat, lengthBeats);
}

function takeFromClip(id: string, clip: AudioClip, lengthBeats: number): AudioTake {
  return {
    id,
    audioAssetId: clip.audioAssetId,
    offsetBeats: 0,
    lengthBeats,
    sourceStartFrame: clip.sourceStartFrame,
    sourceFrameCount: clip.sourceFrameCount,
    fadeInFrames: clip.fadeInFrames,
    fadeOutFrames: clip.fadeOutFrames,
    gainDb: clip.gainDb,
  };
}

function removeClips(project: Project, trackId: string, clipIds: ReadonlySet<string>): Track[] {
  return project.tracks.map((track) => (
    track.id === trackId
      ? { ...track, clips: track.clips.filter((clip) => !clipIds.has(clip.id)) }
      : track
  ));
}

function locateFolder(
  project: Project,
  folderId: string,
): AudioTakeFolder | AudioTakeCompMutationFailure {
  const folder = project.audioTakeFolders.find((candidate) => candidate.id === folderId);
  return folder ?? failure('folder-not-found', `Audio take folder not found: ${folderId}`);
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function normalizedRecordedTrackName(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || codePoints(trimmed).length > MAX_RECORDED_AUDIO_TRACK_NAME_CODE_POINTS
    || trimmed.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return null;
  }
  return trimmed;
}

function readyAssetCoversWindow(
  project: Project,
  asset: ReadyAudioAsset,
  startBeat: number,
  lengthBeats: number,
): boolean {
  const musicalTime = compileMusicalTime(project);
  const requiredFrames = secondsBetweenBeats(
    musicalTime,
    startBeat,
    startBeat + lengthBeats,
  ) * asset.sampleRate;
  return Number.isFinite(requiredFrames)
    && requiredFrames > 0
    && asset.frameCount + 1 >= requiredFrames;
}

/**
 * Atomically adopt one ready asset per completed cycle pass and create the
 * matching take folder directly. No transient Audio Clips are persisted.
 */
export function createRecordedAudioTakeFolder(
  project: Project,
  input: CreateRecordedAudioTakeFolderInput,
  clock: Clock = systemClock,
): CreateRecordedAudioTakeFolderResult {
  return runMutation(project, () => {
    if (
      input.assets.length < 2
      || input.assets.length > MAX_AUDIO_TAKES_PER_FOLDER
    ) {
      return failure(
        'take-limit',
        `Cycle recording requires between 2 and ${MAX_AUDIO_TAKES_PER_FOLDER} ready assets.`,
      );
    }
    if (
      project.audioAssets.length + input.assets.length > MAX_AUDIO_ASSETS
    ) {
      return failure(
        'audio-asset-limit',
        `A project can contain at most ${MAX_AUDIO_ASSETS} audio assets.`,
      );
    }
    if (project.audioTakeFolders.length >= MAX_AUDIO_TAKE_FOLDERS) {
      return failure(
        'folder-limit',
        `A project can contain at most ${MAX_AUDIO_TAKE_FOLDERS} Audio take folders.`,
      );
    }
    if (
      !Number.isFinite(input.startBeat)
      || !Number.isFinite(input.lengthBeats)
      || input.startBeat < 0
      || input.lengthBeats < MIN_EVENT_DURATION_BEATS
      || input.startBeat + input.lengthBeats > project.lengthBeats
    ) {
      return failure(
        'invalid-range',
        'The recorded take folder must use a non-empty window inside the project timeline.',
      );
    }
    const crossfadeMs = input.crossfadeMs ?? DEFAULT_AUDIO_TAKE_CROSSFADE_MS;
    if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0 || crossfadeMs > 50) {
      return failure('invalid-crossfade', 'Audio take crossfade must be between 0 and 50 ms.');
    }

    let targetTrack: Track | undefined;
    let trackName: string | undefined;
    if (input.target.kind === 'existing-audio-track') {
      const targetTrackId = input.target.trackId;
      targetTrack = project.tracks.find((track) => track.id === targetTrackId);
      if (targetTrack === undefined) {
        return failure('track-not-found', `Audio Track not found: ${targetTrackId}`);
      }
      if (targetTrack.type !== 'audio') {
        return failure(
          'unsupported-track-type',
          'Recorded Audio take folders require an Audio Track.',
        );
      }
    } else {
      if (project.tracks.length >= MAX_PROJECT_TRACKS) {
        return failure(
          'track-limit',
          `A project can contain at most ${MAX_PROJECT_TRACKS} tracks.`,
        );
      }
      trackName = normalizedRecordedTrackName(
        input.target.trackName ?? 'Cycle Recording',
      ) ?? undefined;
      if (trackName === undefined) {
        return failure(
          'invalid-track-name',
          `Audio Track names must contain text and be at most ${MAX_RECORDED_AUDIO_TRACK_NAME_CODE_POINTS} Unicode characters.`,
        );
      }
    }

    const prospectiveTrackId = targetTrack?.id;
    if (
      prospectiveTrackId !== undefined
      && project.audioTakeFolders.some((folder) => (
        folder.trackId === prospectiveTrackId
        && sameBeat(folder.startBeat, input.startBeat)
        && sameBeat(folder.lengthBeats, input.lengthBeats)
      ))
    ) {
      return failure(
        'ineligible-clip',
        'This Audio track and timeline window already has a take folder.',
      );
    }

    const reserved = collectProjectEntityIds(project);
    for (const asset of input.assets) {
      if (
        asset.availability !== 'ready'
        || typeof asset.id !== 'string'
        || asset.id.length === 0
        || asset.id.length > MAX_PROJECT_STRING_LENGTH
        || !Number.isSafeInteger(asset.frameCount)
        || asset.frameCount <= 0
        || !Number.isSafeInteger(asset.sampleRate)
        || asset.sampleRate <= 0
        || !readyAssetCoversWindow(
          project,
          asset,
          input.startBeat,
          input.lengthBeats,
        )
      ) {
        return failure(
          'audio-asset-not-ready',
          'Every recorded take requires a valid ready asset covering the cycle window.',
        );
      }
      if (reserved.has(asset.id)) {
        return failure('duplicate-id', `The AudioAsset id already exists: ${asset.id}`);
      }
      reserved.add(asset.id);
    }

    const idFactory = input.idFactory ?? defaultIdFactory;
    if (targetTrack === undefined) {
      const trackId = allocateId('track', idFactory, reserved);
      if (!trackId.ok) return trackId;
      targetTrack = {
        id: trackId.id,
        name: trackName!,
        type: 'audio',
        role: 'general',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      };
    }
    const folderId = allocateId('folder', idFactory, reserved);
    if (!folderId.ok) return folderId;
    const takes: AudioTake[] = [];
    for (const asset of input.assets) {
      const takeId = allocateId('take', idFactory, reserved);
      if (!takeId.ok) return takeId;
      takes.push({
        id: takeId.id,
        audioAssetId: asset.id,
        offsetBeats: 0,
        lengthBeats: input.lengthBeats,
        sourceStartFrame: 0,
        sourceFrameCount: asset.frameCount,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      });
    }
    const segmentId = allocateId('segment', idFactory, reserved);
    if (!segmentId.ok) return segmentId;
    const folder: AudioTakeFolder = {
      id: folderId.id,
      trackId: targetTrack.id,
      startBeat: input.startBeat,
      lengthBeats: input.lengthBeats,
      crossfadeMs,
      takes,
      compSegments: [{
        id: segmentId.id,
        takeId: takes[0]!.id,
        offsetBeats: 0,
        lengthBeats: input.lengthBeats,
      }],
    };

    const creatingTrack = input.target.kind === 'new-track';
    const masterIndex = project.tracks.findIndex((track) => track.type === 'master');
    const insertionIndex = masterIndex === -1 ? project.tracks.length : masterIndex;
    const candidate: Project = {
      ...project,
      audioAssets: [...project.audioAssets, ...input.assets],
      audioTakeFolders: [...project.audioTakeFolders, folder],
      tracks: creatingTrack
        ? [
            ...project.tracks.slice(0, insertionIndex),
            targetTrack,
            ...project.tracks.slice(insertionIndex),
          ]
        : project.tracks,
      audioRouting: creatingTrack
        ? {
            ...project.audioRouting,
            outputs: [
              ...project.audioRouting.outputs,
              { sourceTrackId: targetTrack.id, destination: { type: 'master' } },
            ],
          }
        : project.audioRouting,
      updatedAt: nowIso(clock),
    };
    return {
      ok: true,
      project: candidate,
      changed: true,
      folderId: folder.id,
      trackId: targetTrack.id,
      audioAssetIds: Object.freeze(input.assets.map((asset) => asset.id)),
    };
  });
}

export function groupAudioClipsIntoTakeFolder(
  project: Project,
  clipIds: readonly string[],
  options?: GroupAudioClipsIntoTakeFolderOptions,
): AudioTakeCompMutationResult;
export function groupAudioClipsIntoTakeFolder(
  project: Project,
  input: Readonly<GroupAudioClipsIntoTakeFolderOptions & { clipIds: readonly string[] }>,
): AudioTakeCompMutationResult;
export function groupAudioClipsIntoTakeFolder(
  project: Project,
  clipIdsOrInput:
    | readonly string[]
    | Readonly<GroupAudioClipsIntoTakeFolderOptions & { clipIds: readonly string[] }>,
  suppliedOptions: GroupAudioClipsIntoTakeFolderOptions = {},
): AudioTakeCompMutationResult {
  return runMutation(project, () => {
    const clipIds = isClipIdArray(clipIdsOrInput)
      ? clipIdsOrInput
      : clipIdsOrInput.clipIds;
    const options = isClipIdArray(clipIdsOrInput) ? suppliedOptions : clipIdsOrInput;
    const uniqueClipIds = new Set(clipIds);
    if (clipIds.length < 2 || uniqueClipIds.size !== clipIds.length) {
      return failure(
        'invalid-clip-selection',
        'Choose at least two different Audio Clips for one take folder.',
      );
    }
    if (project.audioTakeFolders.length >= MAX_AUDIO_TAKE_FOLDERS) {
      return failure(
        'folder-limit',
        `A project can contain at most ${MAX_AUDIO_TAKE_FOLDERS} Audio take folders.`,
      );
    }
    if (clipIds.length > MAX_AUDIO_TAKES_PER_FOLDER) {
      return failure(
        'take-limit',
        `An Audio take folder can contain at most ${MAX_AUDIO_TAKES_PER_FOLDER} takes.`,
      );
    }
    const crossfadeMs = options.crossfadeMs ?? DEFAULT_AUDIO_TAKE_CROSSFADE_MS;
    if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0 || crossfadeMs > 50) {
      return failure('invalid-crossfade', 'Audio take crossfade must be between 0 and 50 ms.');
    }

    const located: LocatedAudioClip[] = [];
    for (const clipId of clipIds) {
      const candidate = locateReadyAudioClip(project, clipId);
      if (!('clip' in candidate)) return candidate;
      located.push(candidate);
    }
    const first = located[0];
    if (first === undefined) {
      return failure('invalid-clip-selection', 'Choose Audio Clips for the take folder.');
    }
    for (const candidate of located) {
      if (!clipMatchesWindow(
        project,
        candidate,
        first.track.id,
        first.clip.startBeat,
        first.clip.lengthBeats,
      )) {
        return failure(
          'ineligible-clip',
          'Every take must use the same Audio track and timeline window with enough source audio.',
        );
      }
    }
    if (project.audioTakeFolders.some((folder) => (
      folder.trackId === first.track.id
      && sameBeat(folder.startBeat, first.clip.startBeat)
      && sameBeat(folder.lengthBeats, first.clip.lengthBeats)
    ))) {
      return failure(
        'ineligible-clip',
        'This Audio track and timeline window already has a take folder. Add the clip to that folder instead.',
      );
    }

    const idFactory = options.idFactory ?? defaultIdFactory;
    const reserved = collectProjectEntityIds(project);
    const folderId = allocateId('folder', idFactory, reserved);
    if (!folderId.ok) return folderId;
    const takes: AudioTake[] = [];
    for (const candidate of located) {
      const takeId = allocateId('take', idFactory, reserved);
      if (!takeId.ok) return takeId;
      takes.push(takeFromClip(takeId.id, candidate.clip, first.clip.lengthBeats));
    }
    const segmentId = allocateId('segment', idFactory, reserved);
    if (!segmentId.ok) return segmentId;
    const folder: AudioTakeFolder = {
      id: folderId.id,
      trackId: first.track.id,
      startBeat: first.clip.startBeat,
      lengthBeats: first.clip.lengthBeats,
      crossfadeMs,
      takes,
      compSegments: [{
        id: segmentId.id,
        takeId: takes[0]!.id,
        offsetBeats: 0,
        lengthBeats: first.clip.lengthBeats,
      }],
    };
    const candidate: Project = {
      ...project,
      tracks: removeClips(project, first.track.id, uniqueClipIds),
      audioTakeFolders: [...project.audioTakeFolders, folder],
    };
    return success(candidate, folder.id, true);
  });
}

/** Append one matching raw Audio Clip as a take without changing the current comp. */
export function addAudioClipToTakeFolder(
  project: Project,
  folderId: string,
  clipId: string,
  options: AddAudioClipToTakeFolderOptions = {},
): AudioTakeCompMutationResult {
  return runMutation(project, () => {
    const foundFolder = locateFolder(project, folderId);
    if (!('takes' in foundFolder)) return foundFolder;
    if (foundFolder.takes.length >= MAX_AUDIO_TAKES_PER_FOLDER) {
      return failure(
        'take-limit',
        `An Audio take folder can contain at most ${MAX_AUDIO_TAKES_PER_FOLDER} takes.`,
      );
    }
    const located = locateReadyAudioClip(project, clipId);
    if (!('clip' in located)) return located;
    if (!clipMatchesWindow(
      project,
      located,
      foundFolder.trackId,
      foundFolder.startBeat,
      foundFolder.lengthBeats,
    )) {
      return failure(
        'ineligible-clip',
        'The Audio Clip must match this take folder and contain enough source audio.',
      );
    }
    const reserved = collectProjectEntityIds(project);
    const takeId = allocateId('take', options.idFactory ?? defaultIdFactory, reserved);
    if (!takeId.ok) return takeId;
    const appended = takeFromClip(takeId.id, located.clip, foundFolder.lengthBeats);
    const candidate: Project = {
      ...project,
      tracks: removeClips(project, foundFolder.trackId, new Set([clipId])),
      audioTakeFolders: project.audioTakeFolders.map((folder) => (
        folder.id === folderId
          ? { ...folder, takes: [...folder.takes, appended] }
          : folder
      )),
    };
    return success(candidate, folderId, true);
  });
}

function parsePaintInput(
  takeIdOrInput: string | PaintAudioCompRangeInput,
  offsetBeats?: number,
  lengthBeats?: number,
  idFactory?: AudioTakeCompIdFactory,
): PaintAudioCompRangeInput {
  return typeof takeIdOrInput === 'string'
    ? {
        takeId: takeIdOrInput,
        offsetBeats: offsetBeats ?? Number.NaN,
        lengthBeats: lengthBeats ?? Number.NaN,
        ...(idFactory !== undefined ? { idFactory } : {}),
      }
    : takeIdOrInput;
}

function rangesEqual(
  left: readonly AudioCompSegment[],
  right: readonly AudioCompSegment[],
): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const other = right[index];
    return other !== undefined
      && segment.id === other.id
      && segment.takeId === other.takeId
      && sameBeat(segment.offsetBeats, other.offsetBeats)
      && sameBeat(segment.lengthBeats, other.lengthBeats);
  });
}

function mergeAdjacentSegments(segments: readonly AudioCompSegment[]): AudioCompSegment[] {
  const merged: AudioCompSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (
      previous !== undefined
      && previous.takeId === segment.takeId
      && sameBeat(previous.offsetBeats + previous.lengthBeats, segment.offsetBeats)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        lengthBeats: segment.offsetBeats + segment.lengthBeats - previous.offsetBeats,
      };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

export function paintAudioCompRange(
  project: Project,
  folderId: string,
  input: PaintAudioCompRangeInput,
): AudioTakeCompMutationResult;
export function paintAudioCompRange(
  project: Project,
  folderId: string,
  takeId: string,
  offsetBeats: number,
  lengthBeats: number,
  idFactory?: AudioTakeCompIdFactory,
): AudioTakeCompMutationResult;
export function paintAudioCompRange(
  project: Project,
  folderId: string,
  takeIdOrInput: string | PaintAudioCompRangeInput,
  suppliedOffsetBeats?: number,
  suppliedLengthBeats?: number,
  suppliedIdFactory?: AudioTakeCompIdFactory,
): AudioTakeCompMutationResult {
  return runMutation(project, () => {
    const folder = locateFolder(project, folderId);
    if (!('takes' in folder)) return folder;
    const input = parsePaintInput(
      takeIdOrInput,
      suppliedOffsetBeats,
      suppliedLengthBeats,
      suppliedIdFactory,
    );
    const take = folder.takes.find((candidate) => candidate.id === input.takeId);
    if (take === undefined) {
      return failure('take-not-found', `Audio take not found: ${input.takeId}`);
    }
    const rangeEnd = input.offsetBeats + input.lengthBeats;
    if (
      !Number.isFinite(input.offsetBeats)
      || !Number.isFinite(input.lengthBeats)
      || input.offsetBeats < 0
      || input.lengthBeats < MIN_EVENT_DURATION_BEATS
      || rangeEnd > folder.lengthBeats
      || input.offsetBeats < take.offsetBeats
      || rangeEnd > take.offsetBeats + take.lengthBeats
    ) {
      return failure('invalid-range', 'The painted range must fit both the folder and selected take.');
    }
    const alreadySelected = folder.compSegments
      .filter((segment) => (
        segment.offsetBeats < rangeEnd
        && segment.offsetBeats + segment.lengthBeats > input.offsetBeats
      ))
      .every((segment) => segment.takeId === take.id);
    if (alreadySelected) return success(project, folderId, false);

    const reserved = collectProjectEntityIds(project);
    const idFactory = input.idFactory ?? defaultIdFactory;
    const fragments: AudioCompSegment[] = [];
    for (const segment of folder.compSegments) {
      const segmentEnd = segment.offsetBeats + segment.lengthBeats;
      if (segmentEnd <= input.offsetBeats || segment.offsetBeats >= rangeEnd) {
        fragments.push(segment);
        continue;
      }
      if (segment.takeId === take.id) {
        fragments.push(segment);
        continue;
      }
      const specifications: Array<Omit<AudioCompSegment, 'id'>> = [];
      if (segment.offsetBeats < input.offsetBeats) {
        specifications.push({
          takeId: segment.takeId,
          offsetBeats: segment.offsetBeats,
          lengthBeats: input.offsetBeats - segment.offsetBeats,
        });
      }
      const paintedStart = Math.max(segment.offsetBeats, input.offsetBeats);
      const paintedEnd = Math.min(segmentEnd, rangeEnd);
      specifications.push({
        takeId: take.id,
        offsetBeats: paintedStart,
        lengthBeats: paintedEnd - paintedStart,
      });
      if (segmentEnd > rangeEnd) {
        specifications.push({
          takeId: segment.takeId,
          offsetBeats: rangeEnd,
          lengthBeats: segmentEnd - rangeEnd,
        });
      }
      for (const [index, specification] of specifications.entries()) {
        if (index === 0) {
          fragments.push({ id: segment.id, ...specification });
          continue;
        }
        const segmentId = allocateId('segment', idFactory, reserved);
        if (!segmentId.ok) return segmentId;
        fragments.push({ id: segmentId.id, ...specification });
      }
    }
    const compSegments = mergeAdjacentSegments(fragments);
    if (compSegments.length > MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER) {
      return failure(
        'segment-limit',
        `An Audio take folder can contain at most ${MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER} comp segments.`,
      );
    }
    if (rangesEqual(compSegments, folder.compSegments)) return success(project, folderId, false);
    const candidate: Project = {
      ...project,
      audioTakeFolders: project.audioTakeFolders.map((item) => (
        item.id === folderId ? { ...item, compSegments } : item
      )),
    };
    return success(candidate, folderId, true);
  });
}

function parseBoundaryInput(
  leftSegmentIdOrInput: string | MoveAudioCompBoundaryInput,
  offsetBeats?: number,
): MoveAudioCompBoundaryInput {
  return typeof leftSegmentIdOrInput === 'string'
    ? { leftSegmentId: leftSegmentIdOrInput, offsetBeats: offsetBeats ?? Number.NaN }
    : leftSegmentIdOrInput;
}

export function moveAudioCompBoundary(
  project: Project,
  folderId: string,
  input: MoveAudioCompBoundaryInput,
): AudioTakeCompMutationResult;
export function moveAudioCompBoundary(
  project: Project,
  folderId: string,
  leftSegmentId: string,
  offsetBeats: number,
): AudioTakeCompMutationResult;
export function moveAudioCompBoundary(
  project: Project,
  folderId: string,
  leftSegmentIdOrInput: string | MoveAudioCompBoundaryInput,
  suppliedOffsetBeats?: number,
): AudioTakeCompMutationResult {
  return runMutation(project, () => {
    const folder = locateFolder(project, folderId);
    if (!('takes' in folder)) return folder;
    const input = parseBoundaryInput(leftSegmentIdOrInput, suppliedOffsetBeats);
    const leftIndex = folder.compSegments.findIndex(
      (segment) => segment.id === input.leftSegmentId,
    );
    const left = folder.compSegments[leftIndex];
    const right = folder.compSegments[leftIndex + 1];
    if (left === undefined || right === undefined) {
      return failure('boundary-not-found', 'Choose a shared boundary between two comp segments.');
    }
    const currentBoundary = right.offsetBeats;
    if (sameBeat(input.offsetBeats, currentBoundary)) {
      return success(project, folderId, false);
    }
    const rightEnd = right.offsetBeats + right.lengthBeats;
    const leftTake = folder.takes.find((take) => take.id === left.takeId);
    const rightTake = folder.takes.find((take) => take.id === right.takeId);
    if (
      !Number.isFinite(input.offsetBeats)
      || input.offsetBeats - left.offsetBeats < MIN_EVENT_DURATION_BEATS
      || rightEnd - input.offsetBeats < MIN_EVENT_DURATION_BEATS
      || leftTake === undefined
      || rightTake === undefined
      || input.offsetBeats > leftTake.offsetBeats + leftTake.lengthBeats
      || input.offsetBeats < rightTake.offsetBeats
    ) {
      return failure(
        'invalid-range',
        'The boundary must leave two audible ranges covered by their selected takes.',
      );
    }
    const compSegments = folder.compSegments.map((segment, index) => {
      if (index === leftIndex) {
        return { ...segment, lengthBeats: input.offsetBeats - segment.offsetBeats };
      }
      if (index === leftIndex + 1) {
        return {
          ...segment,
          offsetBeats: input.offsetBeats,
          lengthBeats: rightEnd - input.offsetBeats,
        };
      }
      return segment;
    });
    const candidate: Project = {
      ...project,
      audioTakeFolders: project.audioTakeFolders.map((item) => (
        item.id === folderId ? { ...item, compSegments } : item
      )),
    };
    return success(candidate, folderId, true);
  });
}

function assetIsReferenced(project: Project, assetId: string): boolean {
  return project.tracks.some((track) => track.clips.some(
    (clip) => clip.type === 'audio' && clip.audioAssetId === assetId,
  )) || project.audioTakeFolders.some((folder) => folder.takes.some(
    (take) => take.audioAssetId === assetId,
  ));
}

export function deleteUnusedAudioTake(
  project: Project,
  folderId: string,
  takeId: string,
): AudioTakeCompMutationResult {
  return runMutation(project, () => {
    const folder = locateFolder(project, folderId);
    if (!('takes' in folder)) return folder;
    const take = folder.takes.find((candidate) => candidate.id === takeId);
    if (take === undefined) return failure('take-not-found', `Audio take not found: ${takeId}`);
    if (folder.compSegments.some((segment) => segment.takeId === takeId)) {
      return failure('take-in-use', 'A take used by the current comp cannot be deleted.');
    }
    if (folder.takes.length <= 2) {
      return failure('minimum-takes', 'An Audio take folder must retain at least two takes.');
    }
    const audioTakeFolders = project.audioTakeFolders.map((item) => (
      item.id === folderId
        ? { ...item, takes: item.takes.filter((candidate) => candidate.id !== takeId) }
        : item
    ));
    const withoutTake: Project = { ...project, audioTakeFolders };
    const audioAssets = assetIsReferenced(withoutTake, take.audioAssetId)
      ? project.audioAssets
      : project.audioAssets.filter((asset) => asset.id !== take.audioAssetId);
    return success({ ...withoutTake, audioAssets }, folderId, true);
  });
}

/** Alias with the shorter domain name; deletion still rejects used takes. */
export const deleteAudioTake = deleteUnusedAudioTake;
