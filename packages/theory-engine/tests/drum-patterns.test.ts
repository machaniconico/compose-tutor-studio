import { describe, expect, it } from 'vitest';
import { DRUM_PATTERNS } from '../src';

describe('drum presets', () => {
  it('produces the expected downbeats and offbeats in four beats', () => {
    const [fourOnFloor, eightBeat, hiphop, gameLoop, lofi] = DRUM_PATTERNS;
    expect(fourOnFloor!.beats(4)).toEqual({
      kick: [0, 1, 2, 3],
      closedHat: [0.5, 1.5, 2.5, 3.5],
      clap: [1, 3],
    });
    expect(eightBeat!.beats(4)).toEqual({
      kick: [0, 2],
      snare: [1, 3],
      closedHat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    });
    expect(hiphop!.beats(4).openHat).toEqual([3.5]);
    expect(gameLoop!.beats(4).perc).toEqual([0.5, 2.5]);
    expect(lofi!.beats(4).perc).toEqual([1.75]);
  });

  it.each(DRUM_PATTERNS)('keeps $id hits inside short bars and bounds large inputs', ({ beats }) => {
    for (const span of [0.5, 2, 2.5, 5]) {
      expect(Object.values(beats(span)).flat().every((offset) => offset >= 0 && offset < span)).toBe(true);
    }
    for (const span of [0, -1, Infinity, NaN, 1e9, { toString: null } as never]) {
      expect(beats(span)).toEqual({});
    }
  });
});
