// Polyphonic subtractive synth voice.
//
// Each voice is: bounded oscillator layers -> lowpass BiquadFilter -> ADSR
// GainNode. Presets expose beginner-friendly sounds while aliases keep the
// current project model and playback code working unchanged.
//
// Works with any BaseAudioContext so the same code drives live playback and the
// OfflineAudioContext used for WAV render.

import { SYNTH_OSCILLATOR_STOP_PAD_SECONDS } from './voiceTiming';

/** ADSR envelope, seconds for A/D/R, 0..1 for sustain. */
export type Envelope = {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
};

export type AdsrPoint = {
  time: number;
  value: number;
};

export type AdsrCurve = readonly [AdsrPoint, AdsrPoint, AdsrPoint, AdsrPoint, AdsrPoint];

export type OscillatorLayer = {
  role: 'primary' | 'unison' | 'sub';
  wave: OscillatorType;
  /** Octave offset from the played MIDI note. -1 is a sub oscillator. */
  octave: number;
  /** Fine pitch offset, cents. */
  detuneCents: number;
  /** Layer gain before the filter, 0..1. */
  gain: number;
};

export type OscillatorPlan = OscillatorLayer & {
  frequencyHz: number;
};

export type FilterSettings = {
  cutoffHz: number;
  resonance: number;
};

/** Subtractive-synth preset definition. */
export type SynthPreset = {
  label: string;
  description: string;
  oscillators: readonly OscillatorLayer[];
  filter: FilterSettings;
  /** Per-note gain trim so presets sit at similar loudness. */
  gain: number;
  env: Envelope;
};

export type SynthPatchOptions = {
  preset?: string;
  oscillators?: readonly OscillatorLayer[];
  envelope?: Partial<Envelope>;
  filter?: Partial<FilterSettings>;
  gain?: number;
};

export type SynthNoteOptions = SynthPatchOptions;

export type SynthOptions = SynthPatchOptions & {
  maxVoices?: number;
};

export type SynthPresetSummary = {
  name: string;
  label: string;
  description: string;
};

export const DEFAULT_ENVELOPE: Envelope = {
  attack: 0.01,
  decay: 0.12,
  sustain: 0.75,
  release: 0.16,
};

export const MAX_OSCILLATORS_PER_VOICE = 6;

const DEFAULT_FILTER: FilterSettings = {
  cutoffHz: 1800,
  resonance: 0.7,
};

const DEFAULT_OSCILLATORS: readonly OscillatorLayer[] = [
  { role: 'primary', wave: 'triangle', octave: 0, detuneCents: 0, gain: 1 },
];

const softPadPreset: SynthPreset = {
  label: 'Soft Pad',
  description: 'Slow, mellow chords for gentle harmony practice.',
  oscillators: [
    { role: 'primary', wave: 'triangle', octave: 0, detuneCents: 0, gain: 0.22 },
    { role: 'unison', wave: 'sawtooth', octave: 0, detuneCents: -7, gain: 0.34 },
    { role: 'unison', wave: 'sawtooth', octave: 0, detuneCents: 7, gain: 0.34 },
    { role: 'sub', wave: 'sine', octave: -1, detuneCents: 0, gain: 0.1 },
  ],
  filter: { cutoffHz: 1250, resonance: 0.55 },
  gain: 0.24,
  env: { attack: 0.28, decay: 0.42, sustain: 0.72, release: 0.8 },
};

const brightPluckPreset: SynthPreset = {
  label: 'Bright Pluck',
  description: 'Short, clear notes for simple melodies and arpeggios.',
  oscillators: [
    { role: 'primary', wave: 'sawtooth', octave: 0, detuneCents: 0, gain: 0.55 },
    { role: 'unison', wave: 'square', octave: 0, detuneCents: 9, gain: 0.25 },
    { role: 'sub', wave: 'triangle', octave: -1, detuneCents: 0, gain: 0.2 },
  ],
  filter: { cutoffHz: 4200, resonance: 0.9 },
  gain: 0.23,
  env: { attack: 0.003, decay: 0.16, sustain: 0.18, release: 0.12 },
};

