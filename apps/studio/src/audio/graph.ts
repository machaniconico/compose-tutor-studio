// Per-track audio routing graph and mute/solo resolution.
//
// Each non-master track gets: trackGain (volume) -> insert effects -> panner (pan) -> master bus.
// The master bus + soft limiter live on the AudioEngine. Mute/solo is resolved
// by the pure `computeAudibleTracks` so the rule ("any solo => only solos; mute
// always wins") is unit-testable without any audio nodes, then applied to the
// live gain nodes.

import {
  compileAudioRouting,
  type AutomationTarget,
  type CompiledAudioRoutingPlan,
  type EffectConfig,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  buildEffectChain,
  effectChainNodeCount,
  effectConfigSignature,
  type BuiltEffectChain,
} from './effects';
import {
  applyAudioParam,
  clampPan,
  clampVolume,
  resolveTrackMix,
  type MixUpdateMode,
} from './mixState';

export { clampPan, clampVolume } from './mixState';

export type MeterLevel = {
  /** Highest absolute sample in the analyser window, where 1.0 is 0 dBFS. */
  peak: number;
  /** Root mean square level in the analyser window, where 1.0 is 0 dBFS. */
  rms: number;
  /** True once the analyser window reaches or exceeds 0 dBFS. */
  clipping: boolean;
};

const SILENT_METER: MeterLevel = { peak: 0, rms: 0, clipping: false };
const METER_FFT_SIZE = 1024;
const meterAnalysers = new Map<string, AnalyserNode>();
const meterBuffers = new WeakMap<AnalyserNode, Float32Array<ArrayBuffer>>();
let masterMeter:
  | {
      trackId: string;
      source: AudioNode;
      analyser: AnalyserNode;
      sink: GainNode | null;
    }
  | null = null;

function clearMasterMeter(): void {
  const current = masterMeter;
  if (!current) return;
  masterMeter = null;
  meterAnalysers.delete(current.trackId);
  try {
    current.source.disconnect(current.analyser);
  } catch {
    // already disconnected
  }
  try {
    current.analyser.disconnect();
  } catch {
    // already disconnected
  }
  try {
    current.sink?.disconnect();
  } catch {
    // already disconnected
  }
}

/**
 * Release the live master meter only when the caller still owns its source.
 * Offline graphs never install meters, so exporting cannot disturb this state.
 */
export function disposeMasterMeter(source: AudioNode): void {
  if (masterMeter?.source !== source) return;
  clearMasterMeter();
}

function createMeterAnalyser(ctx: BaseAudioContext): AnalyserNode | null {
  const maybeContext = ctx as BaseAudioContext & {
    createAnalyser?: BaseAudioContext['createAnalyser'];
  };
  if (typeof maybeContext.createAnalyser !== 'function') return null;

  try {
    const analyser = maybeContext.createAnalyser();
    analyser.fftSize = METER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0.35;
    return analyser;
  } catch {
    return null;
  }
}

function connectMeter(analyser: AnalyserNode, source: AudioNode, destination: AudioNode): boolean {
  try {
    source.connect(analyser);
    analyser.connect(destination);
    return true;
  } catch {
    try {
      source.connect(destination);
    } catch {
      // If the graph is already torn down, keep meter setup as a no-op.
    }
    return false;
  }
}

function installMasterMeter(ctx: BaseAudioContext, source: AudioNode, trackId: string | null): void {
  if (trackId === null) {
    clearMasterMeter();
    return;
  }

  if (masterMeter?.source === source) {
    if (masterMeter.trackId !== trackId) {
      meterAnalysers.delete(masterMeter.trackId);
      masterMeter.trackId = trackId;
    }
    meterAnalysers.set(trackId, masterMeter.analyser);
    return;
  }

  clearMasterMeter();

  const analyser = createMeterAnalyser(ctx);
  if (!analyser) {
    masterMeter = null;
    return;
  }

  let sink: GainNode | null = null;
  try {
    sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(ctx.destination);
  } catch {
    try {
      source.connect(analyser);
    } catch {
      masterMeter = null;
      return;
    }
    sink = null;
  }

  masterMeter = { trackId, source, analyser, sink };
  meterAnalysers.set(trackId, analyser);
}

