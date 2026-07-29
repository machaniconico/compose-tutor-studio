// Pure, immutable track-management mutations. These helpers deliberately do
// not stamp Project.updatedAt; the application store owns revision timestamps.

import { makeId } from './ids';
import { isLearningTrack } from './learning-track';
import { encodeProjectJson, MAX_PROJECT_STRING_LENGTH } from './project-codec';
import { projectLengthBeats } from './time';
import type { ProjectCodecIssue } from './project-codec';
import type {
  AudioCompSegment,
  AudioTake,
  AudioTakeFolder,
  Clip,
  DrumEvent,
  EffectConfig,
  NoteEvent,
  Project,
  Track,
} from './types';
import { MAX_PROJECT_TRACKS } from './validation';

export const MAX_TRACK_NAME_CODE_POINTS = 128;
export const DEFAULT_SYNTH_TRACK_PRESET = 'softPad';
export const DEFAULT_DRUM_TRACK_PRESET = 'acoustic';

export type AddTrackKind = 'instrument' | 'drum' | 'bus';
export type TrackMoveDirection = 'up' | 'down';
export type TrackEntityIdKind =
  | 'track'
  | 'clip'
  | 'note'
  | 'drum'
  | 'effect'
  | 'send'
  | 'folder'
  | 'take'
  | 'segment';
export type TrackIdFactory = (kind: TrackEntityIdKind) => string;

export type TrackMutationErrorCode =
  | 'track-not-found'
  | 'track-limit'
  | 'master-protected'
  | 'learning-track-protected'
  | 'learning-track-name-protected'
  | 'reserved-learning-track-name'
  | 'invalid-track-name'
  | 'unsupported-track-kind'
  | 'unsupported-track-type'
  | 'invalid-preset'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'project-not-adoptable'
  | 'unexpected';

export type TrackMutationError = Readonly<{
  code: TrackMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type TrackMutationResult =
  | Readonly<{
      ok: true;
      project: Project;
      /** False means a valid request was already satisfied or hit a move boundary. */
      changed: boolean;
      /** The created, changed, or removed track id. */
      trackId: string;
    }>
  | Readonly<{ ok: false; error: TrackMutationError }>;

export type AddTrackOptions = Readonly<{
  name?: string;
  idFactory?: TrackIdFactory;
}>;

export type DuplicateTrackOptions = Readonly<{
  name?: string;
  idFactory?: TrackIdFactory;
}>;

type MutationBuild = TrackMutationResult;

const defaultIdFactory: TrackIdFactory = (kind) => makeId(kind);

function failure(
  code: TrackMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): TrackMutationResult {
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
  trackId: string,
  changed: boolean,
): TrackMutationResult {
  return { ok: true, project, changed, trackId };
}

function codecFailure(project: Project): TrackMutationResult | null {
  const encoded = encodeProjectJson(project);
  if (encoded.ok) return null;
  const firstIssue = encoded.error.issues[0];
  const detail = firstIssue ? ` ${firstIssue.path}: ${firstIssue.message}` : '';
  return failure(
    'project-not-adoptable',
    `Project codec rejected the track change.${detail}`,
    encoded.error.issues,
  );
}

/**
 * Validate both the input and changed candidate and convert every exception to
 * a result. This makes the public mutation boundary no-throw even when an
 * injected id factory misbehaves.
 */
function runMutation(project: Project, build: () => MutationBuild): TrackMutationResult {
  try {
    const inputFailure = codecFailure(project);
    if (inputFailure) return inputFailure;

    const built = build();
    if (!built.ok || !built.changed) return built;

    const candidateFailure = codecFailure(built.project);
    return candidateFailure ?? built;
  } catch {
    return failure('unexpected', 'The track change could not be completed safely.');
  }
}

function allEntityIds(project: Project): Set<string> {
  const ids = new Set<string>([project.id]);
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
  for (const send of project.audioRouting.sends) ids.add(send.id);
  return ids;
}

type AllocateIdResult =
  | Readonly<{ ok: true; id: string }>
  | Readonly<{ ok: false; result: TrackMutationResult }>;

function allocateId(
  kind: TrackEntityIdKind,
  factory: TrackIdFactory,
  reserved: Set<string>,
): AllocateIdResult {
  let id: unknown;
  try {
    id = factory(kind);
  } catch {
    return {
      ok: false,
      result: failure('id-factory-failed', `The id factory failed while creating a ${kind} id.`),
    };
  }
  if (
    typeof id !== 'string'
    || id.length === 0
    || id.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return {
      ok: false,
      result: failure(
        'id-factory-failed',
        `The id factory must return a non-empty id of at most ${MAX_PROJECT_STRING_LENGTH} characters.`,
      ),
    };
  }
  if (reserved.has(id)) {
    return {
      ok: false,
      result: failure('duplicate-id', `The id factory returned an existing id: ${id}`),
    };
  }
  reserved.add(id);
  return { ok: true, id };
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function truncateCodePoints(value: string, maximum: number): string {
  return codePoints(value).slice(0, maximum).join('');
}

function normalizedName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || codePoints(trimmed).length > MAX_TRACK_NAME_CODE_POINTS) {
    return null;
  }
  return trimmed;
}

