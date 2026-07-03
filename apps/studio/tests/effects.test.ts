import { describe, expect, it } from 'vitest';
import type { EffectConfig, Track } from '@cts/project-model';
import {
  buildEffectChain,
  clamp01,
  decayToSeconds,
  delayTimeToSeconds,
  feedbackToGain,
  normalizeEffectConfig,
} from '../src/audio/effects';
import { TrackGraph } from '../src/audio/graph';

class FakeAudioParam {
  value = 0;

  setTargetAtTime(value: number): void {
    this.value = value;
  }
}

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  disconnectCalls = 0;

  connect(node: FakeAudioNode): FakeAudioNode {
    this.connections.push(node);
    return node;
  }

  disconnect(): void {
    this.connections.length = 0;
    this.disconnectCalls += 1;
  }
}

class FakeGain extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeStereoPanner extends FakeAudioNode {
  readonly pan = new FakeAudioParam();
}

class FakeBiquadFilter extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

class FakeDelay extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam();
}

class FakeConvolver extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
}

class FakeAudioBuffer {
  readonly data: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.data[channel];
    if (!data) throw new Error(`missing channel ${channel}`);
    return data;
  }
}

class FakeContext {
  readonly sampleRate = 44_100;
  readonly gains: FakeGain[] = [];
  readonly panners: FakeStereoPanner[] = [];
  readonly filters: FakeBiquadFilter[] = [];
  readonly delays: FakeDelay[] = [];
  readonly convolvers: FakeConvolver[] = [];

  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createStereoPanner(): FakeStereoPanner {
    const node = new FakeStereoPanner();
    this.panners.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilter {
    const node = new FakeBiquadFilter();
    this.filters.push(node);
    return node;
  }

  createDelay(): FakeDelay {
    const node = new FakeDelay();
    this.delays.push(node);
    return node;
  }

  createConvolver(): FakeConvolver {
    const node = new FakeConvolver();
    this.convolvers.push(node);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
}

function ctx(): BaseAudioContext {
  return new FakeContext() as unknown as BaseAudioContext;
}

function asFakeContext(context: BaseAudioContext): FakeContext {
  return context as unknown as FakeContext;
}

function effect(type: EffectConfig['type'], params: Record<string, number>): EffectConfig {
  return { id: type, type, enabled: true, params };
}

function track(effects: EffectConfig[] = []): Track {
  return {
    id: 'track-1',
    name: 'Track 1',
    type: 'instrument',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects,
  };
}

describe('effect parameter clamps', () => {
  it('clamps normalized values into 0..1', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN, 0.5)).toBe(0.5);
  });

  it('normalizes filter/delay/reverb params with safe defaults', () => {
    const filter = normalizeEffectConfig(effect('filter', { cutoff: 9, resonance: Number.NaN }));
    expect(filter.params.cutoff).toBe(1);
    expect(filter.params.resonance).toBe(0.15);

    const delay = normalizeEffectConfig(
      effect('delay', { delayTime: -1, feedback: 2, mix: Number.NaN, stray: 99 }),
    );
    expect(delay.params.delayTime).toBe(0);
    expect(delay.params.feedback).toBe(1);
    expect(delay.params.mix).toBe(0.25);
    expect(delay.params.stray).toBe(1);

    const reverb = normalizeEffectConfig(effect('reverb', { mix: 0.8, decay: -1 }));
    expect(reverb.params.wet).toBe(0.8);
    expect(reverb.params.decay).toBe(0);
  });
});

describe('buildEffectChain', () => {
  it('returns a bypass chain for empty or disabled configs', () => {
    const chain = buildEffectChain(ctx(), [effect('filter', { cutoff: 1, resonance: 0 })]);
    const bypass = buildEffectChain(ctx(), [
      { ...effect('delay', { delayTime: 1, feedback: 1, mix: 1 }), enabled: false },
    ]);

    expect(chain.isBypassed).toBe(false);
    expect(bypass.isBypassed).toBe(true);
    expect(bypass.input).toBeNull();
    expect(bypass.output).toBeNull();
    expect(bypass.nodes).toEqual([]);
  });

  it('creates filter, delay, and reverb stages with clamped Web Audio values', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const chain = buildEffectChain(context, [
      effect('filter', { cutoff: 2, resonance: -1 }),
      effect('delay', { delayTime: 0.5, feedback: 2, mix: 0.75 }),
      effect('reverb', { wet: 0.4, decay: 0.2 }),
    ]);

    expect(chain.isBypassed).toBe(false);
    expect(fake.filters[0]?.type).toBe('lowpass');
    expect(fake.filters[0]?.Q.value).toBe(0.2);
    expect(fake.filters[0]?.frequency.value).toBeLessThanOrEqual(16_000);
    expect(fake.delays[0]?.delayTime.value).toBe(delayTimeToSeconds(0.5));
    expect(fake.gains.some((gain) => gain.gain.value === feedbackToGain(1))).toBe(true);
    expect(fake.convolvers[0]?.buffer?.length).toBe(
      Math.floor(fake.sampleRate * decayToSeconds(0.2)),
    );
    expect(fake.filters[0]?.connections[0]).toBe(fake.gains[0]);
  });
});

describe('TrackGraph effects routing', () => {
  it('keeps the empty-effects route equivalent to gain -> panner -> master', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const master = new FakeAudioNode();
    const graph = new TrackGraph(context, master as unknown as AudioNode, track());
    const input = graph.input as unknown as FakeGain;

    expect(input.connections[0]).toBe(fake.panners[0]);
    expect(fake.panners[0]?.connections[0]).toBe(master);
  });

  it('rewires gain through effects and rebuilds when configs change', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const master = new FakeAudioNode();
    const graph = new TrackGraph(context, master as unknown as AudioNode, track());
    const input = graph.input as unknown as FakeGain;

    graph.updateEffects([effect('filter', { cutoff: 0.5, resonance: 0.2 })]);
    expect(input.connections[0]).toBe(fake.filters[0]);
    expect(fake.filters[0]?.connections[0]).toBe(fake.panners[0]);

    graph.updateEffects([]);
    expect(fake.filters[0]?.disconnectCalls).toBeGreaterThan(0);
    expect(input.connections[0]).toBe(fake.panners[0]);
  });
});
