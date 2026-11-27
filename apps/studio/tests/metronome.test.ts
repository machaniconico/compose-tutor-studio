import { describe, expect, it } from 'vitest';
import { countInBeatEvents, metronomeBeatEvents } from '../src/audio/metronome';

describe('metronomeBeatEvents', () => {
  it('emits one click per whole beat in [from, to)', () => {
    const clicks = metronomeBeatEvents(0, 4, 4);
    expect(clicks.map((c) => c.beat)).toEqual([0, 1, 2, 3]);
  });

  it('accents the first beat of each 4/4 bar', () => {
    const clicks = metronomeBeatEvents(0, 8, 4);
    expect(clicks.filter((c) => c.accent).map((c) => c.beat)).toEqual([0, 4]);
  });

  it('starts at the next whole beat when from is fractional', () => {
    const clicks = metronomeBeatEvents(1.4, 4, 4);
    expect(clicks.map((c) => c.beat)).toEqual([2, 3]);
  });

  it('accents on the bar start for a 3/4 meter', () => {
    const clicks = metronomeBeatEvents(0, 6, 3);
    expect(clicks.filter((c) => c.accent).map((c) => c.beat)).toEqual([0, 3]);
  });

  it('clicks 3 times in one 3/4 bar, the first one accented', () => {
    const clicks = metronomeBeatEvents(0, 3, 3);
    expect(clicks).toEqual([
      { beat: 0, accent: true },
      { beat: 1, accent: false },
      { beat: 2, accent: false },
    ]);
  });

  it('returns nothing for an empty range', () => {
    expect(metronomeBeatEvents(4, 4, 4)).toEqual([]);
  });
});

it('counts one 6/8 bar before recording with the first eighth note accented', () => {
  expect(countInBeatEvents([6, 8], -3, 1)).toEqual([
    { beat: -3, accent: true },
    { beat: -2.5, accent: false },
    { beat: -2, accent: false },
    { beat: -1.5, accent: false },
    { beat: -1, accent: false },
    { beat: -0.5, accent: false },
  ]);
});