const warmBassPreset: SynthPreset = {
  label: 'Warm Bass',
  description: 'Rounded low notes that support a beginner chord loop.',
  oscillators: [
    { role: 'primary', wave: 'sine', octave: 0, detuneCents: 0, gain: 0.52 },
    { role: 'unison', wave: 'triangle', octave: 0, detuneCents: -4, gain: 0.23 },
    { role: 'sub', wave: 'sine', octave: -1, detuneCents: 0, gain: 0.35 },
  ],
  filter: { cutoffHz: 720, resonance: 0.65 },
  gain: 0.32,
  env: { attack: 0.006, decay: 0.13, sustain: 0.82, release: 0.15 },
};

const brightLeadPreset: SynthPreset = {
  label: 'Bright Lead',
  description: 'Focused lead tone for practicing memorable hooks.',
  oscillators: [
    { role: 'primary', wave: 'sawtooth', octave: 0, detuneCents: -9, gain: 0.42 },
    { role: 'unison', wave: 'sawtooth', octave: 0, detuneCents: 9, gain: 0.42 },
    { role: 'unison', wave: 'square', octave: 0, detuneCents: 0, gain: 0.12 },
    { role: 'sub', wave: 'triangle', octave: -1, detuneCents: 0, gain: 0.04 },
  ],
  filter: { cutoffHz: 3400, resonance: 0.85 },
  gain: 0.24,
  env: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.18 },
};

type CanonicalSynthPresetName = 'softPad' | 'brightPluck' | 'warmBass' | 'brightLead';

const CANONICAL_SYNTH_PRESETS: Readonly<Record<CanonicalSynthPresetName, SynthPreset>> = {
  softPad: softPadPreset,
  brightPluck: brightPluckPreset,
  warmBass: warmBassPreset,
  brightLead: brightLeadPreset,
};

/** One alias registry drives both playback and inspector presentation. */
const SYNTH_PRESET_ALIASES = new Map<string, CanonicalSynthPresetName>([
  ['softPad', 'softPad'],
  ['warmPad', 'softPad'],
  ['pad', 'softPad'],
  ['brightPluck', 'brightPluck'],
  ['warmBass', 'warmBass'],
  ['roundBass', 'warmBass'],
  ['subBass', 'warmBass'],
  ['bass', 'warmBass'],
  ['brightLead', 'brightLead'],
  ['leadSine', 'brightLead'],
  ['lead', 'brightLead'],
]);

/** Playback table includes every persisted legacy alias. */
const synthPresetTable = Object.create(null) as Record<string, SynthPreset>;
for (const [alias, canonical] of SYNTH_PRESET_ALIASES) {
  synthPresetTable[alias] = CANONICAL_SYNTH_PRESETS[canonical];
}
export const SYNTH_PRESETS: Readonly<Record<string, SynthPreset>> = Object.freeze(synthPresetTable);

export const BEGINNER_SYNTH_PRESETS = ['softPad', 'brightPluck', 'warmBass'] as const;

/** Default preset when an unknown name is requested. */
export const DEFAULT_PRESET = 'warmPad';

/** Resolve a preset by name, falling back to the default. */
export function resolvePreset(preset: string | undefined): SynthPreset {
  const canonical = preset ? SYNTH_PRESET_ALIASES.get(preset) : undefined;
  return clonePreset(canonical ? CANONICAL_SYNTH_PRESETS[canonical] : softPadPreset);
}

/** Resolve saved aliases for UI display without rewriting the project. */
export function canonicalSynthPresetName(value: string): string | null {
  return SYNTH_PRESET_ALIASES.get(value) ?? null;
}

export function listSynthPresets(): readonly SynthPresetSummary[] {
  return [
    summary('softPad', softPadPreset),
    summary('brightPluck', brightPluckPreset),
    summary('warmBass', warmBassPreset),
    summary('brightLead', brightLeadPreset),
  ];
}

export function normalizeEnvelope(envelope: Partial<Envelope> = {}): Envelope {
  return {
    attack: clamp(finiteOr(envelope.attack, DEFAULT_ENVELOPE.attack), 0, 10),
    decay: clamp(finiteOr(envelope.decay, DEFAULT_ENVELOPE.decay), 0, 10),
    sustain: clamp(finiteOr(envelope.sustain, DEFAULT_ENVELOPE.sustain), 0, 1),
    release: clamp(finiteOr(envelope.release, DEFAULT_ENVELOPE.release), 0, 10),
  };
}

