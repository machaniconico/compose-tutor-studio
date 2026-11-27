import { describe, expect, it } from 'vitest';
import { createEmptyProject, validateProject, type EffectConfig, type Track, type TrackType } from '@cts/project-model';
import { mulberry32 } from '../../../packages/project-model/tests/acceptance/helpers';
import {
  TrackGraph,
  applyMixState,
  buildTrackGraphs,
  clampPan,
  clampVolume,
  computeAudibleTracks,
  resolveMuteSolo,
} from '../src/audio/graph';
import type { ParamEvent } from '../src/audio/automationSchedule';
import { delayTimeSeconds } from '../src/audio/effects';

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
  readonly events: ParamEvent[] = [];
  constructor(public value: number) {}

  setValueAtTime(value: number, time: number): void {
    this.events.push({ method: 'setValueAtTime', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ method: 'linearRampToValueAtTime', value, time });
  }

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

  disconnect(destination?: FakeNode): void {
    if (!destination) {
      this.connections.length = 0;
      return;
    }
    const index = this.connections.indexOf(destination);
    if (index !== -1) this.connections.splice(index, 1);
  }
}

class FakeGainNode extends FakeNode {
  readonly gain = new FakeAudioParam(1);
}

class FakeConstantSourceNode extends FakeNode {
  readonly offset = new FakeAudioParam(1);
  readonly starts: number[] = [];
  stopped = false;

  start(time: number): void { this.starts.push(time); }
  stop(): void { this.stopped = true; }
}

class FakeStereoPannerNode extends FakeNode {
  readonly pan = new FakeAudioParam(0);
}

class FakeAnalyserNode extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
}

class FakeBiquadFilterNode extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
  readonly gain = new FakeAudioParam(0);
}

class FakeDynamicsCompressorNode extends FakeNode {
  readonly threshold = new FakeAudioParam(-24);
  readonly knee = new FakeAudioParam(30);
  readonly ratio = new FakeAudioParam(12);
  readonly attack = new FakeAudioParam(0.003);
  readonly release = new FakeAudioParam(0.25);
}

class FakeDelayNode extends FakeNode {
  readonly delayTime = new FakeAudioParam(0);
  maxDelayTime = 1;
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

  createConstantSource(): ConstantSourceNode {
    return this.node(
      new FakeConstantSourceNode('ConstantSource', this.name('ConstantSource'), this.connections),
    ) as unknown as ConstantSourceNode;
  }

  createStereoPanner(): StereoPannerNode {
    return this.node(
      new FakeStereoPannerNode('StereoPanner', this.name('StereoPanner'), this.connections),
    ) as unknown as StereoPannerNode;
  }

  createAnalyser(): AnalyserNode {
    return this.node(
      new FakeAnalyserNode('Analyser', this.name('Analyser'), this.connections),
    ) as unknown as AnalyserNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return this.node(
      new FakeBiquadFilterNode('BiquadFilter', this.name('BiquadFilter'), this.connections),
    ) as unknown as BiquadFilterNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    return this.node(
      new FakeDynamicsCompressorNode('DynamicsCompressor', this.name('DynamicsCompressor'), this.connections),
    ) as unknown as DynamicsCompressorNode;
  }

  createDelay(maxDelayTime = 1): DelayNode {
    const node = new FakeDelayNode('Delay', this.name('Delay'), this.connections);
    node.maxDelayTime = maxDelayTime;
    return this.node(node) as unknown as DelayNode;
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
  type: EffectConfig['type'],
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
  it('routes tracks without effects through a meter tap before the master', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    const graph = new TrackGraph(ctx, master, track('a'));
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');
    const analyser = ctx.created.find((node) => node.kind === 'Analyser');
    const meterTap = panner?.connections[0];

    expect(graph.effectTypes).toEqual([]);
    expect(graph.analyser).toBe(analyser as unknown as AnalyserNode);
    expect(meterTap?.connections).toContain(master as unknown as FakeNode);
    expect(meterTap?.connections).toContain(analyser);
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
    const analyser = ctx.created.find((node) => node.kind === 'Analyser');

    expect(graph.effectTypes).toEqual(['filter', 'delay', 'reverb']);
    expect(filter).toBeDefined();
    expect(delay).toBeDefined();
    expect(convolver).toBeDefined();
    expect(panner?.connections).toEqual([filter]);
    expect(ctx.connections).toContain(`${delay?.name}->${delay?.connections[1]?.name}`);
    expect(ctx.connections.some((entry) => entry === `${panner?.name}->${masterNode.name}`)).toBe(false);
    expect(ctx.connections.some((entry) => entry.endsWith(`->${masterNode.name}`))).toBe(true);
    expect(ctx.connections.some((entry) => entry.endsWith(`->${analyser?.name}`))).toBe(true);
  });

