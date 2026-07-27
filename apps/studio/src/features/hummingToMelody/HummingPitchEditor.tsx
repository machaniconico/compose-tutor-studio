import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { midiToNoteName } from '@cts/theory-engine';
import {
  MIN_HUMMING_SEGMENT_SECONDS,
  type HummingPitchDraft,
  type HummingPitchSegment,
} from './hummingCandidateEditing';
import type {
  HummingPitchFrame,
  HummingWaveformBin,
} from '../../audio/hummingTranscription';

const DEFAULT_TIMELINE_SECONDS = 1;
const MOVE_STEP_SECONDS = 0.05;
const FINE_MOVE_STEP_SECONDS = 0.01;
const TIMELINE_HEIGHT_REM = 15;
const TIMELINE_MIN_WIDTH_REM = 40;
const TIMELINE_MAX_WIDTH_REM = 240;
const TIMELINE_REM_PER_SECOND = 4;
const SEGMENT_HALF_HEIGHT_PERCENT = 10;
const TIMING_EPSILON_SECONDS = 1e-9;

export type HummingPitchEditorEditResult = string | null | void;

export type HummingPitchEditorProps = Readonly<{
  draft: HummingPitchDraft;
  waveform: readonly HummingWaveformBin[];
  pitchFrames: readonly HummingPitchFrame[];
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onPitchChange: (
    segmentId: string,
    midi: number,
  ) => HummingPitchEditorEditResult;
  onMove: (
    segmentId: string,
    deltaSeconds: number,
  ) => HummingPitchEditorEditResult;
  onResizeStart: (
    segmentId: string,
    deltaSeconds: number,
  ) => HummingPitchEditorEditResult;
  onResizeEnd: (
    segmentId: string,
    deltaSeconds: number,
  ) => HummingPitchEditorEditResult;
  onRemove: (segmentId: string) => HummingPitchEditorEditResult;
  onSplit: (
    segmentId: string,
    splitSeconds: number,
  ) => HummingPitchEditorEditResult;
  onMergeNext: (segmentId: string) => HummingPitchEditorEditResult;
  onUndo: () => HummingPitchEditorEditResult;
  onRedo: () => HummingPitchEditorEditResult;
  onReset: () => HummingPitchEditorEditResult;
}>;

type MidiRange = Readonly<{
  low: number;
  high: number;
  guides: readonly number[];
}>;

type EditorErrorScope = 'pitch' | 'start' | 'end' | 'action';