/** Read a lightweight peak/RMS snapshot for a track or master meter. */
export function readMeterLevel(trackId: string): MeterLevel {
  const analyser = meterAnalysers.get(trackId);
  if (!analyser) return SILENT_METER;

  try {
    let buffer = meterBuffers.get(analyser);
    if (!buffer || buffer.length !== analyser.fftSize) {
      buffer = new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer>;
      meterBuffers.set(analyser, buffer);
    }
    analyser.getFloatTimeDomainData(buffer);

    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = Math.abs(buffer[i] ?? 0);
      if (sample > peak) peak = sample;
      sumSquares += sample * sample;
    }

    return {
      peak,
      rms: Math.sqrt(sumSquares / buffer.length),
      clipping: peak >= 1,
    };
  } catch {
    return SILENT_METER;
  }
}

/**
 * Resolve which tracks are audible given mute/solo flags.
 *
 * Rules:
 *  - If at least one track is soloed, only soloed tracks are audible.
 *  - A muted track is never audible (mute overrides solo).
 *  - The master track is not a sound source and is excluded.
 *
 * Pure: returns a Set of audible track ids. Unit tested.
 */
export function computeAudibleTracks(tracks: readonly Track[]): Set<string> {
  const soundTracks = tracks.filter((t) => t.type !== 'master');
  const anySolo = soundTracks.some((t) => t.solo && !t.mute);
  const audible = new Set<string>();
  for (const t of soundTracks) {
    if (t.mute) continue;
    if (anySolo && !t.solo) continue;
    audible.add(t.id);
  }
  return audible;
}

/** Conservative ceiling for persistent channel, effect, meter, and route nodes. */
export const MAX_ROUTING_GRAPH_NODES = 4_096;

export class AudioRoutingGraphError extends Error {
  readonly code: 'invalid-routing' | 'graph-node-limit';

  constructor(
    code: 'invalid-routing' | 'graph-node-limit',
    message: string,
    readonly observedNodes: number | null = null,
  ) {
    super(message);
    this.name = 'AudioRoutingGraphError';
    this.code = code;
  }
}

type CompiledRoutingEdge = CompiledAudioRoutingPlan['edges'][number];

/** Stable runtime identity for a persisted output/send edge. */
export function audioRoutingEdgeKey(edge: CompiledRoutingEdge): string {
  return edge.kind === 'output'
    ? `output:${edge.sourceTrackId}`
    : `send:${edge.sendId}`;
}

/** Deterministic topology signature shared by live/offline parity tests. */
export function audioRoutingTopologySignature(plan: CompiledAudioRoutingPlan): string {
  return plan.edges.map((edge) => {
    const destination = edge.destination.type === 'master'
      ? 'master'
      : `bus:${edge.destination.trackId}`;
    return edge.kind === 'output'
      ? `output:${edge.sourceTrackId}>${destination}`
      : `send:${edge.sendId}:${edge.sourceTrackId}:${edge.position}>${destination}`;
  }).join('|');
}

/** Count every static node before constructing any per-channel AudioNode. */
export function estimateRoutingGraphNodeCount(
  project: Project,
  plan: CompiledAudioRoutingPlan,
  metering: 'live' | 'disabled',
): number {
  const channels = project.tracks.filter((track) => track.type !== 'master');
  const masterMeterNodes = metering === 'live'
    && project.tracks.some((track) => track.type === 'master')
    ? 2
    : 0;
  return masterMeterNodes + channels.reduce(
    (count, track) => count + 4 + (metering === 'live' ? 1 : 0)
      + effectChainNodeCount(track.effects),
    plan.edges.length,
  );
}

export function assertRoutingGraphNodeBudget(
  project: Project,
  plan: CompiledAudioRoutingPlan,
  metering: 'live' | 'disabled',
): number {
  const observed = estimateRoutingGraphNodeCount(project, plan, metering);
  if (!Number.isSafeInteger(observed) || observed > MAX_ROUTING_GRAPH_NODES) {
    throw new AudioRoutingGraphError(
      'graph-node-limit',
      `Audio routing requires more than ${MAX_ROUTING_GRAPH_NODES} static nodes.`,
      Number.isSafeInteger(observed) ? observed : Number.MAX_SAFE_INTEGER,
    );
  }
  return observed;
}

function requireCompiledRouting(project: Project): CompiledAudioRoutingPlan {
  const compiled = compileAudioRouting(project);
  if (compiled.ok) return compiled.plan;
  const first = compiled.errors[0];
  const detail = first ? ` ${first.path}: ${first.message}` : '';
  throw new AudioRoutingGraphError(
    'invalid-routing',
    `Audio routing is invalid.${detail}`,
  );
}

