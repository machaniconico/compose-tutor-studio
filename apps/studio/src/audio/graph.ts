// Per-track audio routing graph and mute/solo resolution.
//
// Each non-master track gets: trackGain (volume) -> insert effects -> panner (pan) -> master bus.
// The master bus + soft limiter live on the AudioEngine. Mute/solo is resolved
// by the pure `computeAudibleTracks` so the rule ("any solo => only solos; mute
// always wins") is unit-testable without any audio nodes, then applied to the
// live gain nodes.

import type { EffectConfig, Track } from '@cts/project-model';
import { buildEffectChain, effectConfigSignature, type BuiltEffectChain } from './effects';

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
    if (masterMeter) {
      meterAnalysers.delete(masterMeter.trackId);
    }
    masterMeter = null;
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

  if (masterMeter) {
    meterAnalysers.delete(masterMeter.trackId);
    try {
      masterMeter.source.disconnect(masterMeter.analyser);
    } catch {
      // already disconnected
    }
    try {
      masterMeter.analyser.disconnect();
    } catch {
      // already disconnected
    }
    try {
      masterMeter.sink?.disconnect();
    } catch {
      // already disconnected
    }
  }

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
  private readonly gain: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly meter: AnalyserNode | null;
  private effectChain: BuiltEffectChain | null = null;
  private effectSignature: string | null = null;

  constructor(ctx: BaseAudioContext, master: AudioNode, track: Track) {
    this.ctx = ctx;
    this.trackId = track.id;
    this.gain = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.meter = createMeterAnalyser(ctx);
    this.gain.gain.value = clampVolume(track.volume);
    this.panner.pan.value = clampPan(track.pan);
    // Voices connect to `input` (the gain node); gain -> effects -> panner -> master.
    this.input = this.gain;
    if (!this.meter) {
      this.panner.connect(master);
    } else if (connectMeter(this.meter, this.panner, master)) {
      meterAnalysers.set(this.trackId, this.meter);
    }
    this.updateEffects(track.effects);
  }

  /** Apply volume/pan/mute/solo state to the live nodes. */
  apply(track: Track, audible: boolean, when: number): void {
    const target = audible ? clampVolume(track.volume) : 0;
    // Short ramp avoids zipper noise on live changes.
    this.gain.gain.setTargetAtTime(target, when, 0.01);
    this.panner.pan.setTargetAtTime(clampPan(track.pan), when, 0.01);
  }

  /** Rebuild the insert effect nodes when the track's effect list changes. */
  updateEffects(configs: readonly EffectConfig[]): void {
    const nextSignature = effectConfigSignature(configs);
    if (nextSignature === this.effectSignature) return;

    try {
      this.gain.disconnect();
    } catch {
      // already disconnected
    }
    this.effectChain?.dispose();
    this.effectChain = buildEffectChain(this.ctx, configs);
    this.effectSignature = nextSignature;

    if (
      this.effectChain.isBypassed ||
      this.effectChain.input === null ||
      this.effectChain.output === null
    ) {
      this.gain.connect(this.panner);
      return;
    }

    this.gain.connect(this.effectChain.input);
    this.effectChain.output.connect(this.panner);
  }

  /** Disconnect from the graph. */
  dispose(): void {
    try {
      this.gain.disconnect();
    } catch {
      // already disconnected
    }
    this.effectChain?.dispose();
    try {
      this.panner.disconnect();
    } catch {
      // already disconnected
    }
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
  installMasterMeter(
    ctx,
    master,
    tracks.find((track) => track.type === 'master')?.id ?? null,
  );
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
    graph.updateEffects(track.effects);
    graph.apply(track, audible.has(track.id), when);
  }
}
