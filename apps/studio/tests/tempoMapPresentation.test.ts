import { describe, expect, it } from 'vitest';
import {
  compileMusicalTime,
  type TempoMapEvent,
  type TimeSignatureMapEvent,
} from '@cts/project-model';
import {
  DEFAULT_TEMPO_MAP_VIEWPORT_EVENT_LIMIT,
  TEMPO_MAP_EVENT_TARGET_SIZE,
  TEMPO_MAP_TIMELINE_INSET,
  TEMPO_MAP_TIMELINE_MIN_WIDTH,
  buildTempoMapBarMarkers,
  buildTempoStepRegions,
  effectiveTempoAtBeat,
  effectiveTimeSignatureAtBeat,
  formatTempoMapPosition,
  nextTempoMapFocusId,
  selectTempoMapEventsForViewport,
  tempoMapBeatToX,
  tempoMapBarStartAtBeat,
  tempoMapCanvasWidth,
  tempoMapEventAriaLabel,
  tempoMapRovingTabIndex,
  tempoMapViewportBeatRange,
  timeSignatureMapEventAriaLabel,
} from '../src/features/tempoMap/tempoMapPresentation';

const tempoMap: TempoMapEvent[] = [
  { id: 'tempo-anchor', beat: 0, bpm: 120 },
  { id: 'tempo-two', beat: 8, bpm: 96 },
];
const timeSignatureMap: TimeSignatureMapEvent[] = [
  {
    id: 'signature-anchor',
    beat: 0,
    numerator: 4,
    denominator: 4,
  },
  {
    id: 'signature-two',
    beat: 8,
    numerator: 3,
    denominator: 4,
  },
];
const musicalTime = compileMusicalTime({
  lengthBeats: 14,
  tempoMap,
  timeSignatureMap,
});

