import { describe, expect, it, vi } from 'vitest';
import type { InstrumentMacros } from '@cts/project-model';
import {
  applyMacros,
  MACRO_ATTACK_MAX_S,
  MACRO_ATTACK_MIN_S,
  MACRO_CUTOFF_MAX_HZ,
  MACRO_CUTOFF_MIN_HZ,
  MACRO_RELEASE_MAX_S,
  MACRO_RELEASE_MIN_S,
} from '../src/audio/macros';
import { RENDER_SAMPLE_RATE } from '../src/audio/wav';
import {
  MAX_NODES_PER_VOICE,
  PRESET_LIST,
  SynthVoiceManager,
  resolvePreset,
  type SynthPreset,
} from '../src/audio/synth';

// Parameters as they were at HEAD before US-020 (git show HEAD:apps/studio/src/audio/synth.ts),
// written out by hand so a change to the table is caught.
const WARM_PAD: SynthPreset = {
  waveA: 'sawtooth',
  waveB: 'triangle',
  detuneCents: 8,
  cutoffHz: 1400,
  resonance: 0.6,
  gain: 0.22,
  env: { attack: 0.18, decay: 0.3, sustain: 0.7, release: 0.5 },
};
const ROUND_BASS: SynthPreset = {
  waveA: 'sine',
  waveB: 'triangle',
  detuneCents: 4,
  cutoffHz: 600,
  resonance: 0.4,
  gain: 0.32,
  env: { attack: 0.005, decay: 0.12, sustain: 0.85, release: 0.12 },
};
const BRIGHT_LEAD: SynthPreset = {
  waveA: 'sawtooth',
  waveB: 'sawtooth',
  detuneCents: 12,
  cutoffHz: 3200,
  resonance: 0.9,
  gain: 0.26,
  env: { attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.18 },
};

it('uses warm pad for non-string preset inputs without coercing them', () => {
  for (const preset of [{ toString: null }, ['bell'], new String('bell'), 42, true, Symbol('bell'), null, undefined]) {
    expect(resolvePreset(preset)).toBe(resolvePreset('warmPad'));
  }
});

/** Product / company / artist-like words that must not appear in preset names. */
const BANNED_WORDS = [
  'serum', 'massive', 'logic', 'cubase', 'ableton', 'live', 'fl studio', 'nexus', 'omnisphere',
  'sylenth', 'vital', 'kontakt', 'korg', 'roland', 'yamaha', 'moog', 'juno', 'jupiter', 'tb-303',
  'tr-808', 'dx7', 'nord', 'steinway', 'rhodes', 'wurlitzer', 'hammond', 'prophet', 'arturia',
  'native instruments', 'spectrasonics', 'garageband', 'protools', 'pro tools', 'reason', 'bitwig',
];

const ALL_MAX: InstrumentMacros = { brightness: 1, release: 1, width: 1, attack: 1 };
const ALL_MIN: InstrumentMacros = { brightness: 0, release: 0, width: 0, attack: 0 };

