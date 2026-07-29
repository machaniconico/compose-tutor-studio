// Pure, no-throw tempo and time-signature map commands. The application store
// owns timestamps and turns each successful Project replacement into one Undo
// history entry.

import { makeId } from './ids';
import {
  encodeProjectJson,
  MAX_PROJECT_STRING_LENGTH,
  type ProjectCodecIssue,
} from './project-codec';
import type {
  Project,
  TempoMapEvent,
  TimeSignatureMapEvent,
} from './types';
import {
  MAX_PROJECT_LENGTH_BARS,
  MAX_TEMPO_MAP_EVENTS,
  MAX_TIME_SIGNATURE_MAP_EVENTS,
  MAX_TIME_SIGNATURE_NUMERATOR,
} from './validation';

export type TempoMapKind = 'tempo' | 'time-signature';

export type TempoMapEventIdFactory = (kind: TempoMapKind) => string;

export type TempoMapMutationErrorCode =
  | 'event-not-found'
  | 'anchor-protected'
  | 'invalid-beat'
  | 'invalid-bpm'
  | 'invalid-time-signature'
  | 'event-beat-conflict'
  | 'invalid-bar-boundary'
  | 'map-limit'
  | 'duplicate-id'
  | 'id-factory-failed'
  | 'project-not-adoptable'
  | 'invalid-map'
  | 'unexpected';

export type TempoMapMutationError = Readonly<{
  code: TempoMapMutationErrorCode;
  message: string;
  issues?: readonly ProjectCodecIssue[];
}>;

export type TempoMapMutationResult =
  | Readonly<{
      ok: true;
      project: Project;
      changed: boolean;
      map: TempoMapKind;
      eventId: string;
    }>
  | Readonly<{
      ok: false;
      project: Project;
      changed: false;
      error: TempoMapMutationError;
    }>;

export type AddTempoMapEventInput = Readonly<Pick<TempoMapEvent, 'beat' | 'bpm'>>;

export type UpdateTempoMapEventPatch = Readonly<Partial<
  Pick<TempoMapEvent, 'beat' | 'bpm'>
>>;

export type AddTimeSignatureMapEventInput = Readonly<
  Pick<TimeSignatureMapEvent, 'beat' | 'numerator' | 'denominator'>
>;

export type UpdateTimeSignatureMapEventPatch = Readonly<Partial<
  Pick<TimeSignatureMapEvent, 'beat' | 'numerator' | 'denominator'>
>>;

export type TempoMapEventOptions = Readonly<{
  eventId?: string;
  idFactory?: TempoMapEventIdFactory;
}>;

type TempoMapMutationFailure = Extract<TempoMapMutationResult, { ok: false }>;

type IdAllocationResult =
  | Readonly<{ ok: true; id: string }>
  | Readonly<{ ok: false; result: TempoMapMutationFailure }>;

type LengthBarsResult =
  | Readonly<{ ok: true; lengthBars: number }>
  | Readonly<{ ok: false; result: TempoMapMutationFailure }>;

const VALID_TIME_SIGNATURE_DENOMINATORS = new Set([2, 4, 8, 16]);

const defaultIdFactory: TempoMapEventIdFactory = (kind) =>
  makeId(kind === 'tempo' ? 'tempo' : 'signature');

function failure(
  project: Project,
  code: TempoMapMutationErrorCode,
  message: string,
  issues?: readonly ProjectCodecIssue[],
): TempoMapMutationFailure {
  return {
    ok: false,
    project,
    changed: false,
    error: { code, message, ...(issues === undefined ? {} : { issues }) },
  };
}

function success(
  project: Project,
  map: TempoMapKind,
  eventId: string,
  changed: boolean,
): TempoMapMutationResult {
  return { ok: true, project, changed, map, eventId };
}

function codecFailure(
  candidate: Project,
  source: Project,
  code: 'project-not-adoptable' | 'invalid-map',
): TempoMapMutationFailure | null {
  try {
    const encoded = encodeProjectJson(candidate);
    if (encoded.ok) return null;
    const first = encoded.error.issues[0];
    return failure(
      source,
      code,
      code === 'project-not-adoptable'
        ? `Project codec rejected the map source.${first ? ` ${first.path}: ${first.message}` : ''}`
        : `Tempo or time-signature map change was rejected.${first ? ` ${first.path}: ${first.message}` : ''}`,
      encoded.error.issues,
    );
  } catch {
    return failure(
      source,
      code,
      code === 'project-not-adoptable'
        ? 'Project codec could not safely inspect the map source.'
        : 'Project codec could not safely inspect the map change.',
    );
  }
}

