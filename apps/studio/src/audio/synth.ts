// Polyphonic subtractive synth voice.
//
// Each voice is: 2 detuned oscillators -> lowpass BiquadFilter -> ADSR GainNode.
// Presets (keyed by InstrumentConfig.preset) tweak oscillator shapes, detune,
// filter cutoff and the envelope. Voices are allocated per track with a steal
// cap (~16) so a stuck progression cannot exhaust the audio graph.
//
// Works with any BaseAudioContext so the same code drives live playback and the
// OfflineAudioContext used for WAV render.

/** ADSR envelope, seconds for A/D/R, 0..1 for sustain. */
export type Envelope = {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
};

/** Subtractive-synth preset definition. */
export type SynthPreset = {
  /** Oscillator waveforms for the two detuned voices. */
  waveA: OscillatorType;
  waveB: OscillatorType;
  /** Detune of the second oscillator, cents. */
  detuneCents: number;
  /** Base lowpass cutoff, Hz. */
  cutoffHz: number;
  /** Filter resonance (Q). */
  resonance: number;
  /** Per-note gain trim so presets sit at similar loudness. */
  gain: number;
  env: Envelope;
};

/**
 * Preset table. Keys cover both the canonical task names (warmPad / roundBass /
 * brightLead) and the names the default project currently ships with
 * (subBass / leadSine) so playback works without changing the project model.
 */
const PRESETS: Record<string, SynthPreset> = {
  // Soft attack, mellow filter — default for the Chords track.
  warmPad: {
    waveA: 'sawtooth',
    waveB: 'triangle',
    detuneCents: 8,
    cutoffHz: 1400,
    resonance: 0.6,
    gain: 0.22,
    env: { attack: 0.18, decay: 0.3, sustain: 0.7, release: 0.5 },
  },
  // Short attack, low filter, sine + triangle.
  roundBass: {
    waveA: 'sine',
    waveB: 'triangle',
    detuneCents: 4,
    cutoffHz: 600,
    resonance: 0.4,
    gain: 0.32,
    env: { attack: 0.005, decay: 0.12, sustain: 0.85, release: 0.12 },
  },
  // Saw, brighter filter — Melody.
  brightLead: {
    waveA: 'sawtooth',
    waveB: 'sawtooth',
    detuneCents: 12,
    cutoffHz: 3200,
    resonance: 0.9,
    gain: 0.26,
    env: { attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.18 },
  },
};

// Aliases for the preset names used by the current default project factory.
PRESETS['subBass'] = PRESETS['roundBass'] as SynthPreset;
PRESETS['leadSine'] = PRESETS['brightLead'] as SynthPreset;

/** Default preset when an unknown name is requested. */
const DEFAULT_PRESET = 'warmPad';

/** Resolve a preset by name, falling back to the default. */
export function resolvePreset(preset: string | undefined): SynthPreset {
  if (preset && PRESETS[preset]) return PRESETS[preset] as SynthPreset;
  return PRESETS[DEFAULT_PRESET] as SynthPreset;
}

/** Convert a MIDI note number to frequency in Hz (A4 = 69 = 440Hz). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Default per-voice steal cap (max simultaneous voices per track). */
export const MAX_VOICES = 16;

/** One sounding voice: the nodes plus when it should free itself. */
type ActiveVoice = {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  gain: GainNode;
  /** AudioContext time the voice fully finishes (after release). */
  endTime: number;
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
  private voices: ActiveVoice[] = [];

  constructor(
    ctx: BaseAudioContext,
    output: AudioNode,
    preset: string | undefined,
    maxVoices: number = MAX_VOICES,
  ) {
    this.ctx = ctx;
    this.output = output;
    this.preset = resolvePreset(preset);
    this.maxVoices = maxVoices;
  }

  /**
   * Schedule one note.
   *
   * @param midi      MIDI note number
   * @param startTime AudioContext time to start
   * @param duration  sounding duration in seconds (release happens after)
   * @param velocity  0..127 MIDI velocity
   */
  noteOn(midi: number, startTime: number, duration: number, velocity: number): void {
    this.reap(startTime);
    this.steal(startTime);

    const p = this.preset;
    const freq = midiToFreq(midi);
    const vel = Math.min(1, Math.max(0, velocity / 127));
    const peak = p.gain * (0.3 + 0.7 * vel);

    const oscA = this.ctx.createOscillator();
    oscA.type = p.waveA;
    oscA.frequency.setValueAtTime(freq, startTime);

    const oscB = this.ctx.createOscillator();
    oscB.type = p.waveB;
    oscB.frequency.setValueAtTime(freq, startTime);
    oscB.detune.setValueAtTime(p.detuneCents, startTime);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(p.cutoffHz, startTime);
    filter.Q.setValueAtTime(p.resonance, startTime);

    const gain = this.ctx.createGain();
    const { attack, decay, sustain, release } = p.env;

    // ADSR. Sustain runs until releaseStart, then a release ramp to 0.
    const releaseStart = startTime + Math.max(duration, attack + decay);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peak, startTime + attack);
    gain.gain.linearRampToValueAtTime(peak * sustain, startTime + attack + decay);
    gain.gain.setValueAtTime(peak * sustain, releaseStart);
    gain.gain.linearRampToValueAtTime(0, releaseStart + release);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.output);

    const stopAt = releaseStart + release + 0.02;
    oscA.start(startTime);
    oscB.start(startTime);
    oscA.stop(stopAt);
    oscB.stop(stopAt);

    this.voices.push({ oscA, oscB, gain, endTime: stopAt });
  }

  /** Immediately release every voice (used on stop). */
  releaseAll(when: number): void {
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(when);
        v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), when);
        v.gain.gain.linearRampToValueAtTime(0, when + 0.03);
        v.oscA.stop(when + 0.05);
        v.oscB.stop(when + 0.05);
      } catch {
        // Node may already be stopped; ignore.
      }
    }
    this.voices = [];
  }

  /** Drop voices that have finished before `now`. */
  private reap(now: number): void {
    this.voices = this.voices.filter((v) => v.endTime > now);
  }

  /** Enforce the voice cap by stealing the oldest voice. */
  private steal(when: number): void {
    while (this.voices.length >= this.maxVoices) {
      const victim = this.voices.shift();
      if (!victim) break;
      try {
        victim.gain.gain.cancelScheduledValues(when);
        victim.gain.gain.setValueAtTime(Math.max(0.0001, victim.gain.gain.value), when);
        victim.gain.gain.linearRampToValueAtTime(0, when + 0.02);
        victim.oscA.stop(when + 0.03);
        victim.oscB.stop(when + 0.03);
      } catch {
        // already stopped
      }
    }
  }
}