  it('rebuilds the chain when effects are enabled during playback', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    const first = track('a');
    const graph = new TrackGraph(ctx, master, first);
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');
    const originalMeterTap = panner?.connections[0];

    expect(graph.effectTypes).toEqual([]);
    expect(originalMeterTap?.connections).toContain(master as unknown as FakeNode);

    applyMixState(
      new Map([['a', graph]]),
      [track('a', { effects: [effect('filter', { cutoffHz: 900 })] })],
      0.1,
    );

    const filter = ctx.created.find((node) => node.kind === 'BiquadFilter');
    expect(graph.effectTypes).toEqual(['filter']);
    expect(panner?.connections).toEqual([filter]);
    expect(filter?.connections).toEqual([originalMeterTap]);
  });

  it('orders eq -> compressor -> filter -> delay -> reverb regardless of list order', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    const graph = new TrackGraph(
      ctx,
      master,
      track('a', {
        effects: [
          effect('reverb', { mix: 0.35 }),
          effect('delay'),
          effect('filter'),
          effect('compressor', { thresholdDb: -18, ratio: 4 }),
          effect('eq', { highGainDb: 6 }),
        ],
      }),
    );
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');
    const biquads = ctx.created.filter((node) => node.kind === 'BiquadFilter') as unknown as FakeBiquadFilterNode[];
    const compressor = ctx.created.find((node) => node.kind === 'DynamicsCompressor') as unknown as FakeDynamicsCompressorNode;

    expect(graph.effectTypes).toEqual(['eq', 'compressor', 'filter', 'delay', 'reverb']);
    // eq is three biquads (low shelf, peaking, high shelf) then the filter biquad.
    expect(biquads.map((node) => node.type)).toEqual(['lowshelf', 'peaking', 'highshelf', 'lowpass']);
    expect(panner?.connections).toEqual([biquads[0]]);
    expect(biquads[2]?.connections).toEqual([compressor]);
    expect(compressor.connections).toEqual([biquads[3]]);
    expect(biquads[2]?.gain.value).toBe(6);
    expect(compressor.threshold.value).toBe(-18);
    expect(compressor.ratio.value).toBe(4);
  });

  it('gives the delay node room for a quarter note at 40 BPM', () => {
    const ctx = fakeContext();
    new TrackGraph(
      ctx,
      ctx.createGain(),
      track('a', { effects: [effect('delay', { timeSeconds: delayTimeSeconds(40, '1/4') })] }),
    );
    const delay = ctx.created.find((node) => node.kind === 'Delay') as unknown as FakeDelayNode;
    expect(delay.delayTime.value).toBe(1.5);
    expect(delay.maxDelayTime).toBeGreaterThanOrEqual(1.5);
  });

  it.each([
    ['legacy delayTime over the limit', { delayTime: 4 }, 1.5],
    ['legacy time in range', { time: 0.6 }, 0.6],
    ['timeSeconds over the limit', { timeSeconds: 3 }, 1.5],
  ])('resolves %s to the same delay time as before tempo sync', (_label, params, expected) => {
    const ctx = fakeContext();
    new TrackGraph(ctx, ctx.createGain(), track('a', { effects: [effect('delay', params)] }));
    const delay = ctx.created.find((node) => node.kind === 'Delay') as unknown as FakeDelayNode;
    expect(delay.delayTime.value).toBe(expected);
  });

  it.each([
    [['reverb', 'delay', 'filter'], ['reverb', 'delay', 'filter']],
    [['delay', 'filter', 'delay'], ['delay', 'filter', 'delay']],
  ] as const)('keeps saved order %j when EQ and compressor are off', (saved, expected) => {
    const ctx = fakeContext();
    const graph = new TrackGraph(
      ctx,
      ctx.createGain(),
      track('a', {
        effects: [{ ...effect('eq'), enabled: false }, ...saved.map((type) => effect(type))],
      }),
    );
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');
    const seen = new Set<FakeNode>();
    const queue = panner ? [panner] : [];
    const reached: string[] = [];
    for (const node of queue) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (['BiquadFilter', 'Delay', 'Convolver'].includes(node.kind)) reached.push(node.kind);
      queue.push(...node.connections);
    }

    expect(graph.effectTypes).toEqual(expected);
    expect(reached).toEqual(
      expected.map((type) => ({ filter: 'BiquadFilter', delay: 'Delay', reverb: 'Convolver' })[type]),
    );
  });

  it('keeps node sequence and parameters for filter/delay/reverb-only projects', () => {
    const ctx = fakeContext();
    const master = ctx.createGain();
    new TrackGraph(
      ctx,
      master,
      track('a', {
        effects: [
          effect('filter', { cutoffHz: 1200, resonance: 2 }),
          effect('delay', { timeSeconds: 0.2, feedback: 0.4, mix: 0.5 }),
          effect('reverb', { mix: 0.35 }),
        ],
      }),
    );
    const snapshot = ctx.created.map((node) => {
      if (node instanceof FakeBiquadFilterNode) {
        return [node.kind, node.type, node.frequency.value, node.Q.value];
      }
      if (node instanceof FakeDelayNode) return [node.kind, node.delayTime.value];
      if (node instanceof FakeGainNode) return [node.kind, node.gain.value];
      if (node instanceof FakeStereoPannerNode) return [node.kind, node.pan.value];
      return [node.kind];
    });
    expect(snapshot).toEqual([
      ['Gain', 1],
      ['Gain', 0.8],
      ['StereoPanner', 0],
      ['Gain', 1],
      ['Analyser'],
      ['BiquadFilter', 'lowpass', 1200, 2],
      ['Gain', 1],
      ['Gain', 0.5],
      ['Delay', 0.2],
      ['Gain', 0.4],
      ['Gain', 0.5],
      ['Gain', 1],
      ['Gain', 1],
      ['Gain', 0.65],
      ['Convolver'],
      ['Gain', 0.35],
      ['Gain', 1],
    ]);
  });
});

