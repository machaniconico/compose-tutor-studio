import { songEndBeat } from '@cts/project-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceBeat,
  beatToTime,
  isValidLoop,
  nextEventsInWindow,
  Scheduler,
  secondsPerBeat,
  timeToBeat,
  wrapBeat,
  type LoopRegion,
  type ScheduledEvent,
} from '../src/audio/scheduler';

describe('secondsPerBeat', () => {
  it('is 0.5s at 120bpm', () => {
    expect(secondsPerBeat(120)).toBeCloseTo(0.5, 10);
  });
  it('falls back to 120bpm for non-positive tempo', () => {
    expect(secondsPerBeat(0)).toBeCloseTo(0.5, 10);
    expect(secondsPerBeat(-10)).toBeCloseTo(0.5, 10);
  });
});

describe('beatToTime / timeToBeat', () => {
  it('maps beats to audio time from an anchor', () => {
    // anchorBeat=0 at anchorTime=10s, 120bpm => 0.5s/beat.
    expect(beatToTime(0, 120, 0, 10)).toBeCloseTo(10, 10);
    expect(beatToTime(4, 120, 0, 10)).toBeCloseTo(12, 10);
  });
  it('honors a non-zero anchor beat', () => {
    // playhead started at beat 8 when the clock read 2s.
    expect(beatToTime(8, 120, 8, 2)).toBeCloseTo(2, 10);
    expect(beatToTime(10, 120, 8, 2)).toBeCloseTo(3, 10);
  });
  it('round-trips through timeToBeat', () => {
    const t = beatToTime(7.5, 90, 1, 4);
    expect(timeToBeat(t, 90, 1, 4)).toBeCloseTo(7.5, 10);
  });
});

describe('isValidLoop', () => {
  it('accepts ordered, positive-length regions', () => {
    expect(isValidLoop({ startBeat: 0, endBeat: 4 })).toBe(true);
  });
  it('rejects zero/negative length and null', () => {
    expect(isValidLoop({ startBeat: 4, endBeat: 4 })).toBe(false);
    expect(isValidLoop({ startBeat: 8, endBeat: 4 })).toBe(false);
    expect(isValidLoop(null)).toBe(false);
  });
});

describe('wrapBeat', () => {
  const loop: LoopRegion = { startBeat: 4, endBeat: 8 }; // length 4

  it('passes through beats before the region', () => {
    expect(wrapBeat(0, loop)).toBe(0);
    expect(wrapBeat(3.5, loop)).toBe(3.5);
  });
  it('keeps beats inside the region', () => {
    expect(wrapBeat(4, loop)).toBe(4);
    expect(wrapBeat(7.99, loop)).toBeCloseTo(7.99, 10);
  });
  it('folds beats at/after the end back into the region', () => {
    expect(wrapBeat(8, loop)).toBeCloseTo(4, 10); // one full loop
    expect(wrapBeat(9, loop)).toBeCloseTo(5, 10);
    expect(wrapBeat(12, loop)).toBeCloseTo(4, 10); // two full loops
    expect(wrapBeat(13.5, loop)).toBeCloseTo(5.5, 10);
  });
});

describe('advanceBeat', () => {
  it('advances linearly with no loop', () => {
    expect(advanceBeat(2, 1, null)).toBe(3);
  });
  it('wraps inside a loop region', () => {
    const loop: LoopRegion = { startBeat: 0, endBeat: 4 };
    expect(advanceBeat(3.5, 1, loop)).toBeCloseTo(0.5, 10);
  });
});

describe('songEndBeat', () => {
  it('multiplies bars by beats-per-bar', () => {
    expect(songEndBeat({ lengthBars: 8, timeSignature: [4, 4] })).toBe(32);
  });
  it('guards against non-positive inputs', () => {
    expect(songEndBeat({ lengthBars: 0, timeSignature: [4, 4] })).toBe(0);
    expect(songEndBeat({ lengthBars: 8, timeSignature: [0, 4] })).toBe(32); // beatsPerBar falls back to 4
  });
});