export type ResolvedAudioRoutingMix = Readonly<{
  audibleChannelIds: ReadonlySet<string>;
  activeEdgeIds: ReadonlySet<string>;
  edgeGains: ReadonlyMap<string, number>;
}>;

function currentSendById(project: Project): Map<string, Project['audioRouting']['sends'][number]> {
  return new Map(project.audioRouting.sends.map((send) => [send.id, send]));
}

/**
 * Resolve channel gates separately from route gates.
 *
 * In solo mode, upstream edges which reach a solo and downstream edges which
 * leave a solo are opened. An unrelated dry output from an upstream source is
 * therefore not leaked merely because another send from that source reaches a
 * soloed Bus. Muted channels block traversal and always remain silent.
 */
export function resolveAudioRoutingMix(
  project: Project,
  plan: CompiledAudioRoutingPlan,
): ResolvedAudioRoutingMix {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const sends = currentSendById(project);
  const activeStructuralEdges = plan.edges.filter((edge) => {
    if (edge.kind === 'output') return true;
    const send = sends.get(edge.sendId);
    return send?.enabled === true && clampVolume(send.gain) > 0;
  });
  const outgoing = new Map<string, CompiledRoutingEdge[]>();
  const incoming = new Map<string, CompiledRoutingEdge[]>();
  for (const edge of activeStructuralEdges) {
    const sourceEdges = outgoing.get(edge.sourceTrackId) ?? [];
    sourceEdges.push(edge);
    outgoing.set(edge.sourceTrackId, sourceEdges);
    if (edge.destination.type === 'bus') {
      const targetEdges = incoming.get(edge.destination.trackId) ?? [];
      targetEdges.push(edge);
      incoming.set(edge.destination.trackId, targetEdges);
    }
  }

  const solos = project.tracks.filter(
    (track) => track.type !== 'master' && track.solo && !track.mute,
  );
  const audibleChannelIds = new Set<string>();
  const allowedEdgeIds = new Set<string>();

  if (solos.length === 0) {
    for (const track of project.tracks) {
      if (track.type !== 'master' && !track.mute) audibleChannelIds.add(track.id);
    }
    for (const edge of activeStructuralEdges) {
      if (audibleChannelIds.has(edge.sourceTrackId)) {
        allowedEdgeIds.add(audioRoutingEdgeKey(edge));
      }
    }
  } else {
    const visitUpstream = (startTrackId: string): void => {
      const pending = [startTrackId];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const trackId = pending.pop();
        if (!trackId || visited.has(trackId)) continue;
        visited.add(trackId);
        const track = tracks.get(trackId);
        if (!track || track.type === 'master' || track.mute) continue;
        audibleChannelIds.add(trackId);
        for (const edge of incoming.get(trackId) ?? []) {
          const source = tracks.get(edge.sourceTrackId);
          if (!source || source.type === 'master' || source.mute) continue;
          allowedEdgeIds.add(audioRoutingEdgeKey(edge));
          pending.push(edge.sourceTrackId);
        }
      }
    };
    const visitDownstream = (startTrackId: string): void => {
      const pending = [startTrackId];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const trackId = pending.pop();
        if (!trackId || visited.has(trackId)) continue;
        visited.add(trackId);
        const track = tracks.get(trackId);
        if (!track || track.type === 'master' || track.mute) continue;
        audibleChannelIds.add(trackId);
        for (const edge of outgoing.get(trackId) ?? []) {
          allowedEdgeIds.add(audioRoutingEdgeKey(edge));
          if (edge.destination.type === 'bus') pending.push(edge.destination.trackId);
        }
      }
    };
    for (const solo of solos) {
      visitUpstream(solo.id);
      visitDownstream(solo.id);
    }
  }

  const edgeGains = new Map<string, number>();
  const activeEdgeIds = new Set<string>();
  for (const edge of plan.edges) {
    const key = audioRoutingEdgeKey(edge);
    let gain = 0;
    if (allowedEdgeIds.has(key) && audibleChannelIds.has(edge.sourceTrackId)) {
      if (edge.kind === 'output') {
        gain = 1;
      } else {
        const send = sends.get(edge.sendId);
        gain = send?.enabled === true ? clampVolume(send.gain) : 0;
      }
    }
    edgeGains.set(key, gain);
    if (gain > 0) activeEdgeIds.add(key);
  }
  return { audibleChannelIds, activeEdgeIds, edgeGains };
}

type OwnedRouteEdge = Readonly<{
  key: string;
  tap: AudioNode;
  gain: GainNode;
}>;

