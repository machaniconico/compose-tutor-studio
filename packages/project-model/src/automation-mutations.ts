// Pure, no-throw automation commands. The application store owns timestamps
// and turns each successful Project replacement into one Undo history entry.

import { makeId } from './ids';
import {
  encodeProjectJson,
  MAX_PROJECT_STRING_LENGTH,
  type ProjectCodecIssue,
} from './project-codec';
import type {
  AutomationInterpolation,
  AutomationLane,
  AutomationPoint,
  AutomationTarget,
  Project,
  Track,
} from './types';
import {
  MAX_AUTOMATION_LANES,
  MAX_AUTOMATION_POINTS_PER_LANE,
} from './validation';

export type AutomationIdFactory = (kind: 'lane' | 'point') => string;

export type AutomationMutationErrorCode =
  | 'track-not-found'
  | 'master-protected'
  | 'lane-not-found'
  | 'point-not-found'
  | 'invalid-target'
  | 'invalid-beat'
  | 'invalid-value'
  | 'invalid-interpolation'
  | 'point-beat-conflict'
  | 'lane-limit'
  | 'point-limit'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'project-not-adoptable'
  | 'invalid-automation'
  | 'unexpected';

export type AutomationMutationError = Readonly<{
  code: AutomationMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type AutomationMutationResult =
  | Readonly<{
      ok: true;
      project: Project;
      changed: boolean;
      trackId: string;
      laneId: string;
      pointId?: string;
    }>
  | Readonly<{ ok: false; error: AutomationMutationError }>;

export type AddAutomationPointInput = Readonly<{
  target: AutomationTarget;
  beat: number;
  value: number;
  interpolation: AutomationInterpolation;
}>;

export type AddAutomationPointOptions = Readonly<{
  laneId?: string;
  pointId?: string;
  idFactory?: AutomationIdFactory;
}>;

export type UpdateAutomationPointPatch = Readonly<Partial<Pick<
  AutomationPoint,
  'beat' | 'value' | 'interpolation'
>>>;

type AutomationMutationFailure = Readonly<{
  ok: false;
  error: AutomationMutationError;
}>;

type ValidTarget = Readonly<{
  target: AutomationTarget;
  track: Track;
}>;

type TargetValidationResult =
  | Readonly<{ ok: true; value: ValidTarget }>
  | Readonly<{ ok: false; result: AutomationMutationFailure }>;

type IdAllocationResult =
  | Readonly<{ ok: true; id: string }>
  | Readonly<{ ok: false; result: AutomationMutationFailure }>;

const defaultIdFactory: AutomationIdFactory = (kind) =>
  makeId(kind === 'lane' ? 'automation-lane' : 'automation-point');

function failure(
  code: AutomationMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): AutomationMutationFailure {
  return {
    ok: false,
    error: { code, message, ...(issues === undefined ? {} : { issues }) },
  };
}

function success(
  project: Project,
  trackId: string,
  laneId: string,
  changed: boolean,
  pointId?: string,
): AutomationMutationResult {
  return {
    ok: true,
    project,
    changed,
    trackId,
    laneId,
    ...(pointId === undefined ? {} : { pointId }),
  };
}

function codecFailure(
  project: Project,
  code: 'project-not-adoptable' | 'invalid-automation',
): AutomationMutationFailure | null {
  try {
    const encoded = encodeProjectJson(project);
    if (encoded.ok) return null;
    const first = encoded.error.issues[0];
    return failure(
      code,
      code === 'project-not-adoptable'
        ? `Project codec rejected the automation source.${first ? ` ${first.path}: ${first.message}` : ''}`
        : `Automation change was rejected.${first ? ` ${first.path}: ${first.message}` : ''}`,
      encoded.error.issues,
    );
  } catch {
    return failure(
      code,
      code === 'project-not-adoptable'
        ? 'Project codec could not safely inspect the automation source.'
        : 'Project codec could not safely inspect the automation change.',
    );
  }
}

function runMutation(
  project: Project,
  build: () => AutomationMutationResult,
): AutomationMutationResult {
  try {
    const inputFailure = codecFailure(project, 'project-not-adoptable');
    if (inputFailure) return inputFailure;
    const built = build();
    if (!built.ok || !built.changed) return built;
    return codecFailure(built.project, 'invalid-automation') ?? built;
  } catch {
    return failure('unexpected', 'The automation change could not be completed safely.');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateTarget(project: Project, value: unknown): TargetValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      result: failure('invalid-target', 'Automation target must be an object.'),
    };
  }
  const type = value.type;
  const trackId = value.trackId;
  if (
    (type !== 'track-volume' && type !== 'track-pan')
    || typeof trackId !== 'string'
    || trackId.length === 0
    || trackId.length > MAX_PROJECT_STRING_LENGTH
  ) {
    return {
      ok: false,
      result: failure(
        'invalid-target',
        'Automation target must identify track-volume or track-pan on a bounded track id.',
      ),
    };
  }
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) {
    return {
      ok: false,
      result: failure('track-not-found', `Track not found: ${trackId}`),
    };
  }
  if (track.type === 'master') {
    return {
      ok: false,
      result: failure('master-protected', 'Automation cannot target a Master track.'),
    };
  }
  return {
    ok: true,
    value: {
      target: { type, trackId },
      track,
    },
  };
}

