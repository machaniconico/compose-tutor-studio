import { describe, expect, it, vi } from 'vitest';
import {
  beatToTime,
  createScheduleEventIndex,
  nextIndexedEventsInWindow,
  preflightLoopScheduleDensity,
  queryScheduleEventIndex,
  resolveDrumOccurrence,
  Scheduler,
  type DueEvent,
  type LoopRegion,
  type ScheduledEvent,
} from '../src/audio/scheduler';

type TestDrumPayload = {
  kind: 'drum';
  trackId: string;
  clipId: string;
  eventId: string;
  lane: string;
  velocity: number;
  sourceStepIndex: number;
  clipEndBeat: number;
  stepsPerBar: number;
  beatsPerBar: number;
  probability: number;
  swing: number;
  humanizeVelocity: number;
  seed: number;
};

function drumPayload(
  eventId: string,
  sourceStepIndex: number,
  swing: number,
  overrides: Partial<TestDrumPayload> = {},
): TestDrumPayload {
  return {
    kind: 'drum',
    trackId: 'track-1',
    clipId: 'clip-1',
    eventId,
    lane: 'closed-hat',
    velocity: 96,
    sourceStepIndex,
    clipEndBeat: 128,
    stepsPerBar: 16,
    beatsPerBar: 4,
    probability: 1,
    swing,
    humanizeVelocity: 0,
    seed: 17,
    ...overrides,
  };
}

/** The previous source-order scan, retained here only as an equivalence oracle. */
function linearOracle(
  events: readonly ScheduledEvent[],
  windowStartBeat: number,
  windowEndBeat: number,
  bpm: number,
  anchorBeat: number,
  anchorTime: number,
  loop: LoopRegion | null,
): DueEvent[] {
  if (windowEndBeat <= windowStartBeat) return [];
  const resolved: Array<{ due: DueEvent; sourceOrdinal: number }> = [];

  const append = (
    event: ScheduledEvent,
    sourceOrdinal: number,
    playheadBeat: number,
  ): void => {
    const occurrence = resolveDrumOccurrence(event, playheadBeat);
    if (
      !occurrence ||
      occurrence.beat < windowStartBeat ||
      occurrence.beat >= windowEndBeat
    ) return;
    resolved.push({
      sourceOrdinal,
      due: {
        time: beatToTime(occurrence.beat, bpm, anchorBeat, anchorTime),
        beat: event.beat,
        payload: occurrence.payload,
      },
    });
  };

  events.forEach((event, sourceOrdinal) => {
    if (!loop) {
      append(event, sourceOrdinal, event.beat);
      return;
    }
    if (event.beat < loop.startBeat || event.beat >= loop.endBeat) return;

    const loopLength = loop.endBeat - loop.startBeat;
    for (let pass = 0; event.beat + pass * loopLength < windowEndBeat; pass += 1) {
      append(event, sourceOrdinal, event.beat + pass * loopLength);
    }
  });

  resolved.sort(
    (left, right) =>
      left.due.time - right.due.time || left.sourceOrdinal - right.sourceOrdinal,
  );
  return resolved.map((entry) => entry.due);
}

