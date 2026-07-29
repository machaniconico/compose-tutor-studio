import {
  beatToSecondsAt,
  compileMusicalTime,
  type AutomationLane,
} from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import {
  automationCommandsInWindow,
  automationValueAt,
} from '../src/audio/automation';

const lane: AutomationLane = {
  id: 'automation-volume',
  bypassed: false,
  target: { type: 'track-volume', trackId: 'track-1' },
  points: [
    { id: 'point-1', beat: 2, value: 0.5, interpolation: 'linear' },
    { id: 'point-2', beat: 4, value: 1.5, interpolation: 'hold' },
    { id: 'point-3', beat: 6, value: 0.25, interpolation: 'hold' },
  ],
};

const linearLane: AutomationLane = {
  id: 'automation-linear',
  bypassed: false,
  target: { type: 'track-volume', trackId: 'track-1' },
  points: [
    { id: 'linear-start', beat: 0, value: 0, interpolation: 'linear' },
    { id: 'linear-end', beat: 8, value: 1, interpolation: 'hold' },
  ],
};

type TimedCommand = Readonly<{
  time: number;
  value: number;
  interpolation: 'hold' | 'linear';
}>;

function valueAtTime(commands: readonly TimedCommand[], time: number): number {
  let previous = commands[0];
  if (!previous) throw new Error('at least one command is required');
  for (const command of commands.slice(1)) {
    if (time < command.time) {
      if (command.interpolation !== 'linear' || command.time === previous.time) {
        return previous.value;
      }
      const progress = (time - previous.time) / (command.time - previous.time);
      return previous.value + (command.value - previous.value) * progress;
    }
    previous = command;
  }
  return previous.value;
}

