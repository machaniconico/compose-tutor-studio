// Pure, immutable Audio Track / Clip mutations. Binary ownership stays outside
// the project aggregate; this module only adopts already-verified ready asset
// metadata and keeps every timeline/source edit codec-valid and atomic.

import type { Clock } from './clock';
import { nowIso, systemClock } from './clock';
import { makeId } from './ids';
import { MAX_CLIPS_PER_TRACK, MIN_EVENT_DURATION_BEATS } from './limits';
import {
  addAudioWarpTimingPoint,
  audioWarpsEqual,
  beatToSourceFrame,
  cropAudioWarp,
  mergeAudioPitchRegions,
  moveAudioWarpTimingPoint,
  partitionAudioWarp,
  removeAudioWarpTimingPoint,
  replaceAudioPitchRegions,
  resetAudioPitchRegions,
  resetAudioWarpTimingPoints,
  retargetAudioPitchRegion,
  splitAudioPitchRegion,
  type AudioWarpEditResult,
} from './audio-warp';
import {
  MAX_PROJECT_STRING_LENGTH,
  encodeProjectJson,
  type ProjectCodecIssue,
} from './project-codec';
import {
  barToBeatAt,
  beatToBarPosition,
  beatToSecondsAt,
  compileMusicalTime,
  secondsToBeatAt,
} from './time';
import type {
  AudioClip,
  AudioPitchRegion,
  AudioWarp,
  AudioWarpMarker,
  Clip,
  Project,
  ReadyAudioAsset,
  Track,
} from './types';
import {
  MAX_AUDIO_ASSETS,
  MAX_PROJECT_LENGTH_BARS,
  MAX_PROJECT_TIMELINE_BEATS,
  MAX_PROJECT_TRACKS,
} from './validation';

export const MAX_AUDIO_TRACK_NAME_CODE_POINTS = 128;

export type AudioClipEntityIdKind = 'track' | 'clip';
export type AudioClipIdFactory = (kind: AudioClipEntityIdKind) => string;

export type AudioClipMutationErrorCode =
  | 'project-not-adoptable'
  | 'audio-asset-not-ready'
  | 'audio-asset-not-found'
  | 'audio-asset-limit'
  | 'track-limit'
  | 'track-not-found'
  | 'clip-limit'
  | 'clip-not-found'
  | 'unsupported-track-type'
  | 'unsupported-clip-type'
  | 'invalid-track-name'
  | 'invalid-position'
  | 'invalid-source-range'
  | 'invalid-gain'
  | 'invalid-fades'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'project-length-limit'
  | 'looped-left-trim-unsupported'
  | 'looped-split-unsupported'
  | 'edited-loop-unsupported'
  | 'invalid-audio-warp'
  | 'unexpected';

export type AudioClipMutationError = Readonly<{
  code: AudioClipMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type AudioClipMutationFailure = Readonly<{
  ok: false;
  error: AudioClipMutationError;
}>;

export type AudioClipMutationSuccess = Readonly<{
  ok: true;
  project: Project;
  changed: boolean;
  trackId: string;
  clipId: string;
}>;

export type AudioClipMutationResult =
  | AudioClipMutationSuccess
  | AudioClipMutationFailure;

export type CreateAudioTrackClipResult =
  | Readonly<AudioClipMutationSuccess & { audioAssetId: string }>
  | AudioClipMutationFailure;

export type SplitAudioClipResult =
  | Readonly<AudioClipMutationSuccess & { rightClipId: string }>
  | AudioClipMutationFailure;

export type CreateAudioTrackClipOptions = Readonly<{
  startBeat?: number;
  sourceStartFrame?: number;
  sourceFrameCount?: number;
  trackName?: string;
  loop?: boolean;
  gainDb?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  idFactory?: AudioClipIdFactory;
}>;

export type AppendAudioTrackClipOptions = Readonly<{
  startBeat?: number;
  sourceStartFrame?: number;
  sourceFrameCount?: number;
  loop?: boolean;
  gainDb?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  idFactory?: AudioClipIdFactory;
}>;

export type DuplicateAudioClipOptions = Readonly<{
  startBeat: number;
  id?: string;
  idFactory?: AudioClipIdFactory;
}>;

export type SplitAudioClipOptions = Readonly<{
  splitBeat: number;
  rightClipId?: string;
  idFactory?: AudioClipIdFactory;
}>;

export type AudioClipFadeInput = Readonly<{
  fadeInFrames: number;
  fadeOutFrames: number;
}>;

type AudioClipContext = Readonly<{
  track: Track;
  clip: AudioClip;
}>;

type AudioMutationContext = Readonly<AudioClipContext & {
  asset: ReadyAudioAsset;
}>;

type ProjectExtensionResult =
  | Readonly<{ ok: true; project: Project }>
  | AudioClipMutationFailure;

type AllocatedId =
  | Readonly<{ ok: true; id: string }>
  | AudioClipMutationFailure;

type InitialSourceRange = Readonly<{
  sourceStartFrame: number;
  sourceFrameCount: number;
}>;

type InitialSourceRangeResult =
  | Readonly<{ ok: true; range: InitialSourceRange }>
  | AudioClipMutationFailure;

const defaultIdFactory: AudioClipIdFactory = (kind) => makeId(kind);
const BEAT_ROUNDING_FACTOR = 1_000_000_000_000;

function cloneAudioWarp(clip: AudioClip): AudioClip['audioWarp'] {
  return clip.audioWarp === undefined
    ? undefined
    : {
        ...clip.audioWarp,
        markers: clip.audioWarp.markers.map((marker) => ({ ...marker })),
        pitchRegions: clip.audioWarp.pitchRegions.map((region) => ({ ...region })),
      };
}

function cropWarpToClip(
  clip: AudioClip,
  sourceStartFrame: number,
  sourceEndFrame: number,
  lengthBeats: number,
): AudioClip['audioWarp'] {
  if (clip.audioWarp === undefined) return undefined;
  const cropped = cropAudioWarp(clip.audioWarp, sourceStartFrame, sourceEndFrame);
  return {
    ...cropped,
    markers: cropped.markers.map((marker, index) =>
      index === cropped.markers.length - 1
        ? { ...marker, targetBeatOffset: lengthBeats }
        : marker,
    ),
  };
}

function failure(
  code: AudioClipMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): AudioClipMutationFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(issues !== undefined ? { issues } : {}),
    },
  };
}