function validateBeat(project: Project, beat: unknown): AutomationMutationFailure | null {
  if (
    typeof beat !== 'number'
    || !Number.isFinite(beat)
    || beat < 0
    || beat > project.lengthBeats
  ) {
    return failure(
      'invalid-beat',
      `Automation point beat must be finite and between 0 and ${project.lengthBeats}.`,
    );
  }
  return null;
}

function validateValue(
  target: AutomationTarget,
  value: unknown,
): AutomationMutationFailure | null {
  const minimum = target.type === 'track-volume' ? 0 : -1;
  const maximum = target.type === 'track-volume' ? 2 : 1;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    return failure(
      'invalid-value',
      `${target.type} automation value must be finite and between ${minimum} and ${maximum}.`,
    );
  }
  return null;
}

function validateInterpolation(value: unknown): AutomationMutationFailure | null {
  if (value !== 'hold' && value !== 'linear') {
    return failure(
      'invalid-interpolation',
      'Automation interpolation must be hold or linear.',
    );
  }
  return null;
}

function sameTarget(left: AutomationTarget, right: AutomationTarget): boolean {
  return left.type === right.type && left.trackId === right.trackId;
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
  kind: 'lane' | 'point',
  requestedId: unknown,
  idFactory: AutomationIdFactory,
  reserved: Set<string>,
): IdAllocationResult {
  let id = requestedId;
  if (id === undefined) {
    try {
      id = idFactory(kind);
    } catch {
      return {
        ok: false,
        result: failure(
          'id-factory-failed',
          `The id factory failed while creating an automation ${kind} id.`,
        ),
      };
    }
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROJECT_STRING_LENGTH) {
    return {
      ok: false,
      result: failure(
        'id-factory-failed',
        `An automation ${kind} id must contain 1..${MAX_PROJECT_STRING_LENGTH} characters.`,
      ),
    };
  }
  if (reserved.has(id)) {
    return {
      ok: false,
      result: failure('duplicate-id', `The automation ${kind} id already exists: ${id}`),
    };
  }
  reserved.add(id);
  return { ok: true, id };
}

function laneById(
  project: Project,
  laneId: string,
): Readonly<{ lane: AutomationLane; index: number }> | null {
  const index = project.automationLanes.findIndex((lane) => lane.id === laneId);
  const lane = project.automationLanes[index];
  return lane === undefined ? null : { lane, index };
}

/** Add one point, lazily creating the target lane when needed. */
export function addAutomationPoint(
  project: Project,
  input: AddAutomationPointInput,
  options: AddAutomationPointOptions = {},
): AutomationMutationResult {
  return runMutation(project, () => {
    if (!isRecord(input)) {
      return failure('invalid-target', 'Automation point input must be an object.');
    }
    const targetResult = validateTarget(project, input.target);
    if (!targetResult.ok) return targetResult.result;
    const { target } = targetResult.value;
    const beatFailure = validateBeat(project, input.beat);
    if (beatFailure) return beatFailure;
    const valueFailure = validateValue(target, input.value);
    if (valueFailure) return valueFailure;
    const interpolationFailure = validateInterpolation(input.interpolation);
    if (interpolationFailure) return interpolationFailure;

    const currentLane = project.automationLanes.find((lane) => sameTarget(lane.target, target));
    if (
      currentLane?.points.some((point) => point.beat === input.beat)
    ) {
      return failure(
        'point-beat-conflict',
        `An automation point already exists at beat ${input.beat}.`,
      );
    }
    if (currentLane === undefined && project.automationLanes.length >= MAX_AUTOMATION_LANES) {
      return failure(
        'lane-limit',
        `A project can contain at most ${MAX_AUTOMATION_LANES} automation lanes.`,
      );
    }
    if (
      currentLane !== undefined
      && currentLane.points.length >= MAX_AUTOMATION_POINTS_PER_LANE
    ) {
      return failure(
        'point-limit',
        `An automation lane can contain at most ${MAX_AUTOMATION_POINTS_PER_LANE} points.`,
      );
    }
    if (!isRecord(options)) {
      return failure('id-factory-failed', 'Automation id options must be an object.');
    }

    const reserved = allEntityIds(project);
    let laneId = currentLane?.id;
    if (laneId === undefined) {
      const allocatedLane = allocateId(
        'lane',
        hasOwn(options, 'laneId') ? options.laneId : undefined,
        (options.idFactory as AutomationIdFactory | undefined) ?? defaultIdFactory,
        reserved,
      );
      if (!allocatedLane.ok) return allocatedLane.result;
      laneId = allocatedLane.id;
    }
    const allocatedPoint = allocateId(
      'point',
      hasOwn(options, 'pointId') ? options.pointId : undefined,
      (options.idFactory as AutomationIdFactory | undefined) ?? defaultIdFactory,
      reserved,
    );
    if (!allocatedPoint.ok) return allocatedPoint.result;

    const point: AutomationPoint = {
      id: allocatedPoint.id,
      beat: input.beat as number,
      value: input.value as number,
      interpolation: input.interpolation as AutomationInterpolation,
    };
    if (currentLane === undefined) {
      const lane: AutomationLane = {
        id: laneId,
        target,
        points: [point],
      };
      return success({
        ...project,
        automationLanes: [...project.automationLanes, lane],
      }, target.trackId, lane.id, true, point.id);
    }

    const nextLane: AutomationLane = {
      ...currentLane,
      points: [...currentLane.points, point].sort((left, right) => left.beat - right.beat),
    };
    return success({
      ...project,
      automationLanes: project.automationLanes.map((lane) =>
        lane.id === currentLane.id ? nextLane : lane),
    }, target.trackId, currentLane.id, true, point.id);
  });
}

