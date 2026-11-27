import type { AutomationLane, AutomationParameter, AutomationPoint, Track } from './types';

export const DRUM_CUTOFF_AUTOMATION_MESSAGE = 'ドラムトラックには明るさの変化を設定できません。';
export const MAX_AUTOMATION_POINTS = 10_000;
export const AUTOMATION_PARAMETERS = ['volume', 'pan', 'cutoff'] as const;
export const AUTOMATION_PARAMETER_INFO = {
  volume: { label: '音量', min: 0, max: 1, neutral: 1 },
  pan: { label: '左右', min: -1, max: 1, neutral: 0 },
  cutoff: { label: '明るさ', min: 0.1, max: 10, neutral: 1 },
} as const satisfies Record<AutomationParameter, { label: string; min: number; max: number; neutral: number }>;

export function hasAutomation(track: Track): boolean {
  return track.type !== 'master' && AUTOMATION_PARAMETERS.some((parameter) =>
    Boolean(track.automation?.[parameter]?.points.length));
}

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

export function evaluateAutomation(
  lane: AutomationLane | undefined,
  beat: number,
  parameter: AutomationParameter = 'volume',
): number {
  const points = lane?.points;
  if (!points?.length) return AUTOMATION_PARAMETER_INFO[parameter].neutral;
  const index = afterAutomationBeat(points, beat);
  const left = points[index - 1];
  const nextBeat = points[index]?.beat;
  if (nextBeat === undefined) return left!.value;
  const right = points[afterAutomationBeat(points, nextBeat) - 1]!;
  if (!left) return right.value;
  const fraction = (beat - left.beat) / (right.beat - left.beat);
  if (parameter === 'cutoff') {
    if (beat === left.beat) return left.value;
    const from = Math.log10(left.value);
    return 10 ** (from + (Math.log10(right.value) - from) * fraction);
  }
  return left.value + (right.value - left.value) * fraction;
}

export function isAutomationValue(parameter: AutomationParameter, value: unknown): value is number {
  const { min, max } = AUTOMATION_PARAMETER_INFO[parameter];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validPoint({ beat, value }: AutomationPoint, parameter: AutomationParameter): boolean {
  return Number.isFinite(beat) && beat >= 0 && isAutomationValue(parameter, value);
}

export function addPoint(
  lane: AutomationLane, point: AutomationPoint, parameter: AutomationParameter = 'volume',
): AutomationLane {
  if (lane.points.length >= MAX_AUTOMATION_POINTS || !validPoint(point, parameter)) return lane;
  const points = [...lane.points];
  points.splice(afterAutomationBeat(points, point.beat), 0, point);
  return { points };
}

export function removePoint(lane: AutomationLane, index: number): AutomationLane {
  if (!lane.points[index]) return lane;
  return { points: lane.points.filter((_, i) => i !== index) };
}

export function movePoint(
  lane: AutomationLane, index: number, point: AutomationPoint, parameter: AutomationParameter = 'volume',
): AutomationLane {
  const current = lane.points[index];
  if (!current || !validPoint(point, parameter) || (current.beat === point.beat && current.value === point.value)) return lane;
  return addPoint(removePoint(lane, index), point, parameter);
}
