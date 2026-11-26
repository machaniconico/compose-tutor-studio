import { describe, expect, it } from 'vitest';
import { soundingEvents, MAX_SOUNDING_EVENTS, MAX_SONG_BARS, MIN_LOOP_PERIOD_BEATS } from '../../src/sounding';
import { validateProject } from '../../src/index';
import { SEEDS, generateProject, makeProject, makeTrack, midiClip } from './helpers';

describe('sounding.bounds', () => {
  it('sounding.bounds: 検証を通る任意のプロジェクトで展開が 100ms 以内、イベント数が上限以内', () => {
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      expect(validateProject(project).ok).toBe(true);
      const t0 = performance.now();
      const { events } = soundingEvents(project);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(events.length).toBeLessThanOrEqual(MAX_SOUNDING_EVENTS);
    }
  });

  it('sounding.bounds: 最短周期のループを曲長上限いっぱいに敷いても、検証を通るなら 100ms 以内・上限以内', () => {
    const notes: Array<[number, number, number]> = Array.from({ length: 8 }, (_, i) => [(i * MIN_LOOP_PERIOD_BEATS) / 8, MIN_LOOP_PERIOD_BEATS / 8, 60 + i]);
    const project = makeProject(
      [makeTrack('t', 'instrument', [midiClip('a', 't', 0, MAX_SONG_BARS * 4, notes, { loop: true, contentLengthBeats: MIN_LOOP_PERIOD_BEATS })])],
      { lengthBars: MAX_SONG_BARS },
    );
    if (validateProject(project).ok) {
      const t0 = performance.now();
      const { events } = soundingEvents(project);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(events.length).toBeLessThanOrEqual(MAX_SOUNDING_EVENTS);
    } else {
      expect(validateProject(project).errors.length).toBeGreaterThan(0);
    }
  });
});