describe('synth presets', () => {
  it('lists at least 10 presets with unique ids that all resolve to themselves', () => {
    expect(PRESET_LIST.length).toBeGreaterThanOrEqual(10);
    expect(new Set(PRESET_LIST.map((p) => p.id)).size).toBe(PRESET_LIST.length);
    for (const info of PRESET_LIST) {
      expect(info.name.trim()).not.toBe('');
      expect(info.description.trim()).not.toBe('');
      // Each listed id is a real entry, not the warmPad fallback (warmPad itself excepted).
      if (info.id !== 'warmPad') expect(resolvePreset(info.id)).not.toBe(resolvePreset('warmPad'));
    }
  });

  it('uses functional names without product, company or artist words', () => {
    for (const info of PRESET_LIST) {
      const text = `${info.id} ${info.name} ${info.description}`.toLowerCase();
      for (const word of BANNED_WORDS) expect(text, `${info.id} contains "${word}"`).not.toContain(word);
      // Names are Japanese, with no Latin product-like words.
      expect(info.name).not.toMatch(/[A-Za-z]/);
    }
  });

  it('keeps warmPad / roundBass / brightLead exactly as before', () => {
    expect(resolvePreset('warmPad')).toEqual(WARM_PAD);
    expect(resolvePreset('roundBass')).toEqual(ROUND_BASS);
    expect(resolvePreset('brightLead')).toEqual(BRIGHT_LEAD);
  });

  it('keeps every alias and stored name sounding as before (piano, pad, bass, lead fall back to warmPad)', () => {
    expect(resolvePreset('subBass')).toEqual(ROUND_BASS);
    expect(resolvePreset('leadSine')).toEqual(BRIGHT_LEAD);
    // 'piano' is written by MIDI import; pad / bass / lead by the default project factory.
    for (const stored of ['piano', 'pad', 'bass', 'lead']) expect(resolvePreset(stored)).toEqual(WARM_PAD);
  });

  it('falls back to warmPad for unknown or missing names', () => {
    expect(resolvePreset('no-such-sound')).toEqual(WARM_PAD);
    expect(resolvePreset(undefined)).toEqual(WARM_PAD);
    expect(resolvePreset('')).toEqual(WARM_PAD);
  });

  it('does not pick up inherited object properties as presets (constructor, __proto__, toString)', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolvePreset(name)).toEqual(WARM_PAD);
      const shaped = applyMacros(resolvePreset(name), { brightness: 0.5, release: 0.5, width: 0.5, attack: 0.5 });
      expect(Number.isFinite(shaped.env.attack)).toBe(true);
    }
  });
});

describe('applyMacros', () => {
  const pad = resolvePreset('warmPad');

  it('returns the very same preset object when no macros are set', () => {
    expect(applyMacros(pad, undefined)).toBe(pad);
  });

  it('does not change the input preset', () => {
    applyMacros(pad, ALL_MAX);
    expect(pad).toEqual(WARM_PAD);
  });

  it('raises the filter cutoff monotonically with brightness 0 / 0.5 / 1', () => {
    for (const info of PRESET_LIST) {
      const preset = resolvePreset(info.id);
      const at = (brightness: number) =>
        applyMacros(preset, { brightness, release: 0.5, width: 0, attack: 0.5 }).cutoffHz;
      expect(at(0), info.id).toBeLessThan(at(0.5));
      expect(at(0.5), info.id).toBeLessThan(at(1));
    }
  });

  it('keeps the preset values at the neutral point (brightness / release / attack 0.5, width 0)', () => {
    const out = applyMacros(pad, { brightness: 0.5, release: 0.5, width: 0, attack: 0.5 });
    expect(out.cutoffHz).toBeCloseTo(1400, 9);
    expect(out.env.attack).toBeCloseTo(0.18, 9);
    expect(out.env.release).toBeCloseTo(0.5, 9);
    expect(out.spread).toBe(0);
  });

  it('lengthens release and attack as their macros rise, and spreads with width', () => {
    const low = applyMacros(pad, ALL_MIN);
    const high = applyMacros(pad, ALL_MAX);
    expect(low.env.release).toBeLessThan(high.env.release);
    expect(low.env.attack).toBeLessThan(high.env.attack);
    expect(low.spread).toBe(0);
    expect(high.spread).toBe(1);
  });

  it('keeps every preset playable at the macro bounds 0 and 1', () => {
    const nyquist = RENDER_SAMPLE_RATE / 2;
    for (const info of PRESET_LIST) {
      const preset = resolvePreset(info.id);
      for (const macros of [ALL_MIN, ALL_MAX]) {
        const out = applyMacros(preset, macros);
        const label = `${info.id} ${JSON.stringify(macros)}`;
        expect(Number.isFinite(out.cutoffHz), label).toBe(true);
        expect(out.cutoffHz, label).toBeGreaterThanOrEqual(MACRO_CUTOFF_MIN_HZ);
        expect(out.cutoffHz, label).toBeLessThanOrEqual(MACRO_CUTOFF_MAX_HZ);
        expect(out.cutoffHz, label).toBeLessThan(nyquist);
        expect(out.env.attack, label).toBeGreaterThanOrEqual(MACRO_ATTACK_MIN_S);
        expect(out.env.attack, label).toBeLessThanOrEqual(MACRO_ATTACK_MAX_S);
        expect(out.env.release, label).toBeGreaterThanOrEqual(MACRO_RELEASE_MIN_S);
        expect(out.env.release, label).toBeLessThanOrEqual(MACRO_RELEASE_MAX_S);
        expect(out.env.decay, label).toBeGreaterThan(0);
        expect(out.spread, label).toBeGreaterThanOrEqual(0);
        expect(out.spread, label).toBeLessThanOrEqual(1);
        // Untouched parameters stay as the preset has them.
        expect(out.gain).toBe(preset.gain);
        expect(out.resonance).toBe(preset.resonance);
        expect(out.env.sustain).toBe(preset.env.sustain);
      }
    }
  });

  it('maps non-finite macro values to finite, safe parameters', () => {
    const out = applyMacros(pad, { brightness: Number.NaN, release: Infinity, width: Number.NaN, attack: -Infinity });
    expect(Number.isFinite(out.cutoffHz)).toBe(true);
    expect(Number.isFinite(out.env.release)).toBe(true);
    expect(Number.isFinite(out.env.attack)).toBe(true);
    expect(out.spread).toBe(0);
  });
});