describe('volume automation graph', () => {
  it('places automation after the track gain and keeps its ramp independent of mix updates', () => {
    const ctx = new FakeAudioContext();
    const master = ctx.createGain();
    const trackWithLane: Track = {
      ...track('keys'),
      automation: { volume: { points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] } },
    };
    const graph = new TrackGraph(ctx as unknown as BaseAudioContext, master, trackWithLane);
    const [trackGain, automationGain] = ctx.created.filter((node) => node.kind === 'Gain').slice(1) as FakeGainNode[];
    const panner = ctx.created.find((node) => node.kind === 'StereoPanner');
    expect(graph.input).toBe(trackGain);
    expect(trackGain!.connections).toEqual([automationGain]);
    expect(automationGain!.connections).toEqual([panner]);

    graph.scheduleAutomation({ bpm: 120, loop: null, startBeat: 2, startTime: 1, endBeat: 4 });
    applyMixState(new Map([['keys', graph]]), [{ ...trackWithLane, volume: 0.4, mute: true }], 2);
    expect(trackGain!.gain.value).toBe(0);
    expect(trackGain!.gain.events).toEqual([]);
    expect(automationGain!.gain.value).toBe(1);
    expect(automationGain!.gain.events).toEqual([
      { method: 'setValueAtTime', value: 0.5, time: 1 },
      { method: 'linearRampToValueAtTime', value: 1, time: 2 },
    ]);
    graph.dispose();
    expect(automationGain!.connections).toEqual([]);
  });

  it('keeps the original signal path for absent and empty lanes', () => {
    for (const automation of [undefined, { volume: { points: [] } }]) {
      const ctx = new FakeAudioContext();
      const graph = new TrackGraph(ctx as unknown as BaseAudioContext, ctx.createGain(), { ...track('keys'), automation });
      graph.scheduleAutomation({ bpm: 120, loop: null, startBeat: 0, startTime: 0, endBeat: 4 });
      expect(ctx.created.filter((node) => node.kind === 'Gain')).toHaveLength(3);
      const input = graph.input as unknown as FakeGainNode;
      expect(input.connections.map((node) => node.kind)).toEqual(['StereoPanner']);
      expect(input.gain.events).toEqual([]);
    }
  });
});

function routing(tracks: Track[]) {
  const ctx = fakeContext();
  buildTrackGraphs(ctx, ctx.createGain(), tracks, 0);
  for (const node of ctx.created) {
    for (const destination of node.connections) expect(ctx.created).toContain(destination);
  }
  return {
    nodes: ctx.created.map((node) => node.name),
    connections: ctx.connections,
  };
}