function codecFailure(project: Project): AudioClipMutationFailure | null {
  const encoded = encodeProjectJson(project);
  if (encoded.ok) return null;
  const first = encoded.error.issues[0];
  const detail = first ? ` ${first.path}: ${first.message}` : '';
  return failure(
    'project-not-adoptable',
    `Project codec rejected the audio change.${detail}`,
    encoded.error.issues,
  );
}

/** Validate both sides and turn injected clock/id failures into a no-throw result. */
function runMutation<Success extends AudioClipMutationSuccess>(
  project: Project,
  build: () => Success | AudioClipMutationFailure,
): Success | AudioClipMutationFailure {
  try {
    const inputFailure = codecFailure(project);
    if (inputFailure) return inputFailure;
    const result = build();
    if (!result.ok || !result.changed) return result;
    return codecFailure(result.project) ?? result;
  } catch {
    return failure('unexpected', 'The audio change could not be completed safely.');
  }
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function normalizedTrackName(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || codePoints(trimmed).length > MAX_AUDIO_TRACK_NAME_CODE_POINTS
    || trimmed.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return null;
  }
  return trimmed;
}

function defaultTrackName(originalName: string): string {
  const trimmed = originalName.trim();
  const withoutExtension = trimmed.replace(/\.[^.]+$/u, '').trim();
  const candidate = withoutExtension || 'Audio';
  return codePoints(candidate).slice(0, MAX_AUDIO_TRACK_NAME_CODE_POINTS).join('');
}

function allEntityIds(project: Project): Set<string> {
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
  kind: AudioClipEntityIdKind,
  idFactory: AudioClipIdFactory,
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

function roundedComputedBeat(value: number): number {
  return Math.round(value * BEAT_ROUNDING_FACTOR) / BEAT_ROUNDING_FACTOR;
}

function initialSourceRange(
  asset: ReadyAudioAsset,
  options: Readonly<{
    sourceStartFrame?: number;
    sourceFrameCount?: number;
  }>,
): InitialSourceRangeResult {
  const sourceStartFrame = options.sourceStartFrame ?? 0;
  const sourceFrameCount = options.sourceFrameCount
    ?? asset.frameCount - sourceStartFrame;
  if (
    !Number.isSafeInteger(sourceStartFrame)
    || sourceStartFrame < 0
    || sourceStartFrame >= asset.frameCount
    || !Number.isSafeInteger(sourceFrameCount)
    || sourceFrameCount <= 0
    || sourceFrameCount > asset.frameCount - sourceStartFrame
  ) {
    return failure(
      'invalid-source-range',
      'Audio Clip source frames must select a non-empty range within the ready asset.',
    );
  }
  return {
    ok: true,
    range: { sourceStartFrame, sourceFrameCount },
  };
}

function naturalWindowLengthBeats(
  project: Project,
  startBeat: number,
  frameCount: number,
  sampleRate: number,
): number {
  const musicalTime = compileMusicalTime(project);
  const startSeconds = beatToSecondsAt(musicalTime, startBeat);
  const endBeat = secondsToBeatAt(musicalTime, startSeconds + frameCount / sampleRate);
  return Math.max(
    MIN_EVENT_DURATION_BEATS,
    roundedComputedBeat(endBeat - startBeat),
  );
}

function extendProjectToInclude(project: Project, endBeat: number): ProjectExtensionResult {
  if (!Number.isFinite(endBeat) || endBeat <= 0) {
    return failure('invalid-position', 'Audio clips require a finite positive timeline end.');
  }
  if (endBeat <= project.lengthBeats) return { ok: true, project };
  if (endBeat > MAX_PROJECT_TIMELINE_BEATS) {
    return failure(
      'project-length-limit',
      `The audio clip would exceed ${MAX_PROJECT_TIMELINE_BEATS} timeline beats.`,
    );
  }

  const musicalTime = compileMusicalTime(project);
  const position = beatToBarPosition(musicalTime, endBeat);
  let endBar = position.bar;
  let boundaryBeat = barToBeatAt(musicalTime, endBar);
  if (boundaryBeat < endBeat) {
    endBar += 1;
    boundaryBeat = barToBeatAt(musicalTime, endBar);
  }
  if (
    !Number.isSafeInteger(endBar)
    || endBar < 1
    || endBar > MAX_PROJECT_LENGTH_BARS
    || !Number.isFinite(boundaryBeat)
    || boundaryBeat < endBeat
    || boundaryBeat > MAX_PROJECT_TIMELINE_BEATS
  ) {
    return failure(
      'project-length-limit',
      `The audio clip would exceed the ${MAX_PROJECT_LENGTH_BARS}-bar project limit.`,
    );
  }
  return {
    ok: true,
    project: {
      ...project,
      lengthBars: endBar,
      lengthBeats: boundaryBeat,
    },
  };
}

function findAudioClipContext(
  project: Project,
  clipId: string,
): AudioClipContext | AudioClipMutationFailure {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (!clip) continue;
    if (clip.type !== 'audio') {
      return failure('unsupported-clip-type', 'The selected clip is not an Audio Clip.');
    }
    return { track, clip: clip as AudioClip };
  }
  return failure('clip-not-found', `Audio Clip not found: ${clipId}`);
}