export function createAdsrCurve(
  envelope: Envelope,
  startTime: number,
  duration: number,
  peak: number,
): AdsrCurve {
  const env = normalizeEnvelope(envelope);
  const start = finiteOr(startTime, 0);
  const sustainStartOffset = env.attack + env.decay;
  const releaseStart = start + Math.max(0, finiteOr(duration, 0), sustainStartOffset);
  const peakValue = Math.max(0, finiteOr(peak, 0));
  const sustainValue = peakValue * env.sustain;

  return [
    { time: start, value: 0 },
    { time: start + env.attack, value: peakValue },
    { time: start + sustainStartOffset, value: sustainValue },
    { time: releaseStart, value: sustainValue },
    { time: releaseStart + env.release, value: 0 },
  ];
}

export function normalizeOscillatorLayers(
  layers: readonly OscillatorLayer[] = DEFAULT_OSCILLATORS,
): OscillatorLayer[] {
  const source = layers.length > 0 ? layers : DEFAULT_OSCILLATORS;
  return source.slice(0, MAX_OSCILLATORS_PER_VOICE).map((layer) => ({
    role: layer.role,
    wave: layer.wave,
    octave: clamp(Math.round(finiteOr(layer.octave, 0)), -2, 2),
    detuneCents: clamp(finiteOr(layer.detuneCents, 0), -100, 100),
    gain: clamp(finiteOr(layer.gain, 1), 0, 1),
  }));
}

export function buildOscillatorPlan(preset: SynthPreset, midi: number): OscillatorPlan[] {
  const baseFreq = midiToFreq(midi);
  return normalizeOscillatorLayers(preset.oscillators).map((layer) => ({
    ...layer,
    frequencyHz: baseFreq * Math.pow(2, layer.octave),
  }));
}

export function resolveSynthPatch(presetOrOptions?: string | SynthOptions): SynthPreset {
  const options = typeof presetOrOptions === 'string' ? { preset: presetOrOptions } : presetOrOptions;
  const base = resolvePreset(options?.preset);
  return applyPatchOptions(base, options);
}

/** Convert a MIDI note number to frequency in Hz (A4 = 69 = 440Hz). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Default per-voice steal cap (max simultaneous voices per track). */
export const MAX_VOICES = 16;

/** One scheduled voice and every node exclusively owned by that voice. */
type ActiveVoice = {
  oscillators: OscillatorNode[];
  layerGains: GainNode[];
  filter: BiquadFilterNode;
  gain: GainNode;
  curve: AdsrCurve;
  /** Earliest currently scheduled source stop on the audio timeline. */
  stopAt: number;
  remainingEnded: number;
  disposed: boolean;
};

/**
 * A polyphonic synth bound to one output node (the track's gain input).
 * One instance per instrument track.
 */
export class SynthVoiceManager {
  private readonly ctx: BaseAudioContext;
  private readonly output: AudioNode;
  private readonly preset: SynthPreset;
  private readonly maxVoices: number;
  /** Voices that can still overlap a subsequently scheduled note. */
  private scheduledVoices: ActiveVoice[] = [];
  /** Every voice graph that has not yet been physically disconnected. */
  private readonly ownedVoices = new Set<ActiveVoice>();
  private disposed = false;

  constructor(
    ctx: BaseAudioContext,
    output: AudioNode,
    preset: string | SynthOptions | undefined,
    maxVoices: number = MAX_VOICES,
  ) {
    const options = typeof preset === 'string' ? undefined : preset;
    this.ctx = ctx;
    this.output = output;
    this.preset = resolveSynthPatch(preset);
    this.maxVoices = Math.max(1, Math.floor(options?.maxVoices ?? maxVoices));
  }

