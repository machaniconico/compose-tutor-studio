import type {
  AutomationInterpolation,
  AutomationPoint,
  AutomationTarget,
} from '@cts/project-model';

export const AUTOMATION_LANE_HEIGHT = 240;
export const AUTOMATION_LANE_MIN_WIDTH = 720;
export const AUTOMATION_POINT_SIZE = 44;

export type AutomationTargetType = AutomationTarget['type'];

export type AutomationTargetPresentation = Readonly<{
  label: string;
  shortLabel: string;
  min: number;
  max: number;
  step: number;
  displayLabel: string;
  displayMin: number;
  displayMax: number;
  displayStep: number;
}>;

export const AUTOMATION_TARGETS: Readonly<
  Record<AutomationTargetType, AutomationTargetPresentation>
> = {
  'track-volume': {
    label: 'トラック音量',
    shortLabel: '音量',
    min: 0,
    max: 2,
    step: 0.01,
    displayLabel: '音量（%）',
    displayMin: 0,
    displayMax: 200,
    displayStep: 1,
  },
  'track-pan': {
    label: 'パン',
    shortLabel: 'パン',
    min: -1,
    max: 1,
    step: 0.01,
    displayLabel: 'パン（-100〜100）',
    displayMin: -100,
    displayMax: 100,
    displayStep: 1,
  },
};

const MASTER_VOLUME_AUTOMATION_TARGET: AutomationTargetPresentation = {
  ...AUTOMATION_TARGETS['track-volume'],
  label: 'Master出力音量',
  shortLabel: 'Master出力音量',
  displayLabel: 'Master出力音量（%）',
};

export function automationTargetPresentation(
  targetType: AutomationTargetType,
  isMaster: boolean,
): AutomationTargetPresentation {
  return isMaster && targetType === 'track-volume'
    ? MASTER_VOLUME_AUTOMATION_TARGET
    : AUTOMATION_TARGETS[targetType];
}

export function resolveAutomationTargetType(
  requested: AutomationTargetType,
  supported: readonly AutomationTargetType[],
): AutomationTargetType {
  return supported.includes(requested)
    ? requested
    : supported[0] ?? requested;
}

export function automationWriteConfirmationDescription(
  isMaster: boolean,
): string {
  return isMaster
    ? 'Writeは、コントロールに触れなくても再生位置の下にあるMaster出力音量のオートメーションだけを置き換えます。パスをパンチアウトすると、安全なTouchモードへ自動的に戻ります。'
    : 'Writeは、コントロールに触れなくても再生位置の下にある音量とパンのオートメーションを両方とも置き換えます。パスをパンチアウトすると、安全なTouchモードへ自動的に戻ります。';
}

export const AUTOMATION_SNAP_OPTIONS = [
  { value: 0, label: 'オフ' },
  { value: 0.25, label: '1/16音符' },
  { value: 0.5, label: '1/8音符' },
  { value: 1, label: '1/4音符' },
  { value: 2, label: '1/2音符' },
  { value: 4, label: '4拍' },
] as const;

export type AutomationCurveSegment = Readonly<{
  fromBeat: number;
  fromValue: number;
  toBeat: number;
  toValue: number;
  interpolation: AutomationInterpolation | 'jump';
}>;

export type AutomationCurveSvgPath = Readonly<{
  interpolation: AutomationCurveSegment['interpolation'];
  d: string;
  segmentCount: number;
}>;

export type AutomationCurveSvgViewport = Readonly<{
  targetType: AutomationTargetType;
  lengthBeats: number;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
}>;

export const DEFAULT_AUTOMATION_VIEWPORT_POINT_LIMIT = 400;

export type AutomationViewportPoint = Readonly<{
  point: AutomationPoint;
  /** Index in the complete persisted lane, not the rendered subset. */
  fullIndex: number;
}>;

export type AutomationPointViewport = Readonly<{
  startBeat?: number;
  endBeat?: number;
  selectedPointId?: string | null;
  maxPoints?: number;
}>;