function findAudioContext(
  project: Project,
  clipId: string,
): AudioMutationContext | AudioClipMutationFailure {
  const located = findAudioClipContext(project, clipId);
  if (!('clip' in located)) return located;
  if (located.track.type !== 'audio') {
    return failure('unsupported-clip-type', 'Ready Audio Clips require an Audio Track.');
  }
  const { track, clip } = located;
  const asset = project.audioAssets.find((candidate) => candidate.id === clip.audioAssetId);
  if (!asset) {
    return failure('audio-asset-not-found', 'The Audio Clip references a missing asset.');
  }
  if (asset.availability !== 'ready') {
    return failure('audio-asset-not-ready', 'The Audio Clip asset is unresolved.');
  }
  return { track, clip: clip as AudioClip, asset };
}

function replaceClip(
  project: Project,
  trackId: string,
  clipId: string,
  replacement: AudioClip,
  clock: Clock,
): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === trackId
        ? {
            ...track,
            clips: track.clips.map((clip) => (clip.id === clipId ? replacement : clip)),
          }
        : track,
    ),
    updatedAt: nowIso(clock),
  };
}

function success(
  project: Project,
  context: Pick<AudioMutationContext, 'track' | 'clip'>,
  changed: boolean,
): AudioClipMutationSuccess {
  return {
    ok: true,
    project,
    changed,
    trackId: context.track.id,
    clipId: context.clip.id,
  };
}

function frameDeltaBetweenBeats(
  project: Project,
  fromBeat: number,
  toBeat: number,
  sampleRate: number,
): number | null {
  const musicalTime = compileMusicalTime(project);
  const frames = Math.round(
    (beatToSecondsAt(musicalTime, toBeat) - beatToSecondsAt(musicalTime, fromBeat))
      * sampleRate,
  );
  return Number.isSafeInteger(frames) ? frames : null;
}

function fadeFrameLimit(
  project: Project,
  startBeat: number,
  lengthBeats: number,
  sampleRate: number,
  sourceFrameCount: number,
): number | null {
  const timelineFrames = frameDeltaBetweenBeats(
    project,
    startBeat,
    startBeat + lengthBeats,
    sampleRate,
  );
  if (timelineFrames === null || timelineFrames <= 0) return null;
  return Math.min(sourceFrameCount, timelineFrames);
}

function clampFadesAfterLeftTrim(
  fadeInFrames: number,
  fadeOutFrames: number,
  sourceFrameCount: number,
): AudioClipFadeInput {
  const fadeOut = Math.min(fadeOutFrames, sourceFrameCount);
  const fadeIn = Math.min(fadeInFrames, sourceFrameCount - fadeOut);
  return { fadeInFrames: fadeIn, fadeOutFrames: fadeOut };
}

function clampFadesAfterRightTrim(
  fadeInFrames: number,
  fadeOutFrames: number,
  sourceFrameCount: number,
): AudioClipFadeInput {
  const fadeIn = Math.min(fadeInFrames, sourceFrameCount);
  const fadeOut = Math.min(fadeOutFrames, sourceFrameCount - fadeIn);
  return { fadeInFrames: fadeIn, fadeOutFrames: fadeOut };
}

/**
 * Atomically adopt one verified asset and create its Audio Track / Clip.
 * The initial beat window is the selected source duration projected through
 * the tempo map at rate 1.0; later edits keep this timeline window independent.
 */
export function createAudioTrackClip(
  project: Project,
  asset: ReadyAudioAsset,
  options: CreateAudioTrackClipOptions = {},
  clock: Clock = systemClock,
): CreateAudioTrackClipResult {
  return runMutation(project, () => {
    if (asset.availability !== 'ready') {
      return failure('audio-asset-not-ready', 'Only ready AudioAsset metadata can be adopted.');
    }
    if (project.audioAssets.length >= MAX_AUDIO_ASSETS) {
      return failure('audio-asset-limit', `A project can contain at most ${MAX_AUDIO_ASSETS} audio assets.`);
    }
    if (project.tracks.length >= MAX_PROJECT_TRACKS) {
      return failure('track-limit', `A project can contain at most ${MAX_PROJECT_TRACKS} tracks.`);
    }
    const reserved = allEntityIds(project);
    if (
      typeof asset.id !== 'string'
      || asset.id.length === 0
      || asset.id.length > MAX_PROJECT_STRING_LENGTH
    ) {
      return failure('project-not-adoptable', 'The ready AudioAsset requires a bounded non-empty id.');
    }
    if (reserved.has(asset.id)) {
      return failure('duplicate-id', `The AudioAsset id already exists: ${asset.id}`);
    }
    if (
      !Number.isSafeInteger(asset.frameCount)
      || asset.frameCount <= 0
      || !Number.isSafeInteger(asset.sampleRate)
      || asset.sampleRate <= 0
    ) {
      return failure('audio-asset-not-ready', 'The ready AudioAsset requires a valid frame count and sample rate.');
    }
    reserved.add(asset.id);

    const requestedName = options.trackName ?? defaultTrackName(asset.originalName);
    const trackName = normalizedTrackName(requestedName);
    if (trackName === null) {
      return failure(
        'invalid-track-name',
        `Audio Track names must contain text and be at most ${MAX_AUDIO_TRACK_NAME_CODE_POINTS} Unicode characters.`,
      );
    }
    const startBeat = options.startBeat ?? 0;
    if (!Number.isFinite(startBeat) || startBeat < 0) {
      return failure('invalid-position', 'Audio Clip startBeat must be a non-negative finite number.');
    }
    const sourceRange = initialSourceRange(asset, options);
    if (!sourceRange.ok) return sourceRange;
    const gainDb = options.gainDb ?? 0;
    if (!Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
      return failure('invalid-gain', 'Audio Clip gain must be between -96 dB and 24 dB.');
    }
    const fadeInFrames = options.fadeInFrames ?? 0;
    const fadeOutFrames = options.fadeOutFrames ?? 0;
    if (
      !Number.isSafeInteger(fadeInFrames)
      || fadeInFrames < 0
      || !Number.isSafeInteger(fadeOutFrames)
      || fadeOutFrames < 0
      || fadeInFrames + fadeOutFrames > sourceRange.range.sourceFrameCount
    ) {
      return failure(
        'invalid-fades',
        'Audio Clip fades must be non-negative frames within the source and timeline window.',
      );
    }

    const idFactory = options.idFactory ?? defaultIdFactory;
    const allocatedTrack = allocateId('track', idFactory, reserved);
    if (!allocatedTrack.ok) return allocatedTrack;
    const allocatedClip = allocateId('clip', idFactory, reserved);
    if (!allocatedClip.ok) return allocatedClip;

    const lengthBeats = naturalWindowLengthBeats(
      project,
      startBeat,
      sourceRange.range.sourceFrameCount,
      asset.sampleRate,
    );
    const extension = extendProjectToInclude(project, startBeat + lengthBeats);
    if (!extension.ok) return extension;

    const clip: AudioClip = {
      id: allocatedClip.id,
      trackId: allocatedTrack.id,
      type: 'audio',
      startBeat,
      lengthBeats,
      loop: options.loop ?? false,
      audioAssetId: asset.id,
      sourceStartFrame: sourceRange.range.sourceStartFrame,
      sourceFrameCount: sourceRange.range.sourceFrameCount,
      fadeInFrames,
      fadeOutFrames,
      gainDb,
    };
    const track: Track = {
      id: allocatedTrack.id,
      name: trackName,
      type: 'audio',
      role: 'general',
      clips: [clip],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
    };
    const masterIndex = extension.project.tracks.findIndex(
      (candidate) => candidate.type === 'master',
    );
    const insertionIndex = masterIndex === -1
      ? extension.project.tracks.length
      : masterIndex;
    const candidate: Project = {
      ...extension.project,
      audioAssets: [...extension.project.audioAssets, asset],
      tracks: [
        ...extension.project.tracks.slice(0, insertionIndex),
        track,
        ...extension.project.tracks.slice(insertionIndex),
      ],
      audioRouting: {
        ...extension.project.audioRouting,
        outputs: [
          ...extension.project.audioRouting.outputs,
          { sourceTrackId: track.id, destination: { type: 'master' } },
        ],
      },
      updatedAt: nowIso(clock),
    };
    return {
      ok: true,
      project: candidate,
      changed: true,
      trackId: track.id,
      clipId: clip.id,
      audioAssetId: asset.id,
    };
  });
}