describe('shared return routing', () => {
  it('keeps the node list and connections captured from US-027 HEAD', () => {
    const source: Track = {
      ...track('source'),
      automation: { volume: { points: [{ beat: 0, value: 0.5 }] } },
    };
    const bus = track('return', { type: 'bus', effects: [effect('reverb')] });
    const legacyRouting = routing([source, bus]);
    expect(routing([{ ...source, sends: { return: 0 } }, bus])).toEqual(legacyRouting);
    const empty = { points: [] };
    expect(routing([{ ...source, automation: { ...source.automation, pan: empty, cutoff: empty } }, bus]))
      .toEqual(legacyRouting);
    expect(legacyRouting).toMatchInlineSnapshot(`
      {
        "connections": [
          "Gain#5->Gain#1",
          "Gain#5->Analyser#6",
          "Gain#2->Gain#3",
          "Gain#3->StereoPanner#4",
          "StereoPanner#4->Gain#5",
          "Gain#9->Gain#1",
          "Gain#9->Analyser#10",
          "Gain#7->StereoPanner#8",
          "Gain#11->Gain#12",
          "Gain#12->Gain#15",
          "Gain#11->Convolver#13",
          "Convolver#13->Gain#14",
          "Gain#14->Gain#15",
          "StereoPanner#8->Gain#11",
          "Gain#15->Gain#9",
        ],
        "nodes": [
          "Gain#1",
          "Gain#2",
          "Gain#3",
          "StereoPanner#4",
          "Gain#5",
          "Analyser#6",
          "Gain#7",
          "StereoPanner#8",
          "Gain#9",
          "Analyser#10",
          "Gain#11",
          "Gain#12",
          "Convolver#13",
          "Gain#14",
          "Gain#15",
        ],
      }
    `);
  });

  it('keeps a soloed source and its positive sends audible unless muted', () => {
    const room = track('room', { type: 'bus' });
    const echo = track('echo', { type: 'bus' });
    const source = { ...track('solo', { solo: true }), sends: { room: 0.5, echo: 0 } };
    const other = { ...track('other'), sends: { echo: 1 } };
    expect(resolveMuteSolo([source, other, room, echo])).toEqual(new Set(['solo', 'room']));
    expect(resolveMuteSolo([source, other, { ...room, mute: true }, echo])).toEqual(new Set(['solo']));
    expect(resolveMuteSolo([{ ...source, mute: true }, other, room, echo]))
      .toEqual(new Set(['other', 'room', 'echo']));
  });

  it('feeds the return from after automation and pan and preserves it across FX edits', () => {
    const source: Track = {
      ...track('source'),
      automation: { volume: { points: [{ beat: 0, value: 0.5 }] } },
      sends: { room: 0.5 },
    };
    const room = track('room', { type: 'bus', effects: [effect('reverb')] });
    const ctx = fakeContext();
    const graphs = buildTrackGraphs(ctx, ctx.createGain(), [room, source], 0);
    const input = graphs.get(source.id)!.input as unknown as FakeGainNode;
    const automation = input.connections[0] as FakeGainNode;
    const panner = automation.connections[0] as FakeStereoPannerNode;
    const send = panner.connections[1] as FakeGainNode;
    expect(panner.kind).toBe('StereoPanner');
    expect(send.gain.value).toBe(0.5);
    expect(send.connections).toEqual([graphs.get(room.id)!.input]);
    const next = { ...source, mute: true, effects: [effect('filter')], sends: { room: 0.75 } };
    applyMixState(graphs, [room, next], 1);
    expect(input.gain.value).toBe(0);
    expect(panner.connections).toContain(send);
    expect(send.gain.value).toBe(0.75);
    const returnMeterTap = ctx.created.find((node) => node.connections.includes(graphs.get(room.id)!.analyser as unknown as FakeNode)) as FakeGainNode;
    applyMixState(graphs, [{ ...room, mute: true }, { ...next, sends: { room: 0 } }], 2);
    expect(returnMeterTap.gain.value).toBe(0);
    expect(panner.connections).not.toContain(send);
    expect(send.connections).toEqual([]);
    expect(panner.connections.map((node) => node.kind)).toEqual(['BiquadFilter']);
  });

  it('builds valid graphs for 300 seeded projects (seed 0x034)', () => {
    const random = mulberry32(0x034);
    const flag = () => random() < 0.3;
    for (let i = 0; i < 300; i += 1) {
      const returns = Array.from({ length: Math.floor(random() * 3) }, (_, index) =>
        track(`return-${index}`, { type: 'bus', mute: flag(), solo: flag() }));
      const sources = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index): Track => ({
        ...track(`source-${index}`, { type: index % 2 === 0 ? 'instrument' : 'drum', mute: flag(), solo: flag() }),
        sends: Object.fromEntries(returns.map(({ id }) => [id, flag() ? 0 : random()])),
      }));
      const tracks = [...sources, ...returns, track('master', { type: 'master' })];
      const project = { ...createEmptyProject(), tracks };
      expect(validateProject(project).errors).toEqual([]);
      routing(tracks);
      const zero = tracks.map((track) => track.sends
        ? { ...track, sends: Object.fromEntries(Object.keys(track.sends).map((key) => [key, 0])) }
        : track);
      const absent = tracks.map(({ sends: _sends, ...track }) => track);
      expect(routing(zero)).toEqual(routing(absent));

      // Include malformed saved sends as well as valid mixes.
      const malformed: unknown[] = [null, true, { toString: null }, { constructor: random() }, { [returns[0]?.id ?? 'missing']: NaN }];
      project.tracks[0] = { ...sources[0]!, sends: malformed[i % malformed.length] as Track['sends'] };
      expect(validateProject(project).ok).toBe(false);
    }
  });
});

