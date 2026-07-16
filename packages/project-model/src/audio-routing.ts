import type {
  AudioRouteDestination,
  AudioRouting,
  AudioSend,
  AudioSendPosition,
  Project,
  TrackOutputRoute,
} from './types';

export const MAX_AUDIO_SENDS_PER_SOURCE = 16;
export const MAX_AUDIO_ROUTING_EDGES = 1_024;
const MAX_AUDIO_ROUTING_ERRORS = 100;

export type AudioRoutingValidationError = Readonly<{
  path: string;
  message: string;
}>;

export type AudioRoutingValidationResult = Readonly<{
  ok: boolean;
  errors: readonly AudioRoutingValidationError[];
}>;

export type CompiledAudioOutputEdge = Readonly<{
  kind: 'output';
  sourceTrackId: string;
  destination: AudioRouteDestination;
}>;

export type CompiledAudioSendEdge = Readonly<{
  kind: 'send';
  sendId: string;
  sourceTrackId: string;
  destination: Readonly<{ type: 'bus'; trackId: string }>;
  position: AudioSendPosition;
  gain: number;
  enabled: boolean;
}>;

export type CompiledAudioRoutingEdge = CompiledAudioOutputEdge | CompiledAudioSendEdge;

/**
 * Deterministic, immutable structural plan shared by realtime and offline audio.
 * `topologicalTrackIds` always orders a source before every Bus it feeds.
 */
export type CompiledAudioRoutingPlan = Readonly<{
  topologicalTrackIds: readonly string[];
  edges: readonly CompiledAudioRoutingEdge[];
  outputsBySource: Readonly<Record<string, TrackOutputRoute>>;
  sendsBySource: Readonly<Record<string, readonly AudioSend[]>>;
}>;

export type CompileAudioRoutingResult =
  | Readonly<{ ok: true; plan: CompiledAudioRoutingPlan }>
  | Readonly<{ ok: false; errors: readonly AudioRoutingValidationError[] }>;

type RoutingProject = Pick<Project, 'tracks' | 'audioRouting'>;

function readonlyRecord<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(record);
}

