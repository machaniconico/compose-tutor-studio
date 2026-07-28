import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  compileMusicalTime,
  type TempoMapEvent,
  type TimeSignatureMapEvent,
} from '@cts/project-model';
import {
  addStudioTempoMapEvent,
  addStudioTimeSignatureMapEvent,
  removeStudioTempoMapEvent,
  removeStudioTimeSignatureMapEvent,
  studioTempoMapErrorMessage,
  updateStudioTempoMapEvent,
  updateStudioTimeSignatureMapEvent,
  type StudioTempoMapCommandResult,
} from '../../state/tempoMapActions';
import { useStore } from '../../state/store';
import {
  TEMPO_MAP_EVENT_TARGET_SIZE,
  buildTempoMapBarMarkers,
  buildTempoStepRegions,
  effectiveTempoAtBeat,
  effectiveTimeSignatureAtBeat,
  formatTempoMapBeat,
  formatTempoMapPosition,
  nextTempoMapFocusId,
  selectTempoMapEventsForViewport,
  tempoMapBarStartAtBeat,
  tempoMapBeatToX,
  tempoMapCanvasWidth,
  tempoMapEventAriaLabel,
  tempoMapEventAtBeat,
  tempoMapRovingTabIndex,
  tempoMapViewportBeatRange,
  timeSignatureMapEventAriaLabel,
  type TempoMapKind,
  type TempoMapSelection,
} from './tempoMapPresentation';

const DENOMINATORS = [2, 4, 8, 16] as const;

type Notice = Readonly<{
  kind: 'error' | 'status';
  message: string;
}>;

type TempoDraft = Readonly<{
  map: 'tempo';
  eventId: string;
  beat: string;
  bpm: string;
}>;

type TimeSignatureDraft = Readonly<{
  map: 'time-signature';
  eventId: string;
  beat: string;
  numerator: string;
  denominator: string;
}>;

type InspectorDraft = TempoDraft | TimeSignatureDraft;

type FocusTarget =
  | TempoMapSelection
  | Readonly<{ map: 'tempo-add' | 'time-signature-add' }>;

function tempoDraft(event: TempoMapEvent): TempoDraft {
  return {
    map: 'tempo',
    eventId: event.id,
    beat: event.beat.toString(),
    bpm: event.bpm.toString(),
  };
}

function timeSignatureDraft(
  event: TimeSignatureMapEvent,
): TimeSignatureDraft {
  return {
    map: 'time-signature',
    eventId: event.id,
    beat: event.beat.toString(),
    numerator: event.numerator.toString(),
    denominator: event.denominator.toString(),
  };
}

function stoppedSuffix(playbackStopped: boolean): string {
  return playbackStopped
    ? ' 安全に更新するため再生を停止し、再生位置は保持しました。'
    : '';
}

function markerRefKey(map: TempoMapKind, eventId: string): string {
  return `${map}:${eventId}`;
}

function parseRequiredNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isEditableMapBeat(
  beat: number,
  currentBeat: number,
  lengthBeats: number,
): boolean {
  return beat >= 0
    && (
      beat < lengthBeats
      || (currentBeat === lengthBeats && beat === lengthBeats)
    );
}

function exclusiveEndInputMax(lengthBeats: number): number {
  if (!(lengthBeats > 0) || !Number.isFinite(lengthBeats)) return 0;
  return Math.max(
    0,
    lengthBeats
      - Number.EPSILON * Math.max(1, Math.abs(lengthBeats)),
  );
}

function mapName(map: TempoMapKind): string {
  return map === 'tempo' ? 'テンポ' : '拍子';
}

