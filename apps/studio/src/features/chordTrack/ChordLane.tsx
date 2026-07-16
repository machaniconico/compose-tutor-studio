import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  barToBeatAt,
  beatToBarPosition,
  compileMusicalTime,
  type ChordEvent,
  type MusicalTimeIndex,
} from '@cts/project-model';
import {
  PROGRESSION_TEMPLATES,
  getDiatonicChords,
  suggestNextChords,
  type HarmonicFunction,
} from '@cts/theory-engine';
import { useStore } from '../../state/store';
import { pxPerBeat, timelineWidth } from '../timeline';
import {
  addChordWithAnalysis,
  applyProgressionTemplate,
} from '../../state/editorActions';
import {
  ChordPopover,
  type ChordPopoverCloseReason,
} from './ChordPopover';

const CHORD_POPOVER_WIDTH = 320;
const CHORD_POPOVER_GUTTER = 8;
const CHORD_POPOVER_MIN_USABLE_HEIGHT = 200;

function chordPopoverId(chordId: string): string {
  return `chord-popover-${chordId}`;
}

/** CSS class suffix per harmonic function (drives chip accent color). */
function functionClass(fn: HarmonicFunction | undefined): string {
  switch (fn) {
    case 'T':
      return 'is-fn-t';
    case 'SD':
      return 'is-fn-sd';
    case 'D':
      return 'is-fn-d';
    default:
      return 'is-fn-other';
  }
}

function functionLabel(fn: HarmonicFunction | undefined): string | null {
  switch (fn) {
    case 'T':
      return 'トニック';
    case 'SD':
      return 'サブドミナント';
    case 'D':
      return 'ドミナント';
    default:
      return 'その他の機能';
  }
}

function beatAsBarNumber(musicalTime: MusicalTimeIndex, beat: number): number {
  const position = beatToBarPosition(musicalTime, beat);
  const barStart = barToBeatAt(musicalTime, position.bar);
  const barEnd = barToBeatAt(musicalTime, position.bar + 1);
  const barLength = barEnd - barStart;
  return position.bar + (barLength > 0 ? position.beatInBar / barLength : 0);
}

function beatAtBarNumber(musicalTime: MusicalTimeIndex, barNumber: number): number {
  const bar = Math.floor(barNumber);
  const fraction = barNumber - bar;
  const barStart = barToBeatAt(musicalTime, bar);
  if (fraction === 0) return barStart;
  const barEnd = barToBeatAt(musicalTime, bar + 1);
  return barStart + (barEnd - barStart) * fraction;
}

function chordDurationBars(musicalTime: MusicalTimeIndex, chord: ChordEvent): number {
  const startBar = beatAsBarNumber(musicalTime, chord.startBeat);
  const endBar = beatAsBarNumber(
    musicalTime,
    chord.startBeat + chord.durationBeats,
  );
  return Math.max(0, endBar - startBar);
}

