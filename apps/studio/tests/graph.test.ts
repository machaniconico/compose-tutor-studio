import { describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  compileAudioRouting,
  type AudioRouting,
  type Project,
  type Track,
  type TrackType,
} from '@cts/project-model';
import {
  applyMixState,
  applyRoutingMixState,
  assertRoutingGraphNodeBudget,
  audioRoutingTopologySignature,
  buildTrackGraphs,
  clampPan,
  clampVolume,
  computeAudibleTracks,
  disposeMasterMeter,
  estimateRoutingGraphNodeCount,
  readMeterLevel,
  resolveAudioRoutingMix,
} from '../src/audio/graph';

/** Minimal Track factory for mute/solo tests. */
function track(
  id: string,
  opts: {
    type?: TrackType;
    mute?: boolean;
    solo?: boolean;
    volume?: number;
    pan?: number;
  } = {},
): Track {
  return {
    id,
    name: id,
    type: opts.type ?? 'instrument',
    role: 'general',
    clips: [],
    volume: opts.volume ?? 0.8,
    pan: opts.pan ?? 0,
    mute: opts.mute ?? false,
    solo: opts.solo ?? false,
    effects: [],
  };
}

function routingProject(tracks: Track[], audioRouting: AudioRouting): Project {
  return {
    id: 'routing-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Routing test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [],
    audioRouting,
    tracks,
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function compileRouting(project: Project) {
  const compiled = compileAudioRouting(project);
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((error) => error.message).join(', '));
  }
  return compiled.plan;
}

class RoutingTestParam {
  value = 0;
  readonly setTargetAtTime = vi.fn();
  readonly setValueAtTime = vi.fn();
  readonly cancelAndHoldAtTime = vi.fn();
  readonly cancelScheduledValues = vi.fn();
}

class RoutingTestNode {
  readonly connections: RoutingTestNode[] = [];
  readonly connect = vi.fn((destination: RoutingTestNode) => {
    this.connections.push(destination);
    return destination;
  });
  readonly disconnect = vi.fn((destination?: RoutingTestNode) => {
    if (destination === undefined) {
      this.connections.length = 0;
      return;
    }
    const index = this.connections.indexOf(destination);
    if (index >= 0) this.connections.splice(index, 1);
  });
}

class RoutingTestGain extends RoutingTestNode {
  readonly gain = new RoutingTestParam();
}

class RoutingTestPanner extends RoutingTestNode {
  readonly pan = new RoutingTestParam();
}