type EditorError = Readonly<{
  message: string;
  scope: EditorErrorScope;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function safeTimelineDuration(
  draft: HummingPitchDraft,
  waveform: readonly HummingWaveformBin[],
  pitchFrames: readonly HummingPitchFrame[],
): number {
  if (
    Number.isFinite(draft.sourceDurationSeconds) &&
    draft.sourceDurationSeconds > 0
  ) {
    return draft.sourceDurationSeconds;
  }

  const boundedEnds = [
    ...draft.segments.map((segment) => segment.endSeconds),
    ...waveform.map((bin) => bin.endSeconds),
    ...pitchFrames.map((frame) => frame.endSeconds),
  ].filter((value) => Number.isFinite(value) && value > 0);
  return boundedEnds.length > 0
    ? Math.max(...boundedEnds)
    : DEFAULT_TIMELINE_SECONDS;
}

function timelinePercent(value: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return clamp((finiteNumber(value) / durationSeconds) * 100, 0, 100);
}

function percentStyle(value: number): string {
  return `${Number(clamp(value, 0, 100).toFixed(4))}%`;
}

function timelineWidthRem(durationSeconds: number): number {
  return clamp(
    finiteNumber(durationSeconds, DEFAULT_TIMELINE_SECONDS) *
      TIMELINE_REM_PER_SECOND,
    TIMELINE_MIN_WIDTH_REM,
    TIMELINE_MAX_WIDTH_REM,
  );
}

function segmentWidthPercent(
  segment: HummingPitchSegment,
  durationSeconds: number,
): number {
  const start = timelinePercent(segment.startSeconds, durationSeconds);
  const end = timelinePercent(segment.endSeconds, durationSeconds);
  return clamp(end - start, 0, 100 - start);
}

function midiRange(
  segments: readonly HummingPitchSegment[],
  pitchFrames: readonly HummingPitchFrame[],
): MidiRange {
  const pitches = [
    ...segments.map((segment) => segment.midi),
    ...pitchFrames.flatMap((frame) =>
      frame.midi === null ? [] : [frame.midi],
    ),
  ].filter((midi) => Number.isFinite(midi));

  const minimum = pitches.length > 0 ? Math.min(...pitches) : 60;
  const maximum = pitches.length > 0 ? Math.max(...pitches) : 60;
  let low = clamp(Math.floor(minimum) - 2, 0, 127);
  let high = clamp(Math.ceil(maximum) + 2, 0, 127);
  if (high <= low) {
    low = clamp(low - 1, 0, 126);
    high = low + 1;
  }

  return {
    low,
    high,
    guides: Array.from({ length: high - low + 1 }, (_, index) => low + index),
  };
}

function pitchPercent(midi: number, range: MidiRange): number {
  const span = Math.max(1, range.high - range.low);
  return clamp(100 - ((finiteNumber(midi, range.low) - range.low) / span) * 100, 0, 100);
}

function waveformY(value: number): number {
  return clamp(50 - clamp(finiteNumber(value), -1, 1) * 45, 5, 95);
}

function pitchTracePath(
  frames: readonly HummingPitchFrame[],
  durationSeconds: number,
  range: MidiRange,
): string {
  let beginsSubpath = true;
  const commands: string[] = [];
  for (const frame of frames) {
    if (frame.midi === null || !Number.isFinite(frame.midi)) {
      beginsSubpath = true;
      continue;
    }
    const midpoint =
      (finiteNumber(frame.startSeconds) + finiteNumber(frame.endSeconds)) / 2;
    const x = timelinePercent(midpoint, durationSeconds);
    const y = pitchPercent(frame.midi, range);
    commands.push(
      `${beginsSubpath ? 'M' : 'L'} ${x.toFixed(4)} ${y.toFixed(4)}`,
    );
    beginsSubpath = false;
  }
  return commands.join(' ');
}

function noteName(midi: number): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    return `MIDI ${finiteNumber(midi)}`;
  }
  return midiToNoteName(midi);
}

function confidencePercent(confidence: number): number {
  return Math.round(clamp(finiteNumber(confidence), 0, 1) * 100);
}

