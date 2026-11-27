// Polyphonic subtractive synth voice.
//
// Each voice is: 2 detuned oscillators -> lowpass BiquadFilter -> ADSR GainNode
// (-> StereoPannerNode only when the preset has a stereo spread): at most
// MAX_NODES_PER_VOICE nodes, so 16 voices stay light.
// Presets (keyed by InstrumentConfig.preset) tweak oscillator shapes, detune,
// filter cutoff and the envelope. Voices are allocated per track with a steal
// cap (~16) so a stuck progression cannot exhaust the audio graph.
//
// Works with any BaseAudioContext so the same code drives live playback and the
// OfflineAudioContext used for WAV render.

import type { InstrumentMacros } from '@cts/project-model';
import { noteEnvelopeTiming } from './envelope';
import { applyMacros } from './macros';
import { resolvePreset, type Envelope, type SynthPreset } from './presets';

export {
  PRESET_CATEGORY_LABELS,
  PRESET_LIST,
  resolvePreset,
  type Envelope,
  type PresetCategory,
  type PresetInfo,
  type SynthPreset,
} from './presets';

/** Most audio nodes one voice creates (2 oscillators, filter, gain, panner). */
export const MAX_NODES_PER_VOICE = 6;

/** How far a fully spread voice pans, -1..1. */
const SPREAD_PAN = 0.7;

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
  /** AudioContext time the oscillators stop, just after release. */
  endTime: number;
  /** AudioContext time the gain ramp reaches zero. */
  releaseEndTime: number;
  /** AudioContext time the voice starts sounding. */
  startTime: number;
  env: Envelope;
  peak: number;
};

/**
 * ADSR up to the release for a gate of `gate` seconds: the ramps after the
 * initial 0 at the start (offsets from the start) and the level held when the
 * release begins. A gate shorter than attack+decay cuts the envelope there.
 */
