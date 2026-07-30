import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  automationTargetTypesForTrack,
  effectiveMasterTrackId,
  isSupportedAutomationTarget,
  type AutomationInterpolation,
  type AutomationPoint,
  type AutomationTarget,
  type AutomationWriteMode,
} from '@cts/project-model';
import { automationValueAt } from '../../audio/automation';
import {
  addStudioAutomationPoint,
  clearStudioAutomationLane,
  removeStudioAutomationPoint,
  setStudioAutomationLaneBypassed,
  setStudioGlobalAutomationReadEnabled,
  setStudioTrackAutomationReadEnabled,
  studioAutomationErrorMessage,
  updateStudioAutomationPoint,
} from '../../state/automationActions';
import { useStore } from '../../state/store';
import {
  AUTOMATION_LANE_HEIGHT,
  AUTOMATION_LANE_MIN_WIDTH,
  AUTOMATION_POINT_SIZE,
  AUTOMATION_SNAP_OPTIONS,
  AUTOMATION_TARGETS,
  automationBeatFromClientX,
  automationBeatToX,
  automationCurveSegmentsToSvgPaths,
  automationDisplayValueToModel,
  automationInterpolationLabel,
  automationPointAriaLabel,
  automationTargetPresentation,
  automationWriteConfirmationDescription,
  automationValueToDisplay,
  automationValueFromClientY,
  automationValueToY,
  buildAutomationCurveSegments,
  clampAutomationBeat,
  clampAutomationValue,
  formatAutomationBeat,
  formatAutomationValue,
  resolveAutomationTargetType,
  selectAutomationPointsForViewport,
  snapAutomationBeat,
  type AutomationTargetType,
} from './automationLanePresentation';

const DRAWING_INSET = AUTOMATION_POINT_SIZE / 2;
const DEFAULT_SNAP_BEATS = 0.25;
const KEYBOARD_VALUE_STEP = 0.05;
const VIEWPORT_POINT_BUFFER_PX = AUTOMATION_POINT_SIZE * 2;
const AUTOMATION_WRITE_MODES: readonly AutomationWriteMode[] = [
  'read',
  'touch',
  'latch',
  'write',
];

function automationModeLabel(mode: AutomationWriteMode): string {
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}

type Notice = Readonly<{
  kind: 'error' | 'status';
  message: string;
}>;

type PointDraft = Readonly<{
  beat: string;
  value: string;
  interpolation: AutomationInterpolation;
  dirtyBeat: boolean;
  dirtyValue: boolean;
}>;

type DragPreview = Readonly<{
  pointId: string;
  pointerId: number;
  beat: number;
  value: number;
  moved: boolean;
}>;

function resultPointId(result: { readonly ok: true }): string | null {
  if (!('pointId' in result)) return null;
  return typeof result.pointId === 'string' ? result.pointId : null;
}

function stoppedSuffix(playbackStopped: boolean): string {
  return playbackStopped
    ? ' オートメーションを安全に更新するため再生を停止しました。'
    : '';
}

function draftForPoint(
  point: AutomationPoint,
  targetType: AutomationTargetType,
): PointDraft {
  return {
    beat: point.beat.toString(),
    value: Number(
      automationValueToDisplay(point.value, targetType).toFixed(2),
    ).toString(),
    interpolation: point.interpolation,
    dirtyBeat: false,
    dirtyValue: false,
  };
}

function projectGridBeats(lengthBeats: number): readonly number[] {
  if (!(lengthBeats > 0)) return [0];
  const minimumSpacing = Math.max(1, Math.ceil(lengthBeats / 32));
  const spacing = Math.max(4, Math.ceil(minimumSpacing / 4) * 4);
  const beats: number[] = [];
  for (let beat = 0; beat <= lengthBeats; beat += spacing) beats.push(beat);
  if (beats[beats.length - 1] !== lengthBeats) beats.push(lengthBeats);
  return beats;
}

function targetBaseValue(
  targetType: AutomationTargetType,
  volume: number,
  pan: number,
): number {
  return targetType === 'track-volume' ? volume : pan;
}

function AutomationPlayhead({
  lengthBeats,
  innerWidth,
  innerHeight,
}: Readonly<{
  lengthBeats: number;
  innerWidth: number;
  innerHeight: number;
}>) {
  const positionBeat = useStore((state) => state.transport.positionBeat);
  const x =
    DRAWING_INSET
    + automationBeatToX(positionBeat, lengthBeats, innerWidth);
  return (
    <line
      className="automation-lane__playhead"
      data-automation-playhead-beat={positionBeat}
      x1={x}
      x2={x}
      y1={DRAWING_INSET}
      y2={DRAWING_INSET + innerHeight}
    />
  );
}