/**
 * Atomically adopt one verified asset and append its selected natural-rate
 * source window to an existing Audio Track. The target Track keeps its
 * mixer/effect configuration, and no Track or routing node is created.
 */
export function appendAudioTrackClip(
  project: Project,
  trackId: string,
  asset: ReadyAudioAsset,
  options: AppendAudioTrackClipOptions = {},
  clock: Clock = systemClock,
): CreateAudioTrackClipResult {
  return runMutation(project, () => {
    const target = project.tracks.find((track) => track.id === trackId);
    if (!target) {
      return failure('track-not-found', `Audio Track not found: ${trackId}`);
    }
    if (target.type !== 'audio') {
      return failure('unsupported-track-type', 'Recorded Audio Clips require an Audio Track.');
    }
    if (target.clips.length >= MAX_CLIPS_PER_TRACK) {
      return failure(
        'clip-limit',
        `An Audio Track can contain at most ${MAX_CLIPS_PER_TRACK} clips.`,
      );
    }
    if (asset.availability !== 'ready') {
      return failure('audio-asset-not-ready', 'Only ready AudioAsset metadata can be adopted.');
    }
    if (project.audioAssets.length >= MAX_AUDIO_ASSETS) {
      return failure('audio-asset-limit', `A project can contain at most ${MAX_AUDIO_ASSETS} audio assets.`);
    }

    const reserved = allEntityIds(project);
    if (
      typeof asset.id !== 'string'
      || asset.id.length === 0
      || asset.id.length > MAX_PROJECT_STRING_LENGTH
    ) {
      return failure('project-not-adoptable', 'The ready AudioAsset requires a bounded non-empty id.');
    }
    if (reserved.has(asset.id)) {
      return failure('duplicate-id', `The AudioAsset id already exists: ${asset.id}`);
    }
    if (
      !Number.isSafeInteger(asset.frameCount)
      || asset.frameCount <= 0
      || !Number.isSafeInteger(asset.sampleRate)
      || asset.sampleRate <= 0
    ) {
      return failure('audio-asset-not-ready', 'The ready AudioAsset requires a valid frame count and sample rate.');
    }
    reserved.add(asset.id);

    const startBeat = options.startBeat ?? 0;
    if (!Number.isFinite(startBeat) || startBeat < 0) {
      return failure('invalid-position', 'Audio Clip startBeat must be a non-negative finite number.');
    }
    const sourceRange = initialSourceRange(asset, options);
    if (!sourceRange.ok) return sourceRange;
    const gainDb = options.gainDb ?? 0;
    if (!Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
      return failure('invalid-gain', 'Audio Clip gain must be between -96 dB and 24 dB.');
    }
    const fadeInFrames = options.fadeInFrames ?? 0;
    const fadeOutFrames = options.fadeOutFrames ?? 0;
    if (
      !Number.isSafeInteger(fadeInFrames)
      || fadeInFrames < 0
      || !Number.isSafeInteger(fadeOutFrames)
      || fadeOutFrames < 0
      || fadeInFrames + fadeOutFrames > sourceRange.range.sourceFrameCount
    ) {
      return failure(
        'invalid-fades',
        'Audio Clip fades must be non-negative frames within the source and timeline window.',
      );
    }

    const allocatedClip = allocateId('clip', options.idFactory ?? defaultIdFactory, reserved);
    if (!allocatedClip.ok) return allocatedClip;
    const lengthBeats = naturalWindowLengthBeats(
      project,
      startBeat,
      sourceRange.range.sourceFrameCount,
      asset.sampleRate,
    );
    const extension = extendProjectToInclude(project, startBeat + lengthBeats);
    if (!extension.ok) return extension;

    const clip: AudioClip = {
      id: allocatedClip.id,
      trackId: target.id,
      type: 'audio',
      startBeat,
      lengthBeats,
      loop: options.loop ?? false,
      audioAssetId: asset.id,
      sourceStartFrame: sourceRange.range.sourceStartFrame,
      sourceFrameCount: sourceRange.range.sourceFrameCount,
      fadeInFrames,
      fadeOutFrames,
      gainDb,
    };
    const candidate: Project = {
      ...extension.project,
      audioAssets: [...extension.project.audioAssets, asset],
      tracks: extension.project.tracks.map((track) =>
        track.id === target.id
          ? { ...track, clips: [...track.clips, clip] }
          : track,
      ),
      updatedAt: nowIso(clock),
    };
    return {
      ok: true,
      project: candidate,
      changed: true,
      trackId: target.id,
      clipId: clip.id,
      audioAssetId: asset.id,
    };
  });
}