describe('pan and cutoff automation graph', () => {
  it('schedules the series panner and a shared cutoff source at graph start', () => {
    const source: Track = {
      ...track('keys'),
      pan: 0.25,
      instrument: { type: 'synth', preset: 'brightLead', macros: { brightness: 1, width: 0, attack: 0.5, release: 0.5 } },
      automation: {
        pan: { points: [{ beat: 0, value: -1 }, { beat: 4, value: 0.5 }] },
        cutoff: { points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 10 }] },
      },
      effects: [effect('filter')],
      sends: { room: 0.5 },
    };
    const ctx = fakeContext();
    const room = track('room', { type: 'bus' });
    const graphs = buildTrackGraphs(ctx, ctx.createGain(), [source, room], 1);
    const graph = graphs.get('keys')!;
    const input = graph.input as unknown as FakeGainNode;
    const cutoff = graph.cutoffSource as unknown as FakeConstantSourceNode;
    const automatedPan = input.connections[0] as FakeStereoPannerNode;
    const originalPan = automatedPan.connections[0] as FakeStereoPannerNode;
    const [fx, send] = originalPan.connections as [FakeBiquadFilterNode, FakeGainNode];
    expect(ctx.created.filter(({ kind }) => kind === 'BiquadFilter')).toEqual([fx]);
    expect(ctx.created.filter(({ kind }) => kind === 'ConstantSource')).toEqual([cutoff]);
    expect(cutoff.starts).toEqual([1]);
    expect(cutoff.offset.value).toBe(0);
    expect(automatedPan.kind).toBe('StereoPanner');
    expect(originalPan.kind).toBe('StereoPanner');
    expect(originalPan.pan.value).toBe(0);
    expect(fx.kind).toBe('BiquadFilter');
    expect(send.connections).toEqual([graphs.get('room')!.input]);

    graph.scheduleAutomation({ bpm: 120, loop: null, startBeat: 2, startTime: 1, endBeat: 4 });
    expect(automatedPan.pan.events).toEqual([
      { method: 'setValueAtTime', value: 0, time: 1 },
      { method: 'linearRampToValueAtTime', value: 0.75, time: 2 },
    ]);
    expect(cutoff.offset.events[0]).toEqual({ method: 'setValueAtTime', value: 0, time: 1 });
    expect(cutoff.offset.events.at(-1)).toEqual({
      method: 'linearRampToValueAtTime', value: 1200 * Math.log2(19845 / 12800), time: 2,
    });
    expect(fx.frequency.events).toEqual([]);
    graph.dispose();
    expect(cutoff.stopped).toBe(true);
    expect(automatedPan.connections).toEqual([]);
  });

  it('ignores all automation when directly constructing a master graph', () => {
    const ctx = fakeContext();
    const lane = { points: [{ beat: 0, value: 0.5 }] };
    const master = ctx.createGain();
    const graph = new TrackGraph(ctx, master, { ...track('master', { type: 'master' }),
      automation: { volume: lane, pan: lane, cutoff: lane } });
    graph.scheduleAutomation({ bpm: 120, loop: null, startBeat: 0, startTime: 0 });
    expect(ctx.created.map(({ kind }) => kind)).toEqual(['Gain', 'Gain', 'StereoPanner', 'Gain', 'Analyser']);
    expect((ctx.created[2] as FakeStereoPannerNode).pan.events).toEqual([]);
  });
});
