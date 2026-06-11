// Per-track audio routing graph and mute/solo resolution.
//
// Each non-master track gets: trackGain (volume) -> panner (pan) -> master bus.
// The master bus + soft limiter live on the AudioEngine. Mute/solo is resolved
// by the pure `computeAudibleTracks` so the rule ("any solo => only solos; mute
// always wins") is unit-testable without any audio nodes, then applied to the
// live gain nodes.

import type { Track } from '@cts/project-model';
import {
  buildTrackEffectChain,
  effectSignature,
  type SupportedEffectType,
  type TrackEffectChain,
} from './effects';

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
  private readonly ctx: BaseAudioContext;
  private readonly master: AudioNode;
  private readonly gain: GainNode;
  private readonly panner: StereoPannerNode;
  private effects: TrackEffectChain | null = null;

  constructor(ctx: BaseAudioContext, master: AudioNode, track: Track) {
    this.ctx = ctx;
    this.master = master;
    this.trackId = track.id;
    this.gain = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.gain.gain.value = clampVolume(track.volume);
    this.panner.pan.value = clampPan(track.pan);
    // Voices connect to `input` (the gain node); gain -> panner -> FX -> master.
    this.input = this.gain;
    this.gain.connect(this.panner);
    this.rebuildEffects(track, ctx.currentTime);
  }

  get effectTypes(): readonly SupportedEffectType[] {
    return this.effects?.effectTypes ?? [];
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
      this.panner.disconnect();
      this.effects?.dispose();
      this.effects = null;
    } catch {
      // already disconnected
    }
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
    this.effects = buildTrackEffectChain(this.ctx, this.panner, this.master, track.effects, when);
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
