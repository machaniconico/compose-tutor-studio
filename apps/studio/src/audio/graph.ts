// Per-track audio routing graph and mute/solo resolution.
//
// Each non-master track gets:
// trackGain (volume) -> automation gain (when present) -> panner (pan) -> FX -> meter tap -> master bus.
// The master bus + soft limiter live on the AudioEngine. Mute/solo is resolved
// by the pure `computeAudibleTracks` so the rule ("any solo => only solos; mute
// always wins") is unit-testable without any audio nodes, then applied to the
// live gain nodes.

import { computeAudibleTracks, type AutomationLane, type Track } from '@cts/project-model';
import {
  buildTrackEffectChain,
  effectSignature,
  type SupportedEffectType,
  type TrackEffectChain,
} from './effects';
import { buildParamSchedule, type AutomationPlayback } from './automationSchedule';
import { METER_ANALYSER_FFT_SIZE } from './metering';

const liveTrackAnalysers = new Map<string, AnalyserNode>();

export { computeAudibleTracks };

/** Clamp a volume into the supported 0..2 range. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return Math.min(2, Math.max(0, volume));
}

/** Clamp a pan into the -1..1 range. */
export function clampPan(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  return Math.min(1, Math.max(-1, pan));
}

/** Live node chain for one track. */
export class TrackGraph {
  readonly trackId: string;
  readonly input: GainNode;
  readonly analyser: AnalyserNode;
  private readonly ctx: BaseAudioContext;
  private readonly master: AudioNode;
  private readonly gain: GainNode;
  private readonly automationGain: GainNode | undefined;
  private readonly volumeLane: AutomationLane | undefined;
  private readonly panner: StereoPannerNode;
  private readonly meterTap: GainNode;
  private effects: TrackEffectChain | null = null;

  constructor(ctx: BaseAudioContext, master: AudioNode, track: Track) {
    this.ctx = ctx;
    this.master = master;
    this.trackId = track.id;
    this.gain = ctx.createGain();
    this.volumeLane = track.automation?.volume;
    this.automationGain = this.volumeLane?.points.length ? ctx.createGain() : undefined;
    this.panner = ctx.createStereoPanner();
    this.meterTap = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = METER_ANALYSER_FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.gain.gain.value = clampVolume(track.volume);
    this.panner.pan.value = clampPan(track.pan);
    this.meterTap.connect(this.master);
    this.meterTap.connect(this.analyser);
    registerLiveTrackAnalyser(ctx, this.trackId, this.analyser);
    this.input = this.gain;
    this.gain.connect(this.automationGain ?? this.panner);
    this.automationGain?.connect(this.panner);
    this.rebuildEffects(track, ctx.currentTime);
  }

  get effectTypes(): readonly SupportedEffectType[] {
    return this.effects?.effectTypes ?? [];
  }

  scheduleAutomation(playback: AutomationPlayback, firstPass = 0, passes = 1): void {
    const gain = this.automationGain?.gain;
    if (!gain) return;
    const { startBeat, loop, bpm, startTime, endBeat } = playback;
    for (const { method, time, value } of buildParamSchedule(
      this.volumeLane, startBeat, loop, bpm, { startTime, endBeat, firstPass, passes },
    )) {
      gain[method](value, time);
    }
  }

  /** Apply volume/pan/mute/solo state to the live nodes. */
  apply(track: Track, audible: boolean, when: number): void {
    const target = audible ? clampVolume(track.volume) : 0;
    // Short ramp avoids zipper noise on live changes.
    this.gain.gain.setTargetAtTime(target, when, 0.01);
    this.panner.pan.setTargetAtTime(clampPan(track.pan), when, 0.01);
    this.syncEffects(track, when);
  }

  /** Disconnect from the graph. */
  dispose(): void {
    try {
      this.gain.disconnect();
    } catch {
      // already disconnected
    }
    this.automationGain?.disconnect();
    try {
      this.panner.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.meterTap.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.analyser.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.effects?.dispose();
    } catch {
      // already disconnected
    }
    this.effects = null;
    unregisterLiveTrackAnalyser(this.trackId, this.analyser);
  }

  private syncEffects(track: Track, when: number): void {
    if ((this.effects?.signature ?? '') !== effectSignature(track.effects)) {
      this.rebuildEffects(track, when);
      return;
    }
    this.effects?.apply(track.effects, when);
  }

  private rebuildEffects(track: Track, when: number): void {
    try {
      this.panner.disconnect();
    } catch {
      // not connected yet
    }
    this.effects?.dispose();
    this.effects = buildTrackEffectChain(this.ctx, this.panner, this.meterTap, track.effects, when);
  }
}

/**
 * Build a TrackGraph for every sound track (non-master) and apply the initial
 * mute/solo state. Returns a map keyed by track id.
 */
export function buildTrackGraphs(
  ctx: BaseAudioContext,
  master: AudioNode,
  tracks: readonly Track[],
  when: number,
): Map<string, TrackGraph> {
  const graphs = new Map<string, TrackGraph>();
  const audible = computeAudibleTracks(tracks);
  for (const track of tracks) {
    if (track.type === 'master') continue;
    const graph = new TrackGraph(ctx, master, track);
    graph.apply(track, audible.has(track.id), when);
    graphs.set(track.id, graph);
  }
  return graphs;
}

/** Apply current mute/solo/volume/pan state to existing graphs. */
export function applyMixState(
  graphs: Map<string, TrackGraph>,
  tracks: readonly Track[],
  when: number,
): void {
  const audible = computeAudibleTracks(tracks);
  for (const track of tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
    graph.apply(track, audible.has(track.id), when);
  }
}

/** Return the live analyser for a track if playback has built one. */
export function getTrackAnalyser(trackId: string): AnalyserNode | null {
  return liveTrackAnalysers.get(trackId) ?? null;
}

function registerLiveTrackAnalyser(
  ctx: BaseAudioContext,
  trackId: string,
  analyser: AnalyserNode,
): void {
  if (isLiveAudioContext(ctx)) {
    liveTrackAnalysers.set(trackId, analyser);
  }
}

function unregisterLiveTrackAnalyser(trackId: string, analyser: AnalyserNode): void {
  if (liveTrackAnalysers.get(trackId) === analyser) {
    liveTrackAnalysers.delete(trackId);
  }
}

function isLiveAudioContext(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
}
