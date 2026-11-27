import { afterAutomationBeat, evaluateAutomation, type AutomationLane } from '@cts/project-model';
import { beatToTime, isValidLoop, secondsPerBeat, wrapBeat, type LoopRegion } from './scheduler';

export type ParamEvent = {
  method: 'setValueAtTime' | 'linearRampToValueAtTime';
  value: number;
  time: number;
};

export type AutomationPlayback = {
  bpm: number;
  startBeat: number;
  loop: LoopRegion | null;
  startTime: number;
  endBeat?: number;
};

type ScheduleOptions = Partial<Pick<AutomationPlayback, 'startTime' | 'endBeat'>> & {
  /** Start with the initial (possibly partial) pass, or a later full pass. */
  firstPass?: number;
  passes?: number;
};

export const MAX_AUTOMATION_EVENTS = 32_768;
export const AUTOMATION_EVENTS_PER_SECOND = 500;
const MIN_AUTOMATION_PASS_SECONDS = 0.005;
const MAX_PASSES_PER_SCHEDULE = 256;

/** The shared audio-clock position of a repeat, relative to the original playback beat. */
export function automationLoopOffset(startBeat: number, loop: LoopRegion, pass: number): number {
  const start = startBeat >= loop.endBeat ? wrapBeat(startBeat, loop) : startBeat;
  return (loop.endBeat - start) + (pass - 1) * (loop.endBeat - loop.startBeat);
}

/**
 * Builds a bounded batch of AudioParam events. Curves are on the continuous
 * arranger timeline. Notes already have swing applied before beatToTime.
 * The ramp reaches the value at the loop end before the set at that same
 * time resets the gain. A one-shot range holds its end value during the tail.
 */
export function buildParamSchedule(
  lane: AutomationLane | undefined,
  startBeat: number,
  loop: LoopRegion | null,
  bpm: number,
  options: ScheduleOptions = {},
): ParamEvent[] {
  if (!lane?.points.length) return [];
  const { startTime = 0, endBeat = Infinity, firstPass = 0, passes = 2 } = options;
  if (!Number.isFinite(startBeat) || !Number.isFinite(startTime) || startTime < 0) return [];
  const region = isValidLoop(loop) && Number.isFinite(loop.startBeat) && Number.isFinite(loop.endBeat) ? loop : null;
  if (region && (!Number.isSafeInteger(firstPass) || firstPass < 0 || !Number.isSafeInteger(passes)
    || passes < 1 || passes > MAX_PASSES_PER_SCHEDULE || !Number.isSafeInteger(firstPass + passes))) {
    throw new RangeError('音量の変化を一度に再生できる周回数を超えました。');
  }

  const events: ParamEvent[] = [];
  const emit = (method: ParamEvent['method'], beat: number, elapsedBeats: number) => {
    const time = beatToTime(elapsedBeats, bpm, 0, startTime);
    if (!Number.isFinite(time)) return;
    if (events.length === MAX_AUTOMATION_EVENTS) throw new RangeError('音量の変化を一度に再生できる点の数を超えました。');
    events.push({
      method,
      value: evaluateAutomation(lane, beat),
      time: Math.max(startTime, events.at(-1)?.time ?? startTime, time),
    });
  };

  const segment = (from: number, to: number, offset: number, endOffset: number, entry?: number) => {
    emit('setValueAtTime', from, offset);
    const { points } = lane;
    const seconds = (to - from) * secondsPerBeat(bpm);
    if (seconds < MIN_AUTOMATION_PASS_SECONDS) return;

    const allowance = Math.max(2, Math.floor(AUTOMATION_EVENTS_PER_SECOND * seconds));
    // Reserve the start/end and, on the first pass with a lead-in, the loop
    // entry. The entry ramp ends the lead-in; the set anchors the loop curve.
    const entryEvents = entry === undefined ? 0 : Math.min(2, allowance - 2);
    const interiorBudget = allowance - 2 - entryEvents;
    const interior: number[] = [];
    for (let index = afterAutomationBeat(points, from); index < points.length;) {
      const beat = points[index]!.beat;
      if (beat >= to) break;
      if (beat !== entry) interior.push(beat);
      // Check at most one distinct point beyond the budget. Binary search
      // skips any number of duplicate points at a beat.
      if (interior.length > interiorBudget) break;
      index = afterAutomationBeat(points, beat);
    }

    const elapsed = (beat: number) => Math.min(endOffset, offset + (beat - from));
    const ramp = (beat: number) => emit('linearRampToValueAtTime', beat, elapsed(beat));
    let pendingEntry = entryEvents ? entry : undefined;
    const rampThroughEntry = (beat: number) => {
      if (pendingEntry !== undefined && pendingEntry <= beat) {
        ramp(pendingEntry);
        if (entryEvents === 2) emit('setValueAtTime', pendingEntry, elapsed(pendingEntry));
        const isEntry = beat === pendingEntry;
        pendingEntry = undefined;
        if (isEntry) return;
      }
      ramp(beat);
    };
    if (interior.length > interiorBudget) {
      for (let i = 1; i <= interiorBudget; i++) {
        rampThroughEntry(from + (to - from) * (i / (interiorBudget + 1)));
      }
    } else {
      for (const beat of interior) rampThroughEntry(beat);
    }
    if (pendingEntry !== undefined) rampThroughEntry(pendingEntry);
    emit('linearRampToValueAtTime', to, endOffset);
  };

  if (!region) {
    const end = endBeat === Infinity ? lane.points.at(-1)!.beat : endBeat;
    segment(startBeat, end, 0, end - startBeat);
  } else {
    const start = startBeat >= region.endBeat ? wrapBeat(startBeat, region) : startBeat;
    for (let pass = firstPass; pass < firstPass + passes; pass++) {
      const endOffset = automationLoopOffset(startBeat, region, pass + 1);
      if (pass === 0) {
        segment(start, region.endBeat, 0, endOffset, start < region.startBeat ? region.startBeat : undefined);
      } else {
        segment(region.startBeat, region.endBeat, automationLoopOffset(startBeat, region, pass), endOffset);
      }
    }
  }
  return events;
}
