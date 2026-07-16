import { describe, expect, it, vi } from 'vitest';
import type { Track, TrackType } from '@cts/project-model';
import {
  applyMixState,
  buildTrackGraphs,
  clampPan,
  clampVolume,
  computeAudibleTracks,
  disposeMasterMeter,
  readMeterLevel,
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

describe('buildTrackGraphs', () => {
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
