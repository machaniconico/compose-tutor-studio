import { afterEach, describe, expect, it, vi } from 'vitest';
import { metronomeBeatEvents } from '../src/audio/metronome';
import {
  advanceBeat,
  beatToTime,
  isValidLoop,
  nextEventsInWindow,
  projectLengthBeats,
  Scheduler,
  secondsPerBeat,
  timeToBeat,
  wrapBeat,
  type BeatTimeMapping,
  type LoopRegion,
  type ScheduledEvent,
} from '../src/audio/scheduler';

const variableTempo: BeatTimeMapping = {
  // 120 BPM through beat 4, then 60 BPM.
  beatToSeconds: (beat) => beat <= 4 ? beat * 0.5 : 2 + (beat - 4),
  secondsToBeat: (seconds) => seconds <= 2 ? seconds * 2 : 4 + (seconds - 2),
};

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

  it('integrates a tempo map across an anchored tempo change', () => {
    expect(beatToTime(6, variableTempo, 2, 10)).toBeCloseTo(13, 10);
    expect(timeToBeat(13, variableTempo, 2, 10)).toBeCloseTo(6, 10);
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

describe('projectLengthBeats', () => {
  it('multiplies bars by beats-per-bar', () => {
    expect(projectLengthBeats(8, 4)).toBe(32);
  });
  it('guards against non-positive inputs', () => {
    expect(projectLengthBeats(0, 4)).toBe(0);
    expect(projectLengthBeats(8, 0)).toBe(32); // beatsPerBar falls back to 4
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

  it('repeats the loop tempo contour instead of continuing at the final tempo', () => {
    const tempoLoop: LoopRegion = { startBeat: 0, endBeat: 8 };
    const due = nextEventsInWindow(
      [{ beat: 4, payload: 'change' }],
      0,
      16,
      variableTempo,
      0,
      0,
      tempoLoop,
    );
    expect(due.map((event) => event.time)).toEqual([2, 8]);
  });
});

describe('Scheduler metronome windows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances raw lookahead windows even when no musical events are due', () => {
    vi.useFakeTimers();
    let now = 0;
    let metronomeBeatFrontier = 0;
    const frontiers: number[] = [];
    const clicks: Array<{ beat: number; accent: boolean }> = [];
    const dueBatches: unknown[][] = [];

    const scheduler = new Scheduler({
      clock: () => now,
      fire: (due) => dueBatches.push(due),
      onScheduleWindow: ({ endBeat }) => {
        clicks.push(...metronomeBeatEvents(metronomeBeatFrontier, endBeat, 4));
        metronomeBeatFrontier = endBeat;
        frontiers.push(metronomeBeatFrontier);
      },
      tickMs: 25,
      lookaheadS: 0.51,
    });

    scheduler.start([], 120, 0, null, 8);
    expect(dueBatches).toEqual([]);
    expect(clicks).toEqual([
      { beat: 0, accent: true },
      { beat: 1, accent: false },
    ]);
    expect(frontiers[0]).toBeGreaterThan(1);

    now = 0.5;
    vi.advanceTimersByTime(25);
    expect(dueBatches).toEqual([]);
    expect(frontiers[1]).toBeGreaterThan(frontiers[0] ?? 0);
    expect(clicks.map((click) => click.beat)).toContain(2);

    scheduler.stop();
  });

  it('continues metronome windows after the final musical event', () => {
    vi.useFakeTimers();
    let now = 0;
    let metronomeBeatFrontier = 0;
    const clicks: Array<{ beat: number; accent: boolean }> = [];
    const duePayloads: unknown[] = [];

    const scheduler = new Scheduler({
      clock: () => now,
      fire: (due) => duePayloads.push(...due.map((event) => event.payload)),
      onScheduleWindow: ({ endBeat }) => {
        clicks.push(...metronomeBeatEvents(metronomeBeatFrontier, endBeat, 4));
        metronomeBeatFrontier = endBeat;
      },
      tickMs: 25,
      lookaheadS: 0.05,
    });

    scheduler.start([{ beat: 0, payload: 'final-note' }], 120, 0, null, 8);
    expect(duePayloads).toEqual(['final-note']);
    expect(clicks.map((click) => click.beat)).toEqual([0]);

    now = 1.25;
    vi.advanceTimersByTime(25);
    expect(duePayloads).toEqual(['final-note']);
    expect(clicks.some((click) => click.beat > 0)).toBe(true);
    expect(clicks.map((click) => click.beat)).toContain(2);

    scheduler.stop();
  });
});

describe('Scheduler delayed tick recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a no-loop backlog and schedules only the future lookahead', () => {
    vi.useFakeTimers();
    let now = 0;
    const fired: unknown[] = [];
    const windows: Array<{ startBeat: number; endBeat: number }> = [];
    const scheduler = new Scheduler({
      clock: () => now,
      fire: (events) => fired.push(...events.map((event) => event.payload)),
      onScheduleWindow: (window) => windows.push(window),
      tickMs: 25,
      lookaheadS: 0.1,
    });

    scheduler.start([
      { beat: 1, payload: 'missed-one' },
      { beat: 2, payload: 'missed-two' },
      { beat: 6.1, payload: 'future' },
    ], 120, 0, null, 8);
    now = 3; // beat 6; simulate a throttled timer/device resume.
    vi.advanceTimersByTime(25);

    expect(fired).toEqual(['future']);
    expect(windows).toHaveLength(2);
    expect(windows[1]?.startBeat).toBeCloseTo(6, 10);
    expect(windows[1]?.endBeat).toBeCloseTo(6.2, 10);
    scheduler.stop();
  });

  it('does not replay missed loop passes after a clock jump', () => {
    vi.useFakeTimers();
    let now = 0;
    const fired: unknown[] = [];
    const scheduler = new Scheduler({
      clock: () => now,
      fire: (events) => fired.push(...events.map((event) => event.payload)),
      tickMs: 25,
      lookaheadS: 0.1,
    });

    scheduler.start([
      { beat: 2, payload: 'missed-loop-hit' },
      { beat: 2.2, payload: 'future-loop-hit' },
    ], 120, 0, { startBeat: 0, endBeat: 4 }, Infinity);
    now = 5.05; // beat 10.1: occurrence@10 is past; occurrence@10.2 is future.
    vi.advanceTimersByTime(25);

    expect(fired).toEqual(['future-loop-hit']);
    scheduler.stop();
  });

  it('skips historical metronome clicks when resuming a delayed window', () => {
    vi.useFakeTimers();
    let now = 0;
    const clicks: number[] = [];
    const scheduler = new Scheduler({
      clock: () => now,
      fire: () => {},
      onScheduleWindow: ({ startBeat, endBeat }) => {
        clicks.push(...metronomeBeatEvents(startBeat, endBeat, 4).map((click) => click.beat));
      },
      tickMs: 25,
      lookaheadS: 0.2,
    });

    scheduler.start([], 120, 0, null, 8);
    now = 3; // beat 6
    vi.advanceTimersByTime(25);

    expect(clicks).toEqual([0, 6]);
    scheduler.stop();
  });

  it('fires no missed notes and ends once when a jump passes the song end', () => {
    vi.useFakeTimers();
    let now = 0;
    const fired: unknown[] = [];
    const onEnd = vi.fn();
    const scheduler = new Scheduler({
      clock: () => now,
      fire: (events) => fired.push(...events.map((event) => event.payload)),
      onEnd,
      tickMs: 25,
      lookaheadS: 0.1,
    });

    scheduler.start([{ beat: 3.9, payload: 'missed-tail' }], 120, 0, null, 4);
    now = 3; // beat 6, beyond the 4-beat song.
    vi.advanceTimersByTime(25);
    vi.advanceTimersByTime(100);

    expect(fired).toEqual([]);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(scheduler.isRunning).toBe(false);
  });
});

describe('Scheduler failure boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rethrows a first-window failure and never starts its interval', () => {
    vi.useFakeTimers();
    const failure = new Error('initial voice allocation failed');
    const fire = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();
    const scheduler = new Scheduler({
      clock: () => 0,
      fire,
      onError,
      tickMs: 25,
      lookaheadS: 0.1,
    });

    expect(() => scheduler.start([{ beat: 0, payload: 'note' }], 120, 0, null, 4))
      .toThrow(failure);
    expect(scheduler.isRunning).toBe(false);
    vi.advanceTimersByTime(100);
    expect(fire).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops and reports an interval failure exactly once without retrying its window', () => {
    vi.useFakeTimers();
    let now = 0;
    const failure = new Error('later voice allocation failed');
    const fire = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();
    const scheduler = new Scheduler({
      clock: () => now,
      fire,
      onError,
      tickMs: 25,
      lookaheadS: 0.1,
    });

    scheduler.start([{ beat: 1.1, payload: 'note' }], 120, 0, null, 4);
    now = 0.5;
    vi.advanceTimersByTime(25);

    expect(scheduler.isRunning).toBe(false);
    expect(fire).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    vi.advanceTimersByTime(100);
    expect(fire).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });
});