/** Move the independent timeline window without changing rate or source range. */
export function moveAudioClip(
  project: Project,
  clipId: string,
  startBeat: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (!Number.isFinite(startBeat) || startBeat < 0) {
      return failure('invalid-position', 'Audio Clip startBeat must be a non-negative finite number.');
    }
    if (startBeat === context.clip.startBeat) return success(project, context, false);
    const extension = extendProjectToInclude(project, startBeat + context.clip.lengthBeats);
    if (!extension.ok) return extension;
    const moved: AudioClip = {
      ...context.clip,
      startBeat,
    };
    return success(
      replaceClip(extension.project, context.track.id, clipId, moved, clock),
      { ...context, clip: moved },
      true,
    );
  });
}

/**
 * Move the left outer edge while holding the right edge fixed. The source head
 * advances/restores by the exact tempo-map elapsed time at rate 1.0.
 */
export function trimAudioClipLeft(
  project: Project,
  clipId: string,
  startBeat: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (context.clip.loop) {
      return failure(
        'looped-left-trim-unsupported',
        'A looped Audio Clip cannot move its left edge without a persisted loop phase.',
      );
    }
    const oldEndBeat = context.clip.startBeat + context.clip.lengthBeats;
    if (
      !Number.isFinite(startBeat)
      || startBeat < 0
      || startBeat > oldEndBeat - MIN_EVENT_DURATION_BEATS
    ) {
      return failure('invalid-position', 'The left trim must leave a positive Audio Clip window.');
    }
    if (startBeat === context.clip.startBeat) return success(project, context, false);
    const timingWarp = context.clip.audioWarp?.timingEnabled === true
      ? context.clip.audioWarp
      : undefined;
    const frameDelta = timingWarp === undefined
      ? frameDeltaBetweenBeats(
          project,
          context.clip.startBeat,
          startBeat,
          context.asset.sampleRate,
        )
      : Math.round(
          beatToSourceFrame(
            timingWarp,
            startBeat - context.clip.startBeat,
          ) - context.clip.sourceStartFrame,
        );
    if (frameDelta === null || frameDelta === 0) {
      return failure('invalid-source-range', 'The left trim cannot be represented in source frames.');
    }
    const sourceStartFrame = context.clip.sourceStartFrame + frameDelta;
    const sourceFrameCount = context.clip.sourceFrameCount - frameDelta;
    if (
      !Number.isSafeInteger(sourceStartFrame)
      || sourceStartFrame < 0
      || !Number.isSafeInteger(sourceFrameCount)
      || sourceFrameCount <= 0
      || sourceStartFrame + sourceFrameCount > context.asset.frameCount
    ) {
      return failure('invalid-source-range', 'The left trim would leave the AudioAsset source range.');
    }
    const fadeLimit = fadeFrameLimit(
      project,
      startBeat,
      oldEndBeat - startBeat,
      context.asset.sampleRate,
      sourceFrameCount,
    );
    if (fadeLimit === null) {
      return failure('invalid-fades', 'The left-trimmed Audio Clip fade window is not representable.');
    }
    const fades = clampFadesAfterLeftTrim(
      context.clip.fadeInFrames,
      context.clip.fadeOutFrames,
      fadeLimit,
    );
    const trimmed: AudioClip = {
      ...context.clip,
      startBeat,
      lengthBeats: oldEndBeat - startBeat,
      sourceStartFrame,
      sourceFrameCount,
      ...fades,
      ...(context.clip.audioWarp !== undefined
        ? {
            audioWarp: cropWarpToClip(
              context.clip,
              sourceStartFrame,
              sourceStartFrame + sourceFrameCount,
              oldEndBeat - startBeat,
            ),
          }
        : {}),
    };
    return success(
      replaceClip(project, context.track.id, clipId, trimmed, clock),
      { ...context, clip: trimmed },
      true,
    );
  });
}

/**
 * Move the right outer edge. A non-looping clip reveals/hides source frames at
 * rate 1.0; a looping clip only changes the outer repetition window.
 */
