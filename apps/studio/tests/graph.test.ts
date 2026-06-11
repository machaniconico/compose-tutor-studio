import { describe, expect, it } from 'vitest';
import type { EffectConfig, Track, TrackType } from '@cts/project-model';
import {
  TrackGraph,
  applyMixState,
  clampPan,
  clampVolume,
  computeAudibleTracks,
} from '../src/audio/graph';

/** Minimal Track factory for mute/solo tests. */
function track(
  id: string,
  opts: { type?: TrackType; mute?: boolean; solo?: boolean; effects?: EffectConfig[] } = {},
): Track {
  return {
    id,
    name: id,
    type: opts.type ?? 'instrument',
    clips: [],
    volume: 0.8,
    pan: 0,
    mute: opts.mute ?? false,
    solo: opts.solo ?? false,
    effects: opts.effects ?? [],
  };
}

class FakeAudioParam {
  constructor(public value: number) {}

  setTargetAtTime(value: number): FakeAudioParam {
    this.value = value;
    return this;
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];

  constructor(
    readonly kind: string,
    readonly name: string,
    private readonly log: string[],
  ) {}

  connect(destination: unknown): AudioNode {
    const node = destination as FakeNode;
    this.connections.push(node);
    this.log.push(`${this.name}->${node.name}`);
    return destination as AudioNode;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeGainNode extends FakeNode {
  readonly gain = new FakeAudioParam(1);
}

class FakeStereoPannerNode extends FakeNode {
  readonly pan = new FakeAudioParam(0);
}

class FakeBiquadFilterNode extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
}

class FakeDelayNode extends FakeNode {
  readonly delayTime = new FakeAudioParam(0);
}

class FakeConvolverNode extends FakeNode {
  buffer: AudioBuffer | null = null;
}

class FakeAudioBuffer {
  private readonly channels: Float32Array[];

  constructor(
    numberOfChannels: number,
    length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new Error(`missing channel ${channel}`);
    return data;
  }
}

class FakeAudioContext {
  readonly currentTime = 0;
  readonly sampleRate = 44100;
  readonly created: FakeNode[] = [];
  readonly connections: string[] = [];
  private nextId = 0;

  createGain(): GainNode {
    return this.node(new FakeGainNode('Gain', this.name('Gain'), this.connections)) as unknown as GainNode;
  }

  createStereoPanner(): StereoPannerNode {
    return this.node(
      new FakeStereoPannerNode('StereoPanner', this.name('StereoPanner'), this.connections),
    ) as unknown as StereoPannerNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return this.node(
      new FakeBiquadFilterNode('BiquadFilter', this.name('BiquadFilter'), this.connections),
    ) as unknown as BiquadFilterNode;
  }

  createDelay(): DelayNode {
    return this.node(new FakeDelayNode('Delay', this.name('Delay'), this.connections)) as unknown as DelayNode;
  }

  createConvolver(): ConvolverNode {
    return this.node(
      new FakeConvolverNode('Convolver', this.name('Convolver'), this.connections),
    ) as unknown as ConvolverNode;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate) as unknown as AudioBuffer;
  }

  private node<T extends FakeNode>(node: T): T {
    this.created.push(node);
    return node;
  }

  private name(kind: string): string {
    this.nextId += 1;
    return `${kind}#${this.nextId}`;
  }
}

function fakeContext(): BaseAudioContext & FakeAudioContext {
  return new FakeAudioContext() as BaseAudioContext & FakeAudioContext;
}

function effect(
  type: 'filter' | 'delay' | 'reverb',
  params: Record<string, number> = {},
): EffectConfig {
  return {
    id: `fx-${type}`,
    type,
    enabled: true,
    params,
  };
}

