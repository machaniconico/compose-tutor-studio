import { describe, expect, it } from 'vitest';
import { evaluateAutomation, MIN_LOOP_PERIOD_BEATS, swingBeat, type AutomationLane } from '@cts/project-model';
import { AUTOMATION_EVENTS_PER_SECOND, buildParamSchedule } from '../src/audio/automationSchedule';
import { beatToTime, wrapBeat } from '../src/audio/scheduler';

const fade: AutomationLane = { points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] };
const loop = { startBeat: 0, endBeat: 4 };

describe('buildParamSchedule', () => {
  it('starts with the evaluated value at the playhead', () => {
    expect(buildParamSchedule(fade, 2, null, 120)[0]).toEqual({
      method: 'setValueAtTime', value: 0.5, time: 0,
    });
  });

  it('ramps to the boundary and resets the gain for the second pass at the same time', () => {
    expect(buildParamSchedule(fade, 0, loop, 120)).toEqual([
      { method: 'setValueAtTime', value: 0, time: 0 },
      { method: 'linearRampToValueAtTime', value: 1, time: 2 },
      { method: 'setValueAtTime', value: 0, time: 2 },
      { method: 'linearRampToValueAtTime', value: 1, time: 4 },
    ]);
  });

  it('uses the note scheduler clock at other tempos, including notes shifted by swing', () => {
    const swungNote = swingBeat(0.25, 50);
    const bpm = 173;
    const options = { startTime: 2.5, endBeat: swungNote };
    const events = buildParamSchedule(fade, 0.25, null, bpm, options);
    expect(events.at(-1)).toEqual({
      method: 'linearRampToValueAtTime',
      value: evaluateAutomation(fade, swungNote),
      time: beatToTime(swungNote, bpm, 0.25, 2.5),
    });
  });

  it('produces no events for missing or empty lanes', () => {
    expect(buildParamSchedule(undefined, 2, loop, 120)).toEqual([]);
    expect(buildParamSchedule({ points: [] }, 2, loop, 120)).toEqual([]);
  });

  it('bounds tiny loops, requested passes, and the number of events', () => {
    const tiny = { startBeat: 0, endBeat: Number.EPSILON };
    expect(buildParamSchedule(fade, 0, tiny, 20, { passes: 1e9 })).toEqual(buildParamSchedule(fade, 0, null, 20));
    expect(() => buildParamSchedule(fade, 0, loop, 120, { passes: 1e9 })).toThrow(RangeError);
    const dense = { points: Array.from({ length: 10_000 }, (_, i) => ({ beat: i / 10_000, value: 0.5 })) };
    expect(buildParamSchedule(dense, 0, loop, 120, { passes: 4 }).length)
      .toBeLessThanOrEqual(8 * AUTOMATION_EVENTS_PER_SECOND);
  });

  it('produces finite, ordered, identical live batches and offline schedules in 500 seeded cases', () => {
    let seed = 0x027;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 500; i++) {
      const region = { startBeat: rand() * 5, endBeat: 0 };
      region.endBeat = region.startBeat + (i % 7 === 0 ? MIN_LOOP_PERIOD_BEATS : MIN_LOOP_PERIOD_BEATS + rand() * 8);
      const dense = i % 3 === 0;
      const lane = { points: Array.from({ length: dense ? 300 : 1 + Math.floor(rand() * 24) }, () => ({
        beat: dense ? rand() * region.endBeat : Math.floor(rand() * 32) / 4,
        value: rand(),
      })).sort((a, b) => a.beat - b.beat) };
      const bpm = 20 + rand() * 280;
      const startBeat = rand() * 15;
      const startTime = rand() * 2_000;
      const passes = 2 + Math.floor(rand() * 12);
      const activeLoop = i % 5 === 0 ? null : region;
      const endBeat = startBeat + rand() * 8;
      const options = { startTime, endBeat };
      const offline = buildParamSchedule(lane, startBeat, activeLoop, bpm, { ...options, passes });
      // Live queues one pass at a time with the original shared clock anchor.
      const initial = !activeLoop || startBeat < region.endBeat ? startBeat : wrapBeat(startBeat, region);
      const live = Array.from({ length: activeLoop ? passes : 1 }, (_, firstPass) => {
        const from = firstPass === 0 ? initial : region.startBeat;
        const to = activeLoop ? region.endBeat : endBeat;
        const seconds = beatToTime(to, bpm, from, 0);
        const events = buildParamSchedule(lane, startBeat, activeLoop, bpm, { ...options, firstPass, passes: 1 });
        const allowance = seconds < 0.005 ? 1 : Math.max(2, Math.floor(AUTOMATION_EVENTS_PER_SECOND * seconds));
        expect(events.length, `case ${i}, pass ${firstPass}`).toBeLessThanOrEqual(allowance);
        expect(events[0]).toMatchObject({ method: 'setValueAtTime', value: evaluateAutomation(lane, from) });
        if (seconds >= 0.005) {
          expect(events.at(-1)).toMatchObject({ method: 'linearRampToValueAtTime', value: evaluateAutomation(lane, to) });
        }
        return events;
      }).flat();
      expect(live, `case ${i}`).toEqual(offline);
      expect(live.every(({ value, time }, index) => value >= 0 && value <= 1
        && Number.isFinite(time) && time >= (live[index - 1]?.time ?? startTime)), `case ${i}`).toBe(true);
      const sets = live.filter((event) => event.method === 'setValueAtTime');
      expect(sets[0]).toMatchObject({ time: startTime, value: evaluateAutomation(lane, initial) });
      if (!activeLoop) continue;
      const elapsedStarts = initial < region.startBeat ? [region.startBeat - initial] : [];
      for (let pass = 0; pass < passes - 1; pass++) {
        elapsedStarts.push(region.endBeat - initial + pass * (region.endBeat - region.startBeat));
      }
      expect(sets).toHaveLength(1 + elapsedStarts.length);
      elapsedStarts.forEach((offset, index) => {
        expect(sets[index + 1]?.time).toBeCloseTo(beatToTime(offset, bpm, 0, startTime), 10);
        expect(sets[index + 1]?.value).toBe(evaluateAutomation(lane, region.startBeat));
      });
    }
  });
});