function displayBarCount(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export type ChordBarPlacement = Readonly<{
  startBeat: number;
  durationBeats: number;
}>;

export function chordGridBarPlacement(
  musicalTime: MusicalTimeIndex,
  bar: number,
  durationBars = 1,
): ChordBarPlacement {
  const startBeat = beatAtBarNumber(musicalTime, bar);
  const endBeat = beatAtBarNumber(musicalTime, bar + durationBars);
  return { startBeat, durationBeats: endBeat - startBeat };
}

export function chordGridBarAtBeat(
  musicalTime: MusicalTimeIndex,
  beat: number,
  lengthBars: number,
): number {
  const bar = beatToBarPosition(
    musicalTime,
    Math.min(musicalTime.lengthBeats, Math.max(0, beat)),
  ).bar;
  return Math.min(Math.max(0, lengthBars - 1), Math.max(0, bar));
}

export function chordGridDragPreview(
  musicalTime: MusicalTimeIndex,
  lengthBars: number,
  chord: Pick<ChordEvent, 'id' | 'startBeat' | 'durationBeats'>,
  kind: 'move' | 'resize',
  deltaBeats: number,
): ChordDragPreview {
  const originStartBar = beatAsBarNumber(musicalTime, chord.startBeat);
  const originEndBar = beatAsBarNumber(
    musicalTime,
    chord.startBeat + chord.durationBeats,
  );
  const durationBars = originEndBar - originStartBar;
  if (kind === 'move') {
    const candidateBeat = Math.min(
      musicalTime.lengthBeats,
      Math.max(0, chord.startBeat + deltaBeats),
    );
    const barsDelta = Math.round(
      beatAsBarNumber(musicalTime, candidateBeat) - originStartBar,
    );
    const targetStartBar = Math.min(
      Math.max(0, lengthBars - durationBars),
      Math.max(0, originStartBar + barsDelta),
    );
    const startBeat = beatAtBarNumber(musicalTime, targetStartBar);
    const endBeat = beatAtBarNumber(musicalTime, targetStartBar + durationBars);
    return {
      chordId: chord.id,
      startBeat,
      durationBeats: endBeat - startBeat,
    };
  }

  const candidateEndBeat = Math.min(
    musicalTime.lengthBeats,
    Math.max(0, chord.startBeat + chord.durationBeats + deltaBeats),
  );
  const barsDelta = Math.round(
    beatAsBarNumber(musicalTime, candidateEndBeat) - originEndBar,
  );
  const maxDurationBars = Math.max(0, lengthBars - originStartBar);
  const minimumDurationBars = Math.min(1, durationBars);
  const targetDurationBars = Math.min(
    maxDurationBars,
    Math.max(minimumDurationBars, durationBars + barsDelta),
  );
  const endBeat = beatAtBarNumber(
    musicalTime,
    originStartBar + targetDurationBars,
  );
  return {
    chordId: chord.id,
    startBeat: chord.startBeat,
    durationBeats: endBeat - chord.startBeat,
  };
}

function chordButtonLabel(chord: ChordEvent, musicalTime: MusicalTimeIndex): string {
  const bar = beatToBarPosition(musicalTime, chord.startBeat).bar + 1;
  const bars = chordDurationBars(musicalTime, chord);
  const details = [
    `第${bar}小節`,
    `長さ${displayBarCount(bars)}小節`,
    chord.degree ? `度数${chord.degree}` : null,
    functionLabel(chord.function),
  ].filter((part): part is string => part !== null);
  return `${chord.symbol} コードを編集。${details.join('、')}`;
}

type ChordDrag = {
  chordId: string;
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  originStart: number;
  originDuration: number;
};

type ChordDragPreview = {
  chordId: string;
  startBeat: number;
  durationBeats: number;
};

/**
 * Interactive chord lane. Click an empty bar to add a smart-default chord,
 * click a chip to select, double-click to open the edit popover, drag to move
 * (snap to bar) or resize from the right edge. A template picker can replace
 * the whole chord track.
 */
export function ChordLane() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);
  const selectChord = useStore((s) => s.selectChord);
  const updateChord = useStore((s) => s.updateChord);
  const setInspectorContent = useStore((s) => s.setInspectorContent);

  const [popoverChordId, setPopoverChordId] = useState<string | null>(null);
  const [popoverLeft, setPopoverLeft] = useState(CHORD_POPOVER_GUTTER);
  const [popoverTop, setPopoverTop] = useState(CHORD_POPOVER_GUTTER);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(320);
  const [keyboardBar, setKeyboardBar] = useState(0);
  const [gridAnnouncement, setGridAnnouncement] = useState('');
  const [dragPreview, setDragPreview] = useState<ChordDragPreview | null>(null);
  const laneRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const chordButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<ChordDrag | null>(null);
  const dragPreviewRef = useRef<ChordDragPreview | null>(null);
  const movedRef = useRef(false);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteFallbackRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterCloseRef = useRef<'trigger' | 'delete-fallback' | 'grid' | null>(null);
  const gridInstructionsId = useId();
  const gridStatusId = useId();

  const musicalTime = useMemo(
    () => compileMusicalTime(project),
    [project.lengthBeats, project.tempoMap, project.timeSignatureMap],
  );
  const lengthBeats = project.lengthBeats;
  const width = timelineWidth(lengthBeats, zoomX);
  const ppb = pxPerBeat(zoomX);
  const keyboardBarPlacement = chordGridBarPlacement(musicalTime, keyboardBar);

  const sortedChords = useMemo(
    () => [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat),
    [project.chordTrack],
  );
  const popoverChord = popoverChordId
    ? project.chordTrack.find((chord) => chord.id === popoverChordId) ?? null
    : null;

  const positionPopover = useCallback((trigger: HTMLButtonElement) => {
    const lane = laneRef.current;
    if (!lane) return;
    const laneRect = lane.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const popoverWidth = Math.min(
      CHORD_POPOVER_WIDTH,
      Math.max(0, viewportWidth - CHORD_POPOVER_GUTTER * 2),
    );
    const desiredLeft =
      triggerRect.left + triggerRect.width / 2 - popoverWidth / 2;
    const maxLeft = Math.max(
      CHORD_POPOVER_GUTTER,
      viewportWidth - popoverWidth - CHORD_POPOVER_GUTTER,
    );
    setPopoverLeft(
      Math.min(maxLeft, Math.max(CHORD_POPOVER_GUTTER, desiredLeft)),
    );
    const centerPane = lane.closest<HTMLElement>('.center-pane');
    const centerBottom = centerPane?.getBoundingClientRect().bottom ?? viewportHeight;
    const desiredHeight = Math.min(600, Math.floor(viewportHeight * 0.7));
    const belowTop = laneRect.bottom - 2;
    const centerSpaceBelow = Math.floor(
      centerBottom - belowTop - CHORD_POPOVER_GUTTER,
    );
    const viewportSpaceBelow = Math.floor(
      viewportHeight - belowTop - CHORD_POPOVER_GUTTER,
    );
    const viewportSpaceAbove = Math.floor(laneRect.top - CHORD_POPOVER_GUTTER);
    const containedSpaceBelow = Math.min(centerSpaceBelow, viewportSpaceBelow);

    if (
      laneRect.bottom <= viewportHeight - CHORD_POPOVER_GUTTER &&
      containedSpaceBelow >= CHORD_POPOVER_MIN_USABLE_HEIGHT
    ) {
      setPopoverTop(Math.max(CHORD_POPOVER_GUTTER, belowTop));
      setPopoverMaxHeight(Math.min(desiredHeight, containedSpaceBelow));
    } else if (
      viewportSpaceBelow >= CHORD_POPOVER_MIN_USABLE_HEIGHT ||
      viewportSpaceBelow >= viewportSpaceAbove
    ) {
      setPopoverTop(Math.max(CHORD_POPOVER_GUTTER, belowTop));
      setPopoverMaxHeight(Math.max(1, Math.min(desiredHeight, viewportSpaceBelow)));
    } else {
      const height = Math.max(1, Math.min(desiredHeight, viewportSpaceAbove));
      setPopoverTop(Math.max(CHORD_POPOVER_GUTTER, laneRect.top - height));
      setPopoverMaxHeight(height);
    }
  }, []);

  const closeChordPopover = useCallback(
    (reason: ChordPopoverCloseReason) => {
      if (reason === 'delete' && popoverChordId !== null) {
        const deletedIndex = sortedChords.findIndex(
          (chord) => chord.id === popoverChordId,
        );
        const fallbackChord =
          sortedChords[deletedIndex + 1] ?? sortedChords[deletedIndex - 1] ?? null;
        if (fallbackChord) {
          selectChord(fallbackChord.id);
          setInspectorContent(`chord:${fallbackChord.id}`);
          deleteFallbackRef.current =
            chordButtonRefs.current.get(fallbackChord.id) ?? null;
          focusAfterCloseRef.current = 'delete-fallback';
        } else {
          selectChord(null);
          setInspectorContent(null);
          deleteFallbackRef.current = null;
          focusAfterCloseRef.current = 'grid';
        }
      } else {
        focusAfterCloseRef.current = reason === 'outside' ? null : 'trigger';
      }
      setPopoverChordId(null);
    },
    [popoverChordId, selectChord, setInspectorContent, sortedChords],
  );

  const openChordPopover = useCallback(
    (chordId: string, trigger: HTMLButtonElement) => {
      if (popoverChordId === chordId) {
        closeChordPopover('dismiss');
        return;
      }
      focusAfterCloseRef.current = null;
      popoverTriggerRef.current = trigger;
      positionPopover(trigger);
      selectChord(chordId);
      setInspectorContent(`chord:${chordId}`);
      setPopoverChordId(chordId);
    },
    [closeChordPopover, popoverChordId, positionPopover, selectChord, setInspectorContent],
  );

  useEffect(() => {
    if (popoverChordId !== null) return;
    const destination = focusAfterCloseRef.current;
    if (destination === null) return;
    focusAfterCloseRef.current = null;
    const frame = requestAnimationFrame(() => {
      const trigger = popoverTriggerRef.current;
      const target =
        destination === 'trigger' && trigger?.isConnected
          ? trigger
          : destination === 'delete-fallback' && deleteFallbackRef.current?.isConnected
            ? deleteFallbackRef.current
            : gridRef.current;
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [popoverChordId]);

  useEffect(() => {
    if (popoverChordId === null || popoverChord !== null) return;
    selectChord(null);
    setInspectorContent(null);
    focusAfterCloseRef.current = 'grid';
    setPopoverChordId(null);
  }, [popoverChord, popoverChordId, selectChord, setInspectorContent]);

  useEffect(() => {
    setKeyboardBar((bar) => Math.min(bar, Math.max(0, project.lengthBars - 1)));
  }, [project.lengthBars]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const grid = gridRef.current;
    if (!scroll || !grid || document.activeElement !== grid) return;
    const placement = chordGridBarPlacement(musicalTime, keyboardBar);
    const barStart = placement.startBeat * ppb;
    const barEnd = (placement.startBeat + placement.durationBeats) * ppb;
    if (barStart < scroll.scrollLeft) scroll.scrollLeft = barStart;
    else if (barEnd > scroll.scrollLeft + scroll.clientWidth) {
      scroll.scrollLeft = barEnd - scroll.clientWidth;
    }
  }, [keyboardBar, musicalTime, ppb]);

  useEffect(() => {
    const trigger = popoverTriggerRef.current;
    if (!popoverChordId || !trigger) return;
    positionPopover(trigger);
    const onResize = () => positionPopover(trigger);
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => positionPopover(trigger));
    if (laneRef.current) resizeObserver?.observe(laneRef.current);
    resizeObserver?.observe(trigger);
    const centerPane = laneRef.current?.closest<HTMLElement>('.center-pane');
    if (centerPane) resizeObserver?.observe(centerPane);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [popoverChord?.durationBeats, popoverChord?.startBeat, popoverChordId, positionPopover, ppb]);

  /** Smart default chord for an empty bar: suggestNextChords, else I of key. */
  const smartDefaultSymbol = useCallback(
    (startBeat: number): string => {
      const before = sortedChords
        .filter((c) => c.startBeat < startBeat)
        .map((c) => c.symbol);
      try {
        const suggestions = suggestNextChords({
          key: project.key,
          scale: project.scale,
          currentProgression: before,
        });
        if (suggestions[0]) return suggestions[0].symbol;
      } catch {
        /* fall through */
      }
      try {
        const diatonic = getDiatonicChords(project.key, project.scale);
        const tonic = diatonic.find((d) => d.degree === 'I' || d.degree === 'i');
        if (tonic) return tonic.symbol;
        if (diatonic[0]) return diatonic[0].symbol;
      } catch {
        /* fall through */
      }
      return project.key;
    },
    [sortedChords, project.key, project.scale],
  );

  const addChordAtBar = useCallback(
    (bar: number) => {
      const placement = chordGridBarPlacement(musicalTime, bar);
      const { startBeat, durationBeats } = placement;
      const occupied = sortedChords.some(
        (c) => startBeat >= c.startBeat && startBeat < c.startBeat + c.durationBeats,
      );
      if (occupied) return false;
      addChordWithAnalysis(smartDefaultSymbol(startBeat), startBeat, durationBeats);
      return true;
    },
    [musicalTime, sortedChords, smartDefaultSymbol],
  );

  const onGridClick = useCallback(
    (e: React.MouseEvent) => {
      // Only react to clicks on the empty grid (not on a chip).
      if (e.target !== gridRef.current) return;
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const bar = chordGridBarAtBeat(
        musicalTime,
        x / ppb,
        project.lengthBars,
      );
      setKeyboardBar(bar);
      setGridAnnouncement(
        addChordAtBar(bar)
          ? `第${bar + 1}小節にコードを追加しました。`
          : `第${bar + 1}小節にはすでにコードがあります。`,
      );
    },
    [addChordAtBar, musicalTime, ppb, project.lengthBars],
  );

  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      let nextBar: number | null = null;
      if (e.key === 'ArrowLeft') nextBar = Math.max(0, keyboardBar - 1);
      else if (e.key === 'ArrowRight') {
        nextBar = Math.min(project.lengthBars - 1, keyboardBar + 1);
      } else if (e.key === 'Home') nextBar = 0;
      else if (e.key === 'End') nextBar = project.lengthBars - 1;

      if (nextBar !== null) {
        e.preventDefault();
        e.stopPropagation();
        setKeyboardBar(nextBar);
        setGridAnnouncement(`第${nextBar + 1}小節を選択しました。`);
        return;
      }

      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      setGridAnnouncement(
        addChordAtBar(keyboardBar)
          ? `第${keyboardBar + 1}小節にコードを追加しました。`
          : `第${keyboardBar + 1}小節にはすでにコードがあります。`,
      );
    },
    [addChordAtBar, keyboardBar, project.lengthBars],
  );

  const onChipPointerDown = useCallback(
    (e: React.PointerEvent, chord: ChordEvent, kind: 'move' | 'resize') => {
      if (e.button !== 0 || !e.isPrimary) return;
      e.stopPropagation();
      if (popoverChordId !== null) closeChordPopover('outside');
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      movedRef.current = false;
      dragRef.current = {
        chordId: chord.id,
        kind,
        pointerId: e.pointerId,
        startX: e.clientX,
        originStart: chord.startBeat,
        originDuration: chord.durationBeats,
      };
      const preview = {
        chordId: chord.id,
        startBeat: chord.startBeat,
        durationBeats: chord.durationBeats,
      };
      dragPreviewRef.current = preview;
      setDragPreview(preview);
    },
    [closeChordPopover, popoverChordId],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 3) movedRef.current = true;
      const preview = chordGridDragPreview(
        musicalTime,
        project.lengthBars,
        {
          id: drag.chordId,
          startBeat: drag.originStart,
          durationBeats: drag.originDuration,
        },
        drag.kind,
        dx / ppb,
      );
      const current = dragPreviewRef.current;
      if (
        current?.startBeat === preview.startBeat &&
        current.durationBeats === preview.durationBeats
      ) {
        return;
      }
      dragPreviewRef.current = preview;
      setDragPreview(preview);
    },
    [musicalTime, ppb, project.lengthBars],
  );

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const preview = dragPreviewRef.current;
    dragRef.current = null;
    dragPreviewRef.current = null;
    setDragPreview(null);
    if (
      movedRef.current &&
      preview &&
      (preview.startBeat !== drag.originStart ||
        preview.durationBeats !== drag.originDuration)
    ) {
      updateChord(drag.chordId, {
        startBeat: preview.startBeat,
        durationBeats: preview.durationBeats,
      });
    }
  }, [updateChord]);

  const onPointerCancel = useCallback((event: React.PointerEvent) => {
    if (event.pointerId !== dragRef.current?.pointerId) return;
    dragRef.current = null;
    dragPreviewRef.current = null;
    setDragPreview(null);
  }, []);

  return (
    <section
      ref={laneRef}
      className="chord-lane"
      aria-label="コードトラック"
      data-shortcuts-suspended="true"
    >
      <div className="chord-lane__header">
        <strong>コードトラック</strong>
        <span className="chord-lane__count">{project.chordTrack.length} 個</span>
        <span id={gridInstructionsId} className="chord-lane__shortcut">
          ← → 小節を選ぶ · Enterで追加
        </span>
        <TemplatePicker />
      </div>
      <span id={gridStatusId} className="visually-hidden" aria-live="polite" aria-atomic="true">
        {gridAnnouncement}
      </span>

      <div
        ref={scrollRef}
        className="chord-lane__scroll"
        onScroll={() => {
          const trigger = popoverTriggerRef.current;
          if (popoverChordId && trigger) positionPopover(trigger);
        }}
      >
        <div
          ref={gridRef}
          role="group"
          tabIndex={0}
          aria-label={`コードグリッド。現在は第${keyboardBar + 1}小節`}
          aria-describedby={`${gridInstructionsId} ${gridStatusId}`}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter Space"
          className="chord-lane__grid"
          style={{ width }}
          onClick={onGridClick}
          onKeyDown={onGridKeyDown}
          onFocus={(event) => {
            if (event.target === event.currentTarget) {
              setGridAnnouncement(`第${keyboardBar + 1}小節を選択中です。`);
            }
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
        >
          <div
            className="chord-lane__keyboard-cursor"
            style={{
              left: keyboardBarPlacement.startBeat * ppb,
              width: keyboardBarPlacement.durationBeats * ppb,
            }}
            aria-hidden="true"
          />

          {/* bar guides */}
          {Array.from({ length: project.lengthBars }, (_, bar) => (
            <div
              key={`bar-${bar}`}
              className="chord-lane__bar"
              style={{ left: barToBeatAt(musicalTime, bar) * ppb }}
            />
          ))}

          {sortedChords.map((chord) => {
            const isSelected = chord.id === selectedChordId;
            const isOpen = chord.id === popoverChordId;
            const popoverId = chordPopoverId(chord.id);
            const preview = dragPreview?.chordId === chord.id ? dragPreview : null;
            return (
              <button
                type="button"
                key={chord.id}
                ref={(element) => {
                  if (element) chordButtonRefs.current.set(chord.id, element);
                  else chordButtonRefs.current.delete(chord.id);
                }}
                aria-label={chordButtonLabel(chord, musicalTime)}
                aria-pressed={isSelected}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-controls={popoverId}
                aria-keyshortcuts="Enter Space F2"
                className={`chord-chip ${functionClass(chord.function)}${isSelected ? ' is-selected' : ''}`}
                style={{
                  left: (preview?.startBeat ?? chord.startBeat) * ppb,
                  width: (preview?.durationBeats ?? chord.durationBeats) * ppb,
                }}
                onPointerDown={(e) => onChipPointerDown(e, chord, 'move')}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'F2') return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.repeat) return;
                  movedRef.current = false;
                  openChordPopover(chord.id, e.currentTarget);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (movedRef.current) return;
                  openChordPopover(chord.id, e.currentTarget);
                }}
                title={`${chord.symbol}${chord.degree ? `（${chord.degree}）` : ''}を編集`}
              >
                <span className="chord-chip__symbol">{chord.symbol}</span>
                {chord.degree ? <span className="chord-chip__degree">{chord.degree}</span> : null}
                <span
                  className="chord-chip__resize"
                  onPointerDown={(e) => onChipPointerDown(e, chord, 'resize')}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      </div>

      {popoverChord ? (
        <ChordPopover
          key={popoverChord.id}
          id={chordPopoverId(popoverChord.id)}
          project={project}
          chord={popoverChord}
          triggerElement={popoverTriggerRef.current}
          anchorLeft={popoverLeft}
          anchorTop={popoverTop}
          maxHeight={popoverMaxHeight}
          onClose={closeChordPopover}
        />
      ) : null}
    </section>
  );
}

/** Progression template picker that replaces the whole chord track. */
function TemplatePicker() {
  const [open, setOpen] = useState(false);

  return (
    <div className="chord-lane__templates">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        進行テンプレート
      </button>
      {open ? (
        <ul className="template-menu" role="menu">
          {PROGRESSION_TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const ok = window.confirm(
                    `「${t.name}」でコードトラックをすべて置き換えます。よろしいですか？`,
                  );
                  if (!ok) return;
                  applyProgressionTemplate(t.id);
                  setOpen(false);
                }}
                title={t.description}
              >
                <span className="template-menu__name">{t.name}</span>
                <span className="template-menu__desc">{t.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