function inspectAudioRouting(project: RoutingProject): {
  errors: AudioRoutingValidationError[];
  topologicalTrackIds: string[];
} {
  const errors: AudioRoutingValidationError[] = [];
  const push = (path: string, message: string): void => {
    if (errors.length < MAX_AUDIO_ROUTING_ERRORS) errors.push({ path, message });
  };

  const tracksById = new Map(project.tracks.map((track) => [track.id, track]));
  const nonMasterTrackIds: string[] = [];
  const trackOrder = new Map<string, number>();
  for (const [index, track] of project.tracks.entries()) {
    if (track.type !== 'master' && !trackOrder.has(track.id)) {
      trackOrder.set(track.id, index);
      nonMasterTrackIds.push(track.id);
    }
  }

  const edgeCount = project.audioRouting.outputs.length + project.audioRouting.sends.length;
  if (edgeCount > MAX_AUDIO_ROUTING_EDGES) {
    push(
      'audioRouting',
      `audio routing must contain at most ${MAX_AUDIO_ROUTING_EDGES} output and send edges`,
    );
  }

  const outputBySource = new Map<string, { route: TrackOutputRoute; index: number }>();
  for (const [index, output] of project.audioRouting.outputs.entries()) {
    const path = `audioRouting.outputs[${index}]`;
    const source = tracksById.get(output.sourceTrackId);
    if (source === undefined) {
      push(`${path}.sourceTrackId`, `output references missing track "${output.sourceTrackId}"`);
    } else if (source.type === 'master') {
      push(`${path}.sourceTrackId`, 'Master tracks must not have an output route');
    }
    if (outputBySource.has(output.sourceTrackId)) {
      push(`${path}.sourceTrackId`, `track "${output.sourceTrackId}" must have exactly one output route`);
    } else {
      outputBySource.set(output.sourceTrackId, { route: output, index });
    }

    if (output.destination.type === 'bus') {
      const target = tracksById.get(output.destination.trackId);
      if (target === undefined) {
        push(
          `${path}.destination.trackId`,
          `output references missing Bus track "${output.destination.trackId}"`,
        );
      } else if (target.type !== 'bus') {
        push(`${path}.destination.trackId`, 'output destination must be a Bus track');
      }
      if (output.sourceTrackId === output.destination.trackId) {
        push(`${path}.destination.trackId`, 'a track cannot output to itself');
      }
    }
  }

  for (const track of project.tracks) {
    const output = outputBySource.get(track.id);
    if (track.type === 'master') {
      if (output !== undefined) {
        push(
          `audioRouting.outputs[${output.index}].sourceTrackId`,
          'Master tracks must not have an output route',
        );
      }
    } else if (output === undefined) {
      push('audioRouting.outputs', `non-Master track "${track.id}" requires exactly one output route`);
    }
  }

  const sendsPerSource = new Map<string, number>();
  const sendTargetsBySource = new Map<string, Set<string>>();
  const sendIds = new Set<string>();
  for (const [index, send] of project.audioRouting.sends.entries()) {
    const path = `audioRouting.sends[${index}]`;
    if (sendIds.has(send.id)) {
      push(`${path}.id`, `duplicate send id "${send.id}"`);
    } else {
      sendIds.add(send.id);
    }
    const source = tracksById.get(send.sourceTrackId);
    if (source === undefined) {
      push(`${path}.sourceTrackId`, `send references missing track "${send.sourceTrackId}"`);
    } else if (source.type === 'master') {
      push(`${path}.sourceTrackId`, 'Master tracks cannot own sends');
    }
    const target = tracksById.get(send.targetBusId);
    if (target === undefined) {
      push(`${path}.targetBusId`, `send references missing Bus track "${send.targetBusId}"`);
    } else if (target.type !== 'bus') {
      push(`${path}.targetBusId`, 'send destination must be a Bus track');
    }
    if (send.sourceTrackId === send.targetBusId) {
      push(`${path}.targetBusId`, 'a track cannot send to itself');
    }
    if (!Number.isFinite(send.gain) || send.gain < 0 || send.gain > 2) {
      push(`${path}.gain`, `send gain must be a finite linear value between 0 and 2 (got ${send.gain})`);
    }
    if (send.position !== 'pre-fader' && send.position !== 'post-fader') {
      push(`${path}.position`, `unsupported send position "${String(send.position)}"`);
    }
    if (typeof send.enabled !== 'boolean') {
      push(`${path}.enabled`, 'send enabled must be a boolean');
    }

    const count = (sendsPerSource.get(send.sourceTrackId) ?? 0) + 1;
    sendsPerSource.set(send.sourceTrackId, count);
    if (count > MAX_AUDIO_SENDS_PER_SOURCE) {
      push(
        `${path}.sourceTrackId`,
        `a track can own at most ${MAX_AUDIO_SENDS_PER_SOURCE} sends`,
      );
    }

    const sourceTargets = sendTargetsBySource.get(send.sourceTrackId) ?? new Set<string>();
    if (sourceTargets.has(send.targetBusId)) {
      push(`${path}.targetBusId`, 'duplicate sends from one source to the same Bus are not allowed');
    } else {
      sourceTargets.add(send.targetBusId);
      sendTargetsBySource.set(send.sourceTrackId, sourceTargets);
    }
    const mainOutput = outputBySource.get(send.sourceTrackId)?.route.destination;
    if (mainOutput?.type === 'bus' && mainOutput.trackId === send.targetBusId) {
      push(`${path}.targetBusId`, 'a send cannot target the same Bus as the main output');
    }
  }

  // Every configured edge participates, even if a send is disabled or at zero gain.
  const adjacency = new Map<string, string[]>(nonMasterTrackIds.map((id) => [id, []]));
  const indegree = new Map<string, number>(nonMasterTrackIds.map((id) => [id, 0]));
  const addGraphEdge = (sourceId: string, targetId: string): void => {
    const source = tracksById.get(sourceId);
    const target = tracksById.get(targetId);
    if (source?.type === 'master' || target?.type !== 'bus') return;
    if (!adjacency.has(sourceId) || !indegree.has(targetId)) return;
    adjacency.get(sourceId)!.push(targetId);
    indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
  };
  for (const output of project.audioRouting.outputs) {
    if (output.destination.type === 'bus') {
      addGraphEdge(output.sourceTrackId, output.destination.trackId);
    }
  }
  for (const send of project.audioRouting.sends) {
    addGraphEdge(send.sourceTrackId, send.targetBusId);
  }

  const compareTrackOrder = (left: string, right: string): number =>
    (trackOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (trackOrder.get(right) ?? Number.MAX_SAFE_INTEGER);
  const ready = nonMasterTrackIds.filter((id) => indegree.get(id) === 0).sort(compareTrackOrder);
  const topologicalTrackIds: string[] = [];
  while (ready.length > 0) {
    const sourceId = ready.shift()!;
    topologicalTrackIds.push(sourceId);
    for (const targetId of adjacency.get(sourceId) ?? []) {
      const nextIndegree = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, nextIndegree);
      if (nextIndegree === 0) {
        ready.push(targetId);
        ready.sort(compareTrackOrder);
      }
    }
  }
  if (topologicalTrackIds.length !== nonMasterTrackIds.length) {
    push('audioRouting', 'audio routing graph must be acyclic');
  }

  return { errors, topologicalTrackIds };
}

