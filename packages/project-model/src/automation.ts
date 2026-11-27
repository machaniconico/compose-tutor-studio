import type { AutomationLane, AutomationPoint } from './types';

export const MAX_AUTOMATION_POINTS = 10_000;

/** Index after the last point at or before beat. Equal beats use the last saved point. */
export function afterAutomationBeat(points: readonly AutomationPoint[], beat: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.beat <= beat) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function evaluateAutomation(lane: AutomationLane | undefined, beat: number): number {
  const points = lane?.points;
  if (!points?.length) return 1;
  const index = afterAutomationBeat(points, beat);
  const left = points[index - 1];
  const nextBeat = points[index]?.beat;
  if (nextBeat === undefined) return left!.value;
  const right = points[afterAutomationBeat(points, nextBeat) - 1]!;
  if (!left) return right.value;
  const fraction = (beat - left.beat) / (right.beat - left.beat);
  return left.value + (right.value - left.value) * fraction;
}

function validPoint({ beat, value }: AutomationPoint): boolean {
  return Number.isFinite(beat) && beat >= 0 && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function addPoint(lane: AutomationLane, point: AutomationPoint): AutomationLane {
  if (lane.points.length >= MAX_AUTOMATION_POINTS || !validPoint(point)) return lane;
  const points = [...lane.points];
  points.splice(afterAutomationBeat(points, point.beat), 0, point);
  return { points };
}

export function removePoint(lane: AutomationLane, index: number): AutomationLane {
  if (!lane.points[index]) return lane;
  return { points: lane.points.filter((_, i) => i !== index) };
}

export function movePoint(lane: AutomationLane, index: number, point: AutomationPoint): AutomationLane {
  const current = lane.points[index];
  if (!current || !validPoint(point) || (current.beat === point.beat && current.value === point.value)) return lane;
  return addPoint(removePoint(lane, index), point);
}
