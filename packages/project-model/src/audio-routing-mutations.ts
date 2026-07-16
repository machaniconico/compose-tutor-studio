// Pure, no-throw audio-routing commands. The application store owns timestamps
// and turns each successful Project replacement into one Undo history entry.

import { makeId } from './ids';
import {
  encodeProjectJson,
  MAX_PROJECT_STRING_LENGTH,
  type ProjectCodecIssue,
} from './project-codec';
import type {
  AudioRouteDestination,
  AudioSend,
  AudioSendPosition,
  Project,
} from './types';

export type AudioRoutingIdFactory = (kind: 'send') => string;

export type AudioRoutingMutationErrorCode =
  | 'track-not-found'
  | 'master-protected'
  | 'send-not-found'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'invalid-routing'
  | 'project-not-adoptable'
  | 'unexpected';

export type AudioRoutingMutationError = Readonly<{
  code: AudioRoutingMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type AudioRoutingMutationResult =
  | Readonly<{
      ok: true;
      project: Project;
      changed: boolean;
      sourceTrackId: string;
      sendId?: string;
    }>
  | Readonly<{ ok: false; error: AudioRoutingMutationError }>;

export type AddAudioSendInput = Readonly<Omit<AudioSend, 'id'>>;

export type AddAudioSendOptions = Readonly<{
  id?: string;
  idFactory?: AudioRoutingIdFactory;
}>;

export type UpdateAudioSendPatch = Readonly<Partial<Pick<
  AudioSend,
  'targetBusId' | 'position' | 'gain' | 'enabled'
>>>;

const defaultIdFactory: AudioRoutingIdFactory = () => makeId('send');

function failure(
  code: AudioRoutingMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): AudioRoutingMutationResult {
  return {
    ok: false,
    error: { code, message, ...(issues === undefined ? {} : { issues }) },
  };
}

function success(
  project: Project,
  sourceTrackId: string,
  changed: boolean,
  sendId?: string,
): AudioRoutingMutationResult {
  return {
    ok: true,
    project,
    changed,
    sourceTrackId,
    ...(sendId === undefined ? {} : { sendId }),
  };
}

function codecFailure(
  project: Project,
  code: 'project-not-adoptable' | 'invalid-routing',
): AudioRoutingMutationResult | null {
  const encoded = encodeProjectJson(project);
  if (encoded.ok) return null;
  const first = encoded.error.issues[0];
  return failure(
    code,
    code === 'project-not-adoptable'
      ? `Project codec rejected the routing source.${first ? ` ${first.path}: ${first.message}` : ''}`
      : `Audio routing change was rejected.${first ? ` ${first.path}: ${first.message}` : ''}`,
    encoded.error.issues,
  );
}

function runMutation(
  project: Project,
  build: () => AudioRoutingMutationResult,
): AudioRoutingMutationResult {
  try {
    const inputFailure = codecFailure(project, 'project-not-adoptable');
    if (inputFailure) return inputFailure;
    const built = build();
    if (!built.ok || !built.changed) return built;
    return codecFailure(built.project, 'invalid-routing') ?? built;
  } catch {
    return failure('unexpected', 'The audio routing change could not be completed safely.');
  }
}

function allEntityIds(project: Project): Set<string> {
  const ids = new Set<string>([project.id]);
  for (const event of project.tempoMap) ids.add(event.id);
  for (const event of project.timeSignatureMap) ids.add(event.id);
  for (const asset of project.audioAssets) ids.add(asset.id);
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

function sameDestination(
  left: AudioRouteDestination,
  right: AudioRouteDestination,
): boolean {
  return left.type === right.type
    && (left.type === 'master' || (right.type === 'bus' && left.trackId === right.trackId));
}

/** Replace one non-Master track's exact main output. */
export function setTrackOutput(
  project: Project,
  sourceTrackId: string,
  destination: AudioRouteDestination,
): AudioRoutingMutationResult {
  return runMutation(project, () => {
    const source = project.tracks.find((track) => track.id === sourceTrackId);
    if (source === undefined) return failure('track-not-found', `Track not found: ${sourceTrackId}`);
    if (source.type === 'master') {
      return failure('master-protected', 'Master tracks cannot have an output route.');
    }
    const outputIndex = project.audioRouting.outputs.findIndex(
      (output) => output.sourceTrackId === sourceTrackId,
    );
    const current = project.audioRouting.outputs[outputIndex];
    if (current === undefined) {
      return failure('project-not-adoptable', 'The source track has no main output route.');
    }
    if (sameDestination(current.destination, destination)) {
      return success(project, sourceTrackId, false);
    }
    const outputs = [...project.audioRouting.outputs];
    outputs[outputIndex] = {
      sourceTrackId,
      destination: { ...destination },
    };
    return success({
      ...project,
      audioRouting: { ...project.audioRouting, outputs },
    }, sourceTrackId, true);
  });
}

/** Add one pre/post-fader send with a globally fresh stable id. */
export function addAudioSend(
  project: Project,
  input: AddAudioSendInput,
  options: AddAudioSendOptions = {},
): AudioRoutingMutationResult {
  return runMutation(project, () => {
    const reserved = allEntityIds(project);
    let id: unknown = options.id;
    if (id === undefined) {
      try {
        id = (options.idFactory ?? defaultIdFactory)('send');
      } catch {
        return failure('id-factory-failed', 'The id factory failed while creating a send id.');
      }
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROJECT_STRING_LENGTH) {
      return failure(
        'id-factory-failed',
        `A send id must contain 1..${MAX_PROJECT_STRING_LENGTH} characters.`,
      );
    }
    if (reserved.has(id)) {
      return failure('duplicate-id', `The send id already exists: ${id}`);
    }

    const send: AudioSend = {
      id,
      sourceTrackId: input.sourceTrackId,
      targetBusId: input.targetBusId,
      position: input.position,
      gain: input.gain,
      enabled: input.enabled,
    };
    return success({
      ...project,
      audioRouting: {
        ...project.audioRouting,
        sends: [...project.audioRouting.sends, send],
      },
    }, send.sourceTrackId, true, send.id);
  });
}

/** Update mutable send parameters while keeping its stable id and source. */
export function updateAudioSend(
  project: Project,
  sendId: string,
  patch: UpdateAudioSendPatch,
): AudioRoutingMutationResult {
  return runMutation(project, () => {
    const index = project.audioRouting.sends.findIndex((send) => send.id === sendId);
    const current = project.audioRouting.sends[index];
    if (current === undefined) return failure('send-not-found', `Send not found: ${sendId}`);
    const next: AudioSend = {
      ...current,
      targetBusId: Object.prototype.hasOwnProperty.call(patch, 'targetBusId')
        ? patch.targetBusId as AudioSend['targetBusId']
        : current.targetBusId,
      position: Object.prototype.hasOwnProperty.call(patch, 'position')
        ? patch.position as AudioSend['position']
        : current.position,
      gain: Object.prototype.hasOwnProperty.call(patch, 'gain')
        ? patch.gain as AudioSend['gain']
        : current.gain,
      enabled: Object.prototype.hasOwnProperty.call(patch, 'enabled')
        ? patch.enabled as AudioSend['enabled']
        : current.enabled,
    };
    if (
      next.targetBusId === current.targetBusId
      && next.position === current.position
      && next.gain === current.gain
      && next.enabled === current.enabled
    ) {
      return success(project, current.sourceTrackId, false, current.id);
    }
    const sends = [...project.audioRouting.sends];
    sends[index] = next;
    return success({
      ...project,
      audioRouting: { ...project.audioRouting, sends },
    }, next.sourceTrackId, true, next.id);
  });
}

/** Remove exactly one send. Missing ids are rejected rather than treated as stale success. */
export function removeAudioSend(
  project: Project,
  sendId: string,
): AudioRoutingMutationResult {
  return runMutation(project, () => {
    const send = project.audioRouting.sends.find((candidate) => candidate.id === sendId);
    if (send === undefined) return failure('send-not-found', `Send not found: ${sendId}`);
    return success({
      ...project,
      audioRouting: {
        ...project.audioRouting,
        sends: project.audioRouting.sends.filter((candidate) => candidate.id !== sendId),
      },
    }, send.sourceTrackId, true, send.id);
  });
}

/** Convenience defaults for a newly created send. */
export function defaultAudioSendInput(
  sourceTrackId: string,
  targetBusId: string,
  position: AudioSendPosition = 'post-fader',
): AddAudioSendInput {
  return { sourceTrackId, targetBusId, position, gain: 1, enabled: true };
}
