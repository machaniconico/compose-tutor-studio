import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDrumSwingToBeat,
  humanizeDrumVelocity,
  makeDrumGrooveStepKey,
  nextEventsInWindow,
  resolveDrumGrooveHit,
  setDrumGrooveRuntimeOptions,
  shouldPlayDrumStep,
  type ScheduledEvent,
} from '../src/audio/scheduler';

function resetRuntimeGroove(): void {
  setDrumGrooveRuntimeOptions({
    swing: 0,
    probability: 1,
    humanizeVelocity: 0,
    seed: 1,
    stepsPerBar: 16,
    beatsPerBar: 4,
    probabilitiesByStep: {},
  });
}

afterEach(() => {
  resetRuntimeGroove();
});

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

describe('nextEventsInWindow drum groove runtime', () => {
  it('applies swing to drum payloads without changing the source beat', () => {
    setDrumGrooveRuntimeOptions({
      swing: 1,
      probability: 1,
      humanizeVelocity: 0,
      seed: 1,
      stepsPerBar: 16,
      beatsPerBar: 4,
      probabilitiesByStep: {},
    });
    const events: ScheduledEvent[] = [
      { beat: 0.25, payload: { kind: 'drum', trackId: 'drums', lane: 'kick', velocity: 100 } },
    ];

    const due = nextEventsInWindow(events, 0, 1, 120, 0, 0, null);

    expect(due).toHaveLength(1);
    expect(due[0]?.beat).toBeCloseTo(0.25, 10);
    expect(due[0]?.time).toBeCloseTo(0.1875, 10);
  });

  it('uses per-step probability map entries deterministically', () => {
    setDrumGrooveRuntimeOptions({
      swing: 0,
      probability: 1,
      humanizeVelocity: 0,
      seed: 1,
      stepsPerBar: 16,
      beatsPerBar: 4,
      probabilitiesByStep: {
        [makeDrumGrooveStepKey('kick', 0)]: 0,
      },
    });
    const events: ScheduledEvent[] = [
      { beat: 0, payload: { kind: 'drum', trackId: 'drums', lane: 'kick', velocity: 100 } },
      { beat: 0.5, payload: { kind: 'drum', trackId: 'drums', lane: 'snare', velocity: 100 } },
    ];

    const due = nextEventsInWindow(events, 0, 1, 120, 0, 0, null);

    expect(due.map((event) => (event.payload as { lane: string }).lane)).toEqual(['snare']);
  });
});
