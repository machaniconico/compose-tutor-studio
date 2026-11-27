// Per-track audio routing graph and mute/solo resolution.
//
// Each non-master track gets:
// Fader -> optional volume and pan automation -> existing panner
// -> FX -> meter tap -> master bus. Sends branch after the existing panner.

import { computeAudibleTracks, resolveMuteSolo, sendLevel, type AutomationLane, type Track } from '@cts/project-model';
import {
  buildTrackEffectChain,
  effectSignature,
  type SupportedEffectType,
  type TrackEffectChain,
} from './effects';
import { buildParamSchedule, type AutomationPlayback, type ParamTarget } from './automationSchedule';
import { applyMacros } from './macros';
import { METER_ANALYSER_FFT_SIZE } from './metering';
import { resolvePreset } from './presets';

const liveTrackAnalysers = new Map<string, AnalyserNode>();

export { computeAudibleTracks, resolveMuteSolo };

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
  readonly cutoffSource: ConstantSourceNode | undefined;
  private readonly cutoffTarget: ParamTarget | undefined;
  private readonly automationPanner: StereoPannerNode | undefined;
  private readonly lanes: Track['automation'];
  private readonly mixerPan: number;
  private readonly panner: StereoPannerNode;
  private readonly meterTap: GainNode;
  private effects: TrackEffectChain | null = null;
  private readonly sends = new Map<string, GainNode>();

  constructor(
    ctx: BaseAudioContext,
    master: AudioNode,
    track: Track,
    audible = true,
    startTime = ctx.currentTime,
    connectToMaster = true,
  ) {
    this.ctx = ctx;
    this.master = master;
    this.trackId = track.id;
    this.gain = ctx.createGain();
    this.lanes = track.type === 'master' ? undefined : track.automation;
    this.automationGain = this.lanes?.volume?.points.length ? ctx.createGain() : undefined;
    if (track.type !== 'drum' && track.type !== 'bus' && this.lanes?.cutoff?.points.length) {
      const { preset, macros } = track.instrument ?? {};
      const baseHz = applyMacros(resolvePreset(preset), macros).cutoffHz;
      this.cutoffTarget = { kind: 'cutoff', baseHz, sampleRate: ctx.sampleRate };
      this.cutoffSource = ctx.createConstantSource();
      this.cutoffSource.offset.value = 0;
      this.cutoffSource.start(startTime);
    }
    this.automationPanner = this.lanes?.pan?.points.length ? ctx.createStereoPanner() : undefined;
    this.panner = ctx.createStereoPanner();
    this.meterTap = ctx.createGain();
    if (track.type === 'bus' && !audible) this.meterTap.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = METER_ANALYSER_FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.gain.gain.value = clampVolume(track.volume);
    this.mixerPan = clampPan(track.pan);
    // Apply the sum once. Two non-zero stereo pans in series pan the signal twice.
    if (this.automationPanner) this.automationPanner.pan.value = this.mixerPan;
    else this.panner.pan.value = this.mixerPan;
    if (connectToMaster) this.meterTap.connect(this.master);
    this.meterTap.connect(this.analyser);
    registerLiveTrackAnalyser(ctx, this.trackId, this.analyser);
    this.input = this.gain;
    let previous: AudioNode = this.gain;
    for (const node of [this.automationGain, this.automationPanner, this.panner]) {
      if (!node) continue;
      previous.connect(node);
      previous = node;
    }
    this.rebuildEffects(track, ctx.currentTime);
  }

  get effectTypes(): readonly SupportedEffectType[] {
    return this.effects?.effectTypes ?? [];
  }

  scheduleAutomation(playback: AutomationPlayback, firstPass = 0, passes = 1): void {
    const { startBeat, loop, bpm, startTime, endBeat } = playback;
    const schedule = (param: AudioParam | undefined, lane: AutomationLane | undefined, target?: ParamTarget) => {
      if (!param) return;
      for (const { method, time, value } of buildParamSchedule(
        lane, startBeat, loop, bpm, { startTime, endBeat, firstPass, passes, target },
      )) param[method](value, time);
    };
    schedule(this.automationGain?.gain, this.lanes?.volume);
    schedule(this.automationPanner?.pan, this.lanes?.pan, { kind: 'pan', mixerPan: this.mixerPan });
    schedule(this.cutoffSource?.offset, this.lanes?.cutoff, this.cutoffTarget);
  }

  /** Apply volume/pan/mute/solo state to the live nodes. */
  apply(track: Track, audible: boolean, when: number): void {
    const target = audible ? clampVolume(track.volume) : 0;
    // Short ramp avoids zipper noise on live changes.
    this.gain.gain.setTargetAtTime(target, when, 0.01);
    if (!this.automationPanner) this.panner.pan.setTargetAtTime(clampPan(track.pan), when, 0.01);
    // Also gate the output so muting a return silences echoes already in its FX.
    if (track.type === 'bus') this.meterTap.gain.setTargetAtTime(audible ? 1 : 0, when, 0.01);
    this.syncEffects(track, when);
  }

  syncSends(track: Track, returns: ReadonlyMap<string, TrackGraph>, when: number): void {
    for (const [id, gain] of this.sends) {
      if (!returns.has(id) || sendLevel(track, id) === 0) {
        this.panner.disconnect(gain);
        gain.disconnect();
        this.sends.delete(id);
      }
    }
    for (const [id, target] of returns) {
      const level = sendLevel(track, id);
      if (level === 0) continue;
      const existing = this.sends.get(id);
      if (existing) {
        existing.gain.setTargetAtTime(level, when, 0.01);
        continue;
      }
      const gain = this.ctx.createGain();
      gain.gain.value = level;
      this.panner.connect(gain);
      gain.connect(target.input);
      this.sends.set(id, gain);
    }
  }

  /** Disconnect from the graph. */
  dispose(): void {
    try {
      this.gain.disconnect();
    } catch {
      // already disconnected
    }
    this.automationGain?.disconnect();
    this.cutoffSource?.stop(); // Each voice removes its connection when it ends.
    this.automationPanner?.disconnect();
    for (const gain of this.sends.values()) gain.disconnect();
    this.sends.clear();
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
    if (this.effects) {
      this.panner.disconnect(this.effects.entry);
      this.effects.dispose();
    }
    this.effects = buildTrackEffectChain(this.ctx, this.panner, this.meterTap, track.effects, when, track.type === 'bus');
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
  outputTrackId?: string,
): Map<string, TrackGraph> {
  const graphs = new Map<string, TrackGraph>();
  const audible = resolveMuteSolo(tracks);
  for (const track of tracks) {
    if (track.type === 'master') continue;
    const isAudible = audible.has(track.id);
    const graph = new TrackGraph(ctx, master, track, isAudible, when, outputTrackId === undefined || track.id === outputTrackId);
    graph.apply(track, isAudible, when);
    graphs.set(track.id, graph);
  }
  syncTrackSends(graphs, tracks, when);
  return graphs;
}

/** Apply current mute/solo/volume/pan state to existing graphs. */
export function applyMixState(
  graphs: Map<string, TrackGraph>,
  tracks: readonly Track[],
  when: number,
): void {
  const audible = resolveMuteSolo(tracks);
  for (const track of tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
    graph.apply(track, audible.has(track.id), when);
  }
  syncTrackSends(graphs, tracks, when);
}

function syncTrackSends(graphs: Map<string, TrackGraph>, tracks: readonly Track[], when: number): void {
  const returns = new Map<string, TrackGraph>();
  for (const track of tracks) {
    const graph = graphs.get(track.id);
    if (track.type === 'bus' && graph) returns.set(track.id, graph);
  }
  for (const track of tracks) graphs.get(track.id)?.syncSends(track, returns, when);
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