  /**
   * Schedule one note.
   *
   * @param midi      MIDI note number
   * @param startTime AudioContext time to start
   * @param duration  sounding duration in seconds (release happens after)
   * @param velocity  0..127 MIDI velocity
   */
  noteOn(
    midi: number,
    startTime: number,
    duration: number,
    velocity: number,
    options?: SynthNoteOptions,
  ): void {
    if (this.disposed) return;
    this.reap(startTime);
    this.steal(startTime);

    const p = options
      ? applyPatchOptions(options.preset ? resolvePreset(options.preset) : this.preset, options)
      : this.preset;
    const oscillatorPlan = buildOscillatorPlan(p, midi);
    const vel = Math.min(1, Math.max(0, velocity / 127));
    const peak = p.gain * (0.3 + 0.7 * vel);

    const oscillators: OscillatorNode[] = [];
    const layerGains: GainNode[] = [];
    let filter: BiquadFilterNode | null = null;
    let gain: GainNode | null = null;
    let voice: ActiveVoice | null = null;

    try {
      filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(p.filter.cutoffHz, startTime);
      filter.Q.setValueAtTime(p.filter.resonance, startTime);

      gain = this.ctx.createGain();
      const curve = createAdsrCurve(p.env, startTime, duration, peak);
      scheduleAdsr(gain.gain, curve);

      for (const layer of oscillatorPlan) {
        const osc = this.ctx.createOscillator();
        oscillators.push(osc);
        const layerGain = this.ctx.createGain();
        layerGains.push(layerGain);
        osc.type = layer.wave;
        osc.frequency.setValueAtTime(layer.frequencyHz, startTime);
        osc.detune.setValueAtTime(layer.detuneCents, startTime);
        layerGain.gain.setValueAtTime(layer.gain, startTime);
      }

      voice = {
        oscillators,
        layerGains,
        filter,
        gain,
        curve,
        stopAt: curve[4].time + SYNTH_OSCILLATOR_STOP_PAD_SECONDS,
        remainingEnded: oscillators.length,
        disposed: false,
      };
      this.ownedVoices.add(voice);
      const activeVoice = voice;

      for (const [index, osc] of oscillators.entries()) {
        const layerGain = layerGains[index];
        if (!layerGain) throw new Error('Synth layer allocation became inconsistent.');
        let ended = false;
        osc.onended = () => {
          if (ended || activeVoice.disposed) return;
          ended = true;
          activeVoice.remainingEnded -= 1;
          if (activeVoice.remainingEnded === 0) this.disposeVoice(activeVoice);
        };
        osc.connect(layerGain);
        layerGain.connect(filter);
      }
      filter.connect(gain);
      gain.connect(this.output);

      for (const osc of oscillators) {
        osc.start(startTime);
        osc.stop(activeVoice.stopAt);
      }
      if (!activeVoice.disposed) this.scheduledVoices.push(activeVoice);
    } catch (error) {
      stopOscillators(oscillators, this.ctx.currentTime);
      if (voice) {
        this.disposeVoice(voice);
      } else {
        disconnectVoiceNodes(oscillators, layerGains, filter, gain);
      }
      throw error;
    }
  }

  /** Request a short release without disconnecting before the sources end. */
  releaseAll(when: number): void {
    if (this.disposed) return;
    this.reap(when);
    for (const voice of [...this.ownedVoices]) this.requestSoftStop(voice, when, 0.03, 0.05);
    this.scheduledVoices = [];
  }

  /** Cancel and synchronously disconnect every owned voice. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduledVoices = [];
    for (const voice of [...this.ownedVoices]) {
      stopOscillators(voice.oscillators, this.ctx.currentTime);
      this.disposeVoice(voice);
    }
  }

  /**
   * Prune overlap accounting by schedule time, but only disconnect a missed
   * `ended` callback after the real audio clock has passed its stop. Offline
   * rendering schedules future voices while `currentTime` is still zero.
   */
  private reap(scheduledStartTime: number): void {
    this.scheduledVoices = this.scheduledVoices.filter(
      (voice) => !voice.disposed && voice.stopAt > scheduledStartTime,
    );
    for (const voice of [...this.ownedVoices]) {
      if (voice.stopAt <= this.ctx.currentTime) this.disposeVoice(voice);
    }
  }

  /** Enforce the voice cap by stealing the oldest voice. */
  private steal(when: number): void {
    while (this.scheduledVoices.length >= this.maxVoices) {
      const victim = this.scheduledVoices.shift();
      if (!victim) break;
      this.requestSoftStop(victim, when, 0.02, 0.03);
    }
  }

  private requestSoftStop(
    voice: ActiveVoice,
    when: number,
    fadeSeconds: number,
    stopDelaySeconds: number,
  ): void {
    if (voice.disposed) return;
    if (voice.stopAt <= this.ctx.currentTime) {
      this.disposeVoice(voice);
      return;
    }

    const stopAt = Math.min(voice.stopAt, when + stopDelaySeconds);
    if (stopAt >= voice.stopAt) return;
    try {
      holdAudioParamAtCurveValue(voice.gain.gain, voice.curve, when);
      const fadeAt = Math.min(stopAt, when + fadeSeconds);
      if (fadeAt > when) voice.gain.gain.linearRampToValueAtTime(0, fadeAt);
      else voice.gain.gain.setValueAtTime(0, when);
    } catch {
      // A closed context cannot automate, but the source can still be stopped.
    }
    stopOscillators(voice.oscillators, stopAt);
    voice.stopAt = stopAt;
  }

