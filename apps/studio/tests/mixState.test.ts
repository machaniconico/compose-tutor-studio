import { describe, expect, it, vi } from 'vitest';
import type { AudioRouting, Track } from '@cts/project-model';
import {
  MIX_RAMP_SECONDS,
  applyAudioParam,
  applyMasterMix,
  clampPan,
  clampVolume,
  hasLiveMixChanged,
  hasLiveRoutingMixChanged,
  resolveMasterMix,
  resolveTrackMix,
} from '../src/audio/mixState';

function track(
  id: string,
  type: Track['type'] = 'instrument',
  overrides: Partial<Track> = {},
): Track {
  const { role, ...rest } = overrides;
  return {
    id,
    name: id,
    type,
    role: role ?? 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    ...rest,
  };
}

function fakeParam(initial = 1) {
  const param = {
    value: initial,
    cancelAndHoldAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };
  return param;
}

describe('master mix policy', () => {
  it('detects only fields that update an existing live mixer graph', () => {
    const source = [track('source')];
    expect(hasLiveMixChanged(source, source)).toBe(false);
    expect(hasLiveMixChanged(source, [{ ...source[0]!, name: 'Renamed' }])).toBe(false);
    expect(hasLiveMixChanged(source, [{ ...source[0]!, volume: 0.5 }])).toBe(true);
    expect(hasLiveMixChanged(source, [{
      ...source[0]!,
      effects: [{
        id: 'effect',
        type: 'filter',
        enabled: true,
        params: { cutoff: 0.5, resonance: 0.2 },
      }],
    }])).toBe(true);
  });

  it('updates existing send gates only for live gain/enabled changes', () => {
    const current: AudioRouting = {
      outputs: [{ sourceTrackId: 'source', destination: { type: 'master' } }],
      sends: [{
        id: 'wet',
        sourceTrackId: 'source',
        targetBusId: 'bus',
        position: 'post-fader',
        gain: 0.5,
        enabled: true,
      }],
    };

    expect(hasLiveRoutingMixChanged(current, current)).toBe(false);
    expect(hasLiveRoutingMixChanged(current, {
      ...current,
      sends: [{ ...current.sends[0]!, gain: 1.25 }],
    })).toBe(true);
    expect(hasLiveRoutingMixChanged(current, {
      ...current,
      sends: [{ ...current.sends[0]!, enabled: false }],
    })).toBe(true);
    // Topology is owned by playback-generation invalidation, not a live patch.
    expect(hasLiveRoutingMixChanged(current, {
      ...current,
      outputs: [{ sourceTrackId: 'source', destination: { type: 'bus', trackId: 'bus' } }],
    })).toBe(false);
    expect(hasLiveRoutingMixChanged(current, {
      ...current,
      sends: [{ ...current.sends[0]!, position: 'pre-fader' }],
    })).toBe(false);
  });

  it('uses unity without a master and the first master volume exactly once', () => {
    expect(resolveMasterMix([track('melody')])).toEqual({ trackId: null, gain: 1 });
    expect(
      resolveMasterMix([
        track('first', 'master', { volume: 0.5, mute: true, solo: true, pan: 1 }),
        track('second', 'master', { volume: 2 }),
      ]),
    ).toEqual({ trackId: 'first', gain: 0.5 });
  });

  it('clamps valid gain/pan values and fails corrupt gain silent', () => {
    expect([0, 0.5, 1, 2].map(clampVolume)).toEqual([0, 0.5, 1, 2]);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(3)).toBe(2);
    expect(clampVolume(Number.NaN)).toBe(0);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPan(-2)).toBe(-1);
    expect(clampPan(2)).toBe(1);
    expect(clampPan(Number.NaN)).toBe(0);
  });

  it('resolves mute/solo audibility separately from per-track gain', () => {
    const source = track('source', 'instrument', { volume: 0.5, pan: -0.25 });
    expect(resolveTrackMix(source, true)).toEqual({ gain: 0.5, pan: -0.25 });
    expect(resolveTrackMix(source, false)).toEqual({ gain: 0, pan: -0.25 });
  });
});

describe('audio param application', () => {
  it('sets initial/offline values immediately without an audible ramp', () => {
    const param = fakeParam();
    applyAudioParam(param as unknown as AudioParam, 0, 0, 'immediate');
    expect(param.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(param.setValueAtTime).toHaveBeenCalledWith(0, 0);
    expect(param.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('holds and smooths live updates with the shared ramp duration', () => {
    const param = fakeParam();
    applyAudioParam(param as unknown as AudioParam, 0.5, 4, 'smoothed');
    expect(param.cancelAndHoldAtTime).toHaveBeenCalledWith(4);
    expect(param.setTargetAtTime).toHaveBeenCalledWith(0.5, 4, MIX_RAMP_SECONDS);
    expect(param.setValueAtTime).not.toHaveBeenCalled();
  });

  it('applies resolved master state to the supplied bus', () => {
    const param = fakeParam();
    const master = { gain: param } as unknown as GainNode;
    const mix = applyMasterMix(
      master,
      [track('master', 'master', { volume: 0 })],
      0,
      'immediate',
    );
    expect(mix).toEqual({ trackId: 'master', gain: 0 });
    expect(param.setValueAtTime).toHaveBeenCalledWith(0, 0);
  });
});