/** Update one point while preserving its stable id and the lane's beat order. */
export function updateAutomationPoint(
  project: Project,
  laneId: string,
  pointId: string,
  patch: UpdateAutomationPointPatch,
): AutomationMutationResult {
  return runMutation(project, () => {
    const locatedLane = laneById(project, laneId);
    if (locatedLane === null) {
      return failure('lane-not-found', `Automation lane not found: ${String(laneId)}`);
    }
    const { lane, index: laneIndex } = locatedLane;
    const pointIndex = lane.points.findIndex((point) => point.id === pointId);
    const current = lane.points[pointIndex];
    if (current === undefined) {
      return failure('point-not-found', `Automation point not found: ${String(pointId)}`);
    }
    if (!isRecord(patch)) {
      return failure('unexpected', 'Automation point patch must be an object.');
    }

    const beat = hasOwn(patch, 'beat') ? patch.beat : current.beat;
    const value = hasOwn(patch, 'value') ? patch.value : current.value;
    const interpolation = hasOwn(patch, 'interpolation')
      ? patch.interpolation
      : current.interpolation;
    const beatFailure = validateBeat(project, beat);
    if (beatFailure) return beatFailure;
    const valueFailure = validateValue(lane.target, value);
    if (valueFailure) return valueFailure;
    const interpolationFailure = validateInterpolation(interpolation);
    if (interpolationFailure) return interpolationFailure;
    if (
      beat !== current.beat
      && lane.points.some((point) => point.id !== current.id && point.beat === beat)
    ) {
      return failure(
        'point-beat-conflict',
        `An automation point already exists at beat ${String(beat)}.`,
      );
    }
    if (
      beat === current.beat
      && value === current.value
      && interpolation === current.interpolation
    ) {
      return success(project, lane.target.trackId, lane.id, false, current.id);
    }

    const nextPoint: AutomationPoint = {
      id: current.id,
      beat: beat as number,
      value: value as number,
      interpolation: interpolation as AutomationInterpolation,
    };
    const nextLane: AutomationLane = {
      ...lane,
      points: lane.points
        .map((point) => point.id === current.id ? nextPoint : point)
        .sort((left, right) => left.beat - right.beat),
    };
    const automationLanes = [...project.automationLanes];
    automationLanes[laneIndex] = nextLane;
    return success({
      ...project,
      automationLanes,
    }, lane.target.trackId, lane.id, true, current.id);
  });
}

/** Remove one point and prune the lane when it becomes empty. */
export function removeAutomationPoint(
  project: Project,
  laneId: string,
  pointId: string,
): AutomationMutationResult {
  return runMutation(project, () => {
    const locatedLane = laneById(project, laneId);
    if (locatedLane === null) {
      return failure('lane-not-found', `Automation lane not found: ${String(laneId)}`);
    }
    const { lane, index: laneIndex } = locatedLane;
    const point = lane.points.find((candidate) => candidate.id === pointId);
    if (point === undefined) {
      return failure('point-not-found', `Automation point not found: ${String(pointId)}`);
    }
    const points = lane.points.filter((candidate) => candidate.id !== point.id);
    if (points.length === 0) {
      return success({
        ...project,
        automationLanes: project.automationLanes.filter(
          (candidate) => candidate.id !== lane.id,
        ),
      }, lane.target.trackId, lane.id, true, point.id);
    }
    const automationLanes = [...project.automationLanes];
    automationLanes[laneIndex] = { ...lane, points };
    return success({
      ...project,
      automationLanes,
    }, lane.target.trackId, lane.id, true, point.id);
  });
}

/** Remove a whole lane and all of its points in one immutable change. */
export function clearAutomationLane(
  project: Project,
  laneId: string,
): AutomationMutationResult {
  return runMutation(project, () => {
    const locatedLane = laneById(project, laneId);
    if (locatedLane === null) {
      return failure('lane-not-found', `Automation lane not found: ${String(laneId)}`);
    }
    const { lane } = locatedLane;
    return success({
      ...project,
      automationLanes: project.automationLanes.filter(
        (candidate) => candidate.id !== lane.id,
      ),
    }, lane.target.trackId, lane.id, true);
  });
}
