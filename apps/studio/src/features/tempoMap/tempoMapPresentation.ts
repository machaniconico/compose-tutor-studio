import {
  barToBeatAt,
  beatToBarPosition,
  type MusicalTimeIndex,
  type TempoMapEvent,
  type TimeSignatureMapEvent,
} from '@cts/project-model';

export const TEMPO_MAP_TIMELINE_MIN_WIDTH = 720;
export const TEMPO_MAP_TIMELINE_INSET = 22;
export const TEMPO_MAP_PIXELS_PER_BEAT = 32;
export const TEMPO_MAP_EVENT_TARGET_SIZE = 44;
export const DEFAULT_TEMPO_MAP_VIEWPORT_EVENT_LIMIT = 240;

export type TempoMapKind = 'tempo' | 'time-signature';

export type TempoMapSelection = Readonly<{
  map: TempoMapKind;
  eventId: string;
}>;

export type TempoMapBarMarker = Readonly<{
  /** Zero-based bar index. */
  bar: number;
  beat: number;
  x: number;
}>;

export type TempoStepRegion = Readonly<{
  eventId: string;
  startBeat: number;
  endBeat: number;
  bpm: number;
}>;

export type TempoMapViewportEvent<T extends { id: string; beat: number }> =
  Readonly<{
    event: T;
    /** Index in the complete persisted map, not the rendered subset. */
    fullIndex: number;
  }>;

export type TempoMapEventViewport = Readonly<{
  startBeat?: number;
  endBeat?: number;
  selectedEventId?: string | null;
  maxEvents?: number;
}>;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function tempoMapCanvasWidth(
  lengthBeats: number,
  pixelsPerBeat = TEMPO_MAP_PIXELS_PER_BEAT,
): number {
  const safeLength = finiteNonNegative(lengthBeats);
  const safePixelsPerBeat = Number.isFinite(pixelsPerBeat) && pixelsPerBeat > 0
    ? pixelsPerBeat
    : TEMPO_MAP_PIXELS_PER_BEAT;
  return Math.max(
    TEMPO_MAP_TIMELINE_MIN_WIDTH,
    Math.ceil(safeLength * safePixelsPerBeat) + TEMPO_MAP_EVENT_TARGET_SIZE,
  );
}

export function clampTempoMapBeat(beat: number, lengthBeats: number): number {
  const safeLength = finiteNonNegative(lengthBeats);
  if (!Number.isFinite(beat)) return 0;
  return Math.min(safeLength, Math.max(0, beat));
}

/** Map a beat to the centre of a 44px native event target. */
export function tempoMapBeatToX(
  beat: number,
  lengthBeats: number,
  width: number,
): number {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0;
  const drawableWidth = Math.max(
    0,
    safeWidth - TEMPO_MAP_EVENT_TARGET_SIZE,
  );
  const safeLength = finiteNonNegative(lengthBeats);
  if (safeLength === 0) return Math.min(TEMPO_MAP_TIMELINE_INSET, safeWidth);
  return TEMPO_MAP_TIMELINE_INSET
    + (clampTempoMapBeat(beat, safeLength) / safeLength) * drawableWidth;
}

export function tempoMapViewportBeatRange(
  scrollLeft: number,
  viewportWidth: number,
  canvasWidth: number,
  lengthBeats: number,
): readonly [number, number] {
  const safeCanvasWidth = Number.isFinite(canvasWidth) && canvasWidth > 0
    ? canvasWidth
    : TEMPO_MAP_TIMELINE_MIN_WIDTH;
  const drawableWidth = Math.max(
    1,
    safeCanvasWidth - TEMPO_MAP_EVENT_TARGET_SIZE,
  );
  const safeScrollLeft = finiteNonNegative(scrollLeft);
  const safeViewportWidth = finiteNonNegative(viewportWidth);
  const beatAt = (x: number): number => clampTempoMapBeat(
    ((x - TEMPO_MAP_TIMELINE_INSET) / drawableWidth)
      * finiteNonNegative(lengthBeats),
    lengthBeats,
  );
  return [
    beatAt(safeScrollLeft - TEMPO_MAP_EVENT_TARGET_SIZE),
    beatAt(
      safeScrollLeft + safeViewportWidth + TEMPO_MAP_EVENT_TARGET_SIZE,
    ),
  ];
}

export function buildTempoMapBarMarkers(
  musicalTime: MusicalTimeIndex,
  lengthBars: number,
  lengthBeats: number,
  width: number,
): readonly TempoMapBarMarker[] {
  const safeBarCount = Number.isSafeInteger(lengthBars) && lengthBars >= 0
    ? lengthBars
    : 0;
  const markers: TempoMapBarMarker[] = [];
  for (let bar = 0; bar <= safeBarCount; bar += 1) {
    const beat = barToBeatAt(musicalTime, bar);
    if (beat > lengthBeats + Number.EPSILON) break;
    markers.push({
      bar,
      beat,
      x: tempoMapBeatToX(beat, lengthBeats, width),
    });
  }
  return markers;
}