describe('tempo map presentation', () => {
  it('keeps 44px event targets inside a bounded, horizontally scrollable canvas', () => {
    expect(tempoMapCanvasWidth(4)).toBe(TEMPO_MAP_TIMELINE_MIN_WIDTH);
    expect(tempoMapCanvasWidth(40)).toBe(
      40 * 32 + TEMPO_MAP_EVENT_TARGET_SIZE,
    );
    expect(tempoMapBeatToX(0, 14, 744)).toBe(TEMPO_MAP_TIMELINE_INSET);
    expect(tempoMapBeatToX(14, 14, 744)).toBe(
      744 - TEMPO_MAP_TIMELINE_INSET,
    );
    expect(tempoMapViewportBeatRange(0, 320, 744, 14)).toEqual([
      0,
      6.84,
    ]);
  });

  it('projects mixed-signature bar lines onto one shared timeline', () => {
    expect(
      buildTempoMapBarMarkers(musicalTime, 4, 14, 744).map(
        ({ bar, beat, x }) => ({ bar, beat, x }),
      ),
    ).toEqual([
      { bar: 0, beat: 0, x: 22 },
      { bar: 1, beat: 4, x: 222 },
      { bar: 2, beat: 8, x: 422 },
      { bar: 3, beat: 11, x: 572 },
      { bar: 4, beat: 14, x: 722 },
    ]);
    expect(formatTempoMapPosition(musicalTime, 11)).toBe('4小節 1拍');
    expect(tempoMapBarStartAtBeat(musicalTime, 9.75)).toBe(8);
    expect(tempoMapBarStartAtBeat(musicalTime, 13.9)).toBe(11);
    expect(tempoMapBarStartAtBeat(musicalTime, 14)).toBe(11);
  });

  it('builds ordered tempo steps through the project end', () => {
    expect(buildTempoStepRegions([
      { id: 'later', beat: 8, bpm: 90 },
      { id: 'anchor', beat: 0, bpm: 120 },
      { id: 'middle', beat: 4, bpm: 110 },
    ], 14)).toEqual([
      {
        eventId: 'anchor',
        startBeat: 0,
        endBeat: 4,
        bpm: 120,
      },
      {
        eventId: 'middle',
        startBeat: 4,
        endBeat: 8,
        bpm: 110,
      },
      {
        eventId: 'later',
        startBeat: 8,
        endBeat: 14,
        bpm: 90,
      },
    ]);
  });

  it('labels native controls with position, value, order, and anchor protection', () => {
    expect(tempoMapEventAriaLabel(tempoMap[0]!, 0, musicalTime)).toBe(
      'テンポ 1件目、1小節 1拍、120 BPM、曲の先頭に固定',
    );
    expect(tempoMapEventAriaLabel(tempoMap[1]!, 1, musicalTime)).toBe(
      'テンポ 2件目、3小節 1拍、96 BPM',
    );
    expect(
      timeSignatureMapEventAriaLabel(
        timeSignatureMap[0]!,
        0,
        musicalTime,
      ),
    ).toBe(
      '拍子 1件目、1小節 1拍、4分の4、曲の先頭に固定',
    );
    expect(
      timeSignatureMapEventAriaLabel(
        timeSignatureMap[1]!,
        1,
        musicalTime,
      ),
    ).toBe('拍子 2件目、3小節 1拍、4分の3');
  });

  it('bounds large maps deterministically while retaining viewport edges and selection', () => {
    const events: TempoMapEvent[] = Array.from(
      { length: 4_096 },
      (_, index) => ({
        id: `tempo-${index}`,
        beat: index / 4,
        bpm: 120,
      }),
    );
    const viewport = {
      startBeat: 100,
      endBeat: 600,
      selectedEventId: 'tempo-4095',
    } as const;

    const selected = selectTempoMapEventsForViewport(events, viewport);
    expect(selected).toHaveLength(DEFAULT_TEMPO_MAP_VIEWPORT_EVENT_LIMIT);
    expect(selectTempoMapEventsForViewport(events, viewport)).toEqual(selected);
    expect(selected.some(({ event }) => event.id === 'tempo-4095')).toBe(true);
    expect(selected.some(({ fullIndex }) => fullIndex === 400)).toBe(true);
    expect(selected.some(({ fullIndex }) => fullIndex === 2_400)).toBe(true);
    expect(selected.every(({ fullIndex }, index) => {
      const previous = selected[index - 1];
      return previous === undefined || previous.fullIndex < fullIndex;
    })).toBe(true);
  });

  it('resolves active values and deterministic focus recovery for both lanes', () => {
    expect(effectiveTempoAtBeat(tempoMap, 7)?.id).toBe('tempo-anchor');
    expect(effectiveTempoAtBeat(tempoMap, 8)?.id).toBe('tempo-two');
    expect(
      effectiveTimeSignatureAtBeat(timeSignatureMap, 13)?.id,
    ).toBe('signature-two');
    expect(nextTempoMapFocusId(tempoMap, 'tempo-anchor')).toBe('tempo-two');
    expect(nextTempoMapFocusId(tempoMap, 'tempo-two')).toBe('tempo-anchor');
    expect(nextTempoMapFocusId([], 'missing')).toBeNull();
  });

  it('keeps the first rendered event tabbable when the persisted anchor is virtualized', () => {
    const rendered = selectTempoMapEventsForViewport(tempoMap, {
      startBeat: 4,
      endBeat: 10,
    });
    expect(rendered.map(({ fullIndex }) => fullIndex)).toEqual([1]);
    expect(
      tempoMapRovingTabIndex(
        null,
        'tempo',
        rendered[0]!.event.id,
        0,
      ),
    ).toBe(0);
    expect(
      tempoMapRovingTabIndex(null, 'tempo', 'later-rendered-event', 1),
    ).toBe(-1);
    expect(
      tempoMapRovingTabIndex(
        { map: 'tempo', eventId: 'selected' },
        'tempo',
        'selected',
        3,
      ),
    ).toBe(0);
  });
});