/** Live/offline node chain for one source or Bus channel. */
export class TrackGraph {
  readonly trackId: string;
  readonly input: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly audibilityGate: GainNode | null;
  private readonly fader: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly output: AudioNode;
  private readonly outputGain: GainNode | null;
  private readonly meter: AnalyserNode | null;
  private readonly routeEdges = new Map<string, OwnedRouteEdge>();
  private effectChain: BuiltEffectChain | null = null;
  private effectSignature: string | null = null;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode | null,
    track: Track,
    metering: 'live' | 'disabled',
  ) {
    this.ctx = ctx;
    this.trackId = track.id;
    const routed = destination === null;
    let audibilityGate: GainNode | null = null;
    let fader: GainNode | null = null;
    let panner: StereoPannerNode | null = null;
    let outputGain: GainNode | null = null;
    let meter: AnalyserNode | null = null;
    try {
      if (routed) audibilityGate = ctx.createGain();
      fader = ctx.createGain();
      panner = ctx.createStereoPanner();
      if (routed) outputGain = ctx.createGain();
      meter = metering === 'live' ? createMeterAnalyser(ctx) : null;
      // Fail silent until buildTrackGraphs applies the resolved initial mix.
      if (audibilityGate) audibilityGate.gain.value = 0;
      fader.gain.value = 0;
      panner.pan.value = clampPan(track.pan);
      if (audibilityGate) audibilityGate.connect(fader);
      const output = outputGain ?? destination;
      if (!output) throw new Error('TrackGraph: routed output node is unavailable.');
      if (!meter) panner.connect(output);
      else if (connectMeter(meter, panner, output)) {
        meterAnalysers.set(this.trackId, meter);
      }
    } catch (error) {
      for (const node of [audibilityGate, fader, panner, meter, outputGain]) {
        try { node?.disconnect(); } catch { /* never connected */ }
      }
      if (meter && meterAnalysers.get(this.trackId) === meter) {
        meterAnalysers.delete(this.trackId);
      }
      throw error;
    }
    this.audibilityGate = audibilityGate;
    this.fader = fader;
    this.panner = panner;
    this.outputGain = outputGain;
    this.output = outputGain ?? panner;
    this.meter = meter;
    // Routed voices enter the audibility gate. Legacy/direct construction keeps
    // the historical public input=fader shape used by isolated effect tests.
    this.input = audibilityGate ?? fader;
    try {
      this.updateEffects(track.effects);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Apply volume/pan/mute/solo state to the live nodes. */
  apply(
    track: Track,
    audible: boolean,
    when: number,
    mode: MixUpdateMode,
  ): void {
    const mix = resolveTrackMix(track, audible);
    if (this.audibilityGate) {
      this.applyAudibility(audible, when, mode);
      applyAudioParam(this.fader.gain, clampVolume(track.volume), when, mode);
    } else {
      applyAudioParam(this.fader.gain, mix.gain, when, mode);
    }
    applyAudioParam(this.panner.pan, mix.pan, when, mode);
  }

  /** Update only the routed channel gate, preserving fader/pan automation. */
  applyAudibility(
    audible: boolean,
    when: number,
    mode: MixUpdateMode,
  ): void {
    if (!this.audibilityGate) return;
    applyAudioParam(this.audibilityGate.gain, audible ? 1 : 0, when, mode);
  }

  /** Append one sample-accurate volume or pan automation command. */
  scheduleAutomation(
    target: AutomationTarget['type'],
    value: number,
    when: number,
    interpolation: 'hold' | 'linear',
    audible: boolean,
  ): void {
    const param = target === 'track-volume' ? this.fader.gain : this.panner.pan;
    const safeValue = target === 'track-volume'
      ? (this.audibilityGate ? clampVolume(value) : (audible ? clampVolume(value) : 0))
      : clampPan(value);
    const candidate = param as AudioParam & {
      linearRampToValueAtTime?: (value: number, endTime: number) => AudioParam;
      setValueAtTime?: (value: number, startTime: number) => AudioParam;
    };
    if (interpolation === 'linear' && typeof candidate.linearRampToValueAtTime === 'function') {
      candidate.linearRampToValueAtTime(safeValue, when);
    } else if (typeof candidate.setValueAtTime === 'function') {
      candidate.setValueAtTime(safeValue, when);
    } else {
      param.value = safeValue;
    }
  }

  /** Rebuild the insert effect nodes when the track's effect list changes. */
  updateEffects(configs: readonly EffectConfig[]): void {
    const nextSignature = effectConfigSignature(configs);
    if (nextSignature === this.effectSignature) return;

    // Build first so allocation failures leave the currently audible chain
    // untouched. Only replace ownership after every new connection succeeds.
    const nextChain = buildEffectChain(this.ctx, configs);
    const previousChain = this.effectChain;
    try {
      this.fader.disconnect();
      this.connectEffectChain(nextChain);
    } catch (error) {
      nextChain.dispose();
      try {
        this.fader.disconnect();
        if (previousChain) this.connectEffectChain(previousChain);
      } catch {
        // Preserve the new-chain failure. The caller will surface it and a full
        // session rebuild remains available on the next play request.
      }
      throw error;
    }

    previousChain?.dispose();
    this.effectChain = nextChain;
    this.effectSignature = nextSignature;
  }

  private connectEffectChain(chain: BuiltEffectChain): void {
    if (chain.isBypassed || chain.input === null || chain.output === null) {
      this.fader.connect(this.panner);
      return;
    }
    this.fader.connect(chain.input);
    chain.output.connect(this.panner);
  }

  /** Allocate and connect one independently gated main/send edge. */
  connectRouteEdge(
    key: string,
    position: 'pre-fader' | 'post-fader',
    destination: AudioNode,
  ): void {
    if (!this.audibilityGate || !this.outputGain) {
      throw new Error('TrackGraph: direct graphs cannot own routing edges.');
    }
    if (this.routeEdges.has(key)) {
      throw new Error(`TrackGraph: duplicate routing edge ${key}.`);
    }
    const tap = position === 'pre-fader' ? this.audibilityGate : this.output;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    try {
      tap.connect(gain);
      gain.connect(destination);
      this.routeEdges.set(key, { key, tap, gain });
    } catch (error) {
      try { tap.disconnect(gain); } catch { /* builder rollback follows */ }
      try { gain.disconnect(); } catch { /* never connected */ }
      throw error;
    }
  }

  applyRouteEdge(
    key: string,
    gain: number,
    when: number,
    mode: MixUpdateMode,
  ): void {
    const edge = this.routeEdges.get(key);
    if (!edge) return;
    applyAudioParam(edge.gain.gain, clampVolume(gain), when, mode);
  }

  /** Disconnect from the graph. */
  dispose(): void {
    for (const edge of this.routeEdges.values()) {
      try { edge.tap.disconnect(edge.gain); } catch { /* already disconnected */ }
      try { edge.gain.disconnect(); } catch { /* already disconnected */ }
    }
    this.routeEdges.clear();
    try { this.audibilityGate?.disconnect(); } catch { /* already disconnected */ }
    try { this.fader.disconnect(); } catch { /* already disconnected */ }
    this.effectChain?.dispose();
    try { this.panner.disconnect(); } catch { /* already disconnected */ }
    if (this.meter) {
      try {
        this.meter.disconnect();
      } catch {
        // already disconnected
      }
      if (meterAnalysers.get(this.trackId) === this.meter) {
        meterAnalysers.delete(this.trackId);
      }
    }
    try { this.outputGain?.disconnect(); } catch { /* already disconnected */ }
  }
}

/**
 * Build a TrackGraph for every sound track (non-master) and apply the initial
 * mute/solo state. Returns a map keyed by track id.
 */
export function buildTrackGraphs(
  ctx: BaseAudioContext,
  master: AudioNode,
  source: readonly Track[] | Project,
  when: number,
  metering: 'live' | 'disabled',
  suppliedPlan?: CompiledAudioRoutingPlan,
): Map<string, TrackGraph> {
  const legacyTracks = Array.isArray(source) ? source : null;
  const project = legacyTracks ? null : source as Project;
  const tracks: readonly Track[] = legacyTracks ?? project?.tracks ?? [];
  const plan = project ? (suppliedPlan ?? requireCompiledRouting(project)) : null;
  if (project && plan) assertRoutingGraphNodeBudget(project, plan, metering);
  const graphs = new Map<string, TrackGraph>();
  const legacyAudible = project ? null : computeAudibleTracks(tracks);
  const routingMix = project && plan ? resolveAudioRoutingMix(project, plan) : null;
  if (metering === 'live') {
    installMasterMeter(
      ctx,
      master,
      tracks.find((track) => track.type === 'master')?.id ?? null,
    );
  }
  try {
    for (const track of tracks) {
      if (track.type === 'master') continue;
      const graph = new TrackGraph(ctx, project ? null : master, track, metering);
      graphs.set(track.id, graph);
    }
    if (project && plan && routingMix) {
      for (const edge of plan.edges) {
        const sourceGraph = graphs.get(edge.sourceTrackId);
        if (!sourceGraph) throw new AudioRoutingGraphError(
          'invalid-routing',
          `Audio routing source is unavailable: ${edge.sourceTrackId}`,
        );
        const destinationTrackId = edge.destination.type === 'bus'
          ? edge.destination.trackId
          : null;
        const destination = destinationTrackId === null
          ? master
          : graphs.get(destinationTrackId)?.input;
        if (!destination) throw new AudioRoutingGraphError(
          'invalid-routing',
          `Audio routing destination is unavailable: ${destinationTrackId ?? 'master'}`,
        );
        sourceGraph.connectRouteEdge(
          audioRoutingEdgeKey(edge),
          edge.kind === 'send' ? edge.position : 'post-fader',
          destination,
        );
      }
      for (const track of tracks) {
        const graph = graphs.get(track.id);
        if (!graph) continue;
        graph.apply(track, routingMix.audibleChannelIds.has(track.id), when, 'immediate');
      }
      for (const edge of plan.edges) {
        const key = audioRoutingEdgeKey(edge);
        graphs.get(edge.sourceTrackId)?.applyRouteEdge(
          key,
          routingMix.edgeGains.get(key) ?? 0,
          when,
          'immediate',
        );
      }
    } else if (legacyAudible) {
      for (const track of tracks) {
        graphs.get(track.id)?.apply(
          track,
          legacyAudible.has(track.id),
          when,
          'immediate',
        );
      }
    }
    return graphs;
  } catch (error) {
    for (const graph of graphs.values()) graph.dispose();
    graphs.clear();
    if (metering === 'live') disposeMasterMeter(master);
    throw error;
  }
}

/** Apply current mute/solo/volume/pan state to existing graphs. */
export function applyMixState(
  graphs: Map<string, TrackGraph>,
  source: readonly Track[] | Project,
  when: number,
  suppliedPlan?: CompiledAudioRoutingPlan,
): void {
  const legacyTracks = Array.isArray(source) ? source : null;
  const project = legacyTracks ? null : source as Project;
  const tracks: readonly Track[] = legacyTracks ?? project?.tracks ?? [];
  const plan = project ? (suppliedPlan ?? requireCompiledRouting(project)) : null;
  // Effect edits can rebuild insert chains while a session is running. Recheck
  // the same static-node ceiling used at startup before touching any live node,
  // so a newly adopted effect cannot bypass the allocation preflight.
  if (project && plan) assertRoutingGraphNodeBudget(project, plan, 'live');
  const audible = project && plan
    ? resolveAudioRoutingMix(project, plan)
    : null;
  const legacyAudible = audible ? null : computeAudibleTracks(tracks);
  for (const track of tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
    graph.updateEffects(track.effects);
    graph.apply(
      track,
      audible?.audibleChannelIds.has(track.id) ?? legacyAudible?.has(track.id) ?? false,
      when,
      'smoothed',
    );
  }
  if (audible && plan) {
    for (const edge of plan.edges) {
      const key = audioRoutingEdgeKey(edge);
      graphs.get(edge.sourceTrackId)?.applyRouteEdge(
        key,
        audible.edgeGains.get(key) ?? 0,
        when,
        'smoothed',
      );
    }
  }
}

/** Apply send enable/gain and route-aware solo gates without touching automation. */
export function applyRoutingMixState(
  graphs: Map<string, TrackGraph>,
  project: Project,
  when: number,
  suppliedPlan?: CompiledAudioRoutingPlan,
  suppliedMix?: ResolvedAudioRoutingMix,
): void {
  const plan = suppliedPlan ?? requireCompiledRouting(project);
  const mix = suppliedMix ?? resolveAudioRoutingMix(project, plan);
  for (const track of project.tracks) {
    graphs.get(track.id)?.applyAudibility(
      mix.audibleChannelIds.has(track.id),
      when,
      'smoothed',
    );
  }
  for (const edge of plan.edges) {
    const key = audioRoutingEdgeKey(edge);
    graphs.get(edge.sourceTrackId)?.applyRouteEdge(
      key,
      mix.edgeGains.get(key) ?? 0,
      when,
      'smoothed',
    );
  }
}