export function buildTempoStepRegions(
  events: readonly TempoMapEvent[],
  lengthBeats: number,
): readonly TempoStepRegion[] {
  const safeLength = finiteNonNegative(lengthBeats);
  const sorted = [...events].sort(
    (left, right) => left.beat - right.beat || left.id.localeCompare(right.id),
  );
  return sorted.map((event, index) => ({
    eventId: event.id,
    startBeat: clampTempoMapBeat(event.beat, safeLength),
    endBeat: clampTempoMapBeat(
      sorted[index + 1]?.beat ?? safeLength,
      safeLength,
    ),
    bpm: event.bpm,
  }));
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

function normalizedEventLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TEMPO_MAP_VIEWPORT_EVENT_LIMIT;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Keep native event buttons bounded while retaining the selected and both
 * visible edge events. Results always remain in complete-map order.
 */
export function selectTempoMapEventsForViewport<
  T extends { id: string; beat: number },
>(
  events: readonly T[],
  viewport: TempoMapEventViewport = {},
): readonly TempoMapViewportEvent<T>[] {
  const [startBeat, endBeat] = normalizedViewportBounds(
    viewport.startBeat,
    viewport.endBeat,
  );
  const limit = normalizedEventLimit(viewport.maxEvents);
  const indexed = events.map(
    (event, fullIndex): TempoMapViewportEvent<T> => ({ event, fullIndex }),
  );
  const visible = indexed.filter(({ event }) =>
    Number.isFinite(event.beat)
    && event.beat >= startBeat
    && event.beat <= endBeat);
  const selected = viewport.selectedEventId === null
    || viewport.selectedEventId === undefined
    ? undefined
    : indexed.find(({ event }) => event.id === viewport.selectedEventId);
  const chosen = new Map<number, TempoMapViewportEvent<T>>();
  const retain = (candidate: TempoMapViewportEvent<T> | undefined): void => {
    if (candidate !== undefined && chosen.size < limit) {
      chosen.set(candidate.fullIndex, candidate);
    }
  };

  retain(selected);
  retain(visible[0]);
  retain(visible[visible.length - 1]);

  const remaining = visible.filter(
    ({ fullIndex }) => !chosen.has(fullIndex),
  );
  const sampleCount = Math.min(limit - chosen.size, remaining.length);
  for (let slot = 0; slot < sampleCount; slot += 1) {
    const sampleIndex = Math.floor(
      ((slot + 0.5) * remaining.length) / sampleCount,
    );
    retain(remaining[sampleIndex]);
  }

  return [...chosen.values()].sort(
    (left, right) => left.fullIndex - right.fullIndex,
  );
}

export function formatTempoMapBeat(beat: number): string {
  if (!Number.isFinite(beat)) return '0';
  return Number(beat.toFixed(3)).toString();
}

export function formatTempoMapPosition(
  musicalTime: MusicalTimeIndex,
  beat: number,
): string {
  const position = beatToBarPosition(
    musicalTime,
    clampTempoMapBeat(beat, musicalTime.lengthBeats),
  );
  return `${position.bar + 1}小節 ${formatTempoMapBeat(
    position.beatInBar + 1,
  )}拍`;
}

/** Resolve any playhead position to the start of its containing musical bar. */
export function tempoMapBarStartAtBeat(
  musicalTime: MusicalTimeIndex,
  beat: number,
): number {
  const lengthBeats = finiteNonNegative(musicalTime.lengthBeats);
  const endInset = Number.EPSILON * Math.max(1, lengthBeats);
  const lookupBeat = lengthBeats === 0
    ? 0
    : Math.min(
        Math.max(0, Number.isFinite(beat) ? beat : 0),
        Math.max(0, lengthBeats - endInset),
      );
  return barToBeatAt(
    musicalTime,
    beatToBarPosition(musicalTime, lookupBeat).bar,
  );
}

export function tempoMapEventAriaLabel(
  event: TempoMapEvent,
  index: number,
  musicalTime: MusicalTimeIndex,
): string {
  const fixed = event.beat === 0 ? '、曲の先頭に固定' : '';
  return `テンポ ${index + 1}件目、${formatTempoMapPosition(
    musicalTime,
    event.beat,
  )}、${formatTempoMapBeat(event.bpm)} BPM${fixed}`;
}

export function timeSignatureMapEventAriaLabel(
  event: TimeSignatureMapEvent,
  index: number,
  musicalTime: MusicalTimeIndex,
): string {
  const fixed = event.beat === 0 ? '、曲の先頭に固定' : '';
  return `拍子 ${index + 1}件目、${formatTempoMapPosition(
    musicalTime,
    event.beat,
  )}、${event.denominator}分の${event.numerator}${fixed}`;
}

export function effectiveTempoAtBeat(
  events: readonly TempoMapEvent[],
  beat: number,
): TempoMapEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.beat <= beat) return event;
  }
  return events[0];
}

export function effectiveTimeSignatureAtBeat(
  events: readonly TimeSignatureMapEvent[],
  beat: number,
): TimeSignatureMapEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.beat <= beat) return event;
  }
  return events[0];
}

export function tempoMapEventAtBeat<T extends { beat: number }>(
  events: readonly T[],
  beat: number,
): T | undefined {
  return events.find((event) => event.beat === beat);
}

/**
 * Keep one keyboard entry point per rendered lane, even when virtualization
 * removes the persisted first event from the DOM.
 */
export function tempoMapRovingTabIndex(
  selection: TempoMapSelection | null,
  map: TempoMapKind,
  eventId: string,
  renderedIndex: number,
): 0 | -1 {
  if (selection?.map === map) {
    return selection.eventId === eventId ? 0 : -1;
  }
  return renderedIndex === 0 ? 0 : -1;
}

/** Prefer the item after a deletion, then the previous item. */
export function nextTempoMapFocusId<T extends { id: string }>(
  events: readonly T[],
  removedEventId: string,
): string | null {
  const removedIndex = events.findIndex((event) => event.id === removedEventId);
  if (removedIndex < 0) return events[0]?.id ?? null;
  return events[removedIndex + 1]?.id
    ?? events[removedIndex - 1]?.id
    ?? null;
}
