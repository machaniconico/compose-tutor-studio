import { describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@cts/project-model';
import {
  AUTOMATION_SNAP_OPTIONS,
  DEFAULT_AUTOMATION_VIEWPORT_POINT_LIMIT,
  automationBeatFromClientX,
  automationBeatToX,
  automationCurveSegmentsToSvgPaths,
  automationDisplayValueToModel,
  automationPointAriaLabel,
  automationTargetPresentation,
  automationValueFromClientY,
  automationValueToDisplay,
  automationValueToY,
  automationWriteConfirmationDescription,
  buildAutomationCurveSegments,
  clampAutomationValue,
  formatAutomationValue,
  resolveAutomationTargetType,
  selectAutomationPointsForViewport,
  snapAutomationBeat,
} from '../src/features/automation/automationLanePresentation';

describe('automation lane presentation', () => {
  it('names effective Master volume distinctly and describes volume-only Write', () => {
    expect(resolveAutomationTargetType(
      'track-pan',
      ['track-volume'],
    )).toBe('track-volume');
    expect(
      automationTargetPresentation('track-volume', true),
    ).toMatchObject({
      label: 'Master出力音量',
      shortLabel: 'Master出力音量',
      displayLabel: 'Master出力音量（%）',
    });
    expect(
      automationPointAriaLabel(
        { id: 'master-point', beat: 2, value: 0.75, interpolation: 'linear' },
        0,
        'track-volume',
        true,
      ),
    ).toContain('Master出力音量 1点目');
    expect(automationWriteConfirmationDescription(true)).toContain(
      'Master出力音量のオートメーションだけ',
    );
    expect(automationWriteConfirmationDescription(true)).not.toContain(
      '音量とパン',
    );
    expect(automationWriteConfirmationDescription(false)).toContain(
      '音量とパン',
    );
  });

  it('snaps and clamps point positions without assuming a 4/4 bar', () => {
    expect(snapAutomationBeat(1.13, 0.25, 8)).toBe(1.25);
    expect(snapAutomationBeat(-4, 0.25, 8)).toBe(0);
    expect(snapAutomationBeat(9, 0.25, 8)).toBe(8);
    expect(snapAutomationBeat(1.13, 0, 8)).toBe(1.13);
    expect(AUTOMATION_SNAP_OPTIONS.at(-1)).toEqual({
      value: 4,
      label: '4拍',
    });
    expect(
      AUTOMATION_SNAP_OPTIONS.some((option) => option.label.includes('小節')),
    ).toBe(false);
  });

  it('maps pointer geometry and values at both boundaries', () => {
    expect(automationBeatFromClientX(120, 100, 200, 16)).toBe(1.6);
    expect(automationBeatFromClientX(20, 100, 200, 16)).toBe(0);
    expect(automationBeatFromClientX(400, 100, 200, 16)).toBe(16);
    expect(automationBeatToX(8, 16, 640)).toBe(320);

    expect(automationValueFromClientY(20, 20, 200, 'track-volume')).toBe(2);
    expect(automationValueFromClientY(220, 20, 200, 'track-volume')).toBe(0);
    expect(automationValueFromClientY(120, 20, 200, 'track-pan')).toBe(0);
    expect(automationValueToY(0, 'track-pan', 200)).toBe(100);
    expect(clampAutomationValue(5, 'track-volume')).toBe(2);
    expect(clampAutomationValue(-5, 'track-pan')).toBe(-1);
    expect(automationValueToDisplay(1.25, 'track-volume')).toBe(125);
    expect(automationValueToDisplay(-0.4, 'track-pan')).toBe(-40);
    expect(automationDisplayValueToModel(175, 'track-volume')).toBe(1.75);
    expect(automationDisplayValueToModel(25, 'track-pan')).toBe(0.25);
  });

  it('draws base, hold, jump, linear, and final-hold semantics exactly', () => {
    const points: AutomationPoint[] = [
      { id: 'one', beat: 2, value: 0.5, interpolation: 'hold' },
      { id: 'two', beat: 4, value: 1.5, interpolation: 'linear' },
      { id: 'three', beat: 6, value: 1, interpolation: 'hold' },
    ];

    expect(buildAutomationCurveSegments(points, 0.8, 8)).toEqual([
      {
        fromBeat: 0,
        fromValue: 0.8,
        toBeat: 2,
        toValue: 0.8,
        interpolation: 'hold',
      },
      {
        fromBeat: 2,
        fromValue: 0.8,
        toBeat: 2,
        toValue: 0.5,
        interpolation: 'jump',
      },
      {
        fromBeat: 2,
        fromValue: 0.5,
        toBeat: 4,
        toValue: 0.5,
        interpolation: 'hold',
      },
      {
        fromBeat: 4,
        fromValue: 0.5,
        toBeat: 4,
        toValue: 1.5,
        interpolation: 'jump',
      },
      {
        fromBeat: 4,
        fromValue: 1.5,
        toBeat: 6,
        toValue: 1,
        interpolation: 'linear',
      },
      {
        fromBeat: 6,
        fromValue: 1,
        toBeat: 8,
        toValue: 1,
        interpolation: 'hold',
      },
    ]);
  });

  it('keeps an empty lane at the track scalar and labels native point controls', () => {
    expect(buildAutomationCurveSegments([], 0.8, 8)).toEqual([
      {
        fromBeat: 0,
        fromValue: 0.8,
        toBeat: 8,
        toValue: 0.8,
        interpolation: 'hold',
      },
    ]);
    const point: AutomationPoint = {
      id: 'pan-point',
      beat: 3.5,
      value: -0.25,
      interpolation: 'linear',
    };
    expect(automationPointAriaLabel(point, 1, 'track-pan')).toBe(
      'パン 2点目、拍 3.5、値 左 25、次の点まで直線',
    );
    expect(formatAutomationValue(0, 'track-pan')).toBe('中央');
    expect(formatAutomationValue(1.2, 'track-volume')).toBe('120%');
  });

  it('groups every curve segment into at most three exact SVG subpaths', () => {
    const points: AutomationPoint[] = [
      { id: 'one', beat: 2, value: 0.5, interpolation: 'hold' },
      { id: 'two', beat: 4, value: 1.5, interpolation: 'linear' },
      { id: 'three', beat: 6, value: 1, interpolation: 'hold' },
    ];
    const segments = buildAutomationCurveSegments(points, 0.8, 8);

    const paths = automationCurveSegmentsToSvgPaths(segments, {
      targetType: 'track-volume',
      lengthBeats: 8,
      width: 800,
      height: 200,
      offsetX: 10,
      offsetY: 20,
    });

    expect(paths).toEqual([
      {
        interpolation: 'hold',
        d: 'M 10 140 L 210 140 M 210 170 L 410 170 M 610 120 L 810 120',
        segmentCount: 3,
      },
      {
        interpolation: 'linear',
        d: 'M 410 70 L 610 120',
        segmentCount: 1,
      },
      {
        interpolation: 'jump',
        d: 'M 210 140 L 210 170 M 410 170 L 410 70',
        segmentCount: 2,
      },
    ]);
    expect(paths).toHaveLength(3);
    expect(paths.reduce((count, path) => count + path.segmentCount, 0)).toBe(
      segments.length,
    );
  });

  it('keeps a 20,000-point curve at three SVG elements without dropping segments', () => {
    const points: AutomationPoint[] = Array.from(
      { length: 20_000 },
      (_, index) => ({
        id: `point-${index}`,
        beat: index,
        value: (index % 3) / 2,
        interpolation: index % 2 === 0 ? 'linear' : 'hold',
      }),
    );
    const segments = buildAutomationCurveSegments(points, 1, 20_000);

    const paths = automationCurveSegmentsToSvgPaths(segments, {
      targetType: 'track-volume',
      lengthBeats: 20_000,
      width: 20_000,
      height: 200,
    });

    expect(paths.length).toBeLessThanOrEqual(3);
    expect(paths.reduce((count, path) => count + path.segmentCount, 0)).toBe(
      segments.length,
    );
    expect(
      paths.reduce(
        (count, path) => count + (path.d.match(/\bM /g)?.length ?? 0),
        0,
      ),
    ).toBe(segments.length);
  });

  it('selects a deterministic bounded viewport from 20,000 points and retains selection', () => {
    const points: AutomationPoint[] = Array.from(
      { length: 20_000 },
      (_, index) => ({
        id: `point-${index}`,
        beat: index / 4,
        value: 1,
        interpolation: 'linear',
      }),
    );
    const viewport = {
      startBeat: 1_000,
      endBeat: 3_000,
      selectedPointId: 'point-19999',
    } as const;

    const selected = selectAutomationPointsForViewport(points, viewport);
    const repeated = selectAutomationPointsForViewport(points, viewport);

    expect(selected).toHaveLength(DEFAULT_AUTOMATION_VIEWPORT_POINT_LIMIT);
    expect(repeated).toEqual(selected);
    expect(selected.some(({ point }) => point.id === 'point-19999')).toBe(true);
    expect(selected.some(({ fullIndex }) => fullIndex === 4_000)).toBe(true);
    expect(selected.some(({ fullIndex }) => fullIndex === 12_000)).toBe(true);
    expect(selected.every(({ point, fullIndex }, index) => {
      const previous = selected[index - 1];
      return points[fullIndex] === point
        && (previous === undefined || previous.fullIndex < fullIndex)
        && (
          point.id === 'point-19999'
          || (point.beat >= viewport.startBeat && point.beat <= viewport.endBeat)
        );
    })).toBe(true);
  });

  it('handles viewport edges and prioritizes an explicitly selected point', () => {
    const points: AutomationPoint[] = Array.from(
      { length: 6 },
      (_, index) => ({
        id: `point-${index}`,
        beat: index,
        value: 1,
        interpolation: 'hold',
      }),
    );

    expect(selectAutomationPointsForViewport(points, {
      startBeat: 4,
      endBeat: 1,
      selectedPointId: 'point-2',
      maxPoints: 3,
    }).map(({ fullIndex }) => fullIndex)).toEqual([1, 2, 4]);
    expect(selectAutomationPointsForViewport(points, {
      startBeat: 1,
      endBeat: 4,
      selectedPointId: 'point-5',
      maxPoints: 1,
    }).map(({ fullIndex }) => fullIndex)).toEqual([5]);
    expect(selectAutomationPointsForViewport(points, {
      startBeat: 1,
      endBeat: 4,
      maxPoints: 2,
    }).map(({ fullIndex }) => fullIndex)).toEqual([1, 4]);
    expect(selectAutomationPointsForViewport(points, {
      startBeat: Number.NaN,
      endBeat: Number.NaN,
      maxPoints: 20,
    }).map(({ fullIndex }) => fullIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