export function trimAudioClipRight(
  project: Project,
  clipId: string,
  endBeat: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (
      !Number.isFinite(endBeat)
      || endBeat < context.clip.startBeat + MIN_EVENT_DURATION_BEATS
    ) {
      return failure('invalid-position', 'The right trim must leave a positive Audio Clip window.');
    }
    const oldEndBeat = context.clip.startBeat + context.clip.lengthBeats;
    if (endBeat === oldEndBeat) return success(project, context, false);
    const extension = extendProjectToInclude(project, endBeat);
    if (!extension.ok) return extension;
    let sourceFrameCount = context.clip.sourceFrameCount;
    let fades: AudioClipFadeInput = {
      fadeInFrames: context.clip.fadeInFrames,
      fadeOutFrames: context.clip.fadeOutFrames,
    };
    if (!context.clip.loop) {
      const oldWindowFrameCount = frameDeltaBetweenBeats(
        project,
        context.clip.startBeat,
        oldEndBeat,
        context.asset.sampleRate,
      );
      if (context.clip.audioWarp !== undefined && endBeat > oldEndBeat) {
        return failure(
          'invalid-source-range',
          'An edited Audio Clip cannot reveal source beyond its canonical timing endpoints.',
        );
      }
      const timingWarp = context.clip.audioWarp?.timingEnabled === true
        ? context.clip.audioWarp
        : undefined;
      const windowFrameCount = timingWarp === undefined
        ? frameDeltaBetweenBeats(
            project,
            context.clip.startBeat,
            endBeat,
            context.asset.sampleRate,
          )
        : Math.round(beatToSourceFrame(
            timingWarp,
            endBeat - context.clip.startBeat,
          ) - context.clip.sourceStartFrame);
      if (
        oldWindowFrameCount === null
        || windowFrameCount === null
        || windowFrameCount <= 0
        || windowFrameCount === context.clip.sourceFrameCount
      ) {
        return failure('invalid-source-range', 'The right trim cannot be represented in source frames.');
      }
      const availableSourceFrames = context.asset.frameCount - context.clip.sourceStartFrame;
      sourceFrameCount = endBeat < oldEndBeat
        ? Math.min(context.clip.sourceFrameCount, windowFrameCount)
        : Math.max(
            context.clip.sourceFrameCount,
            Math.min(availableSourceFrames, windowFrameCount),
          );
      if (
        !Number.isSafeInteger(sourceFrameCount)
        || sourceFrameCount <= 0
        || context.clip.sourceStartFrame + sourceFrameCount > context.asset.frameCount
      ) {
        return failure('invalid-source-range', 'The right trim would leave the AudioAsset source range.');
      }
      fades = clampFadesAfterRightTrim(
        context.clip.fadeInFrames,
        context.clip.fadeOutFrames,
        sourceFrameCount,
      );
    }
    const fadeLimit = fadeFrameLimit(
      project,
      context.clip.startBeat,
      endBeat - context.clip.startBeat,
      context.asset.sampleRate,
      sourceFrameCount,
    );
    if (fadeLimit === null) {
      return failure('invalid-fades', 'The right-trimmed Audio Clip fade window is not representable.');
    }
    fades = clampFadesAfterRightTrim(
      fades.fadeInFrames,
      fades.fadeOutFrames,
      fadeLimit,
    );
    const trimmed: AudioClip = {
      ...context.clip,
      lengthBeats: endBeat - context.clip.startBeat,
      sourceFrameCount,
      ...fades,
      ...(context.clip.audioWarp !== undefined
        ? {
            audioWarp: cropWarpToClip(
              context.clip,
              context.clip.sourceStartFrame,
              context.clip.sourceStartFrame + sourceFrameCount,
              endBeat - context.clip.startBeat,
            ),
          }
        : {}),
    };
    return success(
      replaceClip(extension.project, context.track.id, clipId, trimmed, clock),
      { ...context, clip: trimmed },
      true,
    );
  });
}

export function setAudioClipGain(
  project: Project,
  clipId: string,
  gainDb: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (!Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
      return failure('invalid-gain', 'Audio Clip gain must be between -96 dB and 24 dB.');
    }
    if (gainDb === context.clip.gainDb) return success(project, context, false);
    const changed = { ...context.clip, gainDb };
    return success(
      replaceClip(project, context.track.id, clipId, changed, clock),
      { ...context, clip: changed },
      true,
    );
  });
}

export function setAudioClipFades(
  project: Project,
  clipId: string,
  fades: AudioClipFadeInput,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    const fadeLimit = fadeFrameLimit(
      project,
      context.clip.startBeat,
      context.clip.lengthBeats,
      context.asset.sampleRate,
      context.clip.sourceFrameCount,
    );
    if (
      fadeLimit === null
      || !Number.isSafeInteger(fades.fadeInFrames)
      || fades.fadeInFrames < 0
      || !Number.isSafeInteger(fades.fadeOutFrames)
      || fades.fadeOutFrames < 0
      || fades.fadeInFrames + fades.fadeOutFrames > fadeLimit
    ) {
      return failure(
        'invalid-fades',
        'Audio Clip fades must be non-negative frames within the source and timeline window.',
      );
    }
    if (
      fades.fadeInFrames === context.clip.fadeInFrames
      && fades.fadeOutFrames === context.clip.fadeOutFrames
    ) {
      return success(project, context, false);
    }
    const changed = { ...context.clip, ...fades };
    return success(
      replaceClip(project, context.track.id, clipId, changed, clock),
      { ...context, clip: changed },
      true,
    );
  });
}

export function setAudioClipLoop(
  project: Project,
  clipId: string,
  loop: boolean,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (loop === context.clip.loop) return success(project, context, false);
    if (loop && context.clip.audioWarp !== undefined) {
      return failure(
        'edited-loop-unsupported',
        'Reset Elastic Audio edits before enabling loop playback for this Audio Clip.',
      );
    }
    const changed = { ...context.clip, loop };
    return success(
      replaceClip(project, context.track.id, clipId, changed, clock),
      { ...context, clip: changed },
      true,
    );
  });
}

function updateAudioClipWarp(
  project: Project,
  clipId: string,
  edit: (warp: AudioWarp) => AudioWarpEditResult,
  clock: Clock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (context.clip.audioWarp === undefined) {
      return failure('invalid-audio-warp', 'This Audio Clip does not have Elastic Audio edits.');
    }
    const result = edit(context.clip.audioWarp);
    if (!result.ok) return failure('invalid-audio-warp', result.error.message);
    if (!result.changed) return success(project, context, false);
    const clip: AudioClip = { ...context.clip, audioWarp: result.audioWarp };
    return success(
      replaceClip(project, context.track.id, clipId, clip, clock),
      { ...context, clip },
      true,
    );
  });
}

