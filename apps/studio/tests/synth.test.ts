import { describe, expect, it } from 'vitest';
import {
  BEGINNER_SYNTH_PRESETS,
  buildOscillatorPlan,
  createAdsrCurve,
  listSynthPresets,
  midiToFreq,
  normalizeEnvelope,
  resolvePreset,
  resolveSynthPatch,
} from '../src/audio/synth';

describe('createAdsrCurve', () => {
  it('schedules attack, decay, sustain, and release points', () => {
    const curve = createAdsrCurve(
      { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 },
      1,
      2,
      0.8,
    );

    expect(curve).toEqual([
      { time: 1, value: 0 },
      { time: 1.1, value: 0.8 },
      { time: 1.3, value: 0.4 },
      { time: 3, value: 0.4 },
      { time: 3.3, value: 0 },
    ]);
  });

  it('keeps very short notes long enough to finish attack and decay', () => {
    const curve = createAdsrCurve(
      { attack: 0.2, decay: 0.3, sustain: 0.5, release: 0.1 },
      4,
      0.05,
      1,
    );

    expect(curve[3]).toEqual({ time: 4.5, value: 0.5 });
    expect(curve[4]).toEqual({ time: 4.6, value: 0 });
  });
});

describe('normalizeEnvelope', () => {
  it('clamps envelope values to usable ranges', () => {
    const env = normalizeEnvelope({
      attack: -1,
      decay: Number.NaN,
      sustain: 2,
      release: Number.POSITIVE_INFINITY,
    });

    expect(env.attack).toBe(0);
    expect(env.decay).toBeGreaterThan(0);
    expect(env.sustain).toBe(1);
    expect(env.release).toBeGreaterThan(0);
  });
});

describe('synth presets', () => {
  it('lists beginner-friendly selectable presets', () => {
    const names = listSynthPresets().map((preset) => preset.name);

    expect(names).toEqual(expect.arrayContaining([...BEGINNER_SYNTH_PRESETS]));
    expect(new Set(BEGINNER_SYNTH_PRESETS).size).toBe(3);
  });

  it('keeps legacy preset names working through aliases', () => {
    expect(resolvePreset('subBass').label).toBe('Warm Bass');
    expect(resolvePreset('roundBass').label).toBe('Warm Bass');
    expect(resolvePreset('leadSine').label).toBe('Bright Lead');
    expect(resolvePreset('missing-preset').label).toBe(resolvePreset('warmPad').label);
  });

  it('returns independent preset copies', () => {
    const first = resolvePreset('softPad');
    first.env.attack = 9;

    expect(resolvePreset('softPad').env.attack).not.toBe(9);
  });

  it('accepts the old string path and the new option override path', () => {
    expect(resolveSynthPatch('subBass').label).toBe(resolveSynthPatch({ preset: 'subBass' }).label);

    const custom = resolveSynthPatch({
      preset: 'warmBass',
      envelope: { attack: 0.4, sustain: 0.25 },
      filter: { cutoffHz: 900 },
      gain: 0.11,
      oscillators: [{ role: 'primary', wave: 'sine', octave: 0, detuneCents: 0, gain: 1 }],
    });

    expect(custom.env.attack).toBe(0.4);
    expect(custom.env.sustain).toBe(0.25);
    expect(custom.filter.cutoffHz).toBe(900);
    expect(custom.gain).toBe(0.11);
    expect(custom.oscillators).toHaveLength(1);
  });
});

describe('buildOscillatorPlan', () => {
  it('builds detuned unison and sub oscillator layers', () => {
    const plan = buildOscillatorPlan(resolvePreset('softPad'), 60);

    expect(plan.length).toBeGreaterThanOrEqual(3);
    expect(plan.some((layer) => layer.role === 'unison' && layer.detuneCents > 0)).toBe(true);
    expect(plan.some((layer) => layer.role === 'unison' && layer.detuneCents < 0)).toBe(true);
    expect(plan.some((layer) => layer.role === 'sub')).toBe(true);
    expect(plan.find((layer) => layer.role === 'sub')?.frequencyHz).toBeCloseTo(midiToFreq(48), 10);
  });
});
