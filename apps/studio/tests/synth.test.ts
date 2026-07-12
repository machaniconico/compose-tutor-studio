import { describe, expect, it } from 'vitest';
import {
  BEGINNER_SYNTH_PRESETS,
  SynthVoiceManager,
  buildOscillatorPlan,
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
