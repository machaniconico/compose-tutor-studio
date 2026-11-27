import type {
  AutomationLane,
  AutomationPoint,
  AutomationReadState,
  AutomationTarget,
  Project,
  Track,
} from '@cts/project-model';
import { beatToTime, timeToBeat, type LoopRegion, type TempoSource } from './scheduler';

export type AutomationCommand = Readonly<{
  beat: number;
  value: number;
  interpolation: 'hold' | 'linear';
}>;

/** One shared precedence resolver for live and offline rendering. */
export function isAutomationReadEnabled(
  readState: AutomationReadState,
  lane: AutomationLane,
): boolean {
  return readState.globalEnabled
    && !readState.disabledTrackIds.includes(lane.target.trackId)
    && !lane.bypassed;
}

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

  const firstIndex = lastPointAtOrBefore(lane.points, startBeat) + 1;
  for (let index = firstIndex; index < lane.points.length; index += 1) {
    const point = lane.points[index]!;
    if (point.beat > endBeat || (!includeEnd && point.beat === endBeat)) break;
    const previous = lane.points[index - 1];
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
  if (lane.bypassed) return [];
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
  switch (target.type) {
    case 'track-volume': return track.volume;
    case 'track-pan': return track.pan;
    case 'track-filter-cutoff': return 0;
  }
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

/** Only tracks with an audible cutoff change need to schedule filter detune. */
export function activeFilterCutoffLanes(
  project: Project,
): ReadonlyMap<string, AutomationLane> {
  return new Map(project.automationLanes
    .filter((lane) =>
      lane.target.type === 'track-filter-cutoff'
      && isAutomationReadEnabled(project.automationReadState, lane)
      && lane.points.some((point) => point.value !== 0),
    )
    .map((lane) => [lane.target.trackId, lane]));
}

/** Schedule the stored octave curve over one synth voice, including its release. */
export function scheduleFilterCutoff(
  detune: AudioParam,
  lane: AutomationLane,
  startBeat: number,
  startTime: number,
  stopTime: number,
  tempo: TempoSource,
  lengthBeats: number,
  loop: LoopRegion | null,
  tempoChangeBeats: readonly number[],
): void {
  const endBeat = Math.min(
    timeToBeat(stopTime, tempo, startBeat, startTime),
    loop ? Infinity : lengthBeats,
  );
  for (const command of automationCommandsInWindow(
    lane, 0, startBeat, endBeat, loop, loop === null, tempoChangeBeats,
  )) {
    const time = beatToTime(command.beat, tempo, startBeat, startTime);
    const cents = command.value * 1200;
    if (command.interpolation === 'linear') detune.linearRampToValueAtTime(cents, time);
    else detune.setValueAtTime(cents, time);
  }
}
