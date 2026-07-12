import { describe, expect, it } from 'vitest';
import {
  applyDrumSwingToBeat,
  applyDrumSwingToOccurrenceBeat,
  humanizeDrumVelocity,
  nextEventsInWindow,
  resolveDrumOccurrence,
  resolveDrumGrooveHit,
  shouldPlayDrumStep,
  type ScheduledEvent,
} from '../src/audio/scheduler';

function rawDrumEvent(
  payload: Partial<Record<string, string | number>> = {},
  beat = 0.25,
): ScheduledEvent {
  return {
    beat,
    payload: {
      kind: 'drum',
      trackId: 'drums',
      clipId: 'clip-a',
      eventId: 'event-a',
      lane: 'kick',
      velocity: 100,
      sourceStepIndex: 1,
      clipEndBeat: 4,
      stepsPerBar: 16,
      beatsPerBar: 4,
      probability: 1,
      swing: 0,
      humanizeVelocity: 0,
      seed: 1,
      ...payload,
    },
  };
}

describe('applyDrumSwingToBeat', () => {
  it('moves back-side 16th notes later as swing increases', () => {
    expect(applyDrumSwingToBeat(0, 1, 16, 4)).toBeCloseTo(0, 10);
    expect(applyDrumSwingToBeat(0.25, 1, 16, 4)).toBeCloseTo(0.375, 10);
    expect(applyDrumSwingToBeat(0.5, 1, 16, 4)).toBeCloseTo(0.5, 10);
    expect(applyDrumSwingToBeat(0.75, 0.5, 16, 4)).toBeCloseTo(0.8125, 10);
  });

  it('is neutral when swing is zero', () => {
    expect(applyDrumSwingToBeat(0.25, 0, 16, 4)).toBeCloseTo(0.25, 10);
  });
});

describe('applyDrumSwingToOccurrenceBeat', () => {
  it('uses source step parity rather than the absolute project grid', () => {
    expect(applyDrumSwingToOccurrenceBeat(0.25, 0, 1, 16, 4)).toBe(0.25);
    expect(applyDrumSwingToOccurrenceBeat(0.5, 1, 1, 16, 4)).toBe(0.625);
  });
});

describe('shouldPlayDrumStep', () => {
  it('uses probability edges exactly', () => {
    expect(shouldPlayDrumStep(0, 123, 'kick:0')).toBe(false);
    expect(shouldPlayDrumStep(1, 123, 'kick:0')).toBe(true);
  });

  it('is deterministic for the same seed and step key', () => {
    const first = shouldPlayDrumStep(0.5, 77, 'snare:1');
    const second = shouldPlayDrumStep(0.5, 77, 'snare:1');
    expect(second).toBe(first);
  });
});

describe('humanizeDrumVelocity', () => {
  it('keeps velocity inside the requested plus/minus range', () => {
    const velocity = humanizeDrumVelocity(80, 12, 99, 'closedHat:3');
    expect(velocity).toBeGreaterThanOrEqual(68);
    expect(velocity).toBeLessThanOrEqual(92);
  });

  it('is deterministic for the same seed and step key', () => {
    const first = humanizeDrumVelocity(80, 12, 99, 'closedHat:3');
    const second = humanizeDrumVelocity(80, 12, 99, 'closedHat:3');
    expect(second).toBe(first);
  });

  it('is neutral when the amount is zero', () => {
    expect(humanizeDrumVelocity(80, 0, 99, 'closedHat:3')).toBe(80);
  });
});

describe('resolveDrumGrooveHit', () => {
  it('combines probability, swing, and velocity humanize as a pure operation', () => {
    const hit = resolveDrumGrooveHit({
      beat: 0.25,
      lane: 'kick',
      velocity: 100,
      probability: 1,
      swing: 1,
      humanizeVelocity: 0,
      seed: 42,
      stepKey: 'kick:0.25',
      stepsPerBar: 16,
      beatsPerBar: 4,
    });

    expect(hit).toEqual({ beat: 0.375, velocity: 100 });
  });

  it('drops the hit when probability fails', () => {
    expect(
      resolveDrumGrooveHit({
        beat: 0.25,
        lane: 'kick',
        velocity: 100,
        probability: 0,
        seed: 42,
      }),
    ).toBeNull();
  });
});