function routingContext() {
  const gains: RoutingTestGain[] = [];
  const panners: RoutingTestPanner[] = [];
  const context = {
    createGain: vi.fn(() => {
      const gain = new RoutingTestGain();
      gains.push(gain);
      return gain;
    }),
    createStereoPanner: vi.fn(() => {
      const panner = new RoutingTestPanner();
      panners.push(panner);
      return panner;
    }),
  } as unknown as BaseAudioContext;
  return { context, gains, panners };
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

describe('compiled bus routing mix', () => {
  function busSoloProject(
    sourceOverrides: Partial<Track> = {},
    sendOverrides: Partial<AudioRouting['sends'][number]> = {},
  ): Project {
    return routingProject(
      [
        { ...track('source'), ...sourceOverrides },
        track('bus', { type: 'bus', solo: true }),
        track('master', { type: 'master' }),
      ],
      {
        outputs: [
          { sourceTrackId: 'source', destination: { type: 'master' } },
          { sourceTrackId: 'bus', destination: { type: 'master' } },
        ],
        sends: [{
          id: 'source-wet',
          sourceTrackId: 'source',
          targetBusId: 'bus',
          position: 'pre-fader',
          gain: 0.75,
          enabled: true,
          ...sendOverrides,
        }],
      },
    );
  }

  it('solos a Bus through only the upstream send and never leaks the source dry output', () => {
    const project = busSoloProject();
    const mix = resolveAudioRoutingMix(project, compileRouting(project));

    expect([...mix.audibleChannelIds].sort()).toEqual(['bus', 'source']);
    expect(mix.edgeGains.get('output:source')).toBe(0);
    expect(mix.edgeGains.get('send:source-wet')).toBe(0.75);
    expect(mix.edgeGains.get('output:bus')).toBe(1);
    expect([...mix.activeEdgeIds].sort()).toEqual(['output:bus', 'send:source-wet']);
  });

  it('lets mute win over Bus-solo upstream traversal', () => {
    const project = busSoloProject({ mute: true });
    const mix = resolveAudioRoutingMix(project, compileRouting(project));

    expect([...mix.audibleChannelIds]).toEqual(['bus']);
    expect(mix.edgeGains.get('output:source')).toBe(0);
    expect(mix.edgeGains.get('send:source-wet')).toBe(0);
    expect(mix.edgeGains.get('output:bus')).toBe(1);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['zero-gain', { gain: 0 }],
  ] satisfies Array<[string, Partial<AudioRouting['sends'][number]>]>) (
    'keeps a %s send structural but silent during Bus solo',
    (_label, sendOverrides) => {
      const project = busSoloProject({}, sendOverrides);
      const plan = compileRouting(project);
      const mix = resolveAudioRoutingMix(project, plan);

      expect(plan.edges.some((edge) => edge.kind === 'send')).toBe(true);
      expect([...mix.audibleChannelIds]).toEqual(['bus']);
      expect(mix.edgeGains.get('send:source-wet')).toBe(0);
      expect(mix.edgeGains.get('output:source')).toBe(0);
    },
  );
});

describe('buildTrackGraphs', () => {
  it('builds channels first, taps pre-fader sends before inserts, and smooths edge gain', () => {
    const project = routingProject(
      [track('source', { volume: 0.8 }), track('bus', { type: 'bus' })],
      {
        outputs: [
          { sourceTrackId: 'source', destination: { type: 'master' } },
          { sourceTrackId: 'bus', destination: { type: 'master' } },
        ],
        sends: [{
          id: 'source-wet',
          sourceTrackId: 'source',
          targetBusId: 'bus',
          position: 'pre-fader',
          gain: 0.5,
          enabled: true,
        }],
      },
    );
    const plan = compileRouting(project);
    const { context, gains } = routingContext();
    const master = new RoutingTestNode();

    const graphs = buildTrackGraphs(
      context,
      master as unknown as AudioNode,
      project,
      0,
      'disabled',
      plan,
    );
    try {
      const sourceInput = graphs.get('source')?.input as unknown as RoutingTestGain;
      const busInput = graphs.get('bus')?.input as unknown as RoutingTestGain;
      const preSendGate = gains.find(
        (gain) => sourceInput.connections.includes(gain) && gain.connections.includes(busInput),
      );
      const sourceFader = sourceInput.connections.find(
        (node): node is RoutingTestGain =>
          node instanceof RoutingTestGain && node !== preSendGate,
      );

      expect(sourceInput).toBeInstanceOf(RoutingTestGain);
      expect(busInput).toBeInstanceOf(RoutingTestGain);
      expect(preSendGate).toBeDefined();
      expect(preSendGate?.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 0);
      expect(gains.filter((gain) => gain.connections.includes(master))).toHaveLength(2);
      expect(estimateRoutingGraphNodeCount(project, plan, 'disabled')).toBe(11);
      expect(estimateRoutingGraphNodeCount(project, plan, 'live')).toBe(13);
      expect(audioRoutingTopologySignature(plan)).toBe(
        'output:source>master|send:source-wet:source:pre-fader>bus:bus|output:bus>master',
      );

      const updated: Project = {
        ...project,
        audioRouting: {
          ...project.audioRouting,
          sends: [{ ...project.audioRouting.sends[0]!, gain: 1.25 }],
        },
      };
      applyRoutingMixState(graphs, updated, 2, plan);
      expect(preSendGate?.gain.setTargetAtTime).toHaveBeenCalledWith(1.25, 2, 0.01);
      expect(sourceFader?.gain.setTargetAtTime).not.toHaveBeenCalled();
    } finally {
      for (const graph of graphs.values()) graph.dispose();
    }
  });

  it('rejects invalid routing before allocating a channel node', () => {
    const project = routingProject([track('source')], { outputs: [], sends: [] });
    const createGain = vi.fn();
    const context = { createGain } as unknown as BaseAudioContext;
    const master = new RoutingTestNode() as unknown as AudioNode;

    expect(() => buildTrackGraphs(context, master, project, 0, 'disabled')).toThrow(
      /Audio routing is invalid/,
    );
    expect(createGain).not.toHaveBeenCalled();
  });

  it('preflights a bounded static node count before construction', () => {
    const tracks = Array.from({ length: 1_024 }, (_, index) => track(`track-${index}`));
    const project = routingProject(tracks, {
      outputs: tracks.map((item) => ({
        sourceTrackId: item.id,
        destination: { type: 'master' },
      })),
      sends: [],
    });
    const plan = compileRouting(project);

    expect(() => assertRoutingGraphNodeBudget(project, plan, 'disabled')).toThrowError(
      expect.objectContaining({ code: 'graph-node-limit' }),
    );
  });

  it('rejects a live effect rebuild above 4096 nodes before touching any channel', () => {
    let effectOrdinal = 0;
    const withReverbs = (item: Track, count: number): Track => ({
      ...item,
      effects: Array.from({ length: count }, () => ({
        id: `reverb-${effectOrdinal++}`,
        type: 'reverb' as const,
        enabled: true,
        params: { wet: 0.25, decay: 0.45 },
      })),
    });
    const channels = Array.from({ length: 13 }, (_, index) =>
      withReverbs(track(`channel-${index}`), index < 12 ? 64 : 35));
    const master = track('master', { type: 'master' });
    const project = routingProject([...channels, master], {
      outputs: channels.map((channel) => ({
        sourceTrackId: channel.id,
        destination: { type: 'master' },
      })),
      sends: [],
    });
    const plan = compileRouting(project);
    expect(estimateRoutingGraphNodeCount(project, plan, 'live')).toBe(4_095);

    const extraReverb = {
      id: `reverb-${effectOrdinal++}`,
      type: 'reverb' as const,
      enabled: true,
      params: { wet: 0.25, decay: 0.45 },
    };
    const overLimit: Project = {
      ...project,
      tracks: project.tracks.map((item) =>
        item.id === channels.at(-1)?.id
          ? { ...item, effects: [...item.effects, extraReverb] }
          : item),
    };
    expect(estimateRoutingGraphNodeCount(overLimit, plan, 'live')).toBe(4_100);
    const updateEffects = vi.fn();
    const apply = vi.fn();
    const graphs = new Map([
      [channels[0]!.id, { updateEffects, apply }],
    ]) as unknown as Parameters<typeof applyMixState>[0];

    expect(() => applyMixState(graphs, overLimit, 2, plan)).toThrowError(
      expect.objectContaining({ code: 'graph-node-limit', observedNodes: 4_100 }),
    );
    expect(updateEffects).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('disposes already-built track graphs when a later track fails', () => {
    const gains = Array.from({ length: 2 }, () => ({
      gain: {
        value: 0,
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    const panner = {
      pan: {
        value: 0,
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      createGain: vi
        .fn()
        .mockReturnValueOnce(gains[0])
        .mockReturnValueOnce(gains[1]),
      createStereoPanner: vi
        .fn()
        .mockReturnValueOnce(panner)
        .mockImplementationOnce(() => {
          throw new Error('output device graph failed');
        }),
    } as unknown as BaseAudioContext;
    const master = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;

    expect(() =>
      buildTrackGraphs(context, master, [track('first'), track('second')], 0, 'disabled'),
    ).toThrow('output device graph failed');
    expect(gains[0]?.disconnect).toHaveBeenCalled();
    expect(gains[1]?.disconnect).toHaveBeenCalled();
    expect(panner.disconnect).toHaveBeenCalled();
  });

  it('applies initial mute immediately and only smooths later live changes', () => {
    const gainParam = {
      value: 0,
      setTargetAtTime: vi.fn(),
      setValueAtTime: vi.fn(),
      cancelAndHoldAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    };
    const panParam = {
      value: 0,
      setTargetAtTime: vi.fn(),
      setValueAtTime: vi.fn(),
      cancelAndHoldAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    };
    const gain = {
      gain: gainParam,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const panner = {
      pan: panParam,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      createGain: vi.fn(() => gain),
      createStereoPanner: vi.fn(() => panner),
    } as unknown as BaseAudioContext;
    const master = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
    const muted = track('muted', { mute: true, volume: 0.8, pan: -0.25 });

    const graphs = buildTrackGraphs(context, master, [muted], 0, 'disabled');

    expect(gainParam.setValueAtTime).toHaveBeenCalledWith(0, 0);
    expect(panParam.setValueAtTime).toHaveBeenCalledWith(-0.25, 0);
    expect(gainParam.setTargetAtTime).not.toHaveBeenCalled();

    applyMixState(
      graphs,
      [{ ...muted, mute: false, volume: 0.5, pan: 0.25 }],
      2,
    );
    expect(gainParam.setTargetAtTime).toHaveBeenCalledWith(0.5, 2, 0.01);
    expect(panParam.setTargetAtTime).toHaveBeenCalledWith(0.25, 2, 0.01);
  });

  it('silences non-solo tracks at sample zero during initial graph construction', () => {
    const gains = Array.from({ length: 2 }, () => ({
      gain: {
        value: 0,
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    const panners = Array.from({ length: 2 }, () => ({
      pan: {
        value: 0,
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    const context = {
      createGain: vi.fn().mockReturnValueOnce(gains[0]).mockReturnValueOnce(gains[1]),
      createStereoPanner: vi
        .fn()
        .mockReturnValueOnce(panners[0])
        .mockReturnValueOnce(panners[1]),
    } as unknown as BaseAudioContext;
    const master = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;

    buildTrackGraphs(
      context,
      master,
      [track('solo', { solo: true, volume: 0.6 }), track('other', { volume: 0.8 })],
      0,
      'disabled',
    );

    expect(gains[0]?.gain.setValueAtTime).toHaveBeenCalledWith(0.6, 0);
    expect(gains[1]?.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
    expect(gains[0]?.gain.setTargetAtTime).not.toHaveBeenCalled();
    expect(gains[1]?.gain.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('keeps the live meter registry intact while an offline graph is built', () => {
    const makeParam = () => ({
      value: 0,
      setValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    });
    const makeGain = () => ({
      gain: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    });
    const makePanner = () => ({
      pan: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    });
    const makeAnalyser = (sample: number) => ({
      fftSize: 4,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((buffer: Float32Array) => buffer.fill(sample)),
    });

    const liveMasterAnalyser = makeAnalyser(0.1);
    const liveTrackAnalyser = makeAnalyser(0.2);
    const liveContext = {
      destination: {},
      createGain: vi.fn(() => makeGain()),
      createStereoPanner: vi.fn(() => makePanner()),
      createAnalyser: vi
        .fn()
        .mockReturnValueOnce(liveMasterAnalyser)
        .mockReturnValueOnce(liveTrackAnalyser),
    } as unknown as BaseAudioContext;
    const liveMaster = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioNode;
    const liveGraphs = buildTrackGraphs(
      liveContext,
      liveMaster,
      [track('sound'), track('master', { type: 'master' })],
      0,
      'live',
    );

    const offlineContext = {
      destination: {},
      createGain: vi.fn(() => makeGain()),
      createStereoPanner: vi.fn(() => makePanner()),
      createAnalyser: vi.fn(() => makeAnalyser(0.9)),
    } as unknown as BaseAudioContext;
    const offlineMaster = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioNode;

    try {
      expect(readMeterLevel('master').peak).toBeCloseTo(0.1, 6);
      const offlineGraphs = buildTrackGraphs(
        offlineContext,
        offlineMaster,
        [track('sound'), track('master', { type: 'master' })],
        0,
        'disabled',
      );
      for (const graph of offlineGraphs.values()) graph.dispose();

      expect(offlineContext.createAnalyser).not.toHaveBeenCalled();
      expect(readMeterLevel('master').peak).toBeCloseTo(0.1, 6);
    } finally {
      for (const graph of liveGraphs.values()) graph.dispose();
      disposeMasterMeter(liveMaster);
    }
  });
});
