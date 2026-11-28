import { describe, expect, it } from 'vitest';
import { applyInstrumentMacros, NEUTRAL_MACROS, readInstrumentMacro } from '../src/audio/macros';
import {
  BEGINNER_SYNTH_PRESETS,
  SynthVoiceManager,
  buildOscillatorPlan,
  canonicalSynthPresetName,
  createAdsrCurve,
  listSynthPresets,
  midiToFreq,
  normalizeEnvelope,
  resolvePreset,
  resolveSynthPatch,
} from '../src/audio/synth';

class FakeAudioParam {
  value = 0;
  readonly cancellations: number[] = [];
  readonly setEvents: Array<{ value: number; time: number }> = [];

  setValueAtTime(value: number, time = 0): void {
    this.value = value;
    this.setEvents.push({ value, time });
  }

  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }

  cancelScheduledValues(time: number): void {
    this.cancellations.push(time);
  }
}

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  disconnectCalls = 0;

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.length = 0;
  }
}

class FakeOscillator extends FakeAudioNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam();
  readonly detune = new FakeAudioParam();
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  onended: (() => void) | null = null;
  throwOnStart = false;

  start(time: number): void {
    if (this.throwOnStart) throw new Error('fake oscillator start failed');
    this.starts.push(time);
  }

  stop(time?: number): void {
    this.stops.push(time ?? -1);
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeGain extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeFilter extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

class FakeSynthContext {
  currentTime = 0;
  throwOnOscillatorStart = false;
  throwOnGainCall: number | null = null;
  private gainCalls = 0;
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    oscillator.throwOnStart = this.throwOnOscillatorStart;
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    this.gainCalls += 1;
    if (this.gainCalls === this.throwOnGainCall) {
      throw new Error('fake gain allocation failed');
    }
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter(): FakeFilter {
    const filter = new FakeFilter();
    this.filters.push(filter);
    return filter;
  }
}

const primaryLayer = {
  role: 'primary' as const,
  wave: 'sine' as const,
  octave: 0,
  detuneCents: 0,
  gain: 1,
};

function synthManager(
  fake: FakeSynthContext,
  output: FakeAudioNode,
  oscillatorCount = 1,
  maxVoices = 16,
): SynthVoiceManager {
  return new SynthVoiceManager(
    fake as unknown as BaseAudioContext,
    output as unknown as AudioNode,
    {
      oscillators: Array.from({ length: oscillatorCount }, (_, index) => ({
        ...primaryLayer,
        detuneCents: index,
      })),
      envelope: { attack: 0, decay: 0, sustain: 1, release: 0 },
    },
    maxVoices,
  );
}

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
    expect(new Set(names).size).toBe(14);
    for (const name of names) expect(canonicalSynthPresetName(name)).toBe(name);
    expect(new Set(BEGINNER_SYNTH_PRESETS).size).toBe(3);
  });

  it('keeps legacy preset names working through aliases', () => {
    expect(resolvePreset('pad').label).toBe('Soft Pad');
    expect(resolvePreset('subBass').label).toBe('Warm Bass');
    expect(resolvePreset('roundBass').label).toBe('Warm Bass');
    expect(resolvePreset('bass').label).toBe('Warm Bass');
    expect(resolvePreset('leadSine').label).toBe('Bright Lead');
    expect(resolvePreset('lead').label).toBe('Bright Lead');
    expect(resolvePreset('bell')).toEqual(resolvePreset('warmPad'));
    expect(resolvePreset('p22:bell')).not.toEqual(resolvePreset('warmPad'));
    expect(resolvePreset('missing-preset').label).toBe(resolvePreset('warmPad').label);
    expect(canonicalSynthPresetName('pad')).toBe('softPad');
    expect(canonicalSynthPresetName('bass')).toBe('warmBass');
    expect(canonicalSynthPresetName('lead')).toBe('brightLead');
    expect(canonicalSynthPresetName('missing-preset')).toBeNull();
    for (const inheritedKey of ['__proto__', 'constructor', 'toString']) {
      expect(canonicalSynthPresetName(inheritedKey)).toBeNull();
      expect(resolvePreset(inheritedKey).label).toBe('Soft Pad');
    }
  });

  it('falls back for malformed preset values without coercion', () => {
    const malformed = { toString: null };
    expect(canonicalSynthPresetName(malformed)).toBeNull();
    expect(resolvePreset(malformed)).toEqual(resolvePreset('softPad'));
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

describe('instrument macros', () => {
  it('preserves the base patch for absent, malformed, unrelated or neutral params', () => {
    const base = resolvePreset('softPad');
    const invalid = { macroBrightness: { toString: null }, macroAttack: Number.NaN };
    for (const params of [undefined, null, 42, 'invalid', invalid, { cutoff: 123 }, NEUTRAL_MACROS]) {
      expect(applyInstrumentMacros(base, params)).toBe(base);
    }
    expect(readInstrumentMacro(invalid, 'macroBrightness')).toBe(0.5);
    expect(applyInstrumentMacros(base, Object.create({ macroWidth: 1 }))).toBe(base);
  });

  it('clamps at use and changes only the corresponding parameters and unison detune', () => {
    const base = resolvePreset('softPad');
    const raw = { macroBrightness: 3, macroRelease: 2, macroWidth: 9, macroAttack: -1 };
    const adjusted = applyInstrumentMacros(base, raw);
    expect(raw).toEqual({ macroBrightness: 3, macroRelease: 2, macroWidth: 9, macroAttack: -1 });
    expect(adjusted.filter).toEqual({ cutoffHz: 5_000, resonance: base.filter.resonance });
    expect(adjusted.env).toEqual({ ...base.env, release: 3.2, attack: 0.07 });
    expect(adjusted.oscillators.map((layer) => layer.detuneCents)).toEqual([0, -31, 31, 0]);
    expect(base.oscillators.map((layer) => layer.detuneCents)).toEqual([0, -7, 7, 0]);
    expect(resolveSynthPatch({ preset: 'softPad', params: raw })).toEqual(adjusted);
  });

  it('schedules an adjusted voice using the existing node counts', () => {
    const fake = new FakeSynthContext();
    const manager = new SynthVoiceManager(
      fake as unknown as BaseAudioContext,
      new FakeAudioNode() as unknown as AudioNode,
      {
        preset: 'softPad',
        params: { macroBrightness: 1, macroRelease: 1, macroWidth: 1, macroAttack: 1 },
      },
    );
    manager.noteOn(60, 1, 0.05, 100);
    expect(fake.filters).toHaveLength(1);
    expect(fake.filters[0]?.frequency.setEvents).toEqual([{ time: 1, value: 5_000 }]);
    expect(fake.gains).toHaveLength(5);
    expect(fake.oscillators).toHaveLength(4);
    expect(fake.oscillators.map((osc) => osc.detune.value)).toEqual([0, -31, 31, 0]);
    for (const osc of fake.oscillators) {
      expect(osc.stops[0]).toBeCloseTo(1 + 1.12 + 0.42 + 3.2 + 0.02, 12);
    }
  });
});

describe('SynthVoiceManager node ownership', () => {
  it('waits for every oscillator before disconnecting the complete voice graph', () => {
    const fake = new FakeSynthContext();
    const output = new FakeAudioNode();
    const manager = synthManager(fake, output, 2);

    manager.noteOn(60, 0, 1, 100);
    const savedHandlers = fake.oscillators.map((oscillator) => oscillator.onended);
    fake.oscillators[0]?.finish();

    expect(fake.oscillators.every((node) => node.disconnectCalls === 0)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 0)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 0)).toBe(true);

    fake.oscillators[1]?.finish();
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(output.disconnectCalls).toBe(0);

    for (const handler of savedHandlers) handler?.();
    manager.dispose();
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
  });

  it('keeps future-time voices owned after overlap pruning and releases all of them', () => {
    const fake = new FakeSynthContext();
    const output = new FakeAudioNode();
    const manager = synthManager(fake, output);

    manager.noteOn(60, 1, 0.1, 100);
    manager.noteOn(62, 10, 0.1, 100);
    expect(fake.oscillators.every((node) => node.disconnectCalls === 0)).toBe(true);

    manager.releaseAll(0);
    expect(fake.oscillators).toHaveLength(2);
    for (const oscillator of fake.oscillators) {
      expect(oscillator.stops.at(-1)).toBe(0.05);
      expect(oscillator.disconnectCalls).toBe(0);
      oscillator.finish();
    }
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
  });

  it('uses real context time to clean a missed ended callback without cutting future audio', () => {
    const fake = new FakeSynthContext();
    const manager = synthManager(fake, new FakeAudioNode());

    manager.noteOn(60, 0, 0.01, 100);
    fake.currentTime = 0.04;
    manager.noteOn(62, 1, 0.01, 100);

    expect(fake.oscillators[0]?.disconnectCalls).toBe(1);
    expect(fake.oscillators[1]?.disconnectCalls).toBe(0);
    fake.oscillators[1]?.finish();
  });

  it('keeps a stolen voice connected until its earlier replacement stop ends', () => {
    const fake = new FakeSynthContext();
    const manager = synthManager(fake, new FakeAudioNode(), 1, 1);

    manager.noteOn(60, 0, 10, 100);
    manager.noteOn(62, 0.1, 1, 100);

    expect(fake.oscillators[0]?.stops).toEqual([10.02, 0.13]);
    expect(fake.oscillators[0]?.disconnectCalls).toBe(0);
    fake.oscillators[0]?.finish();
    expect(fake.oscillators[0]?.disconnectCalls).toBe(1);
    fake.oscillators[1]?.finish();
  });

  it('holds a future envelope at its scheduled curve value before a steal fade', () => {
    const fake = new FakeSynthContext();
    const manager = new SynthVoiceManager(
      fake as unknown as BaseAudioContext,
      new FakeAudioNode() as unknown as AudioNode,
      {
        oscillators: [primaryLayer],
        envelope: { attack: 1, decay: 0, sustain: 1, release: 0 },
      },
      1,
    );

    manager.noteOn(60, 0, 10, 100);
    manager.noteOn(62, 0.5, 1, 100);

    const held = fake.gains[0]?.gain.setEvents.at(-1);
    expect(held?.time).toBe(0.5);
    expect(held?.value).toBeGreaterThan(0);
    expect(held?.value).toBeLessThan(0.3);
  });

  it('never replaces an earlier natural stop with a later release stop', () => {
    const fake = new FakeSynthContext();
    const manager = synthManager(fake, new FakeAudioNode());

    manager.noteOn(60, 0, 0.01, 100);
    const oscillator = fake.oscillators[0];
    expect(oscillator?.stops).toEqual([0.03]);

    manager.releaseAll(0);
    expect(oscillator?.stops).toEqual([0.03]);
    oscillator?.finish();
  });

  it('cancels a not-yet-started voice hard so it never sounds - live-edit fix B', () => {
    const fake = new FakeSynthContext();
    const output = new FakeAudioNode();
    const manager = new SynthVoiceManager(
      fake as unknown as BaseAudioContext,
      output as unknown as AudioNode,
      'warmPad',
    );
    const handle = manager.noteOn(60, 0.11, 0.5, 100);
    expect(handle).not.toBeNull();
    fake.currentTime = 0.1013;

    manager.releaseVoice(handle!, 0.1013);

    // The voice envelope gain is allocated before the per-layer gains.
    const gain = fake.gains[0]!.gain;
    expect(gain.cancellations).toContain(0);
    expect(gain.setEvents.at(-1)).toEqual({ value: 0, time: 0.1013 });
    // A later stop() replaces the natural one: every source now stops before
    // its 110 ms start, so no sample is rendered.
    for (const oscillator of fake.oscillators) {
      expect(oscillator.starts).toEqual([0.11]);
      expect(oscillator.stops.at(-1)).toBeLessThan(0.11);
      expect(oscillator.disconnectCalls).toBe(1);
    }
    expect(fake.gains[0]!.disconnectCalls).toBe(1);
  });

  it('keeps the short release ramp for a voice that is already sounding', () => {
    const fake = new FakeSynthContext();
    const manager = synthManager(fake, new FakeAudioNode());
    const handle = manager.noteOn(60, 0, 2, 100);
    fake.currentTime = 0.5;

    manager.releaseVoice(handle!, 0.5);

    expect(fake.oscillators[0]?.stops.at(-1)).toBeCloseTo(0.55, 9);
    expect(fake.gains[0]?.disconnectCalls).toBe(0);
  });

  it('hard-disposes scheduled voices synchronously and ignores stale note callbacks', () => {
    const fake = new FakeSynthContext();
    const output = new FakeAudioNode();
    const manager = synthManager(fake, output, 2);

    manager.noteOn(60, 10, 1, 100);
    const staleHandlers = fake.oscillators.map((oscillator) => oscillator.onended);
    manager.dispose();
    manager.dispose();

    expect(fake.oscillators.every((node) => node.stops.at(-1) === 0)).toBe(true);
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
    for (const handler of staleHandlers) handler?.();

    manager.noteOn(62, 12, 1, 100);
    expect(fake.oscillators).toHaveLength(2);
    expect(output.disconnectCalls).toBe(0);
  });

  it('disconnects a partially scheduled graph when a source start fails', () => {
    const fake = new FakeSynthContext();
    fake.throwOnOscillatorStart = true;
    const manager = synthManager(fake, new FakeAudioNode(), 2);

    expect(() => manager.noteOn(60, 0, 1, 100)).toThrow('fake oscillator start failed');
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
    manager.dispose();
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
  });

  it('disconnects nodes allocated before a layer-gain allocation failure', () => {
    const fake = new FakeSynthContext();
    fake.throwOnGainCall = 2;
    const manager = synthManager(fake, new FakeAudioNode(), 2);

    expect(() => manager.noteOn(60, 0, 1, 100)).toThrow('fake gain allocation failed');
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.oscillators[0]?.disconnectCalls).toBe(1);
    expect(fake.gains).toHaveLength(1);
    expect(fake.gains[0]?.disconnectCalls).toBe(1);
    expect(fake.filters[0]?.disconnectCalls).toBe(1);
    manager.dispose();
    expect(fake.oscillators[0]?.disconnectCalls).toBe(1);
  });

  it('disconnects 10,000 naturally ended graphs exactly once', () => {
    const fake = new FakeSynthContext();
    const manager = synthManager(fake, new FakeAudioNode(), 1, 1);

    for (let index = 0; index < 10_000; index += 1) {
      manager.noteOn(60, index, 0.01, 100);
      fake.oscillators[index]?.finish();
    }
    manager.dispose();

    expect(fake.oscillators).toHaveLength(10_000);
    expect(fake.gains).toHaveLength(20_000);
    expect(fake.filters).toHaveLength(10_000);
    expect(fake.oscillators.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
  });
});