  private disposeVoice(voice: ActiveVoice): void {
    if (voice.disposed) return;
    voice.disposed = true;
    this.ownedVoices.delete(voice);
    this.scheduledVoices = this.scheduledVoices.filter((candidate) => candidate !== voice);
    disconnectVoiceNodes(
      voice.oscillators,
      voice.layerGains,
      voice.filter,
      voice.gain,
    );
  }
}

function applyPatchOptions(base: SynthPreset, options: SynthPatchOptions = {}): SynthPreset {
  return {
    ...base,
    oscillators: options.oscillators
      ? normalizeOscillatorLayers(options.oscillators)
      : normalizeOscillatorLayers(base.oscillators),
    filter: normalizeFilter({ ...base.filter, ...options.filter }),
    gain: clamp(finiteOr(options.gain, base.gain), 0, 1),
    env: normalizeEnvelope({ ...base.env, ...options.envelope }),
  };
}

function normalizeFilter(filter: Partial<FilterSettings> = {}): FilterSettings {
  return {
    cutoffHz: clamp(finiteOr(filter.cutoffHz, DEFAULT_FILTER.cutoffHz), 40, 18_000),
    resonance: clamp(finiteOr(filter.resonance, DEFAULT_FILTER.resonance), 0.0001, 20),
  };
}

function scheduleAdsr(param: AudioParam, curve: AdsrCurve): void {
  param.setValueAtTime(curve[0].value, curve[0].time);
  scheduleRamp(param, curve[0], curve[1]);
  scheduleRamp(param, curve[1], curve[2]);
  param.setValueAtTime(curve[3].value, curve[3].time);
  scheduleRamp(param, curve[3], curve[4]);
}

function scheduleRamp(param: AudioParam, from: AdsrPoint, to: AdsrPoint): void {
  if (to.time <= from.time) {
    param.setValueAtTime(to.value, to.time);
  } else {
    param.linearRampToValueAtTime(to.value, to.time);
  }
}

function holdAudioParamAtCurveValue(
  param: AudioParam,
  curve: AdsrCurve,
  when: number,
): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(when);
    return;
  }
  const heldValue = adsrValueAtTime(curve, when);
  param.cancelScheduledValues(when);
  param.setValueAtTime(heldValue, when);
}

function adsrValueAtTime(curve: AdsrCurve, time: number): number {
  if (time <= curve[0].time) return curve[0].value;
  for (let index = 1; index < curve.length; index += 1) {
    const from = curve[index - 1]!;
    const to = curve[index]!;
    if (time > to.time) continue;
    if (to.time <= from.time) return to.value;
    const ratio = Math.max(0, Math.min(1, (time - from.time) / (to.time - from.time)));
    return from.value + (to.value - from.value) * ratio;
  }
  return curve[4].value;
}

function stopOscillators(oscillators: readonly OscillatorNode[], when: number): void {
  for (const osc of oscillators) {
    try {
      osc.stop(when);
    } catch {
      // Node may already be stopped; ignore.
    }
  }
}

function disconnectVoiceNodes(
  oscillators: readonly OscillatorNode[],
  layerGains: readonly GainNode[],
  filter: BiquadFilterNode | null,
  gain: GainNode | null,
): void {
  for (const oscillator of oscillators) {
    oscillator.onended = null;
    disconnectNode(oscillator);
  }
  for (const layerGain of layerGains) disconnectNode(layerGain);
  if (filter) disconnectNode(filter);
  if (gain) disconnectNode(gain);
}

function disconnectNode(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // Cleanup is idempotent and must continue across already-disconnected nodes.
  }
}

function summary(name: string, preset: SynthPreset): SynthPresetSummary {
  return {
    name,
    label: preset.label,
    description: preset.description,
  };
}

function clonePreset(preset: SynthPreset): SynthPreset {
  return {
    ...preset,
    oscillators: normalizeOscillatorLayers(preset.oscillators),
    filter: normalizeFilter(preset.filter),
    env: normalizeEnvelope(preset.env),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