function envelopeShape(env: Envelope, peak: number, gate: number): { ramps: Array<[number, number]>; level: number } {
  const { attack, decay, sustain } = env;
  if (gate >= attack + decay) {
    const level = peak * sustain;
    return { ramps: [[attack, peak], [attack + decay, level]], level };
  }
  if (gate >= attack) {
    const level = peak - (peak - peak * sustain) * ((gate - attack) / decay);
    return { ramps: [[attack, peak], [gate, level]], level };
  }
  const level = peak * (gate / attack);
  return { ramps: [[gate, level]], level };
}

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
    preset: unknown,
    maxVoices: number = MAX_VOICES,
    macros?: InstrumentMacros,
  ) {
    this.ctx = ctx;
    this.output = output;
    // Live playback, WAV render and the live preview all build voices here, so
    // the macros are mapped by the same applyMacros on every path.
    this.preset = applyMacros(resolvePreset(preset), macros);
    this.maxVoices = maxVoices;
  }

  /** AudioContext time when the last scheduled gain ramp reaches zero. */
  get latestReleaseEndTime(): number {
    return this.voices.reduce((latest, voice) => Math.max(latest, voice.releaseEndTime), 0);
  }

  /**
   * Schedule one note.
   *
   * @param midi      MIDI note number
   * @param startTime AudioContext time to start
   * @param duration  sounding duration in seconds (release happens after)
   * @param velocity  0..127 MIDI velocity
   * @param options.env       envelope override (defaults to the preset's envelope)
   * @param options.cutAtEnd  the note was cut short (e.g. at the clip end): release
   *                          exactly at `duration` even if attack+decay is longer
   */
  noteOn(
    midi: number,
    startTime: number,
    duration: number,
    velocity: number,
    options: { env?: Envelope; cutAtEnd?: boolean } = {},
  ): {
    release: (when: number) => void;
    setDuration: (seconds: number, when: number, cutAtEnd?: boolean) => void;
  } {
    const env = options.env ?? this.preset.env;
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
    // ADSR. Sustain runs until releaseStart, then a release ramp to 0. A normal
    // note always plays its full attack+decay before releasing. A note cut short
    // (`cutAtEnd`, e.g. at the clip end) releases at its duration, matching the
    // MIDI note-off: the envelope is cut where it is.
    const { gate, releaseStart, releaseEnd } = noteEnvelopeTiming(env, startTime, duration, options.cutAtEnd);
    gain.gain.setValueAtTime(0, startTime);
    const { ramps, level } = envelopeShape(env, peak, gate);
    for (const [offset, value] of ramps) gain.gain.linearRampToValueAtTime(value, startTime + offset);
    gain.gain.setValueAtTime(level, releaseStart);
    gain.gain.linearRampToValueAtTime(0, releaseEnd);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    const spread = p.spread ?? 0;
    if (spread > 0 && typeof this.ctx.createStereoPanner === 'function') {
      // Alternate notes left / right so chords spread out (deterministic: same
      // pan live and in the WAV render).
      const panner = this.ctx.createStereoPanner();
      panner.pan.setValueAtTime((midi % 2 === 0 ? -1 : 1) * SPREAD_PAN * spread, startTime);
      gain.connect(panner);
      panner.connect(this.output);
    } else {
      gain.connect(this.output);
    }

    const stopAt = releaseEnd + 0.02;
    oscA.start(startTime);
    oscB.start(startTime);
    oscA.stop(stopAt);
    oscB.stop(stopAt);

    const voice: ActiveVoice = { oscA, oscB, gain, endTime: stopAt, releaseEndTime: releaseEnd, startTime, env, peak };
    this.voices.push(voice);
    return {
      release: (when: number) => this.release(voice, when),
      setDuration: (seconds: number, when: number, cutAtEnd?: boolean) =>
        this.setDuration(voice, seconds, when, cutAtEnd),
    };
  }

  /**
   * Move a voice's release (live edits) so it sounds for `seconds` from its
   * start, as if noteOn had been given that duration. The voice keeps its
   * slot: no other voice is taken. A release already past `when` ends it at
   * `when` instead.
   */
  private setDuration(voice: ActiveVoice, seconds: number, when: number, cutAtEnd?: boolean): void {
    if (voice.endTime <= when) return;
    const { gate, releaseStart, releaseEnd } = noteEnvelopeTiming(voice.env, voice.startTime, seconds, cutAtEnd);
    if (releaseStart <= when) {
      this.release(voice, when);
      return;
    }
    const param = voice.gain.gain;
    const from = Math.max(when, voice.startTime);
    try {
      if (from === voice.startTime) {
        param.cancelScheduledValues(from);
        param.setValueAtTime(0, from);
      } else if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(from);
      } else {
        param.cancelScheduledValues(from);
        param.setValueAtTime(param.value, from);
      }
      const { ramps, level } = envelopeShape(voice.env, voice.peak, gate);
      for (const [offset, value] of ramps) {
        if (voice.startTime + offset > from) param.linearRampToValueAtTime(value, voice.startTime + offset);
      }
      // A ramp, not a jump: a voice already in its old release returns smoothly.
      param.linearRampToValueAtTime(level, releaseStart);
      param.linearRampToValueAtTime(0, releaseEnd);
      const stopAt = releaseEnd + 0.02;
      voice.oscA.stop(stopAt);
      voice.oscB.stop(stopAt);
      voice.endTime = stopAt;
      voice.releaseEndTime = releaseEnd;
    } catch {
      // Node may already be stopped; ignore.
    }
  }

  /**
   * End one voice at `when` (live edits). A voice not started by then is
   * silenced without a fade (a fade could run past its start and be heard);
   * a sounding one fades out there instead of at its own end.
   */
  private release(voice: ActiveVoice, when: number, fadeSeconds = 0.03, stopPadSeconds = 0.02): void {
    if (voice.endTime <= when) return;
    const param = voice.gain.gain;
    if (when <= voice.startTime) {
      try {
        param.cancelScheduledValues(when);
        param.setValueAtTime(0, when);
        voice.oscA.stop(voice.startTime);
        voice.oscB.stop(voice.startTime);
      } catch {
        // Node may already be stopped; ignore.
      }
      voice.endTime = voice.startTime;
      voice.releaseEndTime = voice.startTime;
      return;
    }
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(when);
      } else {
        param.cancelScheduledValues(when);
        param.setValueAtTime(Math.max(0.0001, param.value), when);
      }
      param.linearRampToValueAtTime(0, when + fadeSeconds);
      voice.oscA.stop(when + fadeSeconds + stopPadSeconds);
      voice.oscB.stop(when + fadeSeconds + stopPadSeconds);
      voice.endTime = when + fadeSeconds + stopPadSeconds;
      voice.releaseEndTime = when + fadeSeconds;
    } catch {
      // Node may already be stopped; ignore.
    }
  }

  /**
   * Immediately release every voice (used on stop): fade to silence over
   * `fadeSeconds`, then stop the oscillators `stopPadSeconds` later.
   */
  releaseAll(when: number, fadeSeconds = 0.03, stopPadSeconds = 0.02): void {
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(when);
        v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), when);
        v.gain.gain.linearRampToValueAtTime(0, when + fadeSeconds);
        v.oscA.stop(when + fadeSeconds + stopPadSeconds);
        v.oscB.stop(when + fadeSeconds + stopPadSeconds);
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