describe('computeAudibleTracks', () => {
  it('all non-master tracks audible when nothing is muted/soloed', () => {
    const tracks = [track('a'), track('b'), track('drums', { type: 'drum' })];
    const audible = computeAudibleTracks(tracks);
    expect(audible.has('a')).toBe(true);
    expect(audible.has('b')).toBe(true);
    expect(audible.has('drums')).toBe(true);
  });

  it('excludes the master track', () => {
    const tracks = [track('a'), track('master', { type: 'master' })];
    const audible = computeAudibleTracks(tracks);
    expect(audible.has('master')).toBe(false);
    expect(audible.has('a')).toBe(true);
  });

  it('mute removes a track', () => {
    const tracks = [track('a', { mute: true }), track('b')];
    const audible = computeAudibleTracks(tracks);
    expect(audible.has('a')).toBe(false);
    expect(audible.has('b')).toBe(true);
  });

  it('when any track is soloed, only solos are audible', () => {
    const tracks = [track('a', { solo: true }), track('b'), track('c')];
    const audible = computeAudibleTracks(tracks);
    expect(audible.has('a')).toBe(true);
    expect(audible.has('b')).toBe(false);
    expect(audible.has('c')).toBe(false);
  });

  it('mute overrides solo (a muted solo is silent and does not arm solo mode)', () => {
    // Only track that is "soloed" is also muted => it counts as no active solo,
    // so the other unmuted tracks remain audible.
    const tracks = [track('a', { solo: true, mute: true }), track('b')];
    const audible = computeAudibleTracks(tracks);
    expect(audible.has('a')).toBe(false);
    expect(audible.has('b')).toBe(true);
  });

  it('multiple solos: all solos audible, others silent', () => {
    const tracks = [
      track('a', { solo: true }),
      track('b', { solo: true }),
      track('c'),
    ];
    const audible = computeAudibleTracks(tracks);
    expect(audible.has('a')).toBe(true);
    expect(audible.has('b')).toBe(true);
    expect(audible.has('c')).toBe(false);
  });
});

describe('clampVolume / clampPan', () => {
  it('clamps volume into 0..2', () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(3)).toBe(2);
    expect(clampVolume(Number.NaN)).toBe(0);
  });
  it('clamps pan into -1..1', () => {
    expect(clampPan(-2)).toBe(-1);
    expect(clampPan(0.3)).toBe(0.3);
    expect(clampPan(2)).toBe(1);
    expect(clampPan(Number.NaN)).toBe(0);
  });
});

describe('TrackGraph effects', () => {
  it('keeps tracks without effects connected directly to the master', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    const graph = new TrackGraph(ctx, master, track('a'));
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');

    expect(graph.effectTypes).toEqual([]);
    expect(panner?.connections).toEqual([master as unknown as FakeNode]);
  });

  it('inserts enabled filter, delay, and reverb nodes before the master', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    const graph = new TrackGraph(
      ctx,
      master,
      track('a', {
        effects: [
          effect('filter', { cutoffHz: 1200 }),
          effect('delay', { timeSeconds: 0.2, feedback: 0.4 }),
          effect('reverb', { mix: 0.35 }),
        ],
      }),
    );
    const masterNode = master as unknown as FakeNode;
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');
    const filter = ctx.created.find((node) => node.kind === 'BiquadFilter');
    const delay = ctx.created.find((node) => node.kind === 'Delay');
    const convolver = ctx.created.find((node) => node.kind === 'Convolver');

    expect(graph.effectTypes).toEqual(['filter', 'delay', 'reverb']);
    expect(filter).toBeDefined();
    expect(delay).toBeDefined();
    expect(convolver).toBeDefined();
    expect(panner?.connections).toEqual([filter]);
    expect(ctx.connections).toContain(`${delay?.name}->${delay?.connections[1]?.name}`);
    expect(ctx.connections.some((entry) => entry === `${panner?.name}->${masterNode.name}`)).toBe(false);
    expect(ctx.connections.some((entry) => entry.endsWith(`->${masterNode.name}`))).toBe(true);
  });

  it('rebuilds the chain when effects are enabled during playback', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    const first = track('a');
    const graph = new TrackGraph(ctx, master, first);
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');

    expect(graph.effectTypes).toEqual([]);
    expect(panner?.connections).toEqual([master as unknown as FakeNode]);

    applyMixState(
      new Map([['a', graph]]),
      [track('a', { effects: [effect('filter', { cutoffHz: 900 })] })],
      0.1,
    );

    const filter = ctx.created.find((node) => node.kind === 'BiquadFilter');
    expect(graph.effectTypes).toEqual(['filter']);
    expect(panner?.connections).toEqual([filter]);
  });
});