function seededUnit(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('schedule beat index', () => {
  it('snapshots unsorted input and preserves source order for equal onsets', () => {
    const mutable: ScheduledEvent = { beat: 1, payload: 'source-first' };
    const events: ScheduledEvent[] = [
      mutable,
      {
        beat: 0.875,
        payload: drumPayload('swung-to-one', 1, 1),
      },
      { beat: 0.5, payload: 'earlier' },
    ];
    const index = createScheduleEventIndex(events);
    mutable.beat = 2;

    const due = nextIndexedEventsInWindow(index, 0, 1.5, 120, 0, 0);
    expect(due.map((event) => {
      const payload = event.payload as string | TestDrumPayload;
      return typeof payload === 'string' ? payload : payload.eventId;
    })).toEqual(['earlier', 'source-first', 'swung-to-one']);
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.entries)).toBe(true);
    expect(Object.isFrozen(index.entries[0])).toBe(true);
  });

  it('keeps half-open adjacent windows duplicate- and gap-free after swing', () => {
    const events: ScheduledEvent[] = [
      { beat: 0.625, payload: drumPayload('boundary', 1, 1) },
      { beat: 0.75, payload: 'straight' },
    ];
    const index = createScheduleEventIndex(events);

    expect(nextIndexedEventsInWindow(index, 0, 0.75, 120, 0, 0)).toEqual([]);
    expect(
      nextIndexedEventsInWindow(index, 0.75, 1.5, 120, 0, 0).map((event) => event.beat),
    ).toEqual([0.625, 0.75]);
  });

  it('matches a source-order scan across deterministic randomized windows', () => {
    const random = seededUnit(0xc0ffee);
    const events: ScheduledEvent[] = Array.from({ length: 80 }, (_, index) => {
      const beat = Math.round((random() * 10 - 1) * 1_000) / 1_000;
      if (index % 3 !== 0) return { beat, payload: `note-${index}` };
      return {
        beat,
        payload: drumPayload(`drum-${index}`, index % 16, random(), {
          probability: index % 7 === 0 ? 0 : 0.7,
          humanizeVelocity: 9,
          seed: index + 1,
        }),
      };
    });
    const cases: Array<{ loop: LoopRegion | null; windows: Array<[number, number]> }> = [
      {
        loop: null,
        windows: [[0, 0.75], [0.75, 1.5], [2.31, 4.89], [7.5, 10.25]],
      },
      {
        loop: { startBeat: 2, endBeat: 6 },
        windows: [[0, 2], [1.9, 2.4], [3.95, 6.2], [6.2, 11.75]],
      },
    ];

    for (const testCase of cases) {
      const index = createScheduleEventIndex(events, testCase.loop);
      for (const [startBeat, endBeat] of testCase.windows) {
        expect(
          nextIndexedEventsInWindow(index, startBeat, endBeat, 137, 1.25, 3.5),
        ).toEqual(
          linearOracle(events, startBeat, endBeat, 137, 1.25, 3.5, testCase.loop),
        );
      }
    }
  });

  it('preserves loop-boundary swing, occurrence identity, and equal-time order', () => {
    const loop = { startBeat: 0, endBeat: 0.25 };
    const events: ScheduledEvent[] = [
      { beat: 0.125, payload: drumPayload('delayed', 1, 1) },
      { beat: 0, payload: drumPayload('straight', 0, 0) },
    ];
    const index = createScheduleEventIndex(events, loop);

    const first = nextIndexedEventsInWindow(index, 0, 0.25, 120, 0, 0);
    const second = nextIndexedEventsInWindow(index, 0.25, 0.5, 120, 0, 0);
    expect(first.map((event) => (event.payload as TestDrumPayload).eventId)).toEqual([
      'straight',
    ]);
    expect(second.map((event) => (event.payload as TestDrumPayload).eventId)).toEqual([
      'delayed',
      'straight',
    ]);
    expect(second[0]?.time).toBe(0.125);
    expect(second[1]?.time).toBe(0.125);
    expect(second).toEqual(linearOracle(events, 0.25, 0.5, 120, 0, 0, loop));
  });

  it('handles a deterministic swing delay longer than several loop cycles', () => {
    const loop = { startBeat: 0, endBeat: 0.25 };
    const events: ScheduledEvent[] = [{
      beat: 0.125,
      payload: drumPayload('long-delay', 1, 1, {
        stepsPerBar: 1,
        beatsPerBar: 4,
      }),
    }];
    const index = createScheduleEventIndex(events, loop);

    expect(nextIndexedEventsInWindow(index, 0, 2, 120, 0, 0)).toEqual([]);
    expect(nextIndexedEventsInWindow(index, 2, 2.25, 120, 0, 0)).toEqual(
      linearOracle(events, 2, 2.25, 120, 0, 0, loop),
    );
  });

  it('includes a decimal-loop occurrence exactly at the window start', () => {
    const loop = { startBeat: 0, endBeat: 0.3 };
    const events: ScheduledEvent[] = [{ beat: 0.1, payload: 'decimal-boundary' }];
    const index = createScheduleEventIndex(events, loop);

    const before = nextIndexedEventsInWindow(index, 0.3, 0.4, 120, 0, 0);
    const atBoundary = nextIndexedEventsInWindow(index, 0.4, 0.5, 120, 0, 0);
    expect(before).toEqual([]);
    expect(atBoundary.map((event) => event.payload)).toEqual(['decimal-boundary']);
    expect([...before, ...atBoundary]).toEqual(
      nextIndexedEventsInWindow(index, 0.3, 0.5, 120, 0, 0),
    );

    const laterBoundary = 0.1 + 854 * 0.3;
    expect(
      nextIndexedEventsInWindow(
        index,
        laterBoundary,
        laterBoundary + 0.01,
        120,
        0,
        0,
      ).map((event) => event.payload),
    ).toEqual(['decimal-boundary']);
  });

  it('produces the same occurrences for one whole window and adjacent partitions', () => {
    const loop = { startBeat: 1, endBeat: 3 };
    const events: ScheduledEvent[] = [
      { beat: 1, payload: 'one' },
      { beat: 2.875, payload: drumPayload('wrap', 1, 1) },
      { beat: 4, payload: 'outside' },
    ];
    const index = createScheduleEventIndex(events, loop);
    const whole = nextIndexedEventsInWindow(index, 0, 8, 120, 0, 0);
    const partitions = [0, 0.75, 1.5, 2.25, 3, 4.5, 6, 8].flatMap(
      (startBeat, position, boundaries) => {
        const endBeat = boundaries[position + 1];
        return endBeat === undefined
          ? []
          : nextIndexedEventsInWindow(index, startBeat, endBeat, 120, 0, 0);
      },
    );
    expect(partitions).toEqual(whole);
    expect(whole).toEqual(linearOracle(events, 0, 8, 120, 0, 0, loop));
  });

  it('queries the 20,000-event ceiling with logarithmic search and due-only scans', () => {
    const eventCount = 20_000;
    const burstCount = 256;
    const remaining = eventCount - burstCount;
    const events: ScheduledEvent[] = [
      ...Array.from({ length: burstCount }, (_, index) => ({
        beat: 0,
        payload: `burst-${index}`,
      })),
      ...Array.from({ length: remaining }, (_, index) => ({
        beat: 1 + ((index + 0.5) * 1_023) / remaining,
        payload: `spread-${index}`,
      })),
    ];
    const index = createScheduleEventIndex(events);

    const burst = queryScheduleEventIndex(index, 0, 0.6, 300, 0, 0);
    expect(burst.events).toHaveLength(256);
    expect(burst.stats).toMatchObject({
      sourceEventCount: 20_000,
      indexedEventCount: 20_000,
      candidatesVisited: 256,
      emitted: 256,
    });
    expect(burst.stats.lowerBoundComparisons).toBeLessThanOrEqual(32);

    const silence = queryScheduleEventIndex(index, 0.6, 1, 300, 0, 0);
    expect(silence.events).toEqual([]);
    expect(silence.stats.candidatesVisited).toBe(0);
    expect(silence.stats.emitted).toBe(0);
    expect(silence.stats.lowerBoundComparisons).toBeLessThanOrEqual(32);

    const isolated = queryScheduleEventIndex(index, 400, 400.6, 300, 0, 0);
    expect(isolated.stats.candidatesVisited).toBe(isolated.stats.emitted);
    expect(isolated.stats.candidatesVisited).toBeLessThanOrEqual(13);
    expect(isolated.stats.lowerBoundComparisons).toBeLessThanOrEqual(32);

    let totalCandidates = 0;
    let totalEmitted = 0;
    let totalComparisons = 0;
    let maxCandidates = 0;
    const emittedPayloads = new Set<unknown>();
    const queryCount = Math.ceil(1_024 / 0.6);
    for (let query = 0; query < queryCount; query += 1) {
      const startBeat = query * 0.6;
      const endBeat = Math.min(1_024, (query + 1) * 0.6);
      const result = queryScheduleEventIndex(index, startBeat, endBeat, 300, 0, 0);
      totalCandidates += result.stats.candidatesVisited;
      totalEmitted += result.stats.emitted;
      totalComparisons += result.stats.lowerBoundComparisons;
      maxCandidates = Math.max(maxCandidates, result.stats.candidatesVisited);
      result.events.forEach((event) => emittedPayloads.add(event.payload));
    }

    expect(totalCandidates).toBe(20_000);
    expect(totalEmitted).toBe(20_000);
    expect(emittedPayloads.size).toBe(20_000);
    expect(maxCandidates).toBe(256);
    expect(totalComparisons).toBeLessThanOrEqual(54_624);
    expect(totalComparisons + totalCandidates).toBeLessThanOrEqual(74_624);
  });

  it('builds the source index once at Scheduler.start instead of every tick', () => {
    vi.useFakeTimers();
    let beatReads = 0;
    let now = 0;
    const fired: unknown[] = [];
    const source = {
      get beat() {
        beatReads += 1;
        return 1;
      },
      payload: 'indexed-once',
    } satisfies ScheduledEvent;
    const scheduler = new Scheduler({
      clock: () => now,
      fire: (events) => fired.push(...events.map((event) => event.payload)),
      tickMs: 25,
      lookaheadS: 0.12,
    });

    try {
      scheduler.start([source], 120, 0, null, 4);
      expect(beatReads).toBe(1);
      now = 0.5;
      vi.advanceTimersByTime(25);
      expect(fired).toEqual(['indexed-once']);
      expect(beatReads).toBe(1);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('rejects loop-expanded density at the exact 0.25-beat boundary', () => {
    const loop = { startBeat: 0, endBeat: 0.25 };
    const eventsAtZero = (count: number): ScheduledEvent[] =>
      Array.from({ length: count }, (_, index) => ({
        beat: 0,
        payload: `loop-density-${index}`,
      }));

    expect(
      preflightLoopScheduleDensity(
        createScheduleEventIndex(eventsAtZero(85), loop),
        0.75,
        256,
      ),
    ).toEqual({ ok: true, observed: 255, limit: 256 });
    expect(
      preflightLoopScheduleDensity(
        createScheduleEventIndex(eventsAtZero(86), loop),
        0.75,
        256,
      ),
    ).toEqual({
      ok: false,
      observed: 258,
      limit: 256,
      windowStartBeat: 0,
    });
  });

  it('keeps loop density half-open and ignores permanently clipped swing hits', () => {
    const halfOpen = createScheduleEventIndex([
      { beat: 0, payload: 'start' },
      { beat: 0.75, payload: 'next-window' },
    ], { startBeat: 0, endBeat: 2 });
    expect(preflightLoopScheduleDensity(halfOpen, 0.75, 1)).toEqual({
      ok: true,
      observed: 1,
      limit: 1,
    });

    const clipped = createScheduleEventIndex(Array.from({ length: 300 }, (_, index) => ({
      beat: 0.125,
      payload: drumPayload(`clipped-${index}`, 1, 1, { clipEndBeat: 0.2 }),
    })), { startBeat: 0, endBeat: 0.25 });
    expect(preflightLoopScheduleDensity(clipped, 0.75, 256)).toEqual({
      ok: true,
      observed: 0,
      limit: 256,
    });
  });
});