function generatedUniqueName(project: Project, preferred: string): string {
  const used = new Set(project.tracks.map((track) => track.name));
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? '' : ` ${number}`;
    const maximumBaseLength = MAX_TRACK_NAME_CODE_POINTS - codePoints(suffix).length;
    const base = truncateCodePoints(preferred.trim(), maximumBaseLength).trimEnd() || 'Track';
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function firstMasterIndex(project: Project): number {
  const index = project.tracks.findIndex((track) => track.type === 'master');
  return index === -1 ? project.tracks.length : index;
}

/** Add a full-song instrument/drum track or an empty Bus before the first Master. */
export function addTrack(
  project: Project,
  kind: AddTrackKind,
  options: AddTrackOptions = {},
): TrackMutationResult {
  return runMutation(project, () => {
    if (kind !== 'instrument' && kind !== 'drum' && kind !== 'bus') {
      return failure('unsupported-track-kind', `Unsupported track kind: ${String(kind)}`);
    }
    if (project.tracks.length >= MAX_PROJECT_TRACKS) {
      return failure('track-limit', `A project can contain at most ${MAX_PROJECT_TRACKS} tracks.`);
    }

    const name = options.name === undefined
      ? generatedUniqueName(
          project,
          kind === 'instrument' ? 'Instrument' : kind === 'drum' ? 'Drums' : 'Bus',
        )
      : normalizedName(options.name);
    if (name === null) {
      return failure(
        'invalid-track-name',
        `Track names must contain text and be at most ${MAX_TRACK_NAME_CODE_POINTS} Unicode characters.`,
      );
    }
    const reserved = allEntityIds(project);
    const idFactory = options.idFactory ?? defaultIdFactory;
    const trackId = allocateId('track', idFactory, reserved);
    if (!trackId.ok) return trackId.result;

    const lengthBeats = projectLengthBeats(project);
    const isInstrument = kind === 'instrument';
    const isBus = kind === 'bus';
    const clips: Clip[] = [];
    if (!isBus) {
      const clipId = allocateId('clip', idFactory, reserved);
      if (!clipId.ok) return clipId.result;
      clips.push(isInstrument
        ? {
            id: clipId.id,
            trackId: trackId.id,
            type: 'midi',
            startBeat: 0,
            lengthBeats,
            loop: false,
            notes: [],
          }
        : {
            id: clipId.id,
            trackId: trackId.id,
            type: 'drum',
            startBeat: 0,
            lengthBeats,
            loop: false,
            stepsPerBar: 16,
            drumEvents: [],
          });
    }
    const track: Track = {
      id: trackId.id,
      name,
      type: kind,
      role: 'general',
      clips,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      ...(!isBus
        ? {
            instrument: isInstrument
              ? { type: 'synth' as const, preset: DEFAULT_SYNTH_TRACK_PRESET }
              : { type: 'drumkit' as const, preset: DEFAULT_DRUM_TRACK_PRESET },
          }
        : {}),
      effects: [],
    };
    const insertionIndex = firstMasterIndex(project);
    const tracks = [
      ...project.tracks.slice(0, insertionIndex),
      track,
      ...project.tracks.slice(insertionIndex),
    ];
    return success({
      ...project,
      tracks,
      audioRouting: {
        ...project.audioRouting,
        outputs: [
          ...project.audioRouting.outputs,
          { sourceTrackId: track.id, destination: { type: 'master' } },
        ],
      },
    }, track.id, true);
  });
}

/** Rename a track after trimming user-entered surrounding whitespace. */
export function renameTrack(
  project: Project,
  trackId: string,
  name: string,
): TrackMutationResult {
  return runMutation(project, () => {
    const index = project.tracks.findIndex((track) => track.id === trackId);
    if (index === -1) return failure('track-not-found', `Track not found: ${trackId}`);
    if (project.tracks[index]!.type === 'master') {
      return failure('master-protected', 'Master tracks cannot be renamed.');
    }
    const current = project.tracks[index]!;
    const normalized = normalizedName(name);
    if (normalized === null) {
      return failure(
        'invalid-track-name',
        `Track names must contain text and be at most ${MAX_TRACK_NAME_CODE_POINTS} Unicode characters.`,
      );
    }
    if (current.name === normalized) return success(project, trackId, false);
    const tracks = project.tracks.map((track, trackIndex) => (
      trackIndex === index ? { ...track, name: normalized } : track
    ));
    return success({ ...project, tracks }, trackId, true);
  });
}

function cloneClip(
  clip: Clip,
  newTrackId: string,
  newClipId: string,
  clipIds: ReadonlyMap<string, string>,
  idFactory: TrackIdFactory,
  reserved: Set<string>,
): Clip | TrackMutationResult {
  const aliasOf = clip.aliasOf === undefined ? undefined : clipIds.get(clip.aliasOf);
  if (clip.aliasOf !== undefined && aliasOf === undefined) {
    return failure('project-not-adoptable', 'A linked clip source could not be remapped.');
  }

  const notes: NoteEvent[] | undefined = clip.notes === undefined ? undefined : [];
  for (const note of clip.notes ?? []) {
    const noteId = allocateId('note', idFactory, reserved);
    if (!noteId.ok) return noteId.result;
    notes!.push({ ...note, id: noteId.id });
  }

  const drumEvents: DrumEvent[] | undefined = clip.drumEvents === undefined ? undefined : [];
  for (const event of clip.drumEvents ?? []) {
    const eventId = allocateId('drum', idFactory, reserved);
    if (!eventId.ok) return eventId.result;
    drumEvents!.push({ ...event, id: eventId.id });
  }

  return {
    ...clip,
    id: newClipId,
    trackId: newTrackId,
    ...(aliasOf !== undefined ? { aliasOf } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(drumEvents !== undefined ? { drumEvents } : {}),
    ...(clip.drumGroove !== undefined ? { drumGroove: { ...clip.drumGroove } } : {}),
  };
}

/** Duplicate a non-master track and every entity it owns with fresh ids. */
export function duplicateTrack(
  project: Project,
  trackId: string,
  options: DuplicateTrackOptions = {},
): TrackMutationResult {
  return runMutation(project, () => {
    const sourceIndex = project.tracks.findIndex((track) => track.id === trackId);
    if (sourceIndex === -1) return failure('track-not-found', `Track not found: ${trackId}`);
    const source = project.tracks[sourceIndex]!;
    if (source.type === 'master') {
      return failure('master-protected', 'Master tracks cannot be duplicated.');
    }
    if (project.tracks.length >= MAX_PROJECT_TRACKS) {
      return failure('track-limit', `A project can contain at most ${MAX_PROJECT_TRACKS} tracks.`);
    }

    const name = options.name === undefined
      ? generatedUniqueName(project, `${source.name.trim() || 'Track'} Copy`)
      : normalizedName(options.name);
    if (name === null) {
      return failure(
        'invalid-track-name',
        `Track names must contain text and be at most ${MAX_TRACK_NAME_CODE_POINTS} Unicode characters.`,
      );
    }
    const reserved = allEntityIds(project);
    const idFactory = options.idFactory ?? defaultIdFactory;
    const newTrackId = allocateId('track', idFactory, reserved);
    if (!newTrackId.ok) return newTrackId.result;

    // Allocate every clip id first so aliasOf can be remapped regardless of
    // whether the source appears before or after the linked instance.
    const clipIds = new Map<string, string>();
    for (const clip of source.clips) {
      const newClipId = allocateId('clip', idFactory, reserved);
      if (!newClipId.ok) return newClipId.result;
      clipIds.set(clip.id, newClipId.id);
    }

    const effects: EffectConfig[] = [];
    for (const effect of source.effects) {
      const effectId = allocateId('effect', idFactory, reserved);
      if (!effectId.ok) return effectId.result;
      effects.push({ ...effect, id: effectId.id, params: { ...effect.params } });
    }

    const clips: Clip[] = [];
    for (const clip of source.clips) {
      const newClipId = clipIds.get(clip.id);
      if (newClipId === undefined) {
        return failure('project-not-adoptable', 'A clip id could not be remapped.');
      }
      const cloned = cloneClip(
        clip,
        newTrackId.id,
        newClipId,
        clipIds,
        idFactory,
        reserved,
      );
      if ('ok' in cloned) return cloned;
      clips.push(cloned);
    }

    const audioTakeFolders: AudioTakeFolder[] = [];
    for (const folder of project.audioTakeFolders) {
      if (folder.trackId !== source.id) continue;
      const folderId = allocateId('folder', idFactory, reserved);
      if (!folderId.ok) return folderId.result;
      const takeIds = new Map<string, string>();
      const takes: AudioTake[] = [];
      for (const take of folder.takes) {
        const takeId = allocateId('take', idFactory, reserved);
        if (!takeId.ok) return takeId.result;
        takeIds.set(take.id, takeId.id);
        takes.push({ ...take, id: takeId.id });
      }
      const compSegments: AudioCompSegment[] = [];
      for (const segment of folder.compSegments) {
        const takeId = takeIds.get(segment.takeId);
        if (takeId === undefined) {
          return failure('project-not-adoptable', 'A comp segment take could not be remapped.');
        }
        const segmentId = allocateId('segment', idFactory, reserved);
        if (!segmentId.ok) return segmentId.result;
        compSegments.push({ ...segment, id: segmentId.id, takeId });
      }
      audioTakeFolders.push({
        ...folder,
        id: folderId.id,
        trackId: newTrackId.id,
        takes,
        compSegments,
      });
    }

    const duplicate: Track = {
      ...source,
      id: newTrackId.id,
      name,
      role: 'general',
      clips,
      effects,
      ...(source.instrument !== undefined
        ? {
            instrument: {
              ...source.instrument,
              ...(source.instrument.params !== undefined
                ? { params: { ...source.instrument.params } }
                : {}),
            },
          }
        : {}),
    };
    const insertionIndex = sourceIndex + 1;
    const tracks = [
      ...project.tracks.slice(0, insertionIndex),
      duplicate,
      ...project.tracks.slice(insertionIndex),
    ];
    const sourceOutputIndex = project.audioRouting.outputs.findIndex(
      (output) => output.sourceTrackId === source.id,
    );
    const sourceOutput = project.audioRouting.outputs[sourceOutputIndex];
    if (sourceOutput === undefined) {
      return failure('project-not-adoptable', 'The source track has no main output route.');
    }
    const duplicateOutput = {
      sourceTrackId: duplicate.id,
      destination: { ...sourceOutput.destination },
    };
    const outputs = [
      ...project.audioRouting.outputs.slice(0, sourceOutputIndex + 1),
      duplicateOutput,
      ...project.audioRouting.outputs.slice(sourceOutputIndex + 1),
    ];
    const clonedSends = [];
    for (const send of project.audioRouting.sends) {
      if (send.sourceTrackId !== source.id) continue;
      const sendId = allocateId('send', idFactory, reserved);
      if (!sendId.ok) return sendId.result;
      clonedSends.push({ ...send, id: sendId.id, sourceTrackId: duplicate.id });
    }
    return success({
      ...project,
      tracks,
      audioTakeFolders: [...project.audioTakeFolders, ...audioTakeFolders],
      audioRouting: {
        outputs,
        sends: [...project.audioRouting.sends, ...clonedSends],
      },
    }, duplicate.id, true);
  });
}

/** Move a non-master track by one slot without crossing a master boundary. */
export function moveTrack(
  project: Project,
  trackId: string,
  direction: TrackMoveDirection,
): TrackMutationResult {
  return runMutation(project, () => {
    const index = project.tracks.findIndex((track) => track.id === trackId);
    if (index === -1) return failure('track-not-found', `Track not found: ${trackId}`);
    const track = project.tracks[index]!;
    if (track.type === 'master') {
      return failure('master-protected', 'Master tracks cannot be reordered.');
    }
    if (direction !== 'up' && direction !== 'down') {
      return failure('unexpected', `Unsupported move direction: ${String(direction)}`);
    }
    const destination = direction === 'up' ? index - 1 : index + 1;
    if (destination < 0 || destination >= project.tracks.length) {
      return success(project, trackId, false);
    }
    if (project.tracks[destination]!.type === 'master') {
      return success(project, trackId, false);
    }
    const tracks = [...project.tracks];
    [tracks[index], tracks[destination]] = [tracks[destination]!, tracks[index]!];
    return success({ ...project, tracks }, trackId, true);
  });
}

/** Remove a user-managed non-master track. */
export function removeTrack(project: Project, trackId: string): TrackMutationResult {
  return runMutation(project, () => {
    const index = project.tracks.findIndex((track) => track.id === trackId);
    if (index === -1) return failure('track-not-found', `Track not found: ${trackId}`);
    const track = project.tracks[index]!;
    if (track.type === 'master') {
      return failure('master-protected', 'Master tracks cannot be removed.');
    }
    if (isLearningTrack(track)) {
      return failure(
        'learning-track-protected',
        'Learning-role tracks cannot be removed.',
      );
    }
    const tracks = project.tracks.filter((_, trackIndex) => trackIndex !== index);
    const automationLanes = project.automationLanes.filter(
      (lane) => lane.target.trackId !== trackId,
    );
    const audioTakeFolders = project.audioTakeFolders.filter(
      (folder) => folder.trackId !== trackId,
    );
    const removedAudioAssetIds = new Set(
      [
        ...track.clips
          .filter((clip) => clip.type === 'audio')
          .map((clip) => clip.audioAssetId),
        ...project.audioTakeFolders
          .filter((folder) => folder.trackId === trackId)
          .flatMap((folder) => folder.takes.map((take) => take.audioAssetId)),
      ],
    );
    const remainingAudioAssetIds = new Set(
      [
        ...tracks.flatMap((candidate) =>
          candidate.clips
            .filter((clip) => clip.type === 'audio')
            .map((clip) => clip.audioAssetId),
        ),
        ...audioTakeFolders.flatMap((folder) =>
          folder.takes.map((take) => take.audioAssetId),
        ),
      ],
    );
    const audioAssets = project.audioAssets.filter(
      (asset) => !removedAudioAssetIds.has(asset.id) || remainingAudioAssetIds.has(asset.id),
    );
    const audioRouting = {
      outputs: project.audioRouting.outputs
        .filter((output) => output.sourceTrackId !== trackId)
        .map((output) => (
          output.destination.type === 'bus' && output.destination.trackId === trackId
            ? { ...output, destination: { type: 'master' as const } }
            : output
        )),
      sends: project.audioRouting.sends.filter(
        (send) => send.sourceTrackId !== trackId && send.targetBusId !== trackId,
      ),
    };
    return success({
      ...project,
      tracks,
      automationLanes,
      audioTakeFolders,
      audioAssets,
      audioRouting,
    }, trackId, true);
  });
}

/** Set a canonical synth preset supplied by the audio layer's allow-list. */
export function setTrackSynthPreset(
  project: Project,
  trackId: string,
  preset: string,
  allowedPresets: readonly string[],
): TrackMutationResult {
  return runMutation(project, () => {
    const index = project.tracks.findIndex((track) => track.id === trackId);
    if (index === -1) return failure('track-not-found', `Track not found: ${trackId}`);
    const track = project.tracks[index]!;
    if (track.type !== 'instrument' || track.instrument?.type !== 'synth') {
      return failure('unsupported-track-type', 'Synth presets can only be set on synth instrument tracks.');
    }
    if (preset.length === 0 || !allowedPresets.includes(preset)) {
      return failure('invalid-preset', `Unsupported synth preset: ${preset}`);
    }
    if (track.instrument.preset === preset) return success(project, trackId, false);
    const instrument = { ...track.instrument, preset };
    const tracks = project.tracks.map((candidate, trackIndex) => (
      trackIndex === index
        ? { ...candidate, instrument }
        : candidate
    ));
    return success({ ...project, tracks }, trackId, true);
  });
}