export function clampAutomationBeat(beat: number, lengthBeats: number): number {
  if (!Number.isFinite(beat)) return 0;
  const safeLength = Number.isFinite(lengthBeats) && lengthBeats >= 0
    ? lengthBeats
    : 0;
  return Math.min(safeLength, Math.max(0, beat));
}

export function clampAutomationValue(
  value: number,
  targetType: AutomationTargetType,
): number {
  const target = AUTOMATION_TARGETS[targetType];
  if (!Number.isFinite(value)) return target.min;
  return Math.min(target.max, Math.max(target.min, value));
}

/** Convert persisted model scalars to beginner-facing percent-style units. */
export function automationValueToDisplay(
  value: number,
  targetType: AutomationTargetType,
): number {
  return clampAutomationValue(value, targetType) * 100;
}

/** Convert beginner-facing percent-style input back to the persisted scalar. */
export function automationDisplayValueToModel(
  displayValue: number,
  targetType: AutomationTargetType,
): number {
  if (!Number.isFinite(displayValue)) return Number.NaN;
  return displayValue / 100;
}

export function snapAutomationBeat(
  beat: number,
  snapBeats: number,
  lengthBeats: number,
): number {
  const clamped = clampAutomationBeat(beat, lengthBeats);
  if (!Number.isFinite(snapBeats) || snapBeats <= 0) return clamped;
  const snapped = Math.round(clamped / snapBeats) * snapBeats;
  return clampAutomationBeat(Number(snapped.toFixed(6)), lengthBeats);
}

export function automationBeatFromClientX(
  clientX: number,
  laneLeft: number,
  laneWidth: number,
  lengthBeats: number,
): number {
  if (
    !Number.isFinite(clientX)
    || !Number.isFinite(laneLeft)
    || !Number.isFinite(laneWidth)
    || laneWidth <= 0
  ) {
    return 0;
  }
  return clampAutomationBeat(
    ((clientX - laneLeft) / laneWidth) * Math.max(0, lengthBeats),
    lengthBeats,
  );
}

export function automationValueFromClientY(
  clientY: number,
  laneTop: number,
  laneHeight: number,
  targetType: AutomationTargetType,
): number {
  const target = AUTOMATION_TARGETS[targetType];
  if (
    !Number.isFinite(clientY)
    || !Number.isFinite(laneTop)
    || !Number.isFinite(laneHeight)
    || laneHeight <= 0
  ) {
    return target.min;
  }
  const progress = Math.min(1, Math.max(0, (clientY - laneTop) / laneHeight));
  return clampAutomationValue(
    target.max - progress * (target.max - target.min),
    targetType,
  );
}

export function automationBeatToX(
  beat: number,
  lengthBeats: number,
  width: number,
): number {
  if (!(width > 0) || !(lengthBeats > 0)) return 0;
  return (clampAutomationBeat(beat, lengthBeats) / lengthBeats) * width;
}

export function automationValueToY(
  value: number,
  targetType: AutomationTargetType,
  height: number,
): number {
  if (!(height > 0)) return 0;
  const target = AUTOMATION_TARGETS[targetType];
  const span = target.max - target.min;
  if (!(span > 0)) return height / 2;
  return (
    1 - (clampAutomationValue(value, targetType) - target.min) / span
  ) * height;
}

/**
 * Build the same piecewise curve used by playback:
 * base value before the first point, each point's interpolation to the next,
 * then the final point held through the project end.
 */
