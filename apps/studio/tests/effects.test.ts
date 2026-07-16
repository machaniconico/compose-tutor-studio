import { describe, expect, it } from 'vitest';
import type { EffectConfig, Track } from '@cts/project-model';
import {
  buildEffectChain,
  clamp01,
  compressorAttackToSeconds,
  compressorRatioToValue,
  compressorReleaseToSeconds,
  compressorThresholdToDb,
  createDefaultEffectConfig,
  decayToSeconds,
  delayTimeToSeconds,
  eqGainToDb,
  feedbackToGain,
  normalizeEffectConfig,
  resolveEqBiquadSettings,
  resolveFilterBiquadSettings,
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
  readonly gain = new FakeAudioParam();
}

class FakeDelay extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam();
}

class FakeDynamicsCompressor extends FakeAudioNode {
  readonly threshold = new FakeAudioParam();
  readonly knee = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
  readonly attack = new FakeAudioParam();
  readonly release = new FakeAudioParam();
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
  readonly compressors: FakeDynamicsCompressor[] = [];
  readonly convolvers: FakeConvolver[] = [];
  failBiquadAt: number | null = null;
  failCreateDelay = false;

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
    if (this.failBiquadAt === this.filters.length + 1) {
      throw new Error('biquad allocation failed');
    }
    const node = new FakeBiquadFilter();
    this.filters.push(node);
    return node;
  }

  createDelay(): FakeDelay {
    if (this.failCreateDelay) throw new Error('delay allocation failed');
    const node = new FakeDelay();
    this.delays.push(node);
    return node;
  }

  createDynamicsCompressor(): FakeDynamicsCompressor {
    const node = new FakeDynamicsCompressor();
    this.compressors.push(node);
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
    role: 'general',
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

  it('normalizes eq/compressor params with safe defaults', () => {
    const eq = normalizeEffectConfig(
      effect('eq', { lowGain: -1, midGain: Number.NaN, highGain: 2 }),
    );
    expect(eq.params.lowGain).toBe(0);
    expect(eq.params.midGain).toBe(0.5);
    expect(eq.params.highGain).toBe(1);

    const compressor = normalizeEffectConfig(
      effect('compressor', {
        threshold: Number.POSITIVE_INFINITY,
        ratio: 2,
        attack: -1,
        release: Number.NaN,
      }),
    );
    expect(compressor.params.threshold).toBe(0.55);
    expect(compressor.params.ratio).toBe(1);
    expect(compressor.params.attack).toBe(0);
    expect(compressor.params.release).toBe(0.35);
  });

  it('creates default eq/compressor configs', () => {
    expect(createDefaultEffectConfig('eq', 'eq-1')).toEqual({
      id: 'eq-1',
      type: 'eq',
      enabled: true,
      params: { lowGain: 0.5, midGain: 0.5, highGain: 0.5 },
    });
    expect(createDefaultEffectConfig('compressor', 'comp-1')).toEqual({
      id: 'comp-1',
      type: 'compressor',
      enabled: true,
      params: { threshold: 0.55, ratio: 0.35, attack: 0.12, release: 0.35 },
    });
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
    const filterSettings = resolveFilterBiquadSettings(
      effect('filter', { cutoff: 2, resonance: -1 }),
      fake.sampleRate,
    );
    expect(fake.filters[0]?.Q.value).toBe(filterSettings.q);
    expect(fake.filters[0]?.frequency.value).toBe(filterSettings.frequencyHz);
    expect(fake.delays[0]?.delayTime.value).toBe(delayTimeToSeconds(0.5));
    expect(fake.gains.some((gain) => gain.gain.value === feedbackToGain(1))).toBe(true);
    expect(fake.convolvers[0]?.buffer?.length).toBe(
      Math.floor(fake.sampleRate * decayToSeconds(0.2)),
    );
    expect(fake.filters[0]?.connections[0]).toBe(fake.gains[0]);
  });

  it('creates eq and compressor stages with clamped Web Audio values', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const chain = buildEffectChain(context, [
      effect('eq', { lowGain: -1, midGain: 0.5, highGain: 2 }),
      effect('compressor', {
        threshold: Number.NaN,
        ratio: 2,
        attack: -1,
        release: Number.POSITIVE_INFINITY,
      }),
    ]);

    expect(chain.isBypassed).toBe(false);
    expect(fake.filters.slice(0, 3).map((filter) => filter.type)).toEqual([
      'lowshelf',
      'peaking',
      'highshelf',
    ]);
    const eqSettings = resolveEqBiquadSettings(
      effect('eq', { lowGain: -1, midGain: 0.5, highGain: 2 }),
    );
    expect(fake.filters.slice(0, 3).map((filter) => filter.frequency.value)).toEqual(
      eqSettings.map(({ frequencyHz }) => frequencyHz),
    );
    expect(fake.filters[0]?.gain.value).toBe(eqGainToDb(0));
    expect(fake.filters[1]?.gain.value).toBe(eqGainToDb(0.5));
    expect(fake.filters[2]?.gain.value).toBe(eqGainToDb(1));
    expect(fake.filters[0]?.connections[0]).toBe(fake.filters[1]);
    expect(fake.filters[1]?.connections[0]).toBe(fake.filters[2]);
    expect(fake.filters[2]?.connections[0]).toBe(fake.compressors[0]);

    expect(fake.compressors[0]?.threshold.value).toBe(compressorThresholdToDb(0.55));
    expect(fake.compressors[0]?.ratio.value).toBe(compressorRatioToValue(1));
    expect(fake.compressors[0]?.attack.value).toBe(compressorAttackToSeconds(0));
    expect(fake.compressors[0]?.release.value).toBe(compressorReleaseToSeconds(0.35));
  });

  it('builds eq/compressor stages from empty params without throwing', () => {
    const context = ctx();
    const fake = asFakeContext(context);

    expect(() =>
      buildEffectChain(context, [effect('eq', {}), effect('compressor', {})]),
    ).not.toThrow();
    expect(fake.filters).toHaveLength(3);
    expect(fake.compressors).toHaveLength(1);
  });

  it('disconnects earlier stages and partial nodes when a later allocation fails', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    fake.failBiquadAt = 3;

    expect(() =>
      buildEffectChain(context, [
        effect('filter', { cutoff: 0.5 }),
        effect('eq', { lowGain: 0.5, midGain: 0.5, highGain: 0.5 }),
      ]),
    ).toThrow('biquad allocation failed');
    expect(fake.filters.map((node) => node.disconnectCalls)).toEqual([1, 1]);

    const delayContext = ctx();
    const delayFake = asFakeContext(delayContext);
    delayFake.failCreateDelay = true;
    expect(() => buildEffectChain(delayContext, [effect('delay', {})])).toThrow(
      'delay allocation failed',
    );
    expect(delayFake.gains).toHaveLength(4);
    expect(delayFake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
  });
});