export function AutomationLaneEditor() {
  const project = useStore((state) => state.project);
  const selectedTrackId = useStore((state) => state.editor.selectedTrackId);
  const projectOperationBusy = useStore((state) => state.projectOperationBusy);
  const audioRecordingOperationId = useStore(
    (state) => state.audioRecordingOperationId,
  );
  const undo = useStore((state) => state.undo);
  const redo = useStore((state) => state.redo);
  const canUndo = useStore((state) => state.canUndo);
  const canRedo = useStore((state) => state.canRedo);
  const automationRecording = useStore(
    (state) => state.automationRecording,
  );
  const setTrackAutomationMode = useStore(
    (state) => state.setTrackAutomationMode,
  );

  const [requestedTargetType, setTargetType] =
    useState<AutomationTargetType>('track-volume');
  const [snapBeats, setSnapBeats] = useState(DEFAULT_SNAP_BEATS);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PointDraft | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | 'add' | null>(null);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [writeConfirmationOpen, setWriteConfirmationOpen] = useState(false);
  const [viewport, setViewport] = useState({
    scrollLeft: 0,
    width: AUTOMATION_LANE_MIN_WIDTH,
  });

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const addAtPlayheadRef = useRef<HTMLButtonElement | null>(null);
  const clearLaneButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmClearButtonRef = useRef<HTMLButtonElement | null>(null);
  const writeModeButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmWriteButtonRef = useRef<HTMLButtonElement | null>(null);
  const pointRefs = useRef(new Map<string, HTMLButtonElement>());

  const selectedTrack =
    project.tracks.find((track) => track.id === selectedTrackId) ?? null;
  const effectiveMasterId = effectiveMasterTrackId(project);
  const isEffectiveMaster =
    selectedTrack?.type === 'master' && selectedTrack.id === effectiveMasterId;
  const supportedTargetTypes = selectedTrack === null
    ? []
    : automationTargetTypesForTrack(project, selectedTrack.id);
  const targetType = resolveAutomationTargetType(
    requestedTargetType,
    supportedTargetTypes,
  );
  const targetPresentation = automationTargetPresentation(
    targetType,
    isEffectiveMaster,
  );
  const lane =
    selectedTrack === null
      ? null
      : project.automationLanes.find(
          (candidate) =>
            candidate.target.trackId === selectedTrack.id
            && candidate.target.type === targetType,
        ) ?? null;
  const baseValue =
    selectedTrack === null
      ? targetPresentation.min
      : targetBaseValue(
          targetType,
          selectedTrack.volume,
          selectedTrack.pan,
        );
  const disabled =
    projectOperationBusy || audioRecordingOperationId !== null;
  const globalReadEnabled = project.automationReadState.globalEnabled;
  const trackReadEnabled = selectedTrack === null
    ? false
    : !project.automationReadState.disabledTrackIds.includes(selectedTrack.id);
  const selectedTrackMode: AutomationWriteMode = selectedTrack === null
    ? 'read'
    : automationRecording.trackModes[selectedTrack.id] ?? 'read';
  const selectedTrackWriting = selectedTrack === null
    ? false
    : automationRecording.writingTrackIds.includes(selectedTrack.id);
  const selectedTrackArmed =
    selectedTrackMode !== 'read' && !selectedTrackWriting;
  const lengthBeats = Math.max(0, project.lengthBeats);
  const canvasWidth = Math.max(
    AUTOMATION_LANE_MIN_WIDTH,
    Math.ceil(lengthBeats * 32) + AUTOMATION_POINT_SIZE,
  );
  const innerWidth = canvasWidth - AUTOMATION_POINT_SIZE;
  const innerHeight = AUTOMATION_LANE_HEIGHT - AUTOMATION_POINT_SIZE;

  const selectedPoint =
    lane?.points.find((point) => point.id === selectedPointId) ?? null;
  const curveSegments = useMemo(
    () => buildAutomationCurveSegments(
      lane?.points ?? [],
      baseValue,
      lengthBeats,
    ),
    [baseValue, lane?.points, lengthBeats],
  );
  const curvePaths = useMemo(
    () =>
      automationCurveSegmentsToSvgPaths(curveSegments, {
        targetType,
        lengthBeats,
        width: innerWidth,
        height: innerHeight,
        offsetX: DRAWING_INSET,
        offsetY: DRAWING_INSET,
      }),
    [curveSegments, innerHeight, innerWidth, lengthBeats, targetType],
  );
  const viewportStartBeat = automationBeatFromClientX(
    viewport.scrollLeft - DRAWING_INSET - VIEWPORT_POINT_BUFFER_PX,
    0,
    innerWidth,
    lengthBeats,
  );
  const viewportEndBeat = automationBeatFromClientX(
    viewport.scrollLeft
      + viewport.width
      - DRAWING_INSET
      + VIEWPORT_POINT_BUFFER_PX,
    0,
    innerWidth,
    lengthBeats,
  );
  const renderedPoints = useMemo(
    () =>
      selectAutomationPointsForViewport(lane?.points ?? [], {
        startBeat: viewportStartBeat,
        endBeat: viewportEndBeat,
        selectedPointId,
      }),
    [
      lane?.points,
      selectedPointId,
      viewportEndBeat,
      viewportStartBeat,
    ],
  );
  const gridBeats = useMemo(
    () => projectGridBeats(lengthBeats),
    [lengthBeats],
  );

  useEffect(() => {
    if (selectedTrack?.type === 'master') {
      setTargetType('track-volume');
    }
    setSelectedPointId(null);
    setDraft(null);
    setDragPreview(null);
    setNotice(null);
    setClearConfirmationOpen(false);
    setWriteConfirmationOpen(false);
  }, [selectedTrack?.type, selectedTrackId]);

  useEffect(() => {
    setClearConfirmationOpen(false);
  }, [lane?.id, targetType]);

  useEffect(() => {
    if (
      selectedPointId !== null
      && !lane?.points.some((point) => point.id === selectedPointId)
    ) {
      setSelectedPointId(null);
      setDraft(null);
    }
  }, [lane, selectedPointId]);

  useEffect(() => {
    setDraft(
      selectedPoint === null
        ? null
        : draftForPoint(selectedPoint, targetType),
    );
  }, [
    selectedPoint?.beat,
    selectedPoint?.id,
    selectedPoint?.interpolation,
    selectedPoint?.value,
    targetType,
  ]);

  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget === 'add') {
      addAtPlayheadRef.current?.focus();
    } else {
      pointRefs.current.get(focusTarget)?.focus();
    }
    setFocusTarget(null);
  }, [focusTarget, lane?.points]);

  useEffect(() => {
    if (clearConfirmationOpen) confirmClearButtonRef.current?.focus();
  }, [clearConfirmationOpen]);

  useEffect(() => {
    if (writeConfirmationOpen) confirmWriteButtonRef.current?.focus();
  }, [writeConfirmationOpen]);

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
    result: Readonly<{ ok: false; code: Parameters<typeof studioAutomationErrorMessage>[0] }>,
  ): void => {
    setNotice({
      kind: 'error',
      message: studioAutomationErrorMessage(result.code),
    });
  };

  const setReadNotice = (
    scope: 'Global' | 'Track' | 'Master',
    enabled: boolean,
    playbackStopped: boolean,
  ): void => {
    setNotice({
      kind: 'status',
      message: `${scope} Readを${enabled ? 'オン' : 'オフ'}にしました。${stoppedSuffix(
        playbackStopped,
      )}`,
    });
  };

  const setMode = (mode: AutomationWriteMode): void => {
    if (
      selectedTrack === null
      || supportedTargetTypes.length === 0
      || disabled
    ) {
      return;
    }
    if (!setTrackAutomationMode(selectedTrack.id, mode)) {
      setNotice({
        kind: 'error',
        message: 'オートメーションモードを安全に変更できませんでした。',
      });
      return;
    }
    setNotice({
      kind: 'status',
      message:
        mode === 'read'
          ? 'Readモードです。操作は通常のトラック値として扱います。'
          : `${mode}を待機しました。再生中の操作を一括記録します。`,
    });
  };

  const addPoint = (beat: number, value: number, origin: string): void => {
    if (selectedTrack === null || disabled) {
      return;
    }
    const snappedBeat = snapAutomationBeat(beat, snapBeats, lengthBeats);
    const existing = lane?.points.find(
      (point) => Math.abs(point.beat - snappedBeat) < 0.000001,
    );
    if (existing) {
      setSelectedPointId(existing.id);
      setFocusTarget(existing.id);
      setNotice({
        kind: 'status',
        message: `拍 ${formatAutomationBeat(
          snappedBeat,
        )} には点があります。既存の点を選択しました。`,
      });
      return;
    }
    const target: AutomationTarget = {
      type: targetType,
      trackId: selectedTrack.id,
    };
    if (!isSupportedAutomationTarget(project, target)) return;
    const result = addStudioAutomationPoint(target, {
      beat: snappedBeat,
      value: clampAutomationValue(value, targetType),
      interpolation: 'linear',
    });
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    const pointId = resultPointId(result);
    setSelectedPointId(pointId);
    if (pointId !== null) setFocusTarget(pointId);
    setNotice({
      kind: 'status',
      message: `${origin}に${targetPresentation.shortLabel}の点を追加しました。${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const updatePoint = (
    pointId: string,
    patch: Partial<
      Pick<AutomationPoint, 'beat' | 'value' | 'interpolation'>
    >,
    message: string,
  ): boolean => {
    if (lane === null || disabled) return false;
    const result = updateStudioAutomationPoint(lane.id, pointId, patch);
    if (!result.ok) {
      commandFailed(result);
      return false;
    }
    setSelectedPointId(pointId);
    setNotice({
      kind: 'status',
      message: `${message}${stoppedSuffix(result.playbackStopped)}`,
    });
    return true;
  };

  const removePoint = (pointId: string): void => {
    if (lane === null || disabled) return;
    const pointIndex = lane.points.findIndex((point) => point.id === pointId);
    const nextFocus =
      lane.points[pointIndex + 1]?.id
      ?? lane.points[pointIndex - 1]?.id
      ?? 'add';
    const result = removeStudioAutomationPoint(lane.id, pointId);
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    setSelectedPointId(nextFocus === 'add' ? null : nextFocus);
    setFocusTarget(nextFocus);
    setNotice({
      kind: 'status',
      message: `オートメーション点を削除しました。「元に戻す」で復元できます。${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const clearLane = (): void => {
    if (lane === null || disabled) return;
    const result = clearStudioAutomationLane(lane.id);
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    setClearConfirmationOpen(false);
    setSelectedPointId(null);
    setDraft(null);
    setFocusTarget('add');
    setNotice({
      kind: 'status',
      message: `${targetPresentation.shortLabel}レーンをクリアしました。「元に戻す」で復元できます。${stoppedSuffix(
        result.playbackStopped,
      )}`,
    });
  };

  const toggleLaneBypassed = (): void => {
    if (lane === null || disabled) return;
    const nextBypassed = !lane.bypassed;
    const result = setStudioAutomationLaneBypassed(lane.id, nextBypassed);
    if (!result.ok) {
      commandFailed(result);
      return;
    }
    if (!result.changed) {
      setNotice({
        kind: 'status',
        message: nextBypassed
          ? 'オートメーションはすでにBypassです。点と曲線は変更されていません。'
          : 'オートメーションはすでにReadです。点と曲線は変更されていません。',
      });
      return;
    }
    setNotice({
      kind: 'status',
      message: nextBypassed
        ? `${targetPresentation.shortLabel}オートメーションをBypassにしました。点と曲線は保持され、再生とWAV書き出しでは${isEffectiveMaster ? 'Master' : 'トラック'}の現在の基準値を使います。${stoppedSuffix(
            result.playbackStopped,
          )}`
        : `${targetPresentation.shortLabel}オートメーションをReadにしました。保存している曲線を再生とWAV書き出しに反映します。${stoppedSuffix(
            result.playbackStopped,
          )}`,
    });
  };

  const commitDraft = (field: 'beat' | 'value'): void => {
    if (selectedPoint === null || draft === null) return;
    const dirty = field === 'beat' ? draft.dirtyBeat : draft.dirtyValue;
    if (!dirty) return;

    if (field === 'beat') {
      const beat = Number(draft.beat);
      if (draft.beat.trim() === '' || !Number.isFinite(beat)) {
        setNotice({
          kind: 'error',
          message: '拍を数字で入力してください。点は変更されていません。',
        });
        return;
      }
      if (beat < 0 || beat > lengthBeats) {
        setNotice({
          kind: 'error',
          message: `拍は0から${formatAutomationBeat(
            lengthBeats,
          )}までで入力してください。点は変更されていません。`,
        });
        return;
      }
      const nextBeat = snapAutomationBeat(beat, snapBeats, lengthBeats);
      if (
        updatePoint(
          selectedPoint.id,
          { beat: nextBeat },
          '選択した点の拍を更新しました。',
        )
      ) {
        setDraft({
          ...draft,
          beat: nextBeat.toString(),
          dirtyBeat: false,
        });
      }
      return;
    }

    const displayValue = Number(draft.value);
    if (draft.value.trim() === '' || !Number.isFinite(displayValue)) {
      setNotice({
        kind: 'error',
        message: '値を数字で入力してください。点は変更されていません。',
      });
      return;
    }
    const value = automationDisplayValueToModel(displayValue, targetType);
    if (
      updatePoint(
        selectedPoint.id,
        { value },
        '選択した点の値を更新しました。',
      )
    ) {
      setDraft({
        ...draft,
        value: Number(displayValue.toFixed(2)).toString(),
        dirtyValue: false,
      });
    }
  };

  const selectPointByIndex = (index: number): void => {
    const point = lane?.points[index];
    if (!point) return;
    setSelectedPointId(point.id);
    setFocusTarget(point.id);
  };

  const handlePointKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    point: AutomationPoint,
    index: number,
  ): void => {
    if (event.repeat) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        if (canRedo()) {
          redo();
          setNotice({ kind: 'status', message: '変更をやり直しました。' });
        }
      } else if (canUndo()) {
        undo();
        setNotice({ kind: 'status', message: '変更を元に戻しました。' });
      }
      return;
    }
    if (event.key === 'PageUp') {
      event.preventDefault();
      selectPointByIndex(Math.max(0, index - 1));
      return;
    }
    if (event.key === 'PageDown') {
      event.preventDefault();
      selectPointByIndex(Math.min((lane?.points.length ?? 1) - 1, index + 1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      selectPointByIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      selectPointByIndex((lane?.points.length ?? 1) - 1);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removePoint(point.id);
      return;
    }

    const beatStep = snapBeats > 0 ? snapBeats : DEFAULT_SNAP_BEATS;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      updatePoint(
        point.id,
        {
          beat: snapAutomationBeat(
            point.beat + direction * beatStep,
            snapBeats,
            lengthBeats,
          ),
        },
        `点を${direction < 0 ? '前' : '後ろ'}へ移動しました。`,
      );
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? -1 : 1;
      const valueStep =
        KEYBOARD_VALUE_STEP * (event.shiftKey ? 10 : 1);
      updatePoint(
        point.id,
        {
          value: clampAutomationValue(
            point.value + direction * valueStep,
            targetType,
          ),
        },
        `${targetPresentation.shortLabel}を調整しました。`,
      );
    }
  };

  const pointFromPointer = (
    event: Pick<PointerEvent<HTMLElement>, 'clientX' | 'clientY'>,
  ): Readonly<{ beat: number; value: number }> | null => {
    const timeline = timelineRef.current;
    if (timeline === null) return null;
    const rect = timeline.getBoundingClientRect();
    return {
      beat: snapAutomationBeat(
        automationBeatFromClientX(
          event.clientX,
          rect.left + DRAWING_INSET,
          innerWidth,
          lengthBeats,
        ),
        snapBeats,
        lengthBeats,
      ),
      value: clampAutomationValue(
        automationValueFromClientY(
          event.clientY,
          rect.top + DRAWING_INSET,
          innerHeight,
          targetType,
        ),
        targetType,
      ),
    };
  };

  if (selectedTrack === null) {
    return (
      <section className="automation-lane automation-lane--message" aria-labelledby="automation-lane-title">
        <h3 id="automation-lane-title">オートメーション</h3>
        <p>左のトラック一覧から編集するトラックを選択してください。</p>
      </section>
    );
  }

  if (selectedTrack.type === 'master' && !isEffectiveMaster) {
    return (
      <section className="automation-lane automation-lane--message" aria-labelledby="automation-lane-title">
        <h3 id="automation-lane-title">オートメーション</h3>
        <p>この追加Masterはオートメーションに対応していません。先頭のMaster、通常トラック、またはBusを選択してください。</p>
      </section>
    );
  }

  return (
    <section
      className={`automation-lane${lane?.bypassed ? ' is-bypassed' : ''}`}
      data-automation-read-state={
        lane === null ? 'empty' : lane.bypassed ? 'bypassed' : 'read'
      }
      data-global-read={globalReadEnabled ? 'on' : 'off'}
      data-track-read={trackReadEnabled ? 'on' : 'off'}
      aria-labelledby="automation-lane-title"
    >
      <header className="automation-lane__header">
        <div>
          <p className="automation-lane__eyebrow">選択トラック</p>
          <h3 id="automation-lane-title">{selectedTrack.name}のオートメーション</h3>
        </div>
        <div
          className="automation-lane__target"
          role="group"
          aria-label="オートメーション対象"
        >
          {supportedTargetTypes.map(
            (type) => (
              <button
                type="button"
                key={type}
                className={targetType === type ? 'is-active' : ''}
                aria-pressed={targetType === type}
                disabled={disabled}
                onClick={() => {
                  setTargetType(type);
                  setSelectedPointId(null);
                  setDraft(null);
                  setNotice(null);
                  setClearConfirmationOpen(false);
                }}
              >
                {automationTargetPresentation(type, isEffectiveMaster).shortLabel}
              </button>
            ),
          )}
        </div>
      </header>

      <div
        className="automation-lane__automation-controls"
        aria-label="オートメーションのReadと記録"
      >
        <div
          className="automation-lane__read-gates"
          role="group"
          aria-label="Read設定"
        >
          <button
            type="button"
            className={globalReadEnabled ? 'is-active' : ''}
            aria-pressed={globalReadEnabled}
            disabled={disabled}
            onClick={() => {
              const result = setStudioGlobalAutomationReadEnabled(
                !globalReadEnabled,
              );
              if (!result.ok) {
                commandFailed(result);
                return;
              }
              setReadNotice(
                'Global',
                !globalReadEnabled,
                result.playbackStopped,
              );
            }}
          >
            Global Read: {globalReadEnabled ? 'オン' : 'オフ'}
          </button>
          <button
            type="button"
            className={trackReadEnabled ? 'is-active' : ''}
            aria-pressed={trackReadEnabled}
            disabled={disabled}
            onClick={() => {
              const result = setStudioTrackAutomationReadEnabled(
                selectedTrack.id,
                !trackReadEnabled,
              );
              if (!result.ok) {
                commandFailed(result);
                return;
              }
              setReadNotice(
                isEffectiveMaster ? 'Master' : 'Track',
                !trackReadEnabled,
                result.playbackStopped,
              );
            }}
          >
            {isEffectiveMaster ? 'Master' : 'Track'} Read: {trackReadEnabled ? 'オン' : 'オフ'}
          </button>
        </div>

        <div
          className="automation-lane__mode-selector"
          role="radiogroup"
          aria-label={`${selectedTrack.name} 記録モード`}
        >
          {AUTOMATION_WRITE_MODES.map((mode) => (
            <button
              key={mode}
              ref={mode === 'write' ? writeModeButtonRef : undefined}
              type="button"
              role="radio"
              aria-checked={selectedTrackMode === mode}
              className={selectedTrackMode === mode ? 'is-active' : ''}
              disabled={disabled}
              onClick={() => {
                if (mode === 'write') {
                  setWriteConfirmationOpen(true);
                  return;
                }
                setMode(mode);
              }}
            >
              {automationModeLabel(mode)}
            </button>
          ))}
        </div>

        <p
          className={`automation-lane__write-status${
            selectedTrackWriting
              ? ' is-writing'
              : selectedTrackArmed
                ? ' is-armed'
                : ' is-read'
          }`}
          role="status"
          aria-live="polite"
          data-automation-write-status={
            selectedTrackWriting
              ? 'writing'
              : selectedTrackArmed
                ? 'armed'
                : 'read'
          }
        >
          <strong>
            {selectedTrackWriting
              ? '記録中（Writing）'
              : selectedTrackArmed
                ? '待機中（Armed）'
                : '読み取り（Read）'}
          </strong>
          {' — '}
          {automationModeLabel(selectedTrackMode)}
        </p>
      </div>

      {automationRecording.passActive && automationRecording.status ? (
        <div
          className="automation-lane__recording-recovery"
          role="alert"
          aria-live="assertive"
        >
          <p>
            <strong>オートメーション記録を確定できませんでした。</strong>{' '}
            {automationRecording.status.message}
          </p>
          <button
            type="button"
            onClick={() => {
              const store = useStore.getState();
              if (!store.cancelAutomationRecording()) {
                setNotice({
                  kind: 'error',
                  message:
                    '記録を安全に破棄できませんでした。プロジェクトを切り替えず、もう一度お試しください。',
                });
                return;
              }
              useStore.getState().stop();
              setNotice({
                kind: 'status',
                message:
                  '未確定のオートメーション記録を破棄して、再生を停止しました。',
              });
            }}
          >
            記録を破棄して停止
          </button>
        </div>
      ) : null}

      {writeConfirmationOpen ? (
        <dialog
          open
          className="automation-lane__write-confirmation"
          aria-labelledby="automation-write-confirmation-title"
          aria-describedby="automation-write-confirmation-description"
        >
          <h4 id="automation-write-confirmation-title">
            Writeモードを有効にしますか？
          </h4>
          <p id="automation-write-confirmation-description">
            {automationWriteConfirmationDescription(isEffectiveMaster)}
          </p>
          <div>
            <button
              ref={confirmWriteButtonRef}
              type="button"
              className="automation-lane__delete"
              onClick={() => {
                setMode('write');
                setWriteConfirmationOpen(false);
                writeModeButtonRef.current?.focus();
              }}
            >
              Writeを有効にする
            </button>
            <button
              type="button"
              onClick={() => {
                setWriteConfirmationOpen(false);
                setNotice({
                  kind: 'status',
                  message: 'Writeモードへの変更をキャンセルしました。',
                });
                writeModeButtonRef.current?.focus();
              }}
            >
              キャンセル
            </button>
          </div>
        </dialog>
      ) : null}

      <div className="automation-lane__toolbar">
        <label>
          グリッド
          <select
            aria-label="オートメーショングリッド"
            value={snapBeats}
            disabled={disabled}
            onChange={(event) => setSnapBeats(Number(event.currentTarget.value))}
          >
            {AUTOMATION_SNAP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          ref={addAtPlayheadRef}
          className="automation-lane__primary"
          disabled={disabled}
          onClick={() => {
            const positionBeat = useStore.getState().transport.positionBeat;
            addPoint(
              clampAutomationBeat(positionBeat, lengthBeats),
              lane
                ? automationValueAt(lane, baseValue, positionBeat)
                : baseValue,
              '再生位置',
            );
          }}
        >
          再生位置に点を追加
        </button>
        <button
          ref={clearLaneButtonRef}
          type="button"
          disabled={disabled || lane === null || lane.points.length === 0}
          aria-expanded={clearConfirmationOpen}
          aria-controls="automation-lane-clear-confirmation"
          onClick={() => {
            setClearConfirmationOpen(true);
            setNotice({
              kind: 'status',
              message: 'レーン上のすべての点を消去するか確認してください。',
            });
          }}
        >
          レーンをクリア
        </button>
        <span className="automation-lane__base">
          基準値 {formatAutomationValue(baseValue, targetType)}
        </span>
      </div>

      <div
        className={`automation-lane__read-mode${
          lane?.bypassed ? ' is-bypassed' : ''
        }`}
      >
        {lane ? (
          <>
            <button
              type="button"
              className={`automation-lane__read-toggle ${
                lane.bypassed ? 'is-bypassed' : 'is-read'
              }`}
              data-automation-read-toggle="true"
              aria-label={`Lane Bypass: ${lane.bypassed ? 'オン' : 'オフ'}`}
              aria-pressed={lane.bypassed}
              aria-describedby="automation-lane-read-description"
              disabled={disabled}
              onClick={toggleLaneBypassed}
            >
              {lane.bypassed ? 'Bypass' : 'Read'}
            </button>
            <p id="automation-lane-read-description">
              <strong>
                {lane.bypassed
                  ? 'Lane Bypass中。'
                  : 'Lane Bypassはオフです。'}
              </strong>{' '}
              {lane.bypassed
                ? `曲線と点は保持され、再生とWAV書き出しでは${isEffectiveMaster ? 'Master' : 'トラック'}の現在の基準値を使います。点はそのまま編集できます。`
                : '曲線を再生とWAV書き出しに反映します。Bypassに切り替えても点は削除されません。'}
            </p>
          </>
        ) : (
          <p id="automation-lane-read-description">
            最初の点を追加すると、Readが有効なレーンを作成します。
          </p>
        )}
      </div>

      {clearConfirmationOpen && lane && lane.points.length > 0 ? (
        <div
          id="automation-lane-clear-confirmation"
          className="automation-lane__clear-confirmation"
          role="group"
          aria-label="レーン消去の確認"
        >
          <p>
            {targetPresentation.shortLabel}レーンの
            {lane.points.length}点をすべて消去しますか？
          </p>
          <button
            ref={confirmClearButtonRef}
            type="button"
            className="automation-lane__delete"
            disabled={disabled}
            onClick={clearLane}
          >
            クリアを確定
          </button>
          <button
            type="button"
            onClick={() => {
              setClearConfirmationOpen(false);
              setNotice({
                kind: 'status',
                message: 'レーンのクリアをキャンセルしました。点は変更されていません。',
              });
              clearLaneButtonRef.current?.focus();
            }}
          >
            キャンセル
          </button>
        </div>
      ) : null}

      <p id="automation-lane-help" className="automation-lane__hint">
        レーンをクリックすると、その位置と値に点を追加します。点はドラッグまたはキーボードでも調整できます。
      </p>

      <div
        ref={timelineScrollRef}
        className="automation-lane__timeline-scroll"
        data-horizontal-scroll="timeline-only"
        data-automation-total-points={lane?.points.length ?? 0}
        data-automation-rendered-points={renderedPoints.length}
        onScroll={(event) => {
          const element = event.currentTarget;
          setViewport({
            scrollLeft: element.scrollLeft,
            width: element.clientWidth,
          });
        }}
      >
        <div
          ref={timelineRef}
          className="automation-lane__timeline"
          role="group"
          aria-label={`${targetPresentation.label}オートメーションレーン`}
          aria-describedby="automation-lane-help automation-lane-read-description"
          tabIndex={lane?.points.length ? -1 : 0}
          style={{
            width: `${canvasWidth}px`,
            height: `${AUTOMATION_LANE_HEIGHT}px`,
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const point = pointFromPointer(event);
            if (point) addPoint(point.beat, point.value, 'レーン');
          }}
        >
          <svg
            className="automation-lane__curve"
            viewBox={`0 0 ${canvasWidth} ${AUTOMATION_LANE_HEIGHT}`}
            aria-hidden="true"
            focusable="false"
          >
            {gridBeats.map((beat) => {
              const x =
                DRAWING_INSET
                + automationBeatToX(beat, lengthBeats, innerWidth);
              return (
                <g key={beat}>
                  <line
                    className="automation-lane__grid-line"
                    x1={x}
                    x2={x}
                    y1={DRAWING_INSET}
                    y2={DRAWING_INSET + innerHeight}
                  />
                  <text
                    className="automation-lane__grid-label"
                    x={x + 4}
                    y={AUTOMATION_LANE_HEIGHT - 5}
                  >
                    {formatAutomationBeat(beat)}
                  </text>
                </g>
              );
            })}
            <line
              className="automation-lane__base-line"
              x1={DRAWING_INSET}
              x2={DRAWING_INSET + innerWidth}
              y1={
                DRAWING_INSET
                + automationValueToY(baseValue, targetType, innerHeight)
              }
              y2={
                DRAWING_INSET
                + automationValueToY(baseValue, targetType, innerHeight)
              }
            />
            {curvePaths.map((path) => (
              <path
                key={path.interpolation}
                className={`automation-lane__segment is-${path.interpolation}`}
                data-interpolation={path.interpolation}
                data-segment-count={path.segmentCount}
                d={path.d}
              />
            ))}
            <AutomationPlayhead
              lengthBeats={lengthBeats}
              innerWidth={innerWidth}
              innerHeight={innerHeight}
            />
          </svg>

          {renderedPoints.map(({ point: persistedPoint, fullIndex }, renderIndex) => {
            const point =
              dragPreview?.pointId === persistedPoint.id
                ? {
                    ...persistedPoint,
                    beat: dragPreview.beat,
                    value: dragPreview.value,
                  }
                : persistedPoint;
            const selected = point.id === selectedPointId;
            return (
              <button
                type="button"
                key={point.id}
                ref={(element) => {
                  if (element) pointRefs.current.set(point.id, element);
                  else pointRefs.current.delete(point.id);
                }}
                className={`automation-lane__point${selected ? ' is-selected' : ''}`}
                data-automation-point-id={point.id}
                aria-label={automationPointAriaLabel(
                  point,
                  fullIndex,
                  targetType,
                  isEffectiveMaster,
                )}
                aria-pressed={selected}
                aria-keyshortcuts="PageUp PageDown Home End ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown ArrowLeft ArrowRight Delete Backspace Control+Z Meta+Z Control+Shift+Z Meta+Shift+Z"
                tabIndex={
                  selectedPointId === null
                    ? renderIndex === 0
                      ? 0
                      : -1
                    : selected
                      ? 0
                      : -1
                }
                disabled={disabled}
                style={{
                  left: `${
                    DRAWING_INSET
                    + automationBeatToX(point.beat, lengthBeats, innerWidth)
                  }px`,
                  top: `${
                    DRAWING_INSET
                    + automationValueToY(
                      point.value,
                      targetType,
                      innerHeight,
                    )
                  }px`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedPointId(point.id);
                }}
                onKeyDown={(event) =>
                  handlePointKeyDown(event, persistedPoint, fullIndex)
                }
                onPointerDown={(event) => {
                  if (disabled || event.button !== 0) return;
                  event.stopPropagation();
                  setSelectedPointId(point.id);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDragPreview({
                    pointId: point.id,
                    pointerId: event.pointerId,
                    beat: point.beat,
                    value: point.value,
                    moved: false,
                  });
                }}
                onPointerMove={(event) => {
                  if (
                    dragPreview?.pointId !== point.id
                    || dragPreview.pointerId !== event.pointerId
                  ) {
                    return;
                  }
                  const next = pointFromPointer(event);
                  if (!next) return;
                  setDragPreview({
                    ...dragPreview,
                    beat: next.beat,
                    value: next.value,
                    moved:
                      dragPreview.moved
                      || next.beat !== persistedPoint.beat
                      || next.value !== persistedPoint.value,
                  });
                }}
                onPointerUp={(event) => {
                  if (
                    dragPreview?.pointId !== point.id
                    || dragPreview.pointerId !== event.pointerId
                  ) {
                    return;
                  }
                  event.stopPropagation();
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  const completed = dragPreview;
                  setDragPreview(null);
                  if (completed.moved) {
                    updatePoint(
                      point.id,
                      {
                        beat: completed.beat,
                        value: completed.value,
                      },
                      '点を移動しました。',
                    );
                  }
                }}
                onPointerCancel={() => setDragPreview(null)}
              >
                <span aria-hidden="true">{fullIndex + 1}</span>
              </button>
            );
          })}

          {lane === null || lane.points.length === 0 ? (
            <p className="automation-lane__empty">
              点はまだありません。レーン上の位置をクリックするか、再生位置に追加してください。
            </p>
          ) : null}
        </div>
      </div>
      {lane && renderedPoints.length < lane.points.length ? (
        <p className="automation-lane__hint" role="status">
          全{lane.points.length}点のうち、現在の表示範囲と選択中の
          {renderedPoints.length}点を操作用に表示しています。
          PageUp / PageDownで省略された前後の点にも移動できます。
        </p>
      ) : null}

      {selectedPoint && draft ? (
        <fieldset className="automation-lane__inspector">
          <legend>選択中の点</legend>
          <label>
            拍
            <input
              type="number"
              min={0}
              max={lengthBeats}
              step={snapBeats > 0 ? snapBeats : 0.001}
              value={draft.beat}
              disabled={disabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  beat: event.currentTarget.value,
                  dirtyBeat: true,
                })
              }
              onBlur={() => commitDraft('beat')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(draftForPoint(selectedPoint, targetType));
                }
              }}
            />
          </label>
          <label>
            {targetPresentation.displayLabel}
            <input
              type="number"
              min={targetPresentation.displayMin}
              max={targetPresentation.displayMax}
              step={targetPresentation.displayStep}
              value={draft.value}
              disabled={disabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  value: event.currentTarget.value,
                  dirtyValue: true,
                })
              }
              onBlur={() => commitDraft('value')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(draftForPoint(selectedPoint, targetType));
                }
              }}
            />
          </label>
          <label>
            次の点まで
            <select
              value={draft.interpolation}
              disabled={disabled}
              onChange={(event) => {
                const interpolation = event.currentTarget
                  .value as AutomationInterpolation;
                setDraft({ ...draft, interpolation });
                if (
                  !updatePoint(
                    selectedPoint.id,
                    { interpolation },
                    `補間を「${automationInterpolationLabel(
                      interpolation,
                    )}」に変更しました。`,
                  )
                ) {
                  setDraft(draftForPoint(selectedPoint, targetType));
                }
              }}
            >
              <option value="hold">保持</option>
              <option value="linear">直線</option>
            </select>
          </label>
          <output>
            {formatAutomationValue(selectedPoint.value, targetType)}
          </output>
          <button
            type="button"
            className="automation-lane__delete"
            disabled={disabled}
            onClick={() => removePoint(selectedPoint.id)}
          >
            この点を削除
          </button>
        </fieldset>
      ) : null}

      <details className="automation-lane__keyboard">
        <summary>キーボード操作</summary>
        <p>
          PageUp / PageDownで前後の点、Home / Endで最初と最後の点を選択します。左右矢印で拍、上下矢印で値を調整し、Shift + 上下矢印では大きく調整します。DeleteまたはBackspaceで削除します。ControlまたはCommand + Zで元に戻し、Shiftも押すとやり直します。
        </p>
      </details>

      <p
        className={`automation-lane__notice${notice?.kind === 'error' ? ' is-error' : ''}`}
        role={notice?.kind === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        aria-atomic="true"
      >
        {notice?.message
          ?? (lane?.bypassed
            ? 'Bypass中も点の変更は保存されますが、再生とWAV書き出しではトラックの現在の基準値を使います。'
            : '変更内容はプロジェクトに保存され、再生とWAV書き出しに反映されます。')}
      </p>
    </section>
  );
}
