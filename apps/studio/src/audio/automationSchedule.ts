import { afterAutomationBeat, AUTOMATION_PARAMETER_INFO, evaluateAutomation, type AutomationLane } from '@cts/project-model';
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

export type ParamTarget =
  | { kind: 'pan'; mixerPan: number }
  | { kind: 'cutoff'; baseHz: number; sampleRate: number };

type ScheduleOptions = Partial<Pick<AutomationPlayback, 'startTime' | 'endBeat'>> & {
  /** Start with the initial (possibly partial) pass, or a later full pass. */
  firstPass?: number;
  passes?: number;
  target?: ParamTarget;
};

export const MAX_AUTOMATION_EVENTS = 32_768;
export const AUTOMATION_EVENTS_PER_SECOND = 500;
const MIN_AUTOMATION_PASS_SECONDS = 0.005;
const MAX_PASSES_PER_SCHEDULE = 256;
const CENTS_PER_OCTAVE = 1200;

/** The shared audio-clock position of a repeat, relative to the original playback beat. */
export function automationLoopOffset(startBeat: number, loop: LoopRegion, pass: number): number {
  const start = startBeat >= loop.endBeat ? wrapBeat(startBeat, loop) : startBeat;
  return (loop.endBeat - start) + (pass - 1) * (loop.endBeat - loop.startBeat);
}

/**
 * Builds a bounded batch of AudioParam events. Curves are on the continuous
 * arranger timeline. Notes already have swing applied before beatToTime.
 * The ramp reaches the value at the loop end before the set at that same
 * time resets the parameter. A one-shot range holds its end value during the tail.
 */
export function buildParamSchedule(
  lane: AutomationLane | undefined,
  startBeat: number,
  loop: LoopRegion | null,
  bpm: number,
  options: ScheduleOptions = {},
): ParamEvent[] {
  if (!lane?.points.length) return [];
  const { startTime = 0, endBeat = Infinity, firstPass = 0, passes = 2, target } = options;
  if (!Number.isFinite(startBeat) || !Number.isFinite(startTime) || startTime < 0) return [];
  const region = isValidLoop(loop) && Number.isFinite(loop.startBeat) && Number.isFinite(loop.endBeat) ? loop : null;
  if (region && (!Number.isSafeInteger(firstPass) || firstPass < 0 || !Number.isSafeInteger(passes)
    || passes < 1 || passes > MAX_PASSES_PER_SCHEDULE || !Number.isSafeInteger(firstPass + passes))) {
    throw new RangeError('音の変化を一度に再生できる周回数を超えました。');
  }

  const evaluate = (beat: number) => evaluateAutomation(lane, beat, target?.kind);
  const mixerPan = target?.kind === 'pan' && Number.isFinite(target.mixerPan) ? target.mixerPan : 0;
  const cutoff = AUTOMATION_PARAMETER_INFO.cutoff;
  const minMultiplier = target?.kind === 'cutoff' ? Math.max(cutoff.min, 20 / target.baseHz) : cutoff.min;
  // Preserve a neutral lane even at unusually low sample rates where the
  // unmodified preset is already above the automation ceiling.
  const maxMultiplier = target?.kind === 'cutoff'
    ? Math.min(cutoff.max, Math.max(1, 0.45 * target.sampleRate / target.baseHz))
    : cutoff.max;
  const scale = target?.kind === 'cutoff' ? Math.log2 : (value: number) => value;
  const clampPoints = target?.kind === 'pan' ? [-1 - mixerPan, 1 - mixerPan]
    : target?.kind === 'cutoff' ? [scale(minMultiplier), scale(maxMultiplier)] : [];
  const valueAt = (beat: number) => {
    const value = evaluate(beat);
    if (target?.kind === 'pan') return Number.isFinite(value) ? Math.min(1, Math.max(-1, value + mixerPan)) : 0;
    if (target?.kind === 'cutoff') {
      const multiplier = Number.isNaN(value) ? cutoff.neutral : value;
      return CENTS_PER_OCTAVE * Math.log2(Math.min(maxMultiplier, Math.max(minMultiplier, multiplier)));
    }
    return value;
  };
  const events: ParamEvent[] = [];
  const emit = (method: ParamEvent['method'], beat: number, elapsedBeats: number) => {
    const time = beatToTime(elapsedBeats, bpm, 0, startTime);
    if (!Number.isFinite(time)) return;
    if (events.length === MAX_AUTOMATION_EVENTS) throw new RangeError('音の変化を一度に再生できる点の数を超えました。');
    events.push({
      method,
      value: valueAt(beat),
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
    let previousBeat = from;
    let previous = target ? scale(evaluate(from)) : 0;
    const addClampCrossings = (beat: number) => {
      if (!target) return;
      const next = scale(evaluate(beat));
      // A ramp to an already clamped endpoint would reach the limit too
      // late. When the budget allows, anchor the flat part at the crossing.
      for (let index = 0; index < clampPoints.length; index++) {
        const limit = clampPoints[next >= previous ? index : clampPoints.length - 1 - index]!;
        const ratio = (limit - previous) / (next - previous);
        if (!(ratio > 0 && ratio < 1)) continue;
        const crossing = previousBeat + (beat - previousBeat) * ratio;
        if (crossing > previousBeat && crossing < beat && crossing !== entry) interior.push(crossing);
      }
      previousBeat = beat;
      previous = next;
    };
    for (let index = afterAutomationBeat(points, from); index < points.length;) {
      const beat = points[index]!.beat;
      if (beat >= to) break;
      addClampCrossings(beat);
      if (beat !== entry) interior.push(beat);
      // Check at most one distinct point beyond the budget. Binary search
      // skips any number of duplicate points at a beat.
      if (interior.length > interiorBudget) break;
      index = afterAutomationBeat(points, beat);
    }
    if (interior.length <= interiorBudget) addClampCrossings(to);

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