function confidenceBand(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function confidenceDescription(confidence: number): string {
  const band = confidenceBand(confidence);
  return band === 'high' ? '高め' : band === 'medium' ? '中程度' : '低め';
}

function formatSeconds(seconds: number): string {
  return `${finiteNumber(seconds).toFixed(3)}秒`;
}

function timeInputLimit(seconds: number): number {
  return Number(finiteNumber(seconds).toFixed(6));
}

function segmentAccessibleName(
  segment: HummingPitchSegment,
  index: number,
  selected: boolean,
): string {
  return `${index + 1}音目、${noteName(segment.midi)}、MIDI ${segment.midi}、開始 ${formatSeconds(segment.startSeconds)}、終了 ${formatSeconds(segment.endSeconds)}、信頼度 ${confidencePercent(segment.confidence)}%、${selected ? '選択中' : '未選択'}`;
}

function segmentDomId(rootId: string, segmentId: string): string {
  return `${rootId}-segment-${encodeURIComponent(segmentId)}`;
}

export function HummingPitchEditor({
  draft,
  waveform,
  pitchFrames,
  disabled,
  canUndo,
  canRedo,
  onPitchChange,
  onMove,
  onResizeStart,
  onResizeEnd,
  onRemove,
  onSplit,
  onMergeNext,
  onUndo,
  onRedo,
  onReset,
}: HummingPitchEditorProps) {
  const rootId = useId();
  const headingId = `${rootId}-heading`;
  const instructionsId = `${rootId}-instructions`;
  const statusId = `${rootId}-status`;
  const errorId = `${rootId}-error`;
  const inspectorHeadingId = `${rootId}-inspector-heading`;
  const splitHintId = `${rootId}-split-hint`;
  const segments = draft.segments;
  const [selectedId, setSelectedId] = useState<string | null>(
    () => segments[0]?.id ?? null,
  );
  const [announcement, setAnnouncement] = useState('');
  const [inlineError, setInlineError] = useState<EditorError | null>(null);
  const segmentRefs = useRef(new Map<string, HTMLButtonElement>());
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingFocusId = useRef<string | null>(null);
  const pendingTimelineFocus = useRef(false);
  const recoverMissingFocus = useRef(false);

  const selectedIndex = Math.max(
    0,
    segments.findIndex((segment) => segment.id === selectedId),
  );
  const selectedSegment =
    segments.find((segment) => segment.id === selectedId) ?? segments[0] ?? null;
  const rovingId = selectedSegment?.id ?? null;
  const durationSeconds = safeTimelineDuration(draft, waveform, pitchFrames);
  const canvasWidthRem = timelineWidthRem(durationSeconds);
  const range = midiRange(segments, pitchFrames);
  const tracePath = pitchTracePath(pitchFrames, durationSeconds, range);
  const selectedSegmentDuration = selectedSegment
    ? selectedSegment.endSeconds - selectedSegment.startSeconds
    : 0;
  const canSplitSelected =
    selectedSegment !== null &&
    selectedSegmentDuration + TIMING_EPSILON_SECONDS >=
      MIN_HUMMING_SEGMENT_SECONDS * 2;

  useEffect(() => {
    if (selectedId !== rovingId) setSelectedId(rovingId);
  }, [rovingId, selectedId]);

  useEffect(() => {
    if (pendingTimelineFocus.current && segments.length === 0) {
      pendingTimelineFocus.current = false;
      recoverMissingFocus.current = false;
      timelineRef.current?.focus({ preventScroll: true });
      return;
    }
    const focusId = pendingFocusId.current;
    const target =
      (focusId ? segmentRefs.current.get(focusId) : undefined) ??
      (recoverMissingFocus.current && rovingId
        ? segmentRefs.current.get(rovingId)
        : undefined);
    if (!target) return;
    pendingFocusId.current = null;
    pendingTimelineFocus.current = false;
    recoverMissingFocus.current = false;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [rovingId, segments]);

  function completeEdit(
    edit: () => HummingPitchEditorEditResult,
    successAnnouncement: string,
    errorScope: EditorErrorScope = 'action',
  ): boolean {
    try {
      const result = edit();
      if (typeof result === 'string') {
        const message = result.trim() || 'この編集は適用できませんでした。';
        setInlineError({ message, scope: errorScope });
        setAnnouncement(message);
        return false;
      }
      setInlineError(null);
      setAnnouncement(successAnnouncement);
      return true;
    } catch {
      const message = 'この編集は適用できませんでした。';
      setInlineError({ message, scope: errorScope });
      setAnnouncement(message);
      return false;
    }
  }

  function focusSegment(segment: HummingPitchSegment, message?: string): void {
    setSelectedId(segment.id);
    setInlineError(null);
    setAnnouncement(
      message ?? `${noteName(segment.midi)}を選択しました。`,
    );
    const target = segmentRefs.current.get(segment.id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function focusByIndex(index: number): void {
    const segment = segments[clamp(index, 0, Math.max(0, segments.length - 1))];
    if (segment) focusSegment(segment);
  }

  function removeSegment(segment: HummingPitchSegment): void {
    const index = segments.findIndex((candidate) => candidate.id === segment.id);
    const fallback = segments[index + 1] ?? segments[index - 1] ?? null;
    if (
      completeEdit(
        () => onRemove(segment.id),
        `${noteName(segment.midi)}を候補から外しました。`,
      )
    ) {
      setSelectedId(fallback?.id ?? null);
      pendingFocusId.current = fallback?.id ?? null;
      pendingTimelineFocus.current = fallback === null;
    }
  }

  function changePitch(segment: HummingPitchSegment, midi: number): void {
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      const message = 'MIDIノートは0〜127の整数で入力してください。';
      setInlineError({ message, scope: 'pitch' });
      setAnnouncement(message);
      return;
    }
    completeEdit(
      () => onPitchChange(segment.id, midi),
      `${noteName(midi)}に変更しました。`,
      'pitch',
    );
  }

  function readFiniteInput(
    event: ChangeEvent<HTMLInputElement>,
    invalidMessage: string,
    errorScope: EditorErrorScope,
  ): number | null {
    if (event.currentTarget.value.trim() === '') {
      setInlineError({ message: invalidMessage, scope: errorScope });
      setAnnouncement(invalidMessage);
      return null;
    }
    const value = Number(event.currentTarget.value);
    if (!Number.isFinite(value)) {
      setInlineError({ message: invalidMessage, scope: errorScope });
      setAnnouncement(invalidMessage);
      return null;
    }
    return value;
  }

  function handleSegmentKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    segment: HummingPitchSegment,
  ): void {
    if (event.ctrlKey || event.metaKey) return;
    const index = segments.findIndex((candidate) => candidate.id === segment.id);
    const isSelectionNavigation =
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End');
    const isPitchChange =
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown');
    const isMove =
      !event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
    const isResize =
      event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
    const isRemove =
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'Delete' || event.key === 'Backspace');
    if (
      !isSelectionNavigation &&
      !isPitchChange &&
      !isMove &&
      !isResize &&
      !isRemove
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || disabled || index < 0) return;

    if (isSelectionNavigation) {
      if (event.key === 'Home') focusByIndex(0);
      else if (event.key === 'End') focusByIndex(segments.length - 1);
      else if (event.key === 'PageUp') focusByIndex(index - 1);
      else focusByIndex(index + 1);
      return;
    }

    if (isRemove) {
      removeSegment(segment);
      return;
    }

    if (isPitchChange) {
      const nextMidi = segment.midi + (event.key === 'ArrowUp' ? 1 : -1);
      changePitch(segment, nextMidi);
      return;
    }

    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const stepSeconds = event.altKey
      ? FINE_MOVE_STEP_SECONDS
      : MOVE_STEP_SECONDS;
    if (isResize) {
      completeEdit(
        () => onResizeEnd(segment.id, direction * stepSeconds),
        `${noteName(segment.midi)}の終了を${Math.round(stepSeconds * 1_000)}ミリ秒${direction > 0 ? '後ろ' : '前'}へ変更しました。`,
      );
      return;
    }
    completeEdit(
      () => onMove(segment.id, direction * stepSeconds),
      `${noteName(segment.midi)}を${Math.round(stepSeconds * 1_000)}ミリ秒${direction > 0 ? '後ろ' : '前'}へ移動しました。`,
    );
  }

  function handleEditorUndoRedo(
    event: ReactKeyboardEvent<HTMLElement>,
  ): void {
    if (
      event.altKey ||
      (!event.ctrlKey && !event.metaKey) ||
      event.key.toLowerCase() !== 'z'
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || disabled) return;

    const eventTarget = event.target as HTMLElement | null;
    const segmentButton = eventTarget?.closest<HTMLButtonElement>(
      '[data-humming-segment-id]',
    );
    const beganInInspector = Boolean(
      eventTarget?.closest('.humming-pitch-editor__inspector'),
    );
    const focusId =
      segmentButton?.dataset.hummingSegmentId ??
      (beganInInspector ? selectedSegment?.id : undefined);
    const recoverFocus = (): void => {
      if (!focusId) return;
      pendingFocusId.current = focusId;
      pendingTimelineFocus.current = true;
      recoverMissingFocus.current = true;
    };

    if (event.shiftKey) {
      if (!canRedo) {
        setAnnouncement('やり直せる候補編集はありません。');
        return;
      }
      if (completeEdit(onRedo, '候補の編集をやり直しました。')) {
        recoverFocus();
      }
      return;
    }
    if (!canUndo) {
      setAnnouncement('元に戻せる候補編集はありません。');
      return;
    }
    if (completeEdit(onUndo, '候補の編集を元に戻しました。')) {
      recoverFocus();
    }
  }

  return (
    <section
      className="humming-pitch-editor"
      aria-labelledby={headingId}
      aria-keyshortcuts="Control+Z Meta+Z Control+Shift+Z Meta+Shift+Z"
      onKeyDownCapture={handleEditorUndoRedo}
      style={{ maxWidth: '100%', minWidth: 0 }}
    >
      <div className="humming-pitch-editor__header">
        <h3 id={headingId}>検出した音程を調整</h3>
        <div
          className="humming-pitch-editor__history"
          role="group"
          aria-label="候補の編集履歴"
        >
          <button
            type="button"
            aria-label="候補の編集を元に戻す"
            disabled={disabled || !canUndo}
            onClick={() => {
              if (canUndo) completeEdit(onUndo, '候補の編集を元に戻しました。');
            }}
          >
            元に戻す
          </button>
          <button
            type="button"
            aria-label="候補の編集をやり直す"
            disabled={disabled || !canRedo}
            onClick={() => {
              if (canRedo) completeEdit(onRedo, '候補の編集をやり直しました。');
            }}
          >
            やり直す
          </button>
          <button
            type="button"
            aria-label="候補を解析結果に戻す"
            disabled={disabled || (!canUndo && !canRedo)}
            onClick={() => {
              completeEdit(onReset, '候補を解析直後の結果に戻しました。');
            }}
          >
            解析結果に戻す
          </button>
        </div>
      </div>

      <p className="humming-pitch-editor__summary">
        音を選ぶと、音程とタイミングを下の項目で調整できます。信頼度は判定の確かさの目安です。
      </p>

      <span id={instructionsId} className="visually-hidden">
        PageUpとPageDownで前後の音、HomeとEndで最初と最後の音を選びます。上下矢印で1半音、左右矢印で50ミリ秒移動します。Altと左右矢印では10ミリ秒移動し、Shiftと左右矢印では終了位置を変更します。DeleteまたはBackspaceで候補から外します。ControlまたはCommandとZで元に戻し、Shiftも押すとやり直します。
      </span>
      <span
        id={statusId}
        className="visually-hidden"
        role="status"
        aria-label="候補編集の状態"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>

      <div
        className="humming-pitch-editor__timeline-scroll"
        data-horizontal-scroll="timeline-only"
        style={{
          maxWidth: '100%',
          overflowX: 'auto',
          overscrollBehaviorInline: 'contain',
        }}
      >
        <div
          ref={timelineRef}
          className="humming-pitch-editor__timeline"
          role="group"
          tabIndex={segments.length === 0 ? 0 : -1}
          aria-label="鼻歌の波形と検出音程タイムライン"
          aria-describedby={`${instructionsId} ${statusId}`}
          style={{
            minWidth: `${canvasWidthRem}rem`,
            height: `${TIMELINE_HEIGHT_REM}rem`,
            position: 'relative',
          }}
        >
          <svg
            className="humming-pitch-editor__waveform"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {waveform.map((bin, index) => {
              const x = timelinePercent(
                (finiteNumber(bin.startSeconds) + finiteNumber(bin.endSeconds)) /
                  2,
                durationSeconds,
              );
              return (
                <line
                  key={`${index}-${bin.startSeconds}`}
                  x1={x}
                  x2={x}
                  y1={waveformY(bin.max)}
                  y2={waveformY(bin.min)}
                />
              );
            })}
          </svg>

          <svg
            className="humming-pitch-editor__pitch-curve"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {range.guides.map((midi) => (
              <line
                key={midi}
                className="humming-pitch-editor__semitone-guide"
                x1="0"
                x2="100"
                y1={pitchPercent(midi, range)}
                y2={pitchPercent(midi, range)}
              />
            ))}
            {tracePath ? (
              <path
                className="humming-pitch-editor__pitch-trace"
                d={tracePath}
              />
            ) : null}
          </svg>

          {segments.map((segment, index) => {
            const selected = segment.id === rovingId;
            const confidence = confidencePercent(segment.confidence);
            const band = confidenceBand(segment.confidence);
            const startPercent = timelinePercent(
              segment.startSeconds,
              durationSeconds,
            );
            const endPercent = timelinePercent(
              segment.endSeconds,
              durationSeconds,
            );
            const anchorFromRight = startPercent > 50;
            const topPercent = clamp(
              pitchPercent(segment.midi, range),
              SEGMENT_HALF_HEIGHT_PERCENT,
              100 - SEGMENT_HALF_HEIGHT_PERCENT,
            );
            return (
              <button
                type="button"
                key={segment.id}
                id={segmentDomId(rootId, segment.id)}
                ref={(element) => {
                  if (element) segmentRefs.current.set(segment.id, element);
                  else segmentRefs.current.delete(segment.id);
                }}
                className={`humming-pitch-editor__segment is-confidence-${band}${selected ? ' is-selected' : ''}`}
                data-humming-segment-id={segment.id}
                data-confidence={band}
                tabIndex={selected ? 0 : -1}
                aria-pressed={selected}
                aria-label={segmentAccessibleName(segment, index, selected)}
                aria-describedby={`${instructionsId} ${statusId}`}
                aria-keyshortcuts="PageUp PageDown Home End ArrowUp ArrowDown ArrowLeft ArrowRight Alt+ArrowLeft Alt+ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Delete Backspace Control+Z Meta+Z Control+Shift+Z Meta+Shift+Z"
                disabled={disabled}
                style={{
                  left: anchorFromRight ? undefined : percentStyle(startPercent),
                  right: anchorFromRight
                    ? percentStyle(100 - endPercent)
                    : undefined,
                  width: percentStyle(
                    segmentWidthPercent(segment, durationSeconds),
                  ),
                  maxWidth: '100%',
                  top: percentStyle(topPercent),
                  minWidth: '2.75rem',
                  minHeight: '2.75rem',
                  position: 'absolute',
                  transform: 'translateY(-50%)',
                  opacity:
                    0.58 +
                    clamp(finiteNumber(segment.confidence), 0, 1) * 0.42,
                }}
                onFocus={() => {
                  setSelectedId(segment.id);
                  setInlineError(null);
                  setAnnouncement(
                    `${noteName(segment.midi)}にフォーカスしました。`,
                  );
                }}
                onClick={() => focusSegment(segment)}
                onKeyDown={(event) => handleSegmentKeyDown(event, segment)}
              >
                <span className="humming-pitch-editor__segment-note">
                  {noteName(segment.midi)}
                </span>
                <span className="humming-pitch-editor__segment-confidence">
                  信頼度 {confidence}%
                </span>
              </button>
            );
          })}

          {segments.length === 0 ? (
            <p className="humming-pitch-editor__empty">
              編集できる音程区間はありません。声をはっきり伸ばして、もう一度解析してください。
            </p>
          ) : null}
        </div>
      </div>

      {selectedSegment ? (
        <section
          className="humming-pitch-editor__inspector"
          aria-labelledby={inspectorHeadingId}
        >
          <h4 id={inspectorHeadingId}>選択中の音</h4>
          <dl className="humming-pitch-editor__facts">
            <div>
              <dt>音名</dt>
              <dd>{noteName(selectedSegment.midi)}</dd>
            </div>
            <div>
              <dt>MIDI</dt>
              <dd>{selectedSegment.midi}</dd>
            </div>
            <div>
              <dt>信頼度</dt>
              <dd>
                {confidencePercent(selectedSegment.confidence)}%（
                {confidenceDescription(selectedSegment.confidence)}）
              </dd>
            </div>
            <div>
              <dt>開始</dt>
              <dd>{formatSeconds(selectedSegment.startSeconds)}</dd>
            </div>
            <div>
              <dt>終了</dt>
              <dd>{formatSeconds(selectedSegment.endSeconds)}</dd>
            </div>
          </dl>

          <div className="humming-pitch-editor__pitch-controls">
            <button
              type="button"
              aria-label={`${selectedIndex + 1}音目を1半音下げる`}
              disabled={disabled || selectedSegment.midi <= 0}
              onClick={() => changePitch(selectedSegment, selectedSegment.midi - 1)}
            >
              −1半音
            </button>
            <label>
              <span>MIDIノート</span>
              <input
                type="number"
                min="0"
                max="127"
                step="1"
                value={selectedSegment.midi}
                aria-label={`${selectedIndex + 1}音目のMIDIノート`}
                aria-invalid={inlineError?.scope === 'pitch'}
                aria-errormessage={
                  inlineError?.scope === 'pitch' ? errorId : undefined
                }
                disabled={disabled}
                onChange={(event) => {
                  const midi = readFiniteInput(
                    event,
                    'MIDIノートは0〜127の整数で入力してください。',
                    'pitch',
                  );
                  if (midi !== null) changePitch(selectedSegment, midi);
                }}
              />
            </label>
            <button
              type="button"
              aria-label={`${selectedIndex + 1}音目を1半音上げる`}
              disabled={disabled || selectedSegment.midi >= 127}
              onClick={() => changePitch(selectedSegment, selectedSegment.midi + 1)}
            >
              +1半音
            </button>
          </div>

          <div className="humming-pitch-editor__time-controls">
            <label>
              <span>開始（秒）</span>
              <input
                type="number"
                min="0"
                max={timeInputLimit(
                  selectedSegment.endSeconds - MIN_HUMMING_SEGMENT_SECONDS,
                )}
                step="0.01"
                value={selectedSegment.startSeconds}
                aria-label={`${selectedIndex + 1}音目の開始秒`}
                aria-invalid={inlineError?.scope === 'start'}
                aria-errormessage={
                  inlineError?.scope === 'start' ? errorId : undefined
                }
                disabled={disabled}
                onChange={(event) => {
                  const start = readFiniteInput(
                    event,
                    '開始位置を秒数で入力してください。',
                    'start',
                  );
                  if (start === null) return;
                  completeEdit(
                    () =>
                      onResizeStart(
                        selectedSegment.id,
                        start - selectedSegment.startSeconds,
                      ),
                    `開始を${formatSeconds(start)}に変更しました。`,
                    'start',
                  );
                }}
              />
            </label>
            <label>
              <span>終了（秒）</span>
              <input
                type="number"
                min={timeInputLimit(
                  selectedSegment.startSeconds + MIN_HUMMING_SEGMENT_SECONDS,
                )}
                max={durationSeconds}
                step="0.01"
                value={selectedSegment.endSeconds}
                aria-label={`${selectedIndex + 1}音目の終了秒`}
                aria-invalid={inlineError?.scope === 'end'}
                aria-errormessage={
                  inlineError?.scope === 'end' ? errorId : undefined
                }
                disabled={disabled}
                onChange={(event) => {
                  const end = readFiniteInput(
                    event,
                    '終了位置を秒数で入力してください。',
                    'end',
                  );
                  if (end === null) return;
                  completeEdit(
                    () =>
                      onResizeEnd(
                        selectedSegment.id,
                        end - selectedSegment.endSeconds,
                      ),
                    `終了を${formatSeconds(end)}に変更しました。`,
                    'end',
                  );
                }}
              />
            </label>
          </div>

          <div
            className="humming-pitch-editor__segment-actions"
            role="group"
            aria-label={`${selectedIndex + 1}音目の区間編集`}
          >
            <button
              type="button"
              aria-label={`${selectedIndex + 1}音目を中央で分割`}
              aria-describedby={!canSplitSelected ? splitHintId : undefined}
              disabled={disabled || !canSplitSelected}
              onClick={() => {
                const midpoint =
                  (selectedSegment.startSeconds + selectedSegment.endSeconds) /
                  2;
                if (
                  completeEdit(
                    () => onSplit(selectedSegment.id, midpoint),
                    `${noteName(selectedSegment.midi)}を中央で分割しました。`,
                  )
                ) {
                  pendingFocusId.current = selectedSegment.id;
                }
              }}
            >
              中央で分割
            </button>
            <button
              type="button"
              aria-label={`${selectedIndex + 1}音目を次の音と結合`}
              disabled={disabled || selectedIndex >= segments.length - 1}
              onClick={() => {
                if (
                  completeEdit(
                    () => onMergeNext(selectedSegment.id),
                    `${noteName(selectedSegment.midi)}を次の音と結合しました。`,
                  )
                ) {
                  pendingFocusId.current = selectedSegment.id;
                }
              }}
            >
              次の音と結合
            </button>
            <button
              type="button"
              className="is-danger"
              aria-label={`${selectedIndex + 1}音目を候補から外す`}
              disabled={disabled}
              onClick={() => removeSegment(selectedSegment)}
            >
              候補から外す
            </button>
          </div>
          {!canSplitSelected ? (
            <p
              id={splitHintId}
              className="humming-pitch-editor__split-hint"
            >
              分割するには、音の長さが120ミリ秒以上必要です。
            </p>
          ) : null}
        </section>
      ) : null}

      {inlineError ? (
        <p
          id={errorId}
          className="humming-pitch-editor__error"
          role="alert"
        >
          {inlineError.message}
        </p>
      ) : null}

      <details className="humming-pitch-editor__keyboard-help">
        <summary>キーボード操作</summary>
        <p>
          PageUp / PageDownで前後の音、Home / Endで最初と最後の音を選びます。上下矢印は音程、左右矢印は50ミリ秒、Alt +
          左右矢印は10ミリ秒の移動です。Shift + 左右矢印で終了位置を変更し、Delete /
          Backspaceで候補から外します。ControlまたはCommand + Zで元に戻し、Shiftも押すとやり直します。
        </p>
      </details>
    </section>
  );
}
