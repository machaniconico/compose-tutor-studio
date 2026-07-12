// Per-track audio routing graph and mute/solo resolution.
//
// Each non-master track gets: trackGain (volume) -> insert effects -> panner (pan) -> master bus.
// The master bus + soft limiter live on the AudioEngine. Mute/solo is resolved
// by the pure `computeAudibleTracks` so the rule ("any solo => only solos; mute
// always wins") is unit-testable without any audio nodes, then applied to the
// live gain nodes.

import type { EffectConfig, Track } from '@cts/project-model';
import { buildEffectChain, effectConfigSignature, type BuiltEffectChain } from './effects';
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

  constructor(
    ctx: BaseAudioContext,
    master: AudioNode,
    track: Track,
    metering: 'live' | 'disabled',
  ) {
    this.ctx = ctx;
    this.trackId = track.id;
    const gain = ctx.createGain();
    let panner: StereoPannerNode | null = null;
    let meter: AnalyserNode | null = null;
    try {
      panner = ctx.createStereoPanner();
      meter = metering === 'live' ? createMeterAnalyser(ctx) : null;
      // Fail silent until buildTrackGraphs applies the resolved initial mix.
      gain.gain.value = 0;
      panner.pan.value = clampPan(track.pan);
      if (!meter) {
        panner.connect(master);
      } else if (connectMeter(meter, panner, master)) {
        meterAnalysers.set(this.trackId, meter);
      }
    } catch (error) {
      try {
        gain.disconnect();
      } catch {
        // never connected
      }
      try {
        panner?.disconnect();
      } catch {
        // never connected
      }
      try {
        meter?.disconnect();
      } catch {
        // never connected
      }
      if (meter && meterAnalysers.get(this.trackId) === meter) {
        meterAnalysers.delete(this.trackId);
      }
      throw error;
    }
    this.gain = gain;
    this.panner = panner;
    this.meter = meter;
    // Voices connect to `input` (the gain node); gain -> effects -> panner -> master.
    this.input = gain;
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
    applyAudioParam(this.gain.gain, mix.gain, when, mode);
    applyAudioParam(this.panner.pan, mix.pan, when, mode);
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
      this.gain.disconnect();
      this.connectEffectChain(nextChain);
    } catch (error) {
      nextChain.dispose();
      try {
        this.gain.disconnect();
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
      this.gain.connect(this.panner);
      return;
    }
    this.gain.connect(chain.input);
    chain.output.connect(this.panner);
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
  metering: 'live' | 'disabled',
): Map<string, TrackGraph> {
  const graphs = new Map<string, TrackGraph>();
  const audible = computeAudibleTracks(tracks);
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
      const graph = new TrackGraph(ctx, master, track, metering);
      graphs.set(track.id, graph);
      graph.apply(track, audible.has(track.id), when, 'immediate');
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
  tracks: readonly Track[],
  when: number,
): void {
  const audible = computeAudibleTracks(tracks);
  for (const track of tracks) {
    const graph = graphs.get(track.id);
    if (!graph) continue;
    graph.updateEffects(track.effects);
    graph.apply(track, audible.has(track.id), when, 'smoothed');
  }
}