/** Adopt or reset the complete canonical edit in one codec-validated mutation. */
export function setAudioClipWarp(
  project: Project,
  clipId: string,
  audioWarp: AudioWarp | undefined,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (
      (audioWarp === undefined && context.clip.audioWarp === undefined)
      || (audioWarp !== undefined
        && context.clip.audioWarp !== undefined
        && audioWarpsEqual(audioWarp, context.clip.audioWarp))
    ) {
      return success(project, context, false);
    }
    if (audioWarp !== undefined && context.clip.loop) {
      return failure('invalid-audio-warp', 'Elastic Audio edits require a non-looping Audio Clip.');
    }
    const { audioWarp: _oldWarp, ...withoutWarp } = context.clip;
    const clip: AudioClip = audioWarp === undefined
      ? withoutWarp
      : {
          ...withoutWarp,
          audioWarp: {
            ...audioWarp,
            markers: audioWarp.markers.map((marker) => ({ ...marker })),
            pitchRegions: audioWarp.pitchRegions.map((region) => ({ ...region })),
          },
        };
    return success(
      replaceClip(project, context.track.id, clipId, clip, clock),
      { ...context, clip },
      true,
    );
  });
}

export function addAudioClipTimingPoint(
  project: Project,
  clipId: string,
  marker: AudioWarpMarker,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    addAudioWarpTimingPoint(warp, marker), clock);
}

export function moveAudioClipTimingPoint(
  project: Project,
  clipId: string,
  index: number,
  marker: AudioWarpMarker,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    moveAudioWarpTimingPoint(warp, index, marker), clock);
}

export function removeAudioClipTimingPoint(
  project: Project,
  clipId: string,
  index: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    removeAudioWarpTimingPoint(warp, index), clock);
}

export function resetAudioClipTimingPoints(
  project: Project,
  clipId: string,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, resetAudioWarpTimingPoints, clock);
}

export function replaceAudioClipPitchRegions(
  project: Project,
  clipId: string,
  regions: readonly AudioPitchRegion[],
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    replaceAudioPitchRegions(warp, regions), clock);
}

export function splitAudioClipPitchRegion(
  project: Project,
  clipId: string,
  index: number,
  splitSourceFrame: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    splitAudioPitchRegion(warp, index, splitSourceFrame), clock);
}

export function mergeAudioClipPitchRegions(
  project: Project,
  clipId: string,
  index: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    mergeAudioPitchRegions(warp, index), clock);
}

export function retargetAudioClipPitchRegion(
  project: Project,
  clipId: string,
  index: number,
  targetPitchCents: number,
  correctionAmount?: number,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, (warp) =>
    retargetAudioPitchRegion(warp, index, targetPitchCents, correctionAmount), clock);
}

export function resetAudioClipPitchRegions(
  project: Project,
  clipId: string,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return updateAudioClipWarp(project, clipId, resetAudioPitchRegions, clock);
}

/** Split a non-looping clip; only the two original outer edges retain fades. */
export function splitAudioClip(
  project: Project,
  clipId: string,
  options: SplitAudioClipOptions,
  clock: Clock = systemClock,
): SplitAudioClipResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (context.clip.loop) {
      return failure(
        'looped-split-unsupported',
        'A looped Audio Clip cannot be split without a persisted loop phase.',
      );
    }
    if (context.track.clips.length >= MAX_CLIPS_PER_TRACK) {
      return failure('clip-limit', `A track can contain at most ${MAX_CLIPS_PER_TRACK} clips.`);
    }
    const endBeat = context.clip.startBeat + context.clip.lengthBeats;
    if (
      !Number.isFinite(options.splitBeat)
      || options.splitBeat < context.clip.startBeat + MIN_EVENT_DURATION_BEATS
      || options.splitBeat > endBeat - MIN_EVENT_DURATION_BEATS
    ) {
      return failure('invalid-position', 'The split must leave two positive Audio Clip windows.');
    }
    const timingWarp = context.clip.audioWarp?.timingEnabled === true
      ? context.clip.audioWarp
      : undefined;
    const splitFrames = timingWarp === undefined
      ? frameDeltaBetweenBeats(
          project,
          context.clip.startBeat,
          options.splitBeat,
          context.asset.sampleRate,
        )
      : Math.round(beatToSourceFrame(
          timingWarp,
          options.splitBeat - context.clip.startBeat,
        ) - context.clip.sourceStartFrame);
    if (
      splitFrames === null
      || splitFrames <= 0
      || splitFrames >= context.clip.sourceFrameCount
    ) {
      return failure(
        'invalid-source-range',
        'The split point must fall inside the non-looping source range.',
      );
    }
    const reserved = allEntityIds(project);
    let rightClipId = options.rightClipId;
    if (rightClipId !== undefined) {
      if (
        rightClipId.length === 0
        || rightClipId.length > MAX_PROJECT_STRING_LENGTH
      ) {
        return failure('id-factory-failed', 'The right Audio Clip id must be non-empty and bounded.');
      }
      if (reserved.has(rightClipId)) {
        return failure('duplicate-id', `The Audio Clip id already exists: ${rightClipId}`);
      }
      reserved.add(rightClipId);
    } else {
      const allocated = allocateId('clip', options.idFactory ?? defaultIdFactory, reserved);
      if (!allocated.ok) return allocated;
      rightClipId = allocated.id;
    }

    const leftFrameCount = splitFrames;
    const rightFrameCount = context.clip.sourceFrameCount - splitFrames;
    const leftFadeLimit = fadeFrameLimit(
      project,
      context.clip.startBeat,
      options.splitBeat - context.clip.startBeat,
      context.asset.sampleRate,
      leftFrameCount,
    );
    const rightFadeLimit = fadeFrameLimit(
      project,
      options.splitBeat,
      endBeat - options.splitBeat,
      context.asset.sampleRate,
      rightFrameCount,
    );
    if (leftFadeLimit === null || rightFadeLimit === null) {
      return failure('invalid-fades', 'The split Audio Clip fade windows are not representable.');
    }
    const partitionedWarp = context.clip.audioWarp === undefined
      ? undefined
      : partitionAudioWarp(
          context.clip.audioWarp,
          context.clip.sourceStartFrame + splitFrames,
        );
    const leftLengthBeats = options.splitBeat - context.clip.startBeat;
    const rightLengthBeats = endBeat - options.splitBeat;
    const left: AudioClip = {
      ...context.clip,
      lengthBeats: leftLengthBeats,
      sourceFrameCount: leftFrameCount,
      fadeInFrames: Math.min(context.clip.fadeInFrames, leftFadeLimit),
      fadeOutFrames: 0,
      ...(partitionedWarp !== undefined
        ? {
            audioWarp: {
              ...partitionedWarp.left,
              markers: partitionedWarp.left.markers.map((marker, index) =>
                index === partitionedWarp.left.markers.length - 1
                  ? { ...marker, targetBeatOffset: leftLengthBeats }
                  : marker,
              ),
            },
          }
        : {}),
    };
    const right: AudioClip = {
      ...context.clip,
      id: rightClipId,
      startBeat: options.splitBeat,
      lengthBeats: rightLengthBeats,
      sourceStartFrame: context.clip.sourceStartFrame + splitFrames,
      sourceFrameCount: rightFrameCount,
      fadeInFrames: 0,
      fadeOutFrames: Math.min(context.clip.fadeOutFrames, rightFadeLimit),
      ...(partitionedWarp !== undefined
        ? {
            audioWarp: {
              ...partitionedWarp.right,
              markers: partitionedWarp.right.markers.map((marker, index) =>
                index === partitionedWarp.right.markers.length - 1
                  ? { ...marker, targetBeatOffset: rightLengthBeats }
                  : marker,
              ),
            },
          }
        : {}),
    };
    const candidate: Project = {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === context.track.id
          ? {
              ...track,
              clips: track.clips.flatMap((clip): Clip[] =>
                clip.id === clipId ? [left, right] : [clip],
              ),
            }
          : track,
      ),
      updatedAt: nowIso(clock),
    };
    return {
      ok: true,
      project: candidate,
      changed: true,
      trackId: context.track.id,
      clipId: left.id,
      rightClipId: right.id,
    };
  });
}