describe('nextEventsInWindow persisted drum groove', () => {
  it('selects by resolved onset across adjacent half-open windows', () => {
    const event = rawDrumEvent({ swing: 1 });

    expect(nextEventsInWindow([event], 0, 0.3, 120, 0, 0, null)).toEqual([]);
    const due = nextEventsInWindow([event], 0.3, 0.4, 120, 0, 0, null);
    expect(nextEventsInWindow([event], 0.4, 0.5, 120, 0, 0, null)).toEqual([]);

    expect(due).toHaveLength(1);
    expect(due[0]?.beat).toBeCloseTo(0.25, 10);
    expect(due[0]?.time).toBeCloseTo(0.1875, 10);
  });

  it('keeps step 0 straight and swings step 1 for a nonzero clip start', () => {
    const step0 = rawDrumEvent({ eventId: 'step-0', sourceStepIndex: 0, swing: 1 }, 0.25);
    const step1 = rawDrumEvent({ eventId: 'step-1', sourceStepIndex: 1, swing: 1 }, 0.5);

    const due = nextEventsInWindow([step0, step1], 0, 1, 120, 0, 0, null);

    expect(due.map((event) => event.time)).toEqual([0.125, 0.3125]);
  });

  it('honors a saved zero probability without any mounted drum editor', () => {
    expect(nextEventsInWindow(
      [rawDrumEvent({ probability: 0 })],
      0,
      1,
      120,
      0,
      0,
      null,
    )).toEqual([]);
  });

  it('drops a swing-delayed onset at or beyond its translated clip end', () => {
    const midProject = rawDrumEvent(
      { clipId: 'mid', eventId: 'mid-final', clipEndBeat: 2, swing: 1 },
      1.95,
    );
    const projectEnd = rawDrumEvent(
      { clipId: 'end', eventId: 'song-final', clipEndBeat: 4, swing: 1 },
      3.95,
    );

    expect(resolveDrumOccurrence(midProject)).toBeNull();
    expect(resolveDrumOccurrence(projectEnd)).toBeNull();
    expect(nextEventsInWindow([midProject, projectEnd], 0, 5, 120, 0, 0, null)).toEqual([]);
  });

  it('salts humanization by identity and stays deterministic', () => {
    const identities = Array.from({ length: 8 }, (_, index) =>
      rawDrumEvent({
        clipId: `clip-${index % 2}`,
        eventId: `event-${index}`,
        velocity: 64,
        humanizeVelocity: 127,
        seed: 99,
        swing: 0,
      }));
    const resolve = () => identities.map((event) => {
      const occurrence = resolveDrumOccurrence(event);
      return (occurrence?.payload as { velocity: number } | undefined)?.velocity;
    });

    const first = resolve();
    expect(resolve()).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(first.some((velocity) => Math.abs((velocity ?? 64) - 64) > 32)).toBe(true);
  });

  it('derives a stable 32-bit voice seed from every persisted identity field', () => {
    const event = rawDrumEvent({ seed: 99 });
    const resolveVoiceSeed = (
      candidate: ScheduledEvent,
      playheadBeat = candidate.beat,
    ): number =>
      (resolveDrumOccurrence(candidate, playheadBeat)?.payload as { voiceSeed: number })
        .voiceSeed;
    const voiceSeed = resolveVoiceSeed(event);

    expect(Number.isInteger(voiceSeed)).toBe(true);
    expect(voiceSeed).toBeGreaterThanOrEqual(0);
    expect(voiceSeed).toBeLessThanOrEqual(0xffff_ffff);
    expect(resolveVoiceSeed(event)).toBe(voiceSeed);

    const variants = [
      resolveVoiceSeed(rawDrumEvent({ trackId: 'drums-b', seed: 99 })),
      resolveVoiceSeed(rawDrumEvent({ clipId: 'clip-b', seed: 99 })),
      resolveVoiceSeed(rawDrumEvent({ eventId: 'event-b', seed: 99 })),
      resolveVoiceSeed(rawDrumEvent({ lane: 'snare', seed: 99 })),
      resolveVoiceSeed(rawDrumEvent({ sourceStepIndex: 2, seed: 99 })),
      resolveVoiceSeed(rawDrumEvent({ seed: 100 })),
      resolveVoiceSeed(event, 4.25),
    ];
    expect(variants.every((candidate) => candidate !== voiceSeed)).toBe(true);
    expect(new Set([voiceSeed, ...variants]).size).toBe(8);
  });

  it('varies transport-loop passes by playhead occurrence but repeats the sequence', () => {
    const event = rawDrumEvent({
      clipId: 'loop-clip',
      eventId: 'loop-event',
      velocity: 64,
      probability: 1,
      humanizeVelocity: 127,
      seed: 99,
      swing: 0,
    });
    const resolve = () => nextEventsInWindow(
      [event],
      0,
      12,
      120,
      0,
      0,
      { startBeat: 0, endBeat: 4 },
    ).map((occurrence) => {
      const payload = occurrence.payload as { velocity: number; voiceSeed: number };
      return { velocity: payload.velocity, voiceSeed: payload.voiceSeed };
    });

    const first = resolve();
    expect(resolve()).toEqual(first);
    expect(first).toHaveLength(3);
    expect(new Set(first.map(({ velocity }) => velocity)).size).toBeGreaterThan(1);
    expect(new Set(first.map(({ voiceSeed }) => voiceSeed)).size).toBe(3);
  });

  it('keeps loop voice seeds identical across whole and partitioned scheduler windows', () => {
    const event = rawDrumEvent({
      clipId: 'loop-clip',
      eventId: 'loop-event',
      probability: 1,
      seed: 99,
      swing: 0,
    });
    const loop = { startBeat: 0, endBeat: 4 };
    const seeds = (startBeat: number, endBeat: number) =>
      nextEventsInWindow([event], startBeat, endBeat, 120, 0, 0, loop)
        .map((occurrence) =>
          (occurrence.payload as { voiceSeed: number }).voiceSeed);

    const whole = seeds(0, 12);
    const partitioned = [
      ...seeds(0, 4),
      ...seeds(4, 8),
      ...seeds(8, 12),
    ];

    expect(whole).toHaveLength(3);
    expect(partitioned).toEqual(whole);
  });

  it('keeps legacy drum payloads straight and unconditional', () => {
    const legacy: ScheduledEvent = {
      beat: 0.25,
      payload: { kind: 'drum', trackId: 'legacy', lane: 'kick', velocity: 100 },
    };

    const first = nextEventsInWindow([legacy], 0, 1, 120, 0, 0, null);
    const second = nextEventsInWindow([legacy], 0, 1, 120, 0, 0, null);

    expect(second).toEqual(first);
    expect(first).toEqual([
      {
        time: 0.125,
        beat: 0.25,
        payload: {
          ...legacy.payload as Record<string, unknown>,
          voiceSeed: expect.any(Number),
        },
      },
    ]);
  });
});