function runMutation(
  project: Project,
  build: () => TempoMapMutationResult,
): TempoMapMutationResult {
  try {
    const inputFailure = codecFailure(project, project, 'project-not-adoptable');
    if (inputFailure) return inputFailure;
    const built = build();
    if (!built.ok || !built.changed) return built;
    return codecFailure(built.project, project, 'invalid-map') ?? built;
  } catch {
    return failure(
      project,
      'unexpected',
      'The tempo or time-signature map change could not be completed safely.',
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateBeat(
  project: Project,
  beat: unknown,
  existingBeat?: number,
): TempoMapMutationFailure | null {
  const preservesCanonicalTerminalEvent =
    existingBeat === project.lengthBeats
    && beat === existingBeat;
  if (
    typeof beat !== 'number'
    || !Number.isFinite(beat)
    || beat < 0
    || beat > project.lengthBeats
    || (beat === project.lengthBeats && !preservesCanonicalTerminalEvent)
  ) {
    return failure(
      project,
      'invalid-beat',
      `Map event beat must be finite and between 0 (inclusive) and ${project.lengthBeats} (exclusive).`,
    );
  }
  return null;
}

function validateBpm(
  project: Project,
  bpm: unknown,
): TempoMapMutationFailure | null {
  if (
    typeof bpm !== 'number'
    || !Number.isFinite(bpm)
    || bpm < 20
    || bpm > 300
  ) {
    return failure(
      project,
      'invalid-bpm',
      'Tempo must be finite and between 20 and 300 BPM.',
    );
  }
  return null;
}

function validateTimeSignature(
  project: Project,
  numerator: unknown,
  denominator: unknown,
): TempoMapMutationFailure | null {
  if (
    typeof numerator !== 'number'
    || !Number.isInteger(numerator)
    || numerator < 1
    || numerator > MAX_TIME_SIGNATURE_NUMERATOR
    || typeof denominator !== 'number'
    || !VALID_TIME_SIGNATURE_DENOMINATORS.has(denominator)
  ) {
    return failure(
      project,
      'invalid-time-signature',
      `Time signature must use an integer numerator from 1 to ${MAX_TIME_SIGNATURE_NUMERATOR} and denominator 2, 4, 8, or 16.`,
    );
  }
  return null;
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

function allocateEventId(
  project: Project,
  kind: TempoMapKind,
  options: unknown,
): IdAllocationResult {
  if (!isRecord(options)) {
    return {
      ok: false,
      result: failure(project, 'id-factory-failed', 'Map event id options must be an object.'),
    };
  }
  const requestedId = hasOwn(options, 'eventId') ? options.eventId : undefined;
  let id: unknown = requestedId;
  if (id === undefined) {
    const factory = hasOwn(options, 'idFactory') ? options.idFactory : defaultIdFactory;
    if (typeof factory !== 'function') {
      return {
        ok: false,
        result: failure(project, 'id-factory-failed', 'Map event id factory must be a function.'),
      };
    }
    try {
      id = (factory as TempoMapEventIdFactory)(kind);
    } catch {
      return {
        ok: false,
        result: failure(
          project,
          'id-factory-failed',
          `The id factory failed while creating a ${kind} event id.`,
        ),
      };
    }
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROJECT_STRING_LENGTH) {
    return {
      ok: false,
      result: failure(
        project,
        'id-factory-failed',
        `A map event id must contain 1..${MAX_PROJECT_STRING_LENGTH} characters.`,
      ),
    };
  }
  if (allEntityIds(project).has(id)) {
    return {
      ok: false,
      result: failure(project, 'duplicate-id', `The map event id already exists: ${id}`),
    };
  }
  return { ok: true, id };
}

function computeLengthBars(
  project: Project,
  timeSignatureMap: readonly TimeSignatureMapEvent[],
): LengthBarsResult {
  let lengthBars = 0;
  for (let index = 0; index < timeSignatureMap.length; index += 1) {
    const event = timeSignatureMap[index];
    if (event === undefined) {
      return {
        ok: false,
        result: failure(project, 'invalid-bar-boundary', 'Time-signature map is incomplete.'),
      };
    }
    const valueFailure = validateTimeSignature(project, event.numerator, event.denominator);
    if (valueFailure) return { ok: false, result: valueFailure };
    if (index === 0) {
      if (event.beat !== 0) {
        return {
          ok: false,
          result: failure(
            project,
            'anchor-protected',
            'The first time-signature event must remain anchored at beat 0.',
          ),
        };
      }
      continue;
    }
    const previous = timeSignatureMap[index - 1];
    if (previous === undefined || event.beat <= previous.beat) {
      return {
        ok: false,
        result: failure(
          project,
          'event-beat-conflict',
          'Time-signature event beats must be strictly increasing.',
        ),
      };
    }
    const previousBeatsPerBar = previous.numerator * 4 / previous.denominator;
    const segmentBars = (event.beat - previous.beat) / previousBeatsPerBar;
    if (!Number.isSafeInteger(segmentBars) || segmentBars <= 0) {
      return {
        ok: false,
        result: failure(
          project,
          'invalid-bar-boundary',
          `Time-signature event at beat ${event.beat} is not on a bar boundary.`,
        ),
      };
    }
    lengthBars += segmentBars;
  }

  const finalEvent = timeSignatureMap[timeSignatureMap.length - 1];
  if (finalEvent === undefined) {
    return {
      ok: false,
      result: failure(
        project,
        'anchor-protected',
        'Time-signature map must retain its beat-0 anchor.',
      ),
    };
  }
  const finalBeatsPerBar = finalEvent.numerator * 4 / finalEvent.denominator;
  const finalBars = (project.lengthBeats - finalEvent.beat) / finalBeatsPerBar;
  if (!Number.isSafeInteger(finalBars) || finalBars < 0) {
    return {
      ok: false,
      result: failure(
        project,
        'invalid-bar-boundary',
        'The project end must remain on a time-signature bar boundary.',
      ),
    };
  }
  lengthBars += finalBars;
  if (
    !Number.isSafeInteger(lengthBars)
    || lengthBars < 1
    || lengthBars > MAX_PROJECT_LENGTH_BARS
  ) {
    return {
      ok: false,
      result: failure(
        project,
        'invalid-bar-boundary',
        `The edited map must describe between 1 and ${MAX_PROJECT_LENGTH_BARS} complete bars.`,
      ),
    };
  }
  return { ok: true, lengthBars };
}

/** Add one tempo event and keep the map strictly beat-sorted. */
export function addTempoMapEvent(
  project: Project,
  input: AddTempoMapEventInput,
  options: TempoMapEventOptions = {},
): TempoMapMutationResult {
  return runMutation(project, () => {
    if (!isRecord(input)) {
      return failure(project, 'invalid-beat', 'Tempo event input must be an object.');
    }
    const beatFailure = validateBeat(project, input.beat);
    if (beatFailure) return beatFailure;
    const bpmFailure = validateBpm(project, input.bpm);
    if (bpmFailure) return bpmFailure;
    if (project.tempoMap.some((event) => event.beat === input.beat)) {
      return failure(
        project,
        'event-beat-conflict',
        `A tempo event already exists at beat ${input.beat}.`,
      );
    }
    if (project.tempoMap.length >= MAX_TEMPO_MAP_EVENTS) {
      return failure(
        project,
        'map-limit',
        `A project can contain at most ${MAX_TEMPO_MAP_EVENTS} tempo events.`,
      );
    }
    const allocated = allocateEventId(project, 'tempo', options);
    if (!allocated.ok) return allocated.result;
    const event: TempoMapEvent = {
      id: allocated.id,
      beat: input.beat as number,
      bpm: input.bpm as number,
    };
    const tempoMap = [...project.tempoMap, event].sort((left, right) => left.beat - right.beat);
    return success({
      ...project,
      bpm: tempoMap[0]?.bpm ?? project.bpm,
      tempoMap,
    }, 'tempo', event.id, true);
  });
}

/** Update or move one tempo event while preserving its stable id. */
export function updateTempoMapEvent(
  project: Project,
  eventId: string,
  patch: UpdateTempoMapEventPatch,
): TempoMapMutationResult {
  return runMutation(project, () => {
    const current = project.tempoMap.find((event) => event.id === eventId);
    if (current === undefined) {
      return failure(project, 'event-not-found', `Tempo event not found: ${String(eventId)}`);
    }
    if (!isRecord(patch)) {
      return failure(project, 'unexpected', 'Tempo event patch must be an object.');
    }
    const beat = hasOwn(patch, 'beat') ? patch.beat : current.beat;
    const bpm = hasOwn(patch, 'bpm') ? patch.bpm : current.bpm;
    const beatFailure = validateBeat(project, beat, current.beat);
    if (beatFailure) return beatFailure;
    const bpmFailure = validateBpm(project, bpm);
    if (bpmFailure) return bpmFailure;
    if (current.beat === 0 && beat !== 0) {
      return failure(
        project,
        'anchor-protected',
        'The beat-0 tempo event cannot be moved.',
      );
    }
    if (
      beat !== current.beat
      && project.tempoMap.some((event) => event.id !== current.id && event.beat === beat)
    ) {
      return failure(
        project,
        'event-beat-conflict',
        `A tempo event already exists at beat ${String(beat)}.`,
      );
    }
    if (beat === current.beat && bpm === current.bpm) {
      return success(project, 'tempo', current.id, false);
    }
    const nextEvent: TempoMapEvent = {
      id: current.id,
      beat: beat as number,
      bpm: bpm as number,
    };
    const tempoMap = project.tempoMap
      .map((event) => event.id === current.id ? nextEvent : event)
      .sort((left, right) => left.beat - right.beat);
    return success({
      ...project,
      bpm: tempoMap[0]?.bpm ?? project.bpm,
      tempoMap,
    }, 'tempo', current.id, true);
  });
}

/** Remove a non-anchor tempo event. */
export function removeTempoMapEvent(
  project: Project,
  eventId: string,
): TempoMapMutationResult {
  return runMutation(project, () => {
    const current = project.tempoMap.find((event) => event.id === eventId);
    if (current === undefined) {
      return failure(project, 'event-not-found', `Tempo event not found: ${String(eventId)}`);
    }
    if (current.beat === 0) {
      return failure(
        project,
        'anchor-protected',
        'The beat-0 tempo event cannot be deleted.',
      );
    }
    return success({
      ...project,
      tempoMap: project.tempoMap.filter((event) => event.id !== current.id),
    }, 'tempo', current.id, true);
  });
}

/** Add one time-signature event when the complete map remains bar-aligned. */
export function addTimeSignatureMapEvent(
  project: Project,
  input: AddTimeSignatureMapEventInput,
  options: TempoMapEventOptions = {},
): TempoMapMutationResult {
  return runMutation(project, () => {
    if (!isRecord(input)) {
      return failure(project, 'invalid-beat', 'Time-signature event input must be an object.');
    }
    const beatFailure = validateBeat(project, input.beat);
    if (beatFailure) return beatFailure;
    const signatureFailure = validateTimeSignature(
      project,
      input.numerator,
      input.denominator,
    );
    if (signatureFailure) return signatureFailure;
    if (project.timeSignatureMap.some((event) => event.beat === input.beat)) {
      return failure(
        project,
        'event-beat-conflict',
        `A time-signature event already exists at beat ${input.beat}.`,
      );
    }
    if (project.timeSignatureMap.length >= MAX_TIME_SIGNATURE_MAP_EVENTS) {
      return failure(
        project,
        'map-limit',
        `A project can contain at most ${MAX_TIME_SIGNATURE_MAP_EVENTS} time-signature events.`,
      );
    }
    const allocated = allocateEventId(project, 'time-signature', options);
    if (!allocated.ok) return allocated.result;
    const event: TimeSignatureMapEvent = {
      id: allocated.id,
      beat: input.beat as number,
      numerator: input.numerator as number,
      denominator: input.denominator as number,
    };
    const timeSignatureMap = [...project.timeSignatureMap, event]
      .sort((left, right) => left.beat - right.beat);
    const lengthBarsResult = computeLengthBars(project, timeSignatureMap);
    if (!lengthBarsResult.ok) return lengthBarsResult.result;
    const anchor = timeSignatureMap[0];
    if (anchor === undefined) {
      return failure(project, 'anchor-protected', 'Time-signature anchor is missing.');
    }
    return success({
      ...project,
      timeSignature: [anchor.numerator, anchor.denominator],
      timeSignatureMap,
      lengthBars: lengthBarsResult.lengthBars,
    }, 'time-signature', event.id, true);
  });
}

/** Update or move one time-signature event when the complete map remains valid. */
export function updateTimeSignatureMapEvent(
  project: Project,
  eventId: string,
  patch: UpdateTimeSignatureMapEventPatch,
): TempoMapMutationResult {
  return runMutation(project, () => {
    const current = project.timeSignatureMap.find((event) => event.id === eventId);
    if (current === undefined) {
      return failure(
        project,
        'event-not-found',
        `Time-signature event not found: ${String(eventId)}`,
      );
    }
    if (!isRecord(patch)) {
      return failure(project, 'unexpected', 'Time-signature event patch must be an object.');
    }
    const beat = hasOwn(patch, 'beat') ? patch.beat : current.beat;
    const numerator = hasOwn(patch, 'numerator') ? patch.numerator : current.numerator;
    const denominator = hasOwn(patch, 'denominator')
      ? patch.denominator
      : current.denominator;
    const beatFailure = validateBeat(project, beat, current.beat);
    if (beatFailure) return beatFailure;
    const signatureFailure = validateTimeSignature(project, numerator, denominator);
    if (signatureFailure) return signatureFailure;
    if (current.beat === 0 && beat !== 0) {
      return failure(
        project,
        'anchor-protected',
        'The beat-0 time-signature event cannot be moved.',
      );
    }
    if (
      beat !== current.beat
      && project.timeSignatureMap.some(
        (event) => event.id !== current.id && event.beat === beat,
      )
    ) {
      return failure(
        project,
        'event-beat-conflict',
        `A time-signature event already exists at beat ${String(beat)}.`,
      );
    }
    if (
      beat === current.beat
      && numerator === current.numerator
      && denominator === current.denominator
    ) {
      return success(project, 'time-signature', current.id, false);
    }
    const nextEvent: TimeSignatureMapEvent = {
      id: current.id,
      beat: beat as number,
      numerator: numerator as number,
      denominator: denominator as number,
    };
    const timeSignatureMap = project.timeSignatureMap
      .map((event) => event.id === current.id ? nextEvent : event)
      .sort((left, right) => left.beat - right.beat);
    const lengthBarsResult = computeLengthBars(project, timeSignatureMap);
    if (!lengthBarsResult.ok) return lengthBarsResult.result;
    const anchor = timeSignatureMap[0];
    if (anchor === undefined) {
      return failure(project, 'anchor-protected', 'Time-signature anchor is missing.');
    }
    return success({
      ...project,
      timeSignature: [anchor.numerator, anchor.denominator],
      timeSignatureMap,
      lengthBars: lengthBarsResult.lengthBars,
    }, 'time-signature', current.id, true);
  });
}

/** Remove a non-anchor signature event when later bars and project end remain aligned. */
export function removeTimeSignatureMapEvent(
  project: Project,
  eventId: string,
): TempoMapMutationResult {
  return runMutation(project, () => {
    const current = project.timeSignatureMap.find((event) => event.id === eventId);
    if (current === undefined) {
      return failure(
        project,
        'event-not-found',
        `Time-signature event not found: ${String(eventId)}`,
      );
    }
    if (current.beat === 0) {
      return failure(
        project,
        'anchor-protected',
        'The beat-0 time-signature event cannot be deleted.',
      );
    }
    const timeSignatureMap = project.timeSignatureMap.filter(
      (event) => event.id !== current.id,
    );
    const lengthBarsResult = computeLengthBars(project, timeSignatureMap);
    if (!lengthBarsResult.ok) return lengthBarsResult.result;
    const anchor = timeSignatureMap[0];
    if (anchor === undefined) {
      return failure(project, 'anchor-protected', 'Time-signature anchor is missing.');
    }
    return success({
      ...project,
      timeSignature: [anchor.numerator, anchor.denominator],
      timeSignatureMap,
      lengthBars: lengthBarsResult.lengthBars,
    }, 'time-signature', current.id, true);
  });
}