export function buildAutomationCurveSegments(
  points: readonly AutomationPoint[],
  baseValue: number,
  lengthBeats: number,
): readonly AutomationCurveSegment[] {
  const safeLength = Math.max(0, lengthBeats);
  const sorted = [...points]
    .filter(
      (point) =>
        Number.isFinite(point.beat)
        && point.beat >= 0
        && point.beat <= safeLength
        && Number.isFinite(point.value),
    )
    .sort((left, right) => left.beat - right.beat);
  if (sorted.length === 0) {
    return safeLength === 0
      ? []
      : [{
          fromBeat: 0,
          fromValue: baseValue,
          toBeat: safeLength,
          toValue: baseValue,
          interpolation: 'hold',
        }];
  }

  const segments: AutomationCurveSegment[] = [];
  const first = sorted[0];
  if (!first) return segments;
  if (first.beat > 0) {
    segments.push({
      fromBeat: 0,
      fromValue: baseValue,
      toBeat: first.beat,
      toValue: baseValue,
      interpolation: 'hold',
    });
  }
  if (first.value !== baseValue) {
    segments.push({
      fromBeat: first.beat,
      fromValue: baseValue,
      toBeat: first.beat,
      toValue: first.value,
      interpolation: 'jump',
    });
  }

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const point = sorted[index];
    const next = sorted[index + 1];
    if (!point || !next) continue;
    if (point.interpolation === 'linear') {
      segments.push({
        fromBeat: point.beat,
        fromValue: point.value,
        toBeat: next.beat,
        toValue: next.value,
        interpolation: 'linear',
      });
      continue;
    }
    segments.push({
      fromBeat: point.beat,
      fromValue: point.value,
      toBeat: next.beat,
      toValue: point.value,
      interpolation: 'hold',
    });
    if (point.value !== next.value) {
      segments.push({
        fromBeat: next.beat,
        fromValue: point.value,
        toBeat: next.beat,
        toValue: next.value,
        interpolation: 'jump',
      });
    }
  }

  const last = sorted[sorted.length - 1];
  if (last && last.beat < safeLength) {
    segments.push({
      fromBeat: last.beat,
      fromValue: last.value,
      toBeat: safeLength,
      toValue: last.value,
      interpolation: 'hold',
    });
  }
  return segments;
}

const AUTOMATION_CURVE_PATH_ORDER = [
  'hold',
  'linear',
  'jump',
] as const satisfies readonly AutomationCurveSegment['interpolation'][];

function finiteOffset(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) return '0';
  return String(value);
}

/**
 * Collapse an arbitrary number of curve segments into at most three SVG paths.
 *
 * Each source segment remains an independent `M … L …` subpath, so grouping by
 * visual interpolation style cannot introduce a connection between unrelated
 * hold, linear, or jump segments.
 */
export function automationCurveSegmentsToSvgPaths(
  segments: readonly AutomationCurveSegment[],
  viewport: AutomationCurveSvgViewport,
): readonly AutomationCurveSvgPath[] {
  const width = Number.isFinite(viewport.width) && viewport.width > 0
    ? viewport.width
    : 0;
  const height = Number.isFinite(viewport.height) && viewport.height > 0
    ? viewport.height
    : 0;
  const offsetX = finiteOffset(viewport.offsetX);
  const offsetY = finiteOffset(viewport.offsetY);
  const grouped = new Map<
    AutomationCurveSegment['interpolation'],
    { commands: string[]; segmentCount: number }
  >();

  for (const segment of segments) {
    const fromX = offsetX + automationBeatToX(
      segment.fromBeat,
      viewport.lengthBeats,
      width,
    );
    const fromY = offsetY + automationValueToY(
      segment.fromValue,
      viewport.targetType,
      height,
    );
    const toX = offsetX + automationBeatToX(
      segment.toBeat,
      viewport.lengthBeats,
      width,
    );
    const toY = offsetY + automationValueToY(
      segment.toValue,
      viewport.targetType,
      height,
    );
    const current = grouped.get(segment.interpolation) ?? {
      commands: [],
      segmentCount: 0,
    };
    current.commands.push(
      `M ${svgNumber(fromX)} ${svgNumber(fromY)} L ${svgNumber(toX)} ${svgNumber(toY)}`,
    );
    current.segmentCount += 1;
    grouped.set(segment.interpolation, current);
  }

  return AUTOMATION_CURVE_PATH_ORDER.flatMap((interpolation) => {
    const group = grouped.get(interpolation);
    return group === undefined
      ? []
      : [{
          interpolation,
          d: group.commands.join(' '),
          segmentCount: group.segmentCount,
        }];
  });
}

