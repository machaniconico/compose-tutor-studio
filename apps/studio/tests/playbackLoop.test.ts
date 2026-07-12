import { describe, expect, it } from 'vitest';
import { normalizeTransportLoop } from '../src/audio/playback';

describe('normalizeTransportLoop', () => {
  it('returns null when looping is disabled or the song has no length', () => {
    expect(normalizeTransportLoop(false, 1, 3, 8)).toBeNull();
    expect(normalizeTransportLoop(true, 0, 0, 0)).toBeNull();
    expect(normalizeTransportLoop(true, 0, 1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps a valid region and clamps finite bounds to the song', () => {
    expect(normalizeTransportLoop(true, 2, 6, 8)).toEqual({
      startBeat: 2,
      endBeat: 6,
    });
    expect(normalizeTransportLoop(true, -3, 12, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
  });

  it('falls back to the whole song for invalid enabled bounds', () => {
    expect(normalizeTransportLoop(true, 0, 0, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
    expect(normalizeTransportLoop(true, 7, 2, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
    expect(normalizeTransportLoop(true, Number.NaN, 4, 8)).toEqual({
      startBeat: 0,
      endBeat: 8,
    });
  });
});