export function TempoMapEditor() {
  const project = useStore((state) => state.project);
  const positionBeat = useStore((state) => state.transport.positionBeat);
  const projectOperationBusy = useStore((state) => state.projectOperationBusy);
  const audioRecordingOperationId = useStore(
    (state) => state.audioRecordingOperationId,
  );

  const [selection, setSelection] = useState<TempoMapSelection | null>(null);
  const [draft, setDraft] = useState<InspectorDraft | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [viewport, setViewport] = useState({
    scrollLeft: 0,
    width: 720,
  });

  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const tempoAddRef = useRef<HTMLButtonElement | null>(null);
  const signatureAddRef = useRef<HTMLButtonElement | null>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());

  const disabled =
    projectOperationBusy || audioRecordingOperationId !== null;
  const lengthBeats = Math.max(0, project.lengthBeats);
  const canvasWidth = tempoMapCanvasWidth(lengthBeats);
  const musicalTime = useMemo(
    () => compileMusicalTime({
      lengthBeats,
      tempoMap: project.tempoMap,
      timeSignatureMap: project.timeSignatureMap,
    }),
    [lengthBeats, project.tempoMap, project.timeSignatureMap],
  );
  const barMarkers = useMemo(
    () => buildTempoMapBarMarkers(
      musicalTime,
      project.lengthBars,
      lengthBeats,
      canvasWidth,
    ),
    [canvasWidth, lengthBeats, musicalTime, project.lengthBars],
  );
  const tempoRegions = useMemo(
    () => buildTempoStepRegions(project.tempoMap, lengthBeats),
    [lengthBeats, project.tempoMap],
  );
  const [viewportStartBeat, viewportEndBeat] = tempoMapViewportBeatRange(
    viewport.scrollLeft,
    viewport.width,
    canvasWidth,
    lengthBeats,
  );
  const renderedTempoEvents = useMemo(
    () => selectTempoMapEventsForViewport(project.tempoMap, {
      startBeat: viewportStartBeat,
      endBeat: viewportEndBeat,
      selectedEventId:
        selection?.map === 'tempo' ? selection.eventId : null,
    }),
    [
      project.tempoMap,
      selection,
      viewportEndBeat,
      viewportStartBeat,
    ],
  );
  const renderedSignatureEvents = useMemo(
    () => selectTempoMapEventsForViewport(project.timeSignatureMap, {
      startBeat: viewportStartBeat,
      endBeat: viewportEndBeat,
      selectedEventId:
        selection?.map === 'time-signature' ? selection.eventId : null,
    }),
    [
      project.timeSignatureMap,
      selection,
      viewportEndBeat,
      viewportStartBeat,
    ],
  );
  const selectedTempo = selection?.map === 'tempo'
    ? project.tempoMap.find((event) => event.id === selection.eventId) ?? null
    : null;
  const selectedTimeSignature = selection?.map === 'time-signature'
    ? project.timeSignatureMap.find(
        (event) => event.id === selection.eventId,
      ) ?? null
    : null;
  const safePlayheadBeat = Math.min(
    lengthBeats,
    Math.max(0, Number.isFinite(positionBeat) ? positionBeat : 0),
  );
  const playheadX = tempoMapBeatToX(
    safePlayheadBeat,
    lengthBeats,
    canvasWidth,
  );

  useEffect(() => {
    if (selection === null) return;
    const exists = selection.map === 'tempo'
      ? project.tempoMap.some((event) => event.id === selection.eventId)
      : project.timeSignatureMap.some(
          (event) => event.id === selection.eventId,
        );
    if (!exists) {
      setSelection(null);
      setDraft(null);
    }
  }, [project.tempoMap, project.timeSignatureMap, selection]);

  useEffect(() => {
    if (selectedTempo !== null) {
      setDraft(tempoDraft(selectedTempo));
      return;
    }
    if (selectedTimeSignature !== null) {
      setDraft(timeSignatureDraft(selectedTimeSignature));
      return;
    }
    setDraft(null);
  }, [
    selectedTempo?.beat,
    selectedTempo?.bpm,
    selectedTempo?.id,
    selectedTimeSignature?.beat,
    selectedTimeSignature?.denominator,
    selectedTimeSignature?.id,
    selectedTimeSignature?.numerator,
  ]);

  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget.map === 'tempo-add') {
      tempoAddRef.current?.focus();
    } else if (focusTarget.map === 'time-signature-add') {
      signatureAddRef.current?.focus();
    } else if ('eventId' in focusTarget) {
      markerRefs.current
        .get(markerRefKey(focusTarget.map, focusTarget.eventId))
        ?.focus();
    }
    setFocusTarget(null);
  }, [focusTarget, project.tempoMap, project.timeSignatureMap]);

  useEffect(() => {
    const element = timelineScrollRef.current;
    if (element === null) return;
    const measure = (): void => {
      const next = {
        scrollLeft: element.scrollLeft,
        width: element.clientWidth,
      };
      setViewport((current) =>
        current.scrollLeft === next.scrollLeft
        && current.width === next.width
          ? current
          : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasWidth]);

  const commandFailed = (
    result: Extract<StudioTempoMapCommandResult, { ok: false }>,
  ): void => {
    setNotice({
      kind: 'error',
      message: studioTempoMapErrorMessage(result.code),
    });
  };

  const selectAndFocus = (next: TempoMapSelection): void => {
    setSelection(next);
    setFocusTarget(next);
  };

  const addTempoAtPlayhead = (): void => {
    if (disabled) return;
    const existing = tempoMapEventAtBeat(
      project.tempoMap,
      safePlayheadBeat,
    );
    if (existing !== undefined) {
      selectAndFocus({ map: 'tempo', eventId: existing.id });
      setNotice({
        kind: 'status',
        message: 'この再生位置にはテンポがあります。既存のテンポを選択しました。',
      });
      return;
    }
    const active = effectiveTempoAtBeat(project.tempoMap, safePlayheadBeat);
    const result = addStudioTempoMapEvent({
      beat: safePlayheadBeat,
      bpm: active?.bpm ?? 120,
    });
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    const next = { map: 'tempo', eventId: result.eventId } as const;
    setSelection(next);
    setFocusTarget(next);
    setNotice({
      kind: 'status',
      message: `再生位置にテンポを追加しました。${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const addTimeSignatureAtPlayhead = (): void => {
    if (disabled) return;
    const barStartBeat = tempoMapBarStartAtBeat(
      musicalTime,
      safePlayheadBeat,
    );
    const existing = tempoMapEventAtBeat(
      project.timeSignatureMap,
      barStartBeat,
    );
    if (existing !== undefined) {
      selectAndFocus({
        map: 'time-signature',
        eventId: existing.id,
      });
      setNotice({
        kind: 'status',
        message: 'この再生位置を含む小節の先頭には拍子があります。既存の拍子を選択しました。',
      });
      return;
    }
    const active = effectiveTimeSignatureAtBeat(
      project.timeSignatureMap,
      barStartBeat,
    );
    const result = addStudioTimeSignatureMapEvent({
      beat: barStartBeat,
      numerator: active?.numerator ?? 4,
      denominator: active?.denominator ?? 4,
    });
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    const next = {
      map: 'time-signature',
      eventId: result.eventId,
    } as const;
    setSelection(next);
    setFocusTarget(next);
    setNotice({
      kind: 'status',
      message: `${formatTempoMapPosition(
        musicalTime,
        barStartBeat,
      )}（再生位置を含む小節の先頭）に拍子を追加しました。${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const removeEvent = (
    map: TempoMapKind,
    eventId: string,
    beat: number,
  ): void => {
    if (disabled) return;
    if (beat === 0) {
      setNotice({
        kind: 'error',
        message: studioTempoMapErrorMessage('anchor-protected'),
      });
      return;
    }
    const nextId = map === 'tempo'
      ? nextTempoMapFocusId(project.tempoMap, eventId)
      : nextTempoMapFocusId(project.timeSignatureMap, eventId);
    const result = map === 'tempo'
      ? removeStudioTempoMapEvent(eventId)
      : removeStudioTimeSignatureMapEvent(eventId);
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    if (nextId === null) {
      setSelection(null);
      setFocusTarget({
        map: map === 'tempo' ? 'tempo-add' : 'time-signature-add',
      });
    } else {
      const next = { map, eventId: nextId } as const;
      setSelection(next);
      setFocusTarget(next);
    }
    setNotice({
      kind: 'status',
      message: `${mapName(
        map,
      )}を削除しました。「元に戻す」で復元できます。${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const applyTempoDraft = (): void => {
    if (
      disabled
      || selectedTempo === null
      || draft?.map !== 'tempo'
      || draft.eventId !== selectedTempo.id
    ) {
      return;
    }
    const beat = parseRequiredNumber(draft.beat);
    const bpm = parseRequiredNumber(draft.bpm);
    if (
      beat === null
      || !isEditableMapBeat(beat, selectedTempo.beat, lengthBeats)
    ) {
      setNotice({
        kind: 'error',
        message: `位置は0拍以上、${formatTempoMapBeat(
          lengthBeats,
        )}拍より前の数字で入力してください。変更は反映されていません。`,
      });
      return;
    }
    if (bpm === null || bpm < 20 || bpm > 300) {
      setNotice({
        kind: 'error',
        message: 'テンポは20〜300 BPMの範囲で入力してください。変更は反映されていません。',
      });
      return;
    }
    const result = updateStudioTempoMapEvent(selectedTempo.id, {
      ...(selectedTempo.beat === 0 ? {} : { beat }),
      bpm,
    });
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    setNotice({
      kind: 'status',
      message: `${result.changed
        ? 'テンポの位置と値を更新しました。'
        : 'テンポはすでに入力どおりです。'}${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const applyTimeSignatureDraft = (): void => {
    if (
      disabled
      || selectedTimeSignature === null
      || draft?.map !== 'time-signature'
      || draft.eventId !== selectedTimeSignature.id
    ) {
      return;
    }
    const beat = parseRequiredNumber(draft.beat);
    const numerator = parseRequiredNumber(draft.numerator);
    const denominator = parseRequiredNumber(draft.denominator);
    if (
      beat === null
      || !isEditableMapBeat(
        beat,
        selectedTimeSignature.beat,
        lengthBeats,
      )
    ) {
      setNotice({
        kind: 'error',
        message: `位置は0拍以上、${formatTempoMapBeat(
          lengthBeats,
        )}拍より前の数字で入力してください。変更は反映されていません。`,
      });
      return;
    }
    if (
      numerator === null
      || !Number.isInteger(numerator)
      || numerator < 1
      || numerator > 32
      || denominator === null
      || !DENOMINATORS.includes(
        denominator as (typeof DENOMINATORS)[number],
      )
    ) {
      setNotice({
        kind: 'error',
        message: '拍子は分子を1〜32の整数、分母を2・4・8・16から選んでください。変更は反映されていません。',
      });
      return;
    }
    const result = updateStudioTimeSignatureMapEvent(
      selectedTimeSignature.id,
      {
        ...(selectedTimeSignature.beat === 0 ? {} : { beat }),
        numerator,
        denominator,
      },
    );
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    setNotice({
      kind: 'status',
      message: `${result.changed
        ? '拍子の位置と値を更新しました。'
        : '拍子はすでに入力どおりです。'}${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const selectEventByIndex = (
    map: TempoMapKind,
    index: number,
  ): void => {
    const events = map === 'tempo'
      ? project.tempoMap
      : project.timeSignatureMap;
    const event = events[index];
    if (event !== undefined) {
      selectAndFocus({ map, eventId: event.id });
    }
  };

  const handleMarkerKeyDown = (
    keyboardEvent: KeyboardEvent<HTMLButtonElement>,
    map: TempoMapKind,
    event: TempoMapEvent | TimeSignatureMapEvent,
    index: number,
  ): void => {
    if (keyboardEvent.repeat) return;
    const eventCount = map === 'tempo'
      ? project.tempoMap.length
      : project.timeSignatureMap.length;
    if (
      keyboardEvent.key === 'ArrowLeft'
      || keyboardEvent.key === 'PageUp'
    ) {
      keyboardEvent.preventDefault();
      selectEventByIndex(map, Math.max(0, index - 1));
      return;
    }
    if (
      keyboardEvent.key === 'ArrowRight'
      || keyboardEvent.key === 'PageDown'
    ) {
      keyboardEvent.preventDefault();
      selectEventByIndex(map, Math.min(eventCount - 1, index + 1));
      return;
    }
    if (keyboardEvent.key === 'Home') {
      keyboardEvent.preventDefault();
      selectEventByIndex(map, 0);
      return;
    }
    if (keyboardEvent.key === 'End') {
      keyboardEvent.preventDefault();
      selectEventByIndex(map, eventCount - 1);
      return;
    }
    if (
      keyboardEvent.key === 'Delete'
      || keyboardEvent.key === 'Backspace'
    ) {
      keyboardEvent.preventDefault();
      removeEvent(map, event.id, event.beat);
    }
  };

  return (
    <section
      className="tempo-map-editor"
      aria-labelledby="tempo-map-editor-title"
      data-tempo-map-disabled={disabled ? 'true' : 'false'}
    >
      <header className="tempo-map-editor__header">
        <div>
          <p className="tempo-map-editor__eyebrow">曲全体の時間設計</p>
          <h3 id="tempo-map-editor-title">テンポ / 拍子</h3>
          <p>
            テンポの段差と拍子の切り替わりを、同じ小節位置で確認できます。
          </p>
        </div>
        <output
          className="tempo-map-editor__playhead-readout"
          aria-label="現在の再生位置"
        >
          再生位置 {formatTempoMapPosition(musicalTime, safePlayheadBeat)}
        </output>
      </header>

      <div
        className="tempo-map-editor__toolbar"
        role="group"
        aria-label="テンポと拍子の追加"
      >
        <button
          ref={tempoAddRef}
          type="button"
          className="tempo-map-editor__primary"
          disabled={disabled}
          onClick={addTempoAtPlayhead}
        >
          再生位置にテンポを追加
        </button>
        <button
          ref={signatureAddRef}
          type="button"
          disabled={disabled}
          onClick={addTimeSignatureAtPlayhead}
        >
          再生位置に拍子を追加
        </button>
        {disabled ? (
          <span className="tempo-map-editor__busy" role="status">
            {audioRecordingOperationId !== null
              ? '録音中はテンポと拍子を編集できません。'
              : 'プロジェクト処理中はテンポと拍子を編集できません。'}
          </span>
        ) : null}
      </div>

      <p id="tempo-map-editor-help" className="tempo-map-editor__hint">
        マーカーを選ぶと下に編集欄が開きます。拍子の位置は小節の先頭に設定してください。
      </p>

      <div
        ref={timelineScrollRef}
        className="tempo-map-editor__timeline-scroll"
        data-horizontal-scroll="timeline-only"
        data-tempo-total-events={
          project.tempoMap.length + project.timeSignatureMap.length
        }
        data-tempo-rendered-events={
          renderedTempoEvents.length + renderedSignatureEvents.length
        }
        aria-label="テンポと拍子のタイムライン"
        tabIndex={0}
        onScroll={(event) => {
          setViewport({
            scrollLeft: event.currentTarget.scrollLeft,
            width: event.currentTarget.clientWidth,
          });
        }}
      >
        <div
          className="tempo-map-editor__timeline"
          style={{ width: `${canvasWidth}px` }}
        >
          <div className="tempo-map-editor__ruler" aria-hidden="true">
            {barMarkers.map((marker) => (
              <span
                key={marker.bar}
                className="tempo-map-editor__bar-label"
                style={{ left: `${marker.x}px` }}
              >
                {marker.bar + 1}
              </span>
            ))}
          </div>

          <div className="tempo-map-editor__bar-grid" aria-hidden="true">
            {barMarkers.map((marker) => (
              <span
                key={marker.bar}
                className="tempo-map-editor__bar-line"
                style={{ left: `${marker.x}px` }}
              />
            ))}
          </div>

          <div
            className="tempo-map-editor__lane tempo-map-editor__lane--tempo"
            role="group"
            aria-label="テンポレーン"
            aria-describedby="tempo-map-editor-help"
          >
            <span className="tempo-map-editor__lane-label" aria-hidden="true">
              BPM
            </span>
            <div
              className="tempo-map-editor__tempo-steps"
              aria-hidden="true"
            >
              {tempoRegions.map((region) => {
                const startX = tempoMapBeatToX(
                  region.startBeat,
                  lengthBeats,
                  canvasWidth,
                );
                const endX = tempoMapBeatToX(
                  region.endBeat,
                  lengthBeats,
                  canvasWidth,
                );
                return (
                  <span
                    key={region.eventId}
                    className="tempo-map-editor__tempo-step"
                    data-bpm={region.bpm}
                    style={{
                      left: `${startX}px`,
                      width: `${Math.max(1, endX - startX)}px`,
                    }}
                  >
                    {formatTempoMapBeat(region.bpm)}
                  </span>
                );
              })}
            </div>
            {renderedTempoEvents.map(({ event, fullIndex }, renderIndex) => {
              const selected =
                selection?.map === 'tempo'
                && selection.eventId === event.id;
              return (
                <button
                  key={event.id}
                  ref={(element) => {
                    const key = markerRefKey('tempo', event.id);
                    if (element !== null) markerRefs.current.set(key, element);
                    else markerRefs.current.delete(key);
                  }}
                  type="button"
                  className={`tempo-map-editor__marker tempo-map-editor__marker--tempo${selected ? ' is-selected' : ''}${event.beat === 0 ? ' is-anchor' : ''}`}
                  data-tempo-map-kind="tempo"
                  data-tempo-map-event-id={event.id}
                  data-tempo-map-anchor={event.beat === 0 ? 'true' : 'false'}
                  aria-label={tempoMapEventAriaLabel(
                    event,
                    fullIndex,
                    musicalTime,
                  )}
                  aria-pressed={selected}
                  aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown Home End Delete Backspace"
                  tabIndex={tempoMapRovingTabIndex(
                    selection,
                    'tempo',
                    event.id,
                    renderIndex,
                  )}
                  style={{
                    left: `${tempoMapBeatToX(
                      event.beat,
                      lengthBeats,
                      canvasWidth,
                    )}px`,
                  }}
                  onClick={() => setSelection({
                    map: 'tempo',
                    eventId: event.id,
                  })}
                  onKeyDown={(keyboardEvent) =>
                    handleMarkerKeyDown(
                      keyboardEvent,
                      'tempo',
                      event,
                      fullIndex,
                    )
                  }
                >
                  <span aria-hidden="true">
                    {formatTempoMapBeat(event.bpm)}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            className="tempo-map-editor__lane tempo-map-editor__lane--signature"
            role="group"
            aria-label="拍子レーン"
            aria-describedby="tempo-map-editor-help"
          >
            <span className="tempo-map-editor__lane-label" aria-hidden="true">
              拍子
            </span>
            {renderedSignatureEvents.map(
              ({ event, fullIndex }, renderIndex) => {
              const selected =
                selection?.map === 'time-signature'
                && selection.eventId === event.id;
              return (
                <button
                  key={event.id}
                  ref={(element) => {
                    const key = markerRefKey('time-signature', event.id);
                    if (element !== null) markerRefs.current.set(key, element);
                    else markerRefs.current.delete(key);
                  }}
                  type="button"
                  className={`tempo-map-editor__marker tempo-map-editor__marker--signature${selected ? ' is-selected' : ''}${event.beat === 0 ? ' is-anchor' : ''}`}
                  data-tempo-map-kind="time-signature"
                  data-tempo-map-event-id={event.id}
                  data-tempo-map-anchor={event.beat === 0 ? 'true' : 'false'}
                  aria-label={timeSignatureMapEventAriaLabel(
                    event,
                    fullIndex,
                    musicalTime,
                  )}
                  aria-pressed={selected}
                  aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown Home End Delete Backspace"
                  tabIndex={tempoMapRovingTabIndex(
                    selection,
                    'time-signature',
                    event.id,
                    renderIndex,
                  )}
                  style={{
                    left: `${tempoMapBeatToX(
                      event.beat,
                      lengthBeats,
                      canvasWidth,
                    )}px`,
                  }}
                  onClick={() => setSelection({
                    map: 'time-signature',
                    eventId: event.id,
                  })}
                  onKeyDown={(keyboardEvent) =>
                    handleMarkerKeyDown(
                      keyboardEvent,
                      'time-signature',
                      event,
                      fullIndex,
                    )
                  }
                >
                  <span aria-hidden="true">
                    {event.numerator}/{event.denominator}
                  </span>
                </button>
                );
              },
            )}
          </div>

          <span
            className="tempo-map-editor__playhead"
            data-tempo-map-playhead-beat={safePlayheadBeat}
            style={{ left: `${playheadX}px` }}
            aria-hidden="true"
          />
        </div>
      </div>

      {renderedTempoEvents.length < project.tempoMap.length
      || renderedSignatureEvents.length < project.timeSignatureMap.length ? (
        <p className="tempo-map-editor__hint" role="status">
          全イベントのうち、現在の表示範囲と選択中の項目を操作用に表示しています。
        </p>
        ) : null}

      {selectedTempo !== null
      && draft?.map === 'tempo'
      && draft.eventId === selectedTempo.id ? (
        <fieldset
          className="tempo-map-editor__inspector"
          aria-label="テンポ編集"
        >
          <legend>選択中のテンポ</legend>
          <label>
            位置（四分音符の拍）
            <input
              type="number"
              min={0}
              max={
                selectedTempo.beat === lengthBeats
                  ? lengthBeats
                  : exclusiveEndInputMax(lengthBeats)
              }
              step={0.001}
              value={selectedTempo.beat === 0 ? '0' : draft.beat}
              disabled={disabled || selectedTempo.beat === 0}
              aria-describedby={
                selectedTempo.beat === 0
                  ? 'tempo-map-anchor-help'
                  : undefined
              }
              onChange={(event) => setDraft({
                ...draft,
                beat: event.currentTarget.value,
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyTempoDraft();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(tempoDraft(selectedTempo));
                }
              }}
            />
          </label>
          <label>
            テンポ（BPM）
            <input
              type="number"
              min={20}
              max={300}
              step={0.1}
              value={draft.bpm}
              disabled={disabled}
              onChange={(event) => setDraft({
                ...draft,
                bpm: event.currentTarget.value,
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyTempoDraft();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(tempoDraft(selectedTempo));
                }
              }}
            />
          </label>
          {selectedTempo.beat === 0 ? (
            <p id="tempo-map-anchor-help" className="tempo-map-editor__anchor-help">
              曲の先頭に固定されています。BPMは変更できます。
            </p>
          ) : (
            <output>
              {formatTempoMapPosition(musicalTime, selectedTempo.beat)}
            </output>
          )}
          <button
            type="button"
            className="tempo-map-editor__primary"
            disabled={disabled}
            onClick={applyTempoDraft}
          >
            変更を反映
          </button>
          <button
            type="button"
            className="tempo-map-editor__delete"
            disabled={disabled || selectedTempo.beat === 0}
            onClick={() => removeEvent(
              'tempo',
              selectedTempo.id,
              selectedTempo.beat,
            )}
          >
            このテンポを削除
          </button>
        </fieldset>
        ) : null}

      {selectedTimeSignature !== null
      && draft?.map === 'time-signature'
      && draft.eventId === selectedTimeSignature.id ? (
        <fieldset
          className="tempo-map-editor__inspector"
          aria-label="拍子編集"
        >
          <legend>選択中の拍子</legend>
          <label>
            位置（四分音符の拍）
            <input
              type="number"
              min={0}
              max={
                selectedTimeSignature.beat === lengthBeats
                  ? lengthBeats
                  : exclusiveEndInputMax(lengthBeats)
              }
              step={0.001}
              value={
                selectedTimeSignature.beat === 0 ? '0' : draft.beat
              }
              disabled={disabled || selectedTimeSignature.beat === 0}
              aria-describedby={
                selectedTimeSignature.beat === 0
                  ? 'tempo-map-anchor-help'
                  : undefined
              }
              onChange={(event) => setDraft({
                ...draft,
                beat: event.currentTarget.value,
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyTimeSignatureDraft();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(timeSignatureDraft(selectedTimeSignature));
                }
              }}
            />
          </label>
          <label>
            分子
            <input
              type="number"
              min={1}
              max={32}
              step={1}
              value={draft.numerator}
              disabled={disabled}
              onChange={(event) => setDraft({
                ...draft,
                numerator: event.currentTarget.value,
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyTimeSignatureDraft();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(timeSignatureDraft(selectedTimeSignature));
                }
              }}
            />
          </label>
          <label>
            分母
            <select
              value={draft.denominator}
              disabled={disabled}
              onChange={(event) => setDraft({
                ...draft,
                denominator: event.currentTarget.value,
              })}
            >
              {DENOMINATORS.map((denominator) => (
                <option key={denominator} value={denominator}>
                  {denominator}
                </option>
              ))}
            </select>
          </label>
          {selectedTimeSignature.beat === 0 ? (
            <p id="tempo-map-anchor-help" className="tempo-map-editor__anchor-help">
              曲の先頭に固定されています。拍子の値は変更できます。
            </p>
          ) : (
            <output>
              {formatTempoMapPosition(
                musicalTime,
                selectedTimeSignature.beat,
              )}
            </output>
          )}
          <button
            type="button"
            className="tempo-map-editor__primary"
            disabled={disabled}
            onClick={applyTimeSignatureDraft}
          >
            変更を反映
          </button>
          <button
            type="button"
            className="tempo-map-editor__delete"
            disabled={disabled || selectedTimeSignature.beat === 0}
            onClick={() => removeEvent(
              'time-signature',
              selectedTimeSignature.id,
              selectedTimeSignature.beat,
            )}
          >
            この拍子を削除
          </button>
        </fieldset>
        ) : null}

      {selection === null ? (
        <div className="tempo-map-editor__empty-selection" role="status">
          <p>テンポまたは拍子のマーカーを選ぶと、位置と値を編集できます。</p>
          <p>曲の先頭の2項目は固定ですが、BPMと拍子の値は変更できます。</p>
        </div>
      ) : null}

      <details className="tempo-map-editor__keyboard">
        <summary>キーボード操作</summary>
        <p>
          左右矢印またはPageUp / PageDownで同じレーンの前後、Home /
          Endで最初と最後へ移動します。DeleteまたはBackspaceで、先頭以外の項目を削除できます。
        </p>
      </details>

      <p
        className={`tempo-map-editor__notice${notice?.kind === 'error' ? ' is-error' : ''}`}
        role={notice?.kind === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        aria-atomic="true"
      >
        {notice?.message
          ?? '変更内容はプロジェクトに保存され、再生と書き出しに反映されます。'}
      </p>
    </section>
  );
}