export function validateAudioRouting(project: RoutingProject): AudioRoutingValidationResult {
  const { errors } = inspectAudioRouting(project);
  return { ok: errors.length === 0, errors };
}

/** Compile a validated routing graph without mutating the Project. */
export function compileAudioRouting(project: RoutingProject): CompileAudioRoutingResult {
  const { errors, topologicalTrackIds } = inspectAudioRouting(project);
  if (errors.length > 0) return { ok: false, errors };

  const outputs = new Map(project.audioRouting.outputs.map((output) => [output.sourceTrackId, output]));
  const sends = new Map<string, AudioSend[]>();
  for (const send of project.audioRouting.sends) {
    const sourceSends = sends.get(send.sourceTrackId) ?? [];
    sourceSends.push(send);
    sends.set(send.sourceTrackId, sourceSends);
  }

  const outputEntries: Array<readonly [string, TrackOutputRoute]> = [];
  const sendEntries: Array<readonly [string, readonly AudioSend[]]> = [];
  const edges: CompiledAudioRoutingEdge[] = [];
  for (const sourceTrackId of topologicalTrackIds) {
    const output = outputs.get(sourceTrackId)!;
    const compiledOutput: TrackOutputRoute = Object.freeze({
      sourceTrackId: output.sourceTrackId,
      destination: Object.freeze({ ...output.destination }),
    });
    outputEntries.push([sourceTrackId, compiledOutput]);
    edges.push(Object.freeze({
      kind: 'output',
      sourceTrackId,
      destination: compiledOutput.destination,
    }));

    const compiledSends = Object.freeze((sends.get(sourceTrackId) ?? []).map((send) =>
      Object.freeze({ ...send }),
    ));
    sendEntries.push([sourceTrackId, compiledSends]);
    for (const send of compiledSends) {
      edges.push(Object.freeze({
        kind: 'send',
        sendId: send.id,
        sourceTrackId,
        destination: Object.freeze({ type: 'bus', trackId: send.targetBusId }),
        position: send.position,
        gain: send.gain,
        enabled: send.enabled,
      }));
    }
  }

  return {
    ok: true,
    plan: Object.freeze({
      topologicalTrackIds: Object.freeze([...topologicalTrackIds]),
      edges: Object.freeze(edges),
      outputsBySource: readonlyRecord(outputEntries),
      sendsBySource: readonlyRecord(sendEntries),
    }),
  };
}
