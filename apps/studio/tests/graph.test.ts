import { describe, expect, it } from 'vitest';
import type { Track, TrackType } from '@cts/project-model';
import { clampPan, clampVolume, computeAudibleTracks } from '../src/audio/graph';

/** Minimal Track factory for mute/solo tests. */
function track(
  id: string,
  opts: { type?: TrackType; mute?: boolean; solo?: boolean } = {},
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