/** Duplicate one Audio Clip independently while sharing immutable asset bytes. */
export function duplicateAudioClip(
  project: Project,
  clipId: string,
  options: DuplicateAudioClipOptions,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioContext(project, clipId);
    if (!('clip' in context)) return context;
    if (context.track.clips.length >= MAX_CLIPS_PER_TRACK) {
      return failure('clip-limit', `A track can contain at most ${MAX_CLIPS_PER_TRACK} clips.`);
    }
    if (!Number.isFinite(options.startBeat) || options.startBeat < 0) {
      return failure('invalid-position', 'Audio Clip startBeat must be a non-negative finite number.');
    }
    const reserved = allEntityIds(project);
    let duplicateId = options.id;
    if (duplicateId !== undefined) {
      if (duplicateId.length === 0 || duplicateId.length > MAX_PROJECT_STRING_LENGTH) {
        return failure('id-factory-failed', 'The duplicate Audio Clip id must be non-empty and bounded.');
      }
      if (reserved.has(duplicateId)) {
        return failure('duplicate-id', `The Audio Clip id already exists: ${duplicateId}`);
      }
      reserved.add(duplicateId);
    } else {
      const allocated = allocateId('clip', options.idFactory ?? defaultIdFactory, reserved);
      if (!allocated.ok) return allocated;
      duplicateId = allocated.id;
    }
    const extension = extendProjectToInclude(
      project,
      options.startBeat + context.clip.lengthBeats,
    );
    if (!extension.ok) return extension;
    const duplicate: AudioClip = {
      ...context.clip,
      id: duplicateId,
      startBeat: options.startBeat,
      ...(context.clip.audioWarp !== undefined ? { audioWarp: cloneAudioWarp(context.clip) } : {}),
    };
    const candidate: Project = {
      ...extension.project,
      tracks: extension.project.tracks.map((track) =>
        track.id === context.track.id
          ? { ...track, clips: [...track.clips, duplicate] }
          : track,
      ),
      updatedAt: nowIso(clock),
    };
    return {
      ok: true,
      project: candidate,
      changed: true,
      trackId: context.track.id,
      clipId: duplicate.id,
    };
  });
}

/** Delete one timeline clip and release metadata once its asset has no remaining owner. */
export function deleteAudioClip(
  project: Project,
  clipId: string,
  clock: Clock = systemClock,
): AudioClipMutationResult {
  return runMutation(project, () => {
    const context = findAudioClipContext(project, clipId);
    if (!('clip' in context)) return context;
    const tracks = project.tracks.map((track) =>
      track.id === context.track.id
        ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
        : track,
    );
    const assetStillReferenced = tracks.some((track) =>
      track.clips.some(
        (clip) => clip.type === 'audio' && clip.audioAssetId === context.clip.audioAssetId,
      ),
    ) || project.audioTakeFolders.some((folder) =>
      folder.takes.some((take) => take.audioAssetId === context.clip.audioAssetId),
    );
    const candidate: Project = {
      ...project,
      tracks,
      audioAssets: assetStillReferenced
        ? project.audioAssets
        : project.audioAssets.filter((asset) => asset.id !== context.clip.audioAssetId),
      updatedAt: nowIso(clock),
    };
    return {
      ok: true,
      project: candidate,
      changed: true,
      trackId: context.track.id,
      clipId,
    };
  });
}
