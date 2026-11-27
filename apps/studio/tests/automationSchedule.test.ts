import { describe, expect, it } from 'vitest';
import { evaluateAutomation, MIN_LOOP_PERIOD_BEATS, swingBeat, type AutomationLane } from '@cts/project-model';
import { AUTOMATION_EVENTS_PER_SECOND, buildParamSchedule, MAX_AUTOMATION_EVENTS } from '../src/audio/automationSchedule';
import { beatToTime, isValidLoop, wrapBeat } from '../src/audio/scheduler';

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

describe('pan and cutoff schedules', () => {
  const pan = { points: [{ beat: 0, value: -1 }, { beat: 4, value: 1 }] };
  const cutoff = { points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 10 }] };

  it('ramps the summed pan to the clamp crossing and holds it there', () => {
    expect(buildParamSchedule(pan, 0, null, 120, { target: { kind: 'pan', mixerPan: 0.5 } })).toEqual([
      { method: 'setValueAtTime', value: -0.5, time: 0 },
      { method: 'linearRampToValueAtTime', value: 1, time: 1.5 },
      { method: 'linearRampToValueAtTime', value: 1, time: 2 },
    ]);
  });

  it('ramps in cents and preserves both absolute frequency clamp crossings', () => {
    const target = { kind: 'cutoff', baseHz: 2400, sampleRate: 48000 } as const;
    expect(buildParamSchedule(cutoff, 2, null, 120, { target, endBeat: 3 })).toEqual([
      { method: 'setValueAtTime', value: 0, time: 0 },
      { method: 'linearRampToValueAtTime', value: 1200 * Math.log2(10 ** 0.5), time: 0.5 },
    ]);
    const upper = buildParamSchedule(cutoff, 0, null, 120, { target });
    expect(upper.map(({ method }) => method)).toEqual([
      'setValueAtTime', 'linearRampToValueAtTime', 'linearRampToValueAtTime',
    ]);
    expect(upper[1]?.value).toBeCloseTo(1200 * Math.log2(9));
    expect(upper[1]!.time).toBeCloseTo(Math.log10(90));
    expect(upper[2]).toMatchObject({ value: 1200 * Math.log2(9), time: 2 });
    const lower = buildParamSchedule(cutoff, 0, null, 120, { target: { ...target, baseHz: 100 } });
    expect(lower[0]?.value).toBe(1200 * Math.log2(0.2));
    expect(lower[1]?.value).toBeCloseTo(1200 * Math.log2(0.2));
    expect(lower[1]!.time).toBeCloseTo(Math.log10(2));
    expect(lower[2]).toMatchObject({ value: 1200 * Math.log2(10), time: 2 });
  });

  it('keeps a neutral lane at zero cents even when the preset exceeds the cutoff ceiling', () => {
    const neutral = { points: [{ beat: 0, value: 1 }] };
    const target = { kind: 'cutoff', baseHz: 16000, sampleRate: 22050 } as const;
    expect(buildParamSchedule(neutral, 0, null, 120, { target })).toEqual([
      { method: 'setValueAtTime', value: 0, time: 0 },
    ]);
  });

  it('matches a live loop pass to WAV range scheduling and holds passes shorter than 5 ms', () => {
    const target = { kind: 'cutoff', baseHz: 2400, sampleRate: 44100 } as const;
    for (const region of [{ startBeat: 1, endBeat: 3 }, { startBeat: 1, endBeat: 1 + MIN_LOOP_PERIOD_BEATS }]) {
      const live = buildParamSchedule(cutoff, region.startBeat, region, 300, { target, passes: 1 });
      const wav = buildParamSchedule(cutoff, region.startBeat, null, 300, { target, endBeat: region.endBeat });
      expect(live).toEqual(wav);
      if (region.endBeat < 2) expect(live).toEqual([{ method: 'setValueAtTime', value: 1200 * Math.log2(10 ** -0.5), time: 0 }]);
    }
  });

  it('keeps live and offline events equal, finite and within limits in 500 seeded cases', () => {
    let seed = 0x033;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 500; i++) {
      const regionStart = Math.floor(rand() * 5);
      const duration = [Number.EPSILON * 8, MIN_LOOP_PERIOD_BEATS, 0.1 + rand() * 8][i % 3]!;
      const region = i % 7 === 0 ? null : { startBeat: regionStart, endBeat: regionStart + duration };
      const activeLoop = isValidLoop(region) ? region : null;
      const startBeat = rand() * 12;
      const startTime = rand() * 2000;
      const endBeat = startBeat + rand() * 8;
      const bpm = 20 + rand() * 280;
      const passes = 1 + Math.floor(rand() * 8);
      const sampleRate = i % 2 === 0 ? 44100 : 48000;

      for (const target of [
        { kind: 'pan', mixerPan: 2 * rand() - 1 },
        { kind: 'cutoff', baseHz: i % 4 === 0 ? 100 : 2400, sampleRate },
      ] as const) {
        const n = i % 11 === 0 ? 0 : i % 4 === 0 ? 400 : 1 + Math.floor(rand() * 32);
        const lane: AutomationLane = {
          points: Array.from({ length: n }, () => ({
            beat: i % 4 === 0 ? rand() * 12 : Math.floor(rand() * 32) / 4,
            value: target.kind === 'pan' ? 2 * rand() - 1 : 10 ** (2 * rand() - 1),
          })).sort((a, b) => a.beat - b.beat),
        };
        const options = { target, startTime, endBeat };
        const label = `case ${i}, ${target.kind}`;
        const offline = buildParamSchedule(lane, startBeat, region, bpm, { ...options, passes });
        const live = Array.from({ length: activeLoop ? passes : 1 }, (_, firstPass) => {
          const from = activeLoop ? firstPass === 0 ? wrapBeat(startBeat, activeLoop) : activeLoop.startBeat : startBeat;
          const to = activeLoop?.endBeat ?? endBeat;
          const seconds = beatToTime(to, bpm, from, 0);
          const budget = seconds < 0.005 ? 1 : Math.max(2, Math.floor(AUTOMATION_EVENTS_PER_SECOND * seconds));
          const events = buildParamSchedule(lane, startBeat, region, bpm, { ...options, firstPass, passes: 1 });
          expect(events.length, label).toBeLessThanOrEqual(budget);
          expect(events.length === 0, label).toBe(n === 0);
          return events;
        }).flat();
        expect(live, label).toEqual(offline);
        expect(live.length, label).toBeLessThanOrEqual(MAX_AUTOMATION_EVENTS);
        expect(live.every(({ value, time }, index) => Number.isFinite(value) && Number.isFinite(time)
          && time >= (live[index - 1]?.time ?? startTime) && (target.kind === 'pan'
            ? value >= -1 && value <= 1
            : Math.abs(value) <= 1200 * Math.log2(10))), label).toBe(true);
      }
    }
  });
});