describe('TrackGraph effects routing', () => {
  it('keeps the empty-effects route equivalent to gain -> panner -> master', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const master = new FakeAudioNode();
    const graph = new TrackGraph(context, master as unknown as AudioNode, track(), 'disabled');
    const input = graph.input as unknown as FakeGain;

    expect(input.connections[0]).toBe(fake.panners[0]);
    expect(fake.panners[0]?.connections[0]).toBe(master);
  });

  it('rewires gain through effects and rebuilds when configs change', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const master = new FakeAudioNode();
    const graph = new TrackGraph(context, master as unknown as AudioNode, track(), 'disabled');
    const input = graph.input as unknown as FakeGain;

    graph.updateEffects([effect('filter', { cutoff: 0.5, resonance: 0.2 })]);
    expect(input.connections[0]).toBe(fake.filters[0]);
    expect(fake.filters[0]?.connections[0]).toBe(fake.panners[0]);

    graph.updateEffects([]);
    expect(fake.filters[0]?.disconnectCalls).toBeGreaterThan(0);
    expect(input.connections[0]).toBe(fake.panners[0]);
  });

  it('keeps the previous live route when a replacement effect cannot be built', () => {
    const context = ctx();
    const fake = asFakeContext(context);
    const master = new FakeAudioNode();
    const graph = new TrackGraph(context, master as unknown as AudioNode, track(), 'disabled');
    const input = graph.input as unknown as FakeGain;
    fake.failBiquadAt = 1;

    expect(() =>
      graph.updateEffects([effect('filter', { cutoff: 0.5, resonance: 0.2 })]),
    ).toThrow('biquad allocation failed');
    expect(input.connections[0]).toBe(fake.panners[0]);
  });
});