describe('track automation planning', () => {
  it('keeps the stored curve editable but schedules nothing while bypassed', () => {
    const bypassed = { ...linearLane, bypassed: true };

    expect(automationValueAt(bypassed, 0.8, 4)).toBe(0.5);
    expect(automationCommandsInWindow(
      bypassed,
      0.8,
      0,
      8,
      null,
      true,
      [4],
    )).toEqual([]);
    expect(automationCommandsInWindow(
      bypassed,
      0.8,
      4,
      12,
      { startBeat: 4, endBeat: 8 },
      false,
      [6],
    )).toEqual([]);

    expect(automationCommandsInWindow(
      { ...bypassed, bypassed: false },
      0.8,
      0,
      8,
      null,
      true,
      [4],
    )).toEqual(automationCommandsInWindow(
      linearLane,
      0.8,
      0,
      8,
      null,
      true,
      [4],
    ));
  });

  it('uses the Track scalar before the first point and interpolates after it', () => {
    expect(automationValueAt(lane, 0.8, 1)).toBe(0.8);
    expect(automationValueAt(lane, 0.8, 2)).toBe(0.5);
    expect(automationValueAt(lane, 0.8, 3)).toBe(1);
    expect(automationValueAt(lane, 0.8, 5)).toBe(1.5);
  });

  it('continues a linear segment sample-accurately across lookahead windows', () => {
    expect(automationCommandsInWindow(lane, 0.8, 2.5, 3.5)).toEqual([
      { beat: 2.5, value: 0.75, interpolation: 'hold' },
      { beat: 3.5, value: 1.25, interpolation: 'linear' },
    ]);
  });

  it('uses the preceding point to choose the transition into a point', () => {
    expect(automationCommandsInWindow(lane, 0.8, 1, 5)).toEqual([
      { beat: 1, value: 0.8, interpolation: 'hold' },
      { beat: 2, value: 0.5, interpolation: 'hold' },
      { beat: 4, value: 1.5, interpolation: 'linear' },
    ]);
  });

  it('repeats and resets the lane at each loop boundary', () => {
    expect(automationCommandsInWindow(
      lane,
      0.8,
      4,
      12,
      { startBeat: 4, endBeat: 8 },
    )).toEqual([
      { beat: 4, value: 1.5, interpolation: 'hold' },
      { beat: 6, value: 0.25, interpolation: 'hold' },
      { beat: 8, value: 1.5, interpolation: 'hold' },
      { beat: 10, value: 0.25, interpolation: 'hold' },
    ]);
  });

  it('includes a hold point at the project end when scheduling the release tail', () => {
    const endingLane: AutomationLane = {
      ...lane,
      points: [
        { id: 'end', beat: 8, value: 0, interpolation: 'hold' },
      ],
    };

    expect(automationCommandsInWindow(
      endingLane,
      0.8,
      0,
      8,
      null,
      true,
    )).toEqual([
      { beat: 0, value: 0.8, interpolation: 'hold' },
      { beat: 8, value: 0, interpolation: 'hold' },
    ]);
    expect(automationCommandsInWindow(endingLane, 0.8, 0, 8)).toEqual([
      { beat: 0, value: 0.8, interpolation: 'hold' },
    ]);
  });

  it('splits beat-linear ramps at tempo changes for whole-song rendering', () => {
    expect(automationCommandsInWindow(
      linearLane,
      0.8,
      0,
      8,
      null,
      true,
      [4],
    )).toEqual([
      { beat: 0, value: 0, interpolation: 'hold' },
      { beat: 4, value: 0.5, interpolation: 'linear' },
      { beat: 8, value: 1, interpolation: 'linear' },
    ]);
  });

  it('does not add tempo commands to fixed-tempo or hold segments', () => {
    expect(automationCommandsInWindow(linearLane, 0.8, 0, 8, null, true)).toEqual([
      { beat: 0, value: 0, interpolation: 'hold' },
      { beat: 8, value: 1, interpolation: 'linear' },
    ]);

    const holdLane: AutomationLane = {
      ...linearLane,
      points: linearLane.points.map((point) => ({
        ...point,
        interpolation: 'hold',
      })),
    };
    expect(automationCommandsInWindow(
      holdLane,
      0.8,
      0,
      8,
      null,
      true,
      [4],
    )).toEqual([
      { beat: 0, value: 0, interpolation: 'hold' },
      { beat: 8, value: 1, interpolation: 'hold' },
    ]);
  });

  it('orders tempo changes and deduplicates a lane point at a window endpoint', () => {
    const pointAtTempoChange: AutomationLane = {
      ...linearLane,
      points: [
        linearLane.points[0]!,
        { id: 'linear-middle', beat: 4, value: 0.5, interpolation: 'linear' },
        linearLane.points[1]!,
      ],
    };

    expect(automationCommandsInWindow(
      pointAtTempoChange,
      0.8,
      0,
      4,
      null,
      false,
      [4, 2, 4],
    )).toEqual([
      { beat: 0, value: 0, interpolation: 'hold' },
      { beat: 2, value: 0.25, interpolation: 'linear' },
      { beat: 4, value: 0.5, interpolation: 'linear' },
    ]);
  });

  it('repeats tempo splits and preserves the ordered reset at a loop boundary', () => {
    const loopLane: AutomationLane = {
      ...linearLane,
      points: [
        { id: 'loop-start', beat: 4, value: 0, interpolation: 'linear' },
        { id: 'loop-end', beat: 8, value: 1, interpolation: 'hold' },
      ],
    };

    expect(automationCommandsInWindow(
      loopLane,
      0.8,
      4,
      12,
      { startBeat: 4, endBeat: 8 },
      false,
      [6],
    )).toEqual([
      { beat: 4, value: 0, interpolation: 'hold' },
      { beat: 6, value: 0.5, interpolation: 'linear' },
      { beat: 8, value: 1, interpolation: 'linear' },
      { beat: 8, value: 0, interpolation: 'hold' },
      { beat: 10, value: 0.5, interpolation: 'linear' },
      { beat: 12, value: 1, interpolation: 'linear' },
    ]);
  });

  it('keeps lookahead and whole-song AudioParam curves equal across variable tempo', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 8,
      tempoMap: [
        { id: 'tempo-fast', beat: 0, bpm: 120 },
        { id: 'tempo-slow', beat: 4, bpm: 60 },
      ],
      timeSignatureMap: [
        { id: 'signature', beat: 0, numerator: 4, denominator: 4 },
      ],
    });
    const toTimed = (commands: ReturnType<typeof automationCommandsInWindow>) =>
      commands.map((command): TimedCommand => ({
        time: beatToSecondsAt(musicalTime, command.beat),
        value: command.value,
        interpolation: command.interpolation,
      }));
    const offline = toTimed(automationCommandsInWindow(
      linearLane,
      0.8,
      0,
      8,
      null,
      true,
      [4],
    ));
    const live = toTimed([
      ...automationCommandsInWindow(linearLane, 0.8, 0, 3, null, false, [4]),
      ...automationCommandsInWindow(linearLane, 0.8, 3, 5, null, false, [4]),
      ...automationCommandsInWindow(linearLane, 0.8, 5, 8, null, true, [4]),
    ]);

    expect(offline).toEqual([
      { time: 0, value: 0, interpolation: 'hold' },
      { time: 2, value: 0.5, interpolation: 'linear' },
      { time: 6, value: 1, interpolation: 'linear' },
    ]);
    for (const beat of [0, 1, 3, 4, 5, 7, 8]) {
      const time = beatToSecondsAt(musicalTime, beat);
      expect(valueAtTime(live, time)).toBeCloseTo(valueAtTime(offline, time), 10);
      expect(valueAtTime(offline, time)).toBeCloseTo(beat / 8, 10);
    }
  });
});
