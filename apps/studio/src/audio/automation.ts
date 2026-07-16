import type {
  AutomationLane,
  AutomationPoint,
  AutomationTarget,
  Track,
} from '@cts/project-model';
import type { LoopRegion } from './scheduler';

export type AutomationCommand = Readonly<{
  beat: number;
  value: number;
  interpolation: 'hold' | 'linear';
}>;

function lastPointAtOrBefore(
  points: readonly AutomationPoint[],
  beat: number,
): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((points[middle]?.beat ?? Number.POSITIVE_INFINITY) <= beat) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

/** Evaluate a lane; before its first point the persisted Track scalar is used. */
export function automationValueAt(
  lane: AutomationLane,
  baseValue: number,
  beat: number,
): number {
  const previousIndex = lastPointAtOrBefore(lane.points, beat);
  if (previousIndex < 0) return baseValue;
  const previous = lane.points[previousIndex];
  if (!previous) return baseValue;
  const next = lane.points[previousIndex + 1];
  if (
    previous.interpolation !== 'linear' ||
    !next ||
    !(next.beat > previous.beat)
  ) {
    return previous.value;
  }
  const progress = Math.min(
    1,
    Math.max(0, (beat - previous.beat) / (next.beat - previous.beat)),
  );
  return previous.value + (next.value - previous.value) * progress;
}

function commandsOnce(
  lane: AutomationLane,
  baseValue: number,
  startBeat: number,
  endBeat: number,
  includeEnd: boolean,
  tempoChangeBeats: readonly number[],
): AutomationCommand[] {
  if (!(endBeat > startBeat)) return [];
  const commands: AutomationCommand[] = [{
    beat: startBeat,
    value: automationValueAt(lane, baseValue, startBeat),
    interpolation: 'hold',
  }];
  const commandBeats = new Set([startBeat]);

  for (const point of lane.points) {
    if (
      point.beat <= startBeat
      || point.beat > endBeat
      || (!includeEnd && point.beat === endBeat)
    ) continue;
    const previousIndex = lastPointAtOrBefore(lane.points, point.beat) - 1;
    const previous = previousIndex >= 0 ? lane.points[previousIndex] : undefined;
    commands.push({
      beat: point.beat,
      value: point.value,
      interpolation: previous?.interpolation === 'linear' ? 'linear' : 'hold',
    });
    commandBeats.add(point.beat);
  }

  // AudioParam linear ramps are linear in seconds, while persisted automation
  // is linear in beats. Splitting every linear segment at a tempo change makes
  // those two curves equivalent inside each constant-tempo interval.
  for (const beat of tempoChangeBeats) {
    if (beat <= startBeat || beat > endBeat || commandBeats.has(beat)) continue;
    const previousIndex = lastPointAtOrBefore(lane.points, beat);
    const exactPoint = previousIndex >= 0 && lane.points[previousIndex]?.beat === beat;
    const intervalPoint = exactPoint
      ? lane.points[previousIndex - 1]
      : lane.points[previousIndex];
    if (intervalPoint?.interpolation !== 'linear') continue;
    commands.push({
      beat,
      value: automationValueAt(lane, baseValue, beat),
      interpolation: 'linear',
    });
    commandBeats.add(beat);
  }

  const previousIndex = lastPointAtOrBefore(lane.points, endBeat);
  const exactEndPoint = previousIndex >= 0 && lane.points[previousIndex]?.beat === endBeat;
  const intervalPoint = exactEndPoint
    ? lane.points[previousIndex - 1]
    : lane.points[previousIndex];
  if (
    (!exactEndPoint || !includeEnd)
    && intervalPoint?.interpolation === 'linear'
    && !commandBeats.has(endBeat)
  ) {
    commands.push({
      beat: endBeat,
      value: automationValueAt(lane, baseValue, endBeat),
      interpolation: 'linear',
    });
  }
  return commands.sort((left, right) => left.beat - right.beat);
}

/** Build sample-accurate commands for a lookahead window, repeating inside a loop. */
export function automationCommandsInWindow(
  lane: AutomationLane,
  baseValue: number,
  startBeat: number,
  endBeat: number,
  loop: LoopRegion | null = null,
  includeEnd = false,
  tempoChangeBeats: readonly number[] = [],
): AutomationCommand[] {
  if (!(endBeat > startBeat)) return [];
  if (!loop || !(loop.endBeat > loop.startBeat)) {
    return commandsOnce(
      lane,
      baseValue,
      startBeat,
      endBeat,
      includeEnd,
      tempoChangeBeats,
    );
  }

  const commands: AutomationCommand[] = [];
  if (startBeat < loop.startBeat) {
    commands.push(...commandsOnce(
      lane,
      baseValue,
      startBeat,
      Math.min(endBeat, loop.startBeat),
      false,
      tempoChangeBeats,
    ));
  }
  if (endBeat <= loop.startBeat) return commands;

  const loopLength = loop.endBeat - loop.startBeat;
  const firstCycle = Math.floor(
    (Math.max(startBeat, loop.startBeat) - loop.startBeat) / loopLength,
  );
  const endCycle = Math.ceil((endBeat - loop.startBeat) / loopLength);
  for (let cycle = firstCycle; cycle < endCycle; cycle += 1) {
    const offset = cycle * loopLength;
    const sourceStart = Math.max(loop.startBeat, startBeat - offset);
    const sourceEnd = Math.min(loop.endBeat, endBeat - offset);
    for (const command of commandsOnce(
      lane,
      baseValue,
      sourceStart,
      sourceEnd,
      false,
      tempoChangeBeats,
    )) {
      commands.push({ ...command, beat: command.beat + offset });
    }
  }
  return commands;
}

export function automationBaseValue(track: Track, target: AutomationTarget): number {
  return target.type === 'track-volume' ? track.volume : track.pan;
}

/** At most one lane per target is accepted by schema validation. */
export function automationLaneForTrack(
  lanes: readonly AutomationLane[],
  trackId: string,
  type: AutomationTarget['type'],
): AutomationLane | null {
  return lanes.find((lane) => lane.target.trackId === trackId && lane.target.type === type)
    ?? null;
}