describe('nextEventsInWindow (no loop)', () => {
  const events: ScheduledEvent[] = [
    { beat: 0, payload: 'a' },
    { beat: 1, payload: 'b' },
    { beat: 2, payload: 'c' },
    { beat: 3, payload: 'd' },
  ];

  it('selects events in [start, end) and resolves their time', () => {
    // 120bpm, anchorBeat 0 at anchorTime 0.
    const due = nextEventsInWindow(events, 1, 3, 120, 0, 0, null);
    expect(due.map((d) => d.payload)).toEqual(['b', 'c']);
    expect(due[0]?.time).toBeCloseTo(0.5, 10); // beat 1 -> 0.5s
    expect(due[1]?.time).toBeCloseTo(1.0, 10); // beat 2 -> 1.0s
  });

  it('is half-open: the end beat is excluded', () => {
    const due = nextEventsInWindow(events, 0, 2, 120, 0, 0, null);
    expect(due.map((d) => d.payload)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty/inverted window', () => {
    expect(nextEventsInWindow(events, 2, 2, 120, 0, 0, null)).toEqual([]);
    expect(nextEventsInWindow(events, 3, 1, 120, 0, 0, null)).toEqual([]);
  });
});

describe('nextEventsInWindow (loop wrap)', () => {
  const loop: LoopRegion = { startBeat: 0, endBeat: 4 }; // length 4
  const events: ScheduledEvent[] = [
    { beat: 0, payload: 'kick' },
    { beat: 2, payload: 'snare' },
  ];

  it('repeats in-region events each pass with increasing time', () => {
    // Window spans [0, 8): two passes of a 4-beat loop.
    const due = nextEventsInWindow(events, 0, 8, 120, 0, 0, loop);
    // Expect kick@0, snare@2, kick@4(=loop), snare@6(=loop) by time order.
    expect(due.map((d) => d.payload)).toEqual(['kick', 'snare', 'kick', 'snare']);
    expect(due.map((d) => d.time)).toEqual([0, 1, 2, 3]); // 0.5s/beat
    // The reported source beat folds back into the region.
    expect(due.map((d) => d.beat)).toEqual([0, 2, 0, 2]);
  });

  it('crosses the loop boundary mid-window', () => {
    // Window [3, 5): catches the wrapped kick at playhead beat 4 only.
    const due = nextEventsInWindow(events, 3, 5, 120, 0, 0, loop);
    expect(due.map((d) => d.payload)).toEqual(['kick']);
    expect(due[0]?.time).toBeCloseTo(2, 10); // playhead beat 4 -> 2.0s
    expect(due[0]?.beat).toBe(0); // source beat
  });

  it('never plays events outside the loop region (they are unreachable)', () => {
    const mixed: ScheduledEvent[] = [
      { beat: 1, payload: 'inside' },
      { beat: 6, payload: 'outside' }, // beyond endBeat=4: playhead wraps first
    ];
    // First pass: only the in-region event sounds.
    const firstPass = nextEventsInWindow(mixed, 0, 4, 120, 0, 0, loop);
    expect(firstPass.map((d) => d.payload)).toEqual(['inside']);
    // Subsequent passes: the in-region event recurs, the outside one never does.
    const secondPass = nextEventsInWindow(mixed, 4, 8, 120, 0, 0, loop);
    expect(secondPass.map((d) => d.payload)).toEqual(['inside']);
  });
});

describe('loop region that starts after beat 0', () => {
  const loop: LoopRegion = { startBeat: 4, endBeat: 12 }; // length 8
  const events: ScheduledEvent[] = [
    { beat: 0, payload: 'intro' }, // before the region
    { beat: 4, payload: 'loopStart' },
    { beat: 13, payload: 'after' }, // past the region end
  ];

  it('plays events before the region once, then only the region', () => {
    // Playhead beats [0, 20): pre-roll 0-4, first pass 4-12, second pass 12-20.
    const due = nextEventsInWindow(events, 0, 20, 120, 0, 0, loop);
    expect(due.map((d) => d.payload)).toEqual(['intro', 'loopStart', 'loopStart']);
    expect(due.map((d) => d.time)).toEqual([0, 2, 6]); // beats 0, 4, 12 at 0.5s/beat
  });

  it('never replays the pre-region events on later passes', () => {
    const due = nextEventsInWindow(events, 12, 28, 120, 0, 0, loop);
    expect(due.map((d) => d.payload)).toEqual(['loopStart', 'loopStart']);
  });

  it('starting inside the region skips the pre-region events', () => {
    const due = nextEventsInWindow(events, 6, 14, 120, 6, 0, loop);
    expect(due.map((d) => d.payload)).toEqual(['loopStart']);
    expect(due[0]?.time).toBeCloseTo(3, 10); // playhead beat 12 is 6 beats after the anchor
  });

  describe('Scheduler', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sounds the note at beat 0 when playing from 0 with the loop at 4-12', () => {
      const fire = vi.fn();
      let now = 0;
      const scheduler = new Scheduler({ clock: () => now, fire, tickMs: 25, lookaheadS: 0.1 });

      scheduler.start(events, 120, 0, loop, Infinity);
      expect(fire).toHaveBeenCalledTimes(1);
      expect(fire.mock.calls[0]?.[0]).toEqual([{ time: 0, beat: 0, payload: 'intro' }]);

      // Run 9.5s (19 beats): the loop start sounds at playhead beats 4 and 12, the intro never again.
      for (let i = 0; i < 380; i += 1) {
        now += 0.025;
        vi.advanceTimersByTime(25);
      }
      const payloads = fire.mock.calls.flatMap(([due]) => (due as { payload: unknown }[]).map((d) => d.payload));
      expect(payloads).toEqual(['intro', 'loopStart', 'loopStart']);
      scheduler.stop();
    });
  });
});

describe('Scheduler start at the project end (loop off)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends inside the first tick and leaves no interval behind', () => {
    const onEnd = vi.fn();
    const fire = vi.fn();
    const scheduler = new Scheduler({ clock: () => 10, fire, onEnd });

    scheduler.start([{ beat: 0, payload: 'kick' }], 120, 32, null, 32);

    expect(onEnd).toHaveBeenCalledOnce();
    expect(fire).not.toHaveBeenCalled();
    expect(scheduler.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accumulate intervals over repeated starts at the end', () => {
    const scheduler = new Scheduler({ clock: () => 10, fire: () => undefined });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      scheduler.start([], 120, 32, null, 32);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still keeps its interval when started before the end', () => {
    const onEnd = vi.fn();
    const scheduler = new Scheduler({ clock: () => 10, fire: () => undefined, onEnd });

    scheduler.start([], 120, 28, null, 32);

    expect(scheduler.isRunning).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