function normalizedViewportBounds(
  startBeat: number | undefined,
  endBeat: number | undefined,
): readonly [number, number] {
  const start = typeof startBeat === 'number' && !Number.isNaN(startBeat)
    ? startBeat
    : Number.NEGATIVE_INFINITY;
  const end = typeof endBeat === 'number' && !Number.isNaN(endBeat)
    ? endBeat
    : Number.POSITIVE_INFINITY;
  return start <= end ? [start, end] : [end, start];
}

function normalizedPointLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_AUTOMATION_VIEWPORT_POINT_LIMIT;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Select the native point controls that belong to a beat viewport.
 *
 * The returned list stays in full-lane order and never exceeds `maxPoints`.
 * The selected point is retained even when it is outside the viewport; with
 * normal limits the first and last visible points are retained as anchors and
 * the remaining budget is distributed deterministically across the viewport.
 */
export function selectAutomationPointsForViewport(
  points: readonly AutomationPoint[],
  viewport: AutomationPointViewport = {},
): readonly AutomationViewportPoint[] {
  const [startBeat, endBeat] = normalizedViewportBounds(
    viewport.startBeat,
    viewport.endBeat,
  );
  const limit = normalizedPointLimit(viewport.maxPoints);
  const indexed = points.map((point, fullIndex): AutomationViewportPoint => ({
    point,
    fullIndex,
  }));
  const visible = indexed.filter(({ point }) =>
    Number.isFinite(point.beat)
    && point.beat >= startBeat
    && point.beat <= endBeat);
  const selected = viewport.selectedPointId === null
    || viewport.selectedPointId === undefined
    ? undefined
    : indexed.find(({ point }) => point.id === viewport.selectedPointId);
  const chosen = new Map<number, AutomationViewportPoint>();
  const retain = (candidate: AutomationViewportPoint | undefined): void => {
    if (candidate !== undefined && chosen.size < limit) {
      chosen.set(candidate.fullIndex, candidate);
    }
  };

  // Selection takes precedence for very small explicit limits.
  retain(selected);
  retain(visible[0]);
  retain(visible[visible.length - 1]);

  const remainingBudget = limit - chosen.size;
  if (remainingBudget > 0) {
    const remainingVisible = visible.filter(
      ({ fullIndex }) => !chosen.has(fullIndex),
    );
    const sampleCount = Math.min(remainingBudget, remainingVisible.length);
    for (let slot = 0; slot < sampleCount; slot += 1) {
      const sampleIndex = Math.floor(
        ((slot + 0.5) * remainingVisible.length) / sampleCount,
      );
      retain(remainingVisible[sampleIndex]);
    }
  }

  return [...chosen.values()].sort(
    (left, right) => left.fullIndex - right.fullIndex,
  );
}

export function formatAutomationBeat(beat: number): string {
  return Number(beat.toFixed(3)).toString();
}

export function formatAutomationValue(
  value: number,
  targetType: AutomationTargetType,
): string {
  if (targetType === 'track-volume') {
    return `${Math.round(value * 100)}%`;
  }
  if (Math.abs(value) < 0.005) return '中央';
  const amount = Math.round(Math.abs(value) * 100);
  return value < 0 ? `左 ${amount}` : `右 ${amount}`;
}

export function automationInterpolationLabel(
  interpolation: AutomationInterpolation,
): string {
  return interpolation === 'linear' ? '次の点まで直線' : '次の点まで保持';
}

export function automationPointAriaLabel(
  point: AutomationPoint,
  index: number,
  targetType: AutomationTargetType,
  isMaster = false,
): string {
  const target = automationTargetPresentation(targetType, isMaster);
  return `${target.shortLabel} ${index + 1}点目、拍 ${formatAutomationBeat(
    point.beat,
  )}、値 ${formatAutomationValue(
    point.value,
    targetType,
  )}、${automationInterpolationLabel(point.interpolation)}`;
}