/** A context that counts the audio nodes it creates. */
function countingContext() {
  const counts = { nodes: 0, panners: 0 };
  const param = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const node = <T extends object>(extra: T) => {
    counts.nodes += 1;
    return { connect: vi.fn(), ...extra };
  };
  const ctx = {
    currentTime: 0,
    createOscillator: vi.fn(() =>
      node({ type: 'sine', frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn() }),
    ),
    createBiquadFilter: vi.fn(() => node({ type: 'lowpass', frequency: param(), Q: param() })),
    createGain: vi.fn(() => node({ gain: param() })),
    createStereoPanner: vi.fn(() => {
      counts.panners += 1;
      return node({ pan: param() });
    }),
  };
  return { ctx: ctx as unknown as BaseAudioContext, counts };
}

describe('voice node budget', () => {
  it('creates at most MAX_NODES_PER_VOICE (6) nodes per voice, with or without macros', () => {
    expect(MAX_NODES_PER_VOICE).toBeLessThanOrEqual(6);
    for (const info of PRESET_LIST) {
      for (const macros of [undefined, ALL_MAX]) {
        const { ctx, counts } = countingContext();
        const synth = new SynthVoiceManager(ctx, {} as AudioNode, info.id, undefined, macros);
        for (let i = 0; i < 16; i += 1) synth.noteOn(48 + i, i * 0.01, 0.5, 100);
        expect(counts.nodes / 16, info.id).toBeLessThanOrEqual(MAX_NODES_PER_VOICE);
      }
    }
  });

  it('adds no panner node without a width spread, so old songs keep their exact graph', () => {
    const { ctx, counts } = countingContext();
    new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad').noteOn(60, 0, 0.5, 100);
    expect(counts.nodes).toBe(4);
    expect(counts.panners).toBe(0);
  });

  it('pans neighbouring notes to opposite sides when width is up', () => {
    const { ctx } = countingContext();
    const synth = new SynthVoiceManager(ctx, {} as AudioNode, 'warmPad', undefined, ALL_MAX);
    synth.noteOn(60, 0, 0.5, 100);
    synth.noteOn(61, 0, 0.5, 100);
    const panners = (ctx.createStereoPanner as unknown as ReturnType<typeof vi.fn>).mock.results.map(
      (r) => (r.value as { pan: { setValueAtTime: ReturnType<typeof vi.fn> } }).pan.setValueAtTime.mock.calls[0]![0] as number,
    );
    expect(panners).toHaveLength(2);
    expect(Math.sign(panners[0]!)).toBe(-Math.sign(panners[1]!));
    expect(Math.abs(panners[0]!)).toBeGreaterThan(0);
    expect(Math.abs(panners[0]!)).toBeLessThanOrEqual(1);
  });
});
