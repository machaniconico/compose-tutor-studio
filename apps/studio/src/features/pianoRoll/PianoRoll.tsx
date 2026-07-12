import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useStore } from '../../state/store';
import {
  MIN_EVENT_DURATION_BEATS,
  beatsPerBar,
  projectLengthBeats,
  resolveClipContent,
  type Clip,
  type NoteEvent,
  type Project,
} from '@cts/project-model';
import { midiToNoteName } from '@cts/theory-engine';
import { pxPerBeat } from '../timeline';
import { isAnyDialogOpen } from '../common/dialogState';
import { useScaleInfo } from './useScaleInfo';
import {
  GRID_SNAP_OPTIONS,
  GRID_SNAP_LABELS,
  PIANO_HIGH_MIDI,
  PIANO_LOW_MIDI,
  beatToX,
  clampPitch,
  normalizeRect,
  rectsOverlap,
  snapBeat,
  snapPitchToPitchClasses,
  xToBeat,
  yToPitch,
} from './gridMath';
import {
  commitNoteUpdates,
  duplicateNotesAt,
  quantizeNotes,
  removeNotes,
} from '../../state/editorActions';

const FINE_ROW_HEIGHT = 16;
const COARSE_ROW_HEIGHT = 24;
const DEFAULT_VELOCITY = 100;
const DRAG_THRESHOLD_PX = 3;

/** Find a clip across all tracks. */
function findClip(project: Project, clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return resolveClipContent(project, clip);
  }
  return null;
}

/** Visible MIDI rows, high pitch at the top. */
function buildRows(): number[] {
  const rows: number[] = [];
  for (let midi = PIANO_HIGH_MIDI; midi >= PIANO_LOW_MIDI; midi -= 1) rows.push(midi);
  return rows;
}

function coarsePointerMatches(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(any-pointer: coarse)').matches;
}

function useCoarsePointer(): boolean {
  const [isCoarse, setIsCoarse] = useState(coarsePointerMatches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(any-pointer: coarse)');
    const update = () => setIsCoarse(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isCoarse;
}

type NoteDragState = {
  kind: 'move' | 'resize';
  pointerId: number;
  noteId: string;
  startX: number;
  startY: number;
  snapshot: NoteEvent[];
  duplicate: boolean;
  clipId: string;
  clipLengthBeats: number;
  ppb: number;
  gridSnap: number;
  rowHeight: number;
  scaleSnap: boolean;
  scalePcs: ReadonlySet<number>;
  selectionBefore: string[];
  deselectOnClick: boolean;
};

type MarqueeDragState = {
  kind: 'marquee';
  pointerId: number;
  originX: number;
  originY: number;
  shiftKey: boolean;
  selectionBefore: string[];
};

type DragState = NoteDragState | MarqueeDragState;

type NoteGesturePreview = {
  mode: 'replace' | 'duplicate';
  notes: NoteEvent[];
};

type KeyboardCursor = {
  startBeat: number;
  pitch: number;
};

type PendingKeyboardFocus =
  | { kind: 'note'; noteId: string }
  | { kind: 'grid' };

type NoteTranslation = {
  snapshot: readonly NoteEvent[];
  anchorId: string;
  requestedBeatDelta: number;
  requestedPitchDelta: number;
  clipLengthBeats: number;
  scaleSnap: boolean;
  scalePcs: ReadonlySet<number>;
  scaleBias?: 'nearest' | 'up' | 'down';
};

function crossedDragThreshold(drag: NoteDragState, clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - drag.startX, clientY - drag.startY) >= DRAG_THRESHOLD_PX;
}

function capturePointer(element: HTMLElement | null, pointerId: number): boolean {
  if (!element?.setPointerCapture) return false;
  try {
    element.setPointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

function translateNoteGroup(args: NoteTranslation): NoteEvent[] {
  const { snapshot } = args;
  const anchor = snapshot.find((note) => note.id === args.anchorId) ?? snapshot[0];
  if (!anchor) return [];

  const minimumBeatDelta = Math.max(...snapshot.map((note) => -note.startBeat));
  const maximumBeatDelta = Math.min(
    ...snapshot.map(
      (note) => args.clipLengthBeats - note.durationBeats - note.startBeat,
    ),
  );
  const beatDelta = Math.max(
    minimumBeatDelta,
    Math.min(maximumBeatDelta, args.requestedBeatDelta),
  );

  const minimumPitchDelta = Math.max(
    ...snapshot.map((note) => PIANO_LOW_MIDI - note.pitch),
  );
  const maximumPitchDelta = Math.min(
    ...snapshot.map((note) => PIANO_HIGH_MIDI - note.pitch),
  );
  const pitchDelta = Math.max(
    minimumPitchDelta,
    Math.min(maximumPitchDelta, args.requestedPitchDelta),
  );

  return snapshot.map((source) => {
    let pitch = clampPitch(source.pitch + pitchDelta);
    if (args.scaleSnap) {
      const snappedPitch = snapPitchToPitchClasses(
        pitch,
        args.scalePcs,
        PIANO_LOW_MIDI,
        PIANO_HIGH_MIDI,
        args.scaleBias,
      );
      const snappedPc = ((snappedPitch % 12) + 12) % 12;
      pitch =
        args.scaleBias && args.scaleBias !== 'nearest' && !args.scalePcs.has(snappedPc)
          ? source.pitch
          : clampPitch(snappedPitch);
    }
    return {
      ...source,
      startBeat: source.startBeat + beatDelta,
      pitch,
    };
  });
}

function resizeNoteGroup(
  snapshot: readonly NoteEvent[],
  requestedDelta: number,
  clipLengthBeats: number,
): NoteEvent[] {
  if (snapshot.length === 0) return [];
  const minimumDelta = Math.max(
    ...snapshot.map((note) => MIN_EVENT_DURATION_BEATS - note.durationBeats),
  );
  const maximumDelta = Math.min(
    ...snapshot.map(
      (note) => clipLengthBeats - note.startBeat - note.durationBeats,
    ),
  );
  const durationDelta = Math.max(
    minimumDelta,
    Math.min(maximumDelta, requestedDelta),
  );
  return snapshot.map((note) => ({
    ...note,
    durationBeats: note.durationBeats + durationDelta,
  }));
}

function adjustNoteGroupVelocity(
  snapshot: readonly NoteEvent[],
  requestedDelta: number,
): NoteEvent[] {
  if (snapshot.length === 0) return [];
  const minimumDelta = Math.max(...snapshot.map((note) => 1 - note.velocity));
  const maximumDelta = Math.min(...snapshot.map((note) => 127 - note.velocity));
  const velocityDelta = Math.max(
    minimumDelta,
    Math.min(maximumDelta, requestedDelta),
  );
  return snapshot.map((note) => ({ ...note, velocity: note.velocity + velocityDelta }));
}

function displayBeat(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function noteAccessibilityLabel(
  note: NoteEvent,
  isSelected: boolean,
  isInScale: boolean,
): string {
  return `${midiToNoteName(note.pitch)}。開始 ${displayBeat(note.startBeat + 1)} 拍目、長さ ${displayBeat(note.durationBeats)} 拍、強さ ${note.velocity}、${isInScale ? 'スケール内' : 'スケール外'}。${isSelected ? '選択中' : '未選択'}`;
}

function buildNoteGesturePreview(
  drag: NoteDragState,
  pointer: { clientX: number; clientY: number; shiftKey: boolean },
): NoteGesturePreview {
  const { clientX, clientY, shiftKey } = pointer;
  const dx = clientX - drag.startX;

  if (drag.kind === 'resize') {
    const source = drag.snapshot.find((note) => note.id === drag.noteId);
    if (!source) return { mode: 'replace', notes: [] };
    const beatDelta = xToBeat(dx, drag.ppb);
    const remainingBeats = Math.max(
      MIN_EVENT_DURATION_BEATS,
      drag.clipLengthBeats - source.startBeat,
    );
    let durationBeats = source.durationBeats + beatDelta;
    durationBeats = shiftKey
      ? Math.max(MIN_EVENT_DURATION_BEATS, durationBeats)
      : Math.max(
          MIN_EVENT_DURATION_BEATS,
          snapBeat(source.startBeat + durationBeats, drag.gridSnap) - source.startBeat,
        );
    durationBeats = Math.min(remainingBeats, durationBeats);
    return {
      mode: 'replace',
      notes: [{ ...source, durationBeats }],
    };
  }

  const anchor = drag.snapshot.find((note) => note.id === drag.noteId) ?? drag.snapshot[0];
  if (!anchor) return { mode: drag.duplicate ? 'duplicate' : 'replace', notes: [] };
  const rawBeatDelta = xToBeat(dx, drag.ppb);
  const requestedBeatDelta = shiftKey
    ? rawBeatDelta
    : snapBeat(anchor.startBeat + rawBeatDelta, drag.gridSnap) - anchor.startBeat;
  const requestedPitchDelta = -Math.round((clientY - drag.startY) / drag.rowHeight);
  const previewNotes = translateNoteGroup({
    snapshot: drag.snapshot,
    anchorId: drag.noteId,
    requestedBeatDelta,
    requestedPitchDelta,
    clipLengthBeats: drag.clipLengthBeats,
    scaleSnap: drag.scaleSnap,
    scalePcs: drag.scalePcs,
    scaleBias:
      requestedPitchDelta > 0 ? 'up' : requestedPitchDelta < 0 ? 'down' : 'nearest',
  });
  const sourceById = new Map(drag.snapshot.map((note) => [note.id, note]));
  const movedInTime = previewNotes.some((note) => {
    const source = sourceById.get(note.id);
    return source && source.startBeat !== note.startBeat;
  });
  if (requestedPitchDelta === 0 && !movedInTime) {
    return {
      mode: drag.duplicate ? 'duplicate' : 'replace',
      notes: drag.duplicate ? [] : drag.snapshot.map((note) => ({ ...note })),
    };
  }
  return {
    mode: drag.duplicate ? 'duplicate' : 'replace',
    notes: previewNotes,
  };
}

function hasFinalPlacementChange(
  drag: NoteDragState,
  preview: NoteGesturePreview,
  finalClientY: number,
): boolean {
  const originalById = new Map(drag.snapshot.map((note) => [note.id, note]));
  const requestedPitchDelta = -Math.round(
    (finalClientY - drag.startY) / drag.rowHeight,
  );
  return preview.notes.some((note) => {
    const original = originalById.get(note.id);
    return (
      original &&
      (original.startBeat !== note.startBeat ||
        (requestedPitchDelta !== 0 && original.pitch !== note.pitch))
    );
  });
}

/**
 * Interactive piano roll for the selected MIDI clip.
 *
 * Interactions: double-click empty cell adds a note; drag a note to move it
 * (snap to grid, Shift disables time snap); right-edge drag resizes; Alt+drag
 * duplicates; click selects, Shift+click multi-selects; drag on empty area is
 * a marquee. Explicit focused controls expose Q/S/C actions; Delete removes.
 */
export function PianoRoll() {
  const project = useStore((s) => s.project);
  const editor = useStore((s) => s.editor);
  const selectNotes = useStore((s) => s.selectNotes);
  const addNote = useStore((s) => s.addNote);
  const setZoomX = useStore((s) => s.setZoomX);

  const clip = findClip(project, editor.selectedClipId);
  const scaleInfo = useScaleInfo(project);
  const coarsePointer = useCoarsePointer();
  const rowHeight = coarsePointer ? COARSE_ROW_HEIGHT : FINE_ROW_HEIGHT;
  const noteInset = coarsePointer ? 0 : 1;

  const [gridSnap, setGridSnap] = useState(1);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const [notePreview, setNotePreview] = useState<NoteGesturePreview | null>(null);
  const [keyboardNoteId, setKeyboardNoteId] = useState<string | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState<KeyboardCursor>({
    startBeat: 0,
    pitch: 60,
  });
  const [gridKeyboardFocused, setGridKeyboardFocused] = useState(false);
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState('');
  const [pendingKeyboardFocus, setPendingKeyboardFocus] =
    useState<PendingKeyboardFocus | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const noteRefs = useRef(new Map<string, HTMLButtonElement>());
  const keyboardInstructionsId = useId();
  const keyboardStatusId = useId();

  const ppb = pxPerBeat(editor.zoomX);
  const rows = useMemo(() => buildRows(), []);
  const gridHeight = rows.length * rowHeight;
  const barBeats = beatsPerBar(project.timeSignature);
  const lengthBeats = projectLengthBeats(project);
  const gridWidth = lengthBeats * ppb;
  const notes = clip?.type === 'midi' ? clip.notes ?? [] : [];
  const visibleNotes = useMemo(
    () =>
      notes.filter(
        (note) => note.pitch >= PIANO_LOW_MIDI && note.pitch <= PIANO_HIGH_MIDI,
      ),
    [notes],
  );
  const visibleNoteIds = useMemo(
    () => new Set(visibleNotes.map((note) => note.id)),
    [visibleNotes],
  );
  const liveSelectedNoteIds = useMemo(
    () => editor.selectedNoteIds.filter((id) => visibleNoteIds.has(id)),
    [editor.selectedNoteIds, visibleNoteIds],
  );
  const selected = useMemo(
    () => new Set(liveSelectedNoteIds),
    [liveSelectedNoteIds],
  );
  const orderedNotes = useMemo(
    () =>
      [...visibleNotes].sort(
        (left, right) =>
          left.startBeat - right.startBeat ||
          left.pitch - right.pitch ||
          left.id.localeCompare(right.id),
      ),
    [visibleNotes],
  );
  const focusableNoteId = useMemo(() => {
    if (keyboardNoteId && visibleNoteIds.has(keyboardNoteId)) {
      return keyboardNoteId;
    }
    const selectedNote = liveSelectedNoteIds[0];
    return selectedNote ?? orderedNotes[0]?.id ?? null;
  }, [keyboardNoteId, liveSelectedNoteIds, orderedNotes, visibleNoteIds]);
  const previewById = useMemo(
    () =>
      notePreview?.mode === 'replace'
        ? new Map(notePreview.notes.map((note) => [note.id, note]))
        : new Map<string, NoteEvent>(),
    [notePreview],
  );

  useEffect(() => {
    dragRef.current = null;
    setMarquee(null);
    setNotePreview(null);
    setKeyboardNoteId(null);
    setKeyboardCursor({ startBeat: 0, pitch: 60 });
    setGridKeyboardFocused(false);
    setPendingKeyboardFocus(null);
  }, [clip?.id]);

  useEffect(() => {
    // A primary-pointer capability change also changes the pitch-row geometry.
    // Discard any in-flight preview rather than reinterpreting its coordinates.
    dragRef.current = null;
    setMarquee(null);
    setNotePreview(null);
  }, [rowHeight]);

  useEffect(() => {
    if (!clip) return;
    const maximumStart = Math.max(
      0,
      clip.lengthBeats - Math.min(gridSnap, clip.lengthBeats),
    );
    setKeyboardCursor((current) => ({
      startBeat: Math.max(0, Math.min(maximumStart, current.startBeat)),
      pitch: clampPitch(current.pitch),
    }));
  }, [clip?.lengthBeats, gridSnap]);

  useEffect(() => {
    if (
      liveSelectedNoteIds.length === editor.selectedNoteIds.length &&
      liveSelectedNoteIds.every((id, index) => id === editor.selectedNoteIds[index])
    ) {
      return;
    }
    selectNotes(liveSelectedNoteIds);
  }, [editor.selectedNoteIds, liveSelectedNoteIds, selectNotes]);

  useLayoutEffect(() => {
    if (!pendingKeyboardFocus) return;
    const target =
      pendingKeyboardFocus.kind === 'note'
        ? noteRefs.current.get(pendingKeyboardFocus.noteId) ?? null
        : gridRef.current;
    if (!target) return;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target.focus({ preventScroll: true });
    setPendingKeyboardFocus(null);
  }, [pendingKeyboardFocus, visibleNotes]);

  // --- keyboard shortcuts (ignored while another interactive control owns focus) ---
  useEffect(() => {
    function isInteractiveTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      return (
        t.closest(
          'button, input, textarea, select, a[href], summary, [contenteditable="true"], [data-shortcuts-suspended]',
        ) !== null
      );
    }
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isInteractiveTarget(e.target)) return;
      if (isAnyDialogOpen()) return;
      if (editor.activeView !== 'pianoRoll') return;
      const ids = liveSelectedNoteIds;
      if ((e.key === 'Delete' || e.key === 'Backspace') && clip && ids.length > 0) {
        e.preventDefault();
        removeNotes(clip.id, ids);
        selectNotes([]);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor.activeView, clip, liveSelectedNoteIds, selectNotes]);

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const boundedGridPoint = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const point = localPoint(e);
      return {
        x: Math.max(0, Math.min(gridWidth, point.x)),
        y: Math.max(0, Math.min(gridHeight, point.y)),
      };
    },
    [gridHeight, gridWidth, localPoint],
  );

  const previewForPointer = useCallback(
    (drag: NoteDragState, e: { clientX: number; clientY: number; shiftKey: boolean }) =>
      buildNoteGesturePreview(drag, e),
    [],
  );

  const onNotePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, note: NoteEvent) => {
      if (!clip || dragRef.current || !e.isPrimary || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      setKeyboardNoteId(note.id);
      e.currentTarget.focus({ preventScroll: true });
      const isResize =
        e.target instanceof Element && e.target.closest('.pr__note-resize') !== null;

      // selection handling
      const selectionBefore = [...liveSelectedNoteIds];
      let nextSelected: string[];
      let deselectOnClick = false;
      if (e.shiftKey) {
        if (selected.has(note.id)) {
          nextSelected = selectionBefore;
          deselectOnClick = true;
        } else {
          nextSelected = [...selectionBefore, note.id];
        }
      } else if (!selected.has(note.id)) {
        nextSelected = [note.id];
      } else {
        nextSelected = selectionBefore;
      }
      selectNotes(nextSelected);

      const dragIds = nextSelected.includes(note.id) ? nextSelected : [note.id];
      const live = visibleNotes;
      const snapshot = dragIds
        .map((id) => live.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is NoteEvent => candidate !== undefined)
        .map((candidate) => ({ ...candidate }));
      if (snapshot.length === 0) return;

      dragRef.current = {
        kind: isResize ? 'resize' : 'move',
        pointerId: e.pointerId,
        noteId: note.id,
        startX: e.clientX,
        startY: e.clientY,
        snapshot,
        duplicate: e.altKey && !isResize,
        clipId: clip.id,
        clipLengthBeats: clip.lengthBeats,
        ppb,
        gridSnap,
        rowHeight,
        scaleSnap: editor.scaleSnap,
        scalePcs: new Set(scaleInfo.scalePcs),
        selectionBefore,
        deselectOnClick,
      };
      if (!capturePointer(gridRef.current, e.pointerId)) {
        dragRef.current = null;
        selectNotes(selectionBefore);
      }
    },
    [
      clip,
      editor.scaleSnap,
      gridSnap,
      liveSelectedNoteIds,
      ppb,
      rowHeight,
      scaleInfo.scalePcs,
      selectNotes,
      selected,
      visibleNotes,
    ],
  );

  const onGridPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current || !e.isPrimary || e.button !== 0) return;
      const { x, y } = boundedGridPoint(e);
      if (!capturePointer(e.currentTarget as HTMLElement, e.pointerId)) return;
      dragRef.current = {
        kind: 'marquee',
        pointerId: e.pointerId,
        originX: x,
        originY: y,
        shiftKey: e.shiftKey,
        selectionBefore: [...liveSelectedNoteIds],
      };
      setMarquee({ x, y, w: 0, h: 0 });
    },
    [boundedGridPoint, liveSelectedNoteIds],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.kind === 'marquee') {
        const { x, y } = boundedGridPoint(e);
        const rect = normalizeRect(drag.originX, drag.originY, x, y);
        setMarquee(rect);
        return;
      }

      if (!crossedDragThreshold(drag, e.clientX, e.clientY)) {
        setNotePreview(null);
        return;
      }
      setNotePreview(previewForPointer(drag, e));
    },
    [boundedGridPoint, previewForPointer],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setMarquee(null);
    setNotePreview(null);

    if (drag.kind === 'marquee') {
      const { x, y } = boundedGridPoint(e);
      const finalMarquee = normalizeRect(drag.originX, drag.originY, x, y);
      const hitIds = visibleNotes
        .filter((n) => {
          const noteRect = {
            x: beatToX(n.startBeat, ppb),
            y: (PIANO_HIGH_MIDI - n.pitch) * rowHeight,
            w: Math.max(4, n.durationBeats * ppb),
            h: rowHeight,
          };
          return rectsOverlap(noteRect, finalMarquee);
        })
        .map((n) => n.id);
      const base = drag.shiftKey ? drag.selectionBefore : [];
      selectNotes(Array.from(new Set([...base, ...hitIds])));
      return;
    }

    if (!crossedDragThreshold(drag, e.clientX, e.clientY)) {
      if (drag.deselectOnClick) {
        selectNotes(drag.selectionBefore.filter((id) => id !== drag.noteId));
      }
      return;
    }
    const preview = previewForPointer(drag, e);
    if (preview.notes.length === 0) return;

    if (preview.mode === 'duplicate') {
      if (!hasFinalPlacementChange(drag, preview, e.clientY)) return;
      const created = duplicateNotesAt(
        drag.clipId,
        preview.notes.map((note) => ({
          sourceId: note.id,
          startBeat: note.startBeat,
          pitch: note.pitch,
        })),
      );
      if (created.length > 0) {
        selectNotes(created.map((note) => note.id));
        setKeyboardNoteId(created[0]?.id ?? null);
        if (created[0]) {
          setPendingKeyboardFocus({ kind: 'note', noteId: created[0].id });
        }
      }
      return;
    }

    if (drag.kind === 'move' && !hasFinalPlacementChange(drag, preview, e.clientY)) {
      return;
    }

    commitNoteUpdates(
      drag.clipId,
      preview.notes.map((note) => ({
        id: note.id,
        patch:
          drag.kind === 'resize'
            ? { durationBeats: note.durationBeats }
            : { startBeat: note.startBeat, pitch: note.pitch },
      })),
    );
  }, [boundedGridPoint, ppb, previewForPointer, rowHeight, selectNotes, visibleNotes]);

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setMarquee(null);
      setNotePreview(null);
      if (drag.kind !== 'marquee') selectNotes(drag.selectionBefore);
    },
    [selectNotes],
  );

  const onGridDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!clip || clip.type !== 'midi') return;
      const { x, y } = localPoint(e);
      const durationBeats = Math.min(gridSnap, clip.lengthBeats);
      const maximumStart = Math.max(0, clip.lengthBeats - durationBeats);
      const beat = Math.min(maximumStart, snapBeat(xToBeat(x, ppb), gridSnap));
      let pitch = clampPitch(yToPitch(y, rowHeight));
      if (editor.scaleSnap) pitch = clampPitch(snapPitchToPitchClasses(pitch, scaleInfo.scalePcs));
      const beforeIds = new Set((clip.notes ?? []).map((note) => note.id));
      addNote(clip.id, {
        pitch,
        startBeat: beat,
        durationBeats,
        velocity: DEFAULT_VELOCITY,
      });
      const committedClip = findClip(useStore.getState().project, clip.id);
      const created = committedClip?.notes?.find((note) => !beforeIds.has(note.id));
      if (created) {
        selectNotes([created.id]);
        setKeyboardNoteId(created.id);
        setPendingKeyboardFocus({ kind: 'note', noteId: created.id });
      }
    },
    [
      addNote,
      clip,
      editor.scaleSnap,
      gridSnap,
      localPoint,
      ppb,
      rowHeight,
      scaleInfo.scalePcs,
      selectNotes,
    ],
  );

  const keyboardSnapshotFor = useCallback(
    (note: NoteEvent): NoteEvent[] => {
      const ids = selected.has(note.id) ? liveSelectedNoteIds : [note.id];
      const byId = new Map(visibleNotes.map((candidate) => [candidate.id, candidate]));
      return ids
        .map((id) => byId.get(id))
        .filter((candidate): candidate is NoteEvent => candidate !== undefined)
        .map((candidate) => ({ ...candidate }));
    },
    [liveSelectedNoteIds, selected, visibleNotes],
  );

  const focusNote = useCallback((note: NoteEvent) => {
    setKeyboardNoteId(note.id);
    const target = noteRefs.current.get(note.id);
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target?.focus({ preventScroll: true });
  }, []);

  const onNoteKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, note: NoteEvent) => {
      if (event.altKey) return;
      const commandKey = (event.ctrlKey || event.metaKey) && !event.shiftKey;
      const isSelectAll = commandKey && event.key.toLowerCase() === 'a';
      const isDuplicate = commandKey && event.key.toLowerCase() === 'd';
      if ((event.ctrlKey || event.metaKey) && !isSelectAll && !isDuplicate) return;
      const isHorizontalArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const isPlainArrow =
        !commandKey &&
        !event.shiftKey &&
        (isHorizontalArrow || event.key === 'ArrowUp' || event.key === 'ArrowDown');
      const isResize = !commandKey && event.shiftKey && isHorizontalArrow;
      const isNavigation =
        !commandKey &&
        ((!event.shiftKey && (event.key === 'Home' || event.key === 'End')) ||
          (event.shiftKey && (event.key === 'PageUp' || event.key === 'PageDown')));
      const isVelocity =
        !commandKey &&
        !event.shiftKey &&
        (event.key === 'PageUp' || event.key === 'PageDown');
      const isSelection =
        !commandKey && !event.shiftKey && (event.key === 'Enter' || event.key === ' ');
      const isDelete =
        !commandKey &&
        !event.shiftKey &&
        (event.key === 'Delete' || event.key === 'Backspace');
      const isEscape = !commandKey && !event.shiftKey && event.key === 'Escape';
      if (
        !isSelectAll &&
        !isDuplicate &&
        !isPlainArrow &&
        !isResize &&
        !isNavigation &&
        !isVelocity &&
        !isSelection &&
        !isDelete &&
        !isEscape
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || !clip) return;

      if (isSelectAll) {
        selectNotes(orderedNotes.map((candidate) => candidate.id));
        setKeyboardAnnouncement(
          `現在クリップの編集音域にある${orderedNotes.length}個のノートをすべて選択しました。`,
        );
        return;
      }

      const snapshot = keyboardSnapshotFor(note);
      if (isDuplicate) {
        const finalNotes = translateNoteGroup({
          snapshot,
          anchorId: note.id,
          requestedBeatDelta: gridSnap,
          requestedPitchDelta: 0,
          clipLengthBeats: clip.lengthBeats,
          scaleSnap: editor.scaleSnap,
          scalePcs: scaleInfo.scalePcs,
        });
        const sourceById = new Map(snapshot.map((candidate) => [candidate.id, candidate]));
        const changed = finalNotes.some((candidate) => {
          const source = sourceById.get(candidate.id);
          return source && source.startBeat !== candidate.startBeat;
        });
        if (!changed) {
          setKeyboardAnnouncement('この方向には複製できません。');
          return;
        }
        const created = duplicateNotesAt(
          clip.id,
          finalNotes.map((candidate) => ({
            sourceId: candidate.id,
            startBeat: candidate.startBeat,
            pitch: candidate.pitch,
          })),
        );
        if (created.length === 0) {
          setKeyboardAnnouncement('ノートを複製できませんでした。');
          return;
        }
        selectNotes(created.map((candidate) => candidate.id));
        setKeyboardNoteId(created[0]?.id ?? null);
        if (created[0]) {
          setPendingKeyboardFocus({ kind: 'note', noteId: created[0].id });
        }
        setKeyboardAnnouncement(`${created.length}個のノートを複製しました。`);
        return;
      }

      if (isNavigation) {
        const index = Math.max(
          0,
          orderedNotes.findIndex((candidate) => candidate.id === note.id),
        );
        const target =
          event.key === 'Home'
            ? orderedNotes[0]
            : event.key === 'End'
              ? orderedNotes[orderedNotes.length - 1]
              : event.key === 'PageUp'
                ? orderedNotes[Math.max(0, index - 1)]
                : orderedNotes[Math.min(orderedNotes.length - 1, index + 1)];
        if (target) focusNote(target);
        return;
      }

      if (isSelection) {
        if (event.key === 'Enter') {
          selectNotes([note.id]);
          setKeyboardAnnouncement(`${midiToNoteName(note.pitch)}だけを選択しました。`);
        } else {
          const next = selected.has(note.id)
            ? liveSelectedNoteIds.filter((id) => id !== note.id)
            : [...liveSelectedNoteIds, note.id];
          selectNotes(next);
          setKeyboardAnnouncement(
            `${midiToNoteName(note.pitch)}を${selected.has(note.id) ? '選択解除' : '選択'}しました。`,
          );
        }
        return;
      }

      if (isEscape) {
        setKeyboardCursor({ startBeat: note.startBeat, pitch: note.pitch });
        gridRef.current?.focus({ preventScroll: true });
        setKeyboardAnnouncement('ピアノロールの入力位置へ戻りました。');
        return;
      }

      if (isDelete) {
        const ids = snapshot.map((candidate) => candidate.id);
        const deleting = new Set(ids);
        const currentIndex = orderedNotes.findIndex((candidate) => candidate.id === note.id);
        const fallback =
          orderedNotes.slice(Math.max(0, currentIndex + 1)).find((candidate) => !deleting.has(candidate.id)) ??
          [...orderedNotes.slice(0, Math.max(0, currentIndex))]
            .reverse()
            .find((candidate) => !deleting.has(candidate.id)) ??
          null;

        removeNotes(clip.id, ids);
        const committedClip = findClip(useStore.getState().project, clip.id);
        const remainingIds = new Set(committedClip?.notes?.map((candidate) => candidate.id) ?? []);
        if (ids.some((id) => remainingIds.has(id))) {
          setKeyboardAnnouncement('ノートを削除できませんでした。');
          return;
        }

        selectNotes(fallback ? [fallback.id] : []);
        setKeyboardNoteId(fallback?.id ?? null);
        setPendingKeyboardFocus(fallback
          ? { kind: 'note', noteId: fallback.id }
          : { kind: 'grid' });
        setKeyboardAnnouncement(
          `${ids.length}個のノートを削除しました。${fallback ? `${midiToNoteName(fallback.pitch)}を選択しました。` : '入力位置へ移動しました。'}`,
        );
        return;
      }

      if (isResize) {
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const finalNotes = resizeNoteGroup(snapshot, direction * gridSnap, clip.lengthBeats);
        const committed = commitNoteUpdates(
          clip.id,
          finalNotes.map((candidate) => ({
            id: candidate.id,
            patch: { durationBeats: candidate.durationBeats },
          })),
        );
        setKeyboardAnnouncement(
          committed.length > 0
            ? `${committed.length}個のノートの長さを変更しました。`
            : 'この方向へは長さを変更できません。',
        );
        return;
      }

      if (isVelocity) {
        const direction = event.key === 'PageUp' ? 1 : -1;
        const finalNotes = adjustNoteGroupVelocity(snapshot, direction * 5);
        const committed = commitNoteUpdates(
          clip.id,
          finalNotes.map((candidate) => ({
            id: candidate.id,
            patch: { velocity: candidate.velocity },
          })),
        );
        setKeyboardAnnouncement(
          committed.length > 0
            ? `${committed.length}個のノートの強さを変更しました。`
            : 'この方向へは強さを変更できません。',
        );
        return;
      }

      const requestedBeatDelta =
        event.key === 'ArrowLeft' ? -gridSnap : event.key === 'ArrowRight' ? gridSnap : 0;
      const requestedPitchDelta =
        event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      const finalNotes = translateNoteGroup({
        snapshot,
        anchorId: note.id,
        requestedBeatDelta,
        requestedPitchDelta,
        clipLengthBeats: clip.lengthBeats,
        scaleSnap: editor.scaleSnap,
        scalePcs: scaleInfo.scalePcs,
        scaleBias:
          requestedPitchDelta > 0 ? 'up' : requestedPitchDelta < 0 ? 'down' : 'nearest',
      });
      if (requestedBeatDelta !== 0) {
        const sourceById = new Map(snapshot.map((candidate) => [candidate.id, candidate]));
        const movedInTime = finalNotes.some((candidate) => {
          const source = sourceById.get(candidate.id);
          return source && source.startBeat !== candidate.startBeat;
        });
        if (!movedInTime) {
          setKeyboardAnnouncement('この方向へは移動できません。');
          return;
        }
      }
      const committed = commitNoteUpdates(
        clip.id,
        finalNotes.map((candidate) => ({
          id: candidate.id,
          patch: { startBeat: candidate.startBeat, pitch: candidate.pitch },
        })),
      );
      setKeyboardAnnouncement(
        committed.length > 0
          ? `${committed.length}個のノートを移動しました。`
          : 'この方向へは移動できません。',
      );
    },
    [
      clip,
      editor.scaleSnap,
      focusNote,
      gridSnap,
      keyboardSnapshotFor,
      liveSelectedNoteIds,
      orderedNotes,
      scaleInfo.scalePcs,
      selectNotes,
      selected,
    ],
  );

  const onGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      const recognized =
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'Enter' ||
        event.key === ' ';
      if (!recognized || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || !clip) return;

      if (event.key === 'Enter' || event.key === ' ') {
        const durationBeats = Math.min(
          gridSnap,
          clip.lengthBeats - keyboardCursor.startBeat,
        );
        if (durationBeats < MIN_EVENT_DURATION_BEATS) {
          setKeyboardAnnouncement('この位置にはノートを追加できません。');
          return;
        }
        const beforeIds = new Set(notes.map((note) => note.id));
        addNote(clip.id, {
          pitch: keyboardCursor.pitch,
          startBeat: keyboardCursor.startBeat,
          durationBeats,
          velocity: DEFAULT_VELOCITY,
        });
        const committedClip = findClip(useStore.getState().project, clip.id);
        const created = committedClip?.notes?.find((note) => !beforeIds.has(note.id));
        if (!created) {
          setKeyboardAnnouncement('ノートを追加できませんでした。');
          return;
        }
        selectNotes([created.id]);
        setKeyboardNoteId(created.id);
        setPendingKeyboardFocus({ kind: 'note', noteId: created.id });
        setKeyboardAnnouncement(`${midiToNoteName(created.pitch)}を追加しました。`);
        return;
      }

      const maximumStart = Math.max(0, clip.lengthBeats - Math.min(gridSnap, clip.lengthBeats));
      let startBeat = keyboardCursor.startBeat;
      let pitch = keyboardCursor.pitch;
      if (event.key === 'Home') startBeat = 0;
      else if (event.key === 'End') startBeat = maximumStart;
      else if (event.key === 'ArrowLeft') startBeat = Math.max(0, startBeat - gridSnap);
      else if (event.key === 'ArrowRight') startBeat = Math.min(maximumStart, startBeat + gridSnap);
      else {
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        pitch = clampPitch(pitch + direction);
        if (editor.scaleSnap) {
          const snappedPitch = snapPitchToPitchClasses(
            pitch,
            scaleInfo.scalePcs,
            PIANO_LOW_MIDI,
            PIANO_HIGH_MIDI,
            direction > 0 ? 'up' : 'down',
          );
          const snappedPc = ((snappedPitch % 12) + 12) % 12;
          pitch = scaleInfo.scalePcs.has(snappedPc)
            ? snappedPitch
            : keyboardCursor.pitch;
        }
      }
      setKeyboardCursor({ startBeat, pitch });
      setKeyboardAnnouncement(
        `入力位置は${midiToNoteName(pitch)}、${displayBeat(startBeat + 1)}拍目です。`,
      );
    },
    [
      addNote,
      clip,
      editor.scaleSnap,
      gridSnap,
      keyboardCursor,
      notes,
      scaleInfo.scalePcs,
      selectNotes,
    ],
  );

  const quantizeSelection = useCallback(() => {
    if (!clip || liveSelectedNoteIds.length === 0) return;
    const committed = quantizeNotes(clip.id, liveSelectedNoteIds, gridSnap);
    setKeyboardAnnouncement(
      committed.length > 0
        ? `${committed.length}個のノートをクオンタイズしました。`
        : '選択ノートはすでに現在のグリッド上です。',
    );
  }, [clip, gridSnap, liveSelectedNoteIds]);

  if (!clip || clip.type !== 'midi') {
    return (
      <div className="empty-hint">
        トラック一覧からMIDIクリップを選ぶと、ここでノートを編集できます。
      </div>
    );
  }

  return (
    <div className="pr">
      <span id={keyboardInstructionsId} className="visually-hidden">
        ノートでは、矢印キーで移動、Shiftと左右矢印で長さ変更、PageUpとPageDownで強さ変更、ShiftとPageUpまたはPageDownで前後のノートへ移動します。Enterで単独選択、Spaceで選択切替、ControlまたはCommandとAで現在クリップの編集音域にある音をすべて選択、ControlまたはCommandとDで複製、Deleteで削除します。Escapeで入力位置へ戻ります。
      </span>
      <span
        id={keyboardStatusId}
        className="visually-hidden"
        aria-live="polite"
        aria-atomic="true"
      >
        {keyboardAnnouncement}
      </span>
      <div className="pr__toolbar">
        <label className="pr__field">
          <span>グリッド</span>
          <select
            value={gridSnap}
            onChange={(e) => setGridSnap(Number(e.target.value))}
            aria-label="グリッド分解能"
          >
            {GRID_SNAP_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {GRID_SNAP_LABELS[opt] ?? `${opt}拍`}
              </option>
            ))}
          </select>
        </label>
        <div className="pr__zoom" role="group" aria-label="横ズーム">
          <button
            type="button"
            onClick={() => setZoomX(Math.max(0.5, editor.zoomX - 0.25))}
            aria-label="ズームアウト"
          >
            −
          </button>
          <span className="pr__zoom-val">{Math.round(editor.zoomX * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoomX(Math.min(4, editor.zoomX + 0.25))}
            aria-label="ズームイン"
          >
            ＋
          </button>
        </div>
        <button
          type="button"
          disabled={liveSelectedNoteIds.length === 0}
          aria-keyshortcuts="Q"
          onClick={quantizeSelection}
          onKeyDown={(event) => {
            if (
              !event.repeat &&
              event.key.toLowerCase() === 'q' &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              quantizeSelection();
            }
          }}
        >
          選択ノートをクオンタイズ
        </button>
        <p className="pr__hint">
          ダブルクリックでノート追加 / ドラッグで移動（Shiftで自由位置）/ 右端で長さ変更 /
          Alt+ドラッグで複製 / Tabでノートへ移動 / 矢印キーで編集 / Delete=削除
        </p>
      </div>

      <div className="pr__scroll">
        <div className="pr__keyboard" style={{ height: gridHeight }}>
          {rows.map((midi) => {
            const pc = ((midi % 12) + 12) % 12;
            const inScale = scaleInfo.scalePcs.has(pc);
            const isC = pc === 0;
            return (
              <div
                key={midi}
                className={`pr__key${inScale ? ' is-scale' : ''}${isC ? ' is-c' : ''}`}
                style={{ height: rowHeight }}
              >
                {isC ? <span className="pr__key-label">{midiToNoteName(midi)}</span> : null}
              </div>
            );
          })}
        </div>

        <div
          ref={gridRef}
          className="pr__grid"
          role="group"
          tabIndex={visibleNotes.length === 0 ? 0 : -1}
          aria-label={`ピアノロール入力位置。${midiToNoteName(keyboardCursor.pitch)}、${displayBeat(keyboardCursor.startBeat + 1)}拍目`}
          aria-describedby={`${keyboardInstructionsId} ${keyboardStatusId}`}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter Space"
          data-shortcuts-suspended="true"
          style={{ width: gridWidth, height: gridHeight }}
          onPointerDown={onGridPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onDoubleClick={onGridDoubleClick}
          onKeyDown={onGridKeyDown}
          onFocus={(event) => {
            if (event.target !== event.currentTarget) return;
            setGridKeyboardFocused(true);
            setKeyboardAnnouncement(
              `入力位置は${midiToNoteName(keyboardCursor.pitch)}、${displayBeat(keyboardCursor.startBeat + 1)}拍目です。`,
            );
          }}
          onBlur={(event) => {
            if (event.target === event.currentTarget) setGridKeyboardFocused(false);
          }}
        >
          {/* pitch-row tints */}
          {rows.map((midi, i) => {
            const pc = ((midi % 12) + 12) % 12;
            const inScale = scaleInfo.scalePcs.has(pc);
            return (
              <div
                key={midi}
                className={`pr__row${inScale ? ' is-scale' : ''}`}
                style={{ top: i * rowHeight, height: rowHeight }}
              />
            );
          })}

          {/* bar / beat gridlines */}
          {Array.from({ length: Math.ceil(lengthBeats) + 1 }, (_, beat) => (
            <div
              key={`beat-${beat}`}
              className="pr__gridline"
              style={{ left: beat * ppb }}
            />
          ))}
          {Array.from({ length: project.lengthBars + 1 }, (_, bar) => (
            <div
              key={`bar-${bar}`}
              className="pr__gridline is-bar"
              style={{ left: bar * barBeats * ppb }}
            />
          ))}

          {/* chord-tone highlight per region (when C on) */}
          {editor.chordToneHighlight
            ? project.chordTrack.map((chord) =>
                rows.map((midi, i) => {
                  const pc = ((midi % 12) + 12) % 12;
                  const isChordTone = chord.notes
                    .map((n) => ((n % 12) + 12) % 12)
                    .includes(pc);
                  if (!isChordTone) return null;
                  return (
                    <div
                      key={`ct-${chord.id}-${midi}`}
                      className="pr__chordtone"
                      style={{
                        top: i * rowHeight,
                        height: rowHeight,
                        left: chord.startBeat * ppb,
                        width: chord.durationBeats * ppb,
                      }}
                    />
                  );
                }),
              )
            : null}

          {gridKeyboardFocused ? (
            <div
              className="pr__keyboard-cursor"
              style={{
                top: (PIANO_HIGH_MIDI - keyboardCursor.pitch) * rowHeight + noteInset,
                left: keyboardCursor.startBeat * ppb,
                width: Math.max(4, Math.min(gridSnap, clip.lengthBeats) * ppb - 1),
                height: rowHeight - noteInset * 2,
              }}
              aria-hidden="true"
            />
          ) : null}

          {/* notes */}
          {visibleNotes.map((note) => {
            const displayedNote = previewById.get(note.id) ?? note;
            const i = PIANO_HIGH_MIDI - displayedNote.pitch;
            if (i < 0 || i >= rows.length) return null;
            const pc = ((displayedNote.pitch % 12) + 12) % 12;
            const outOfScale = scaleInfo.scalePcs.size > 0 && !scaleInfo.scalePcs.has(pc);
            const isSelected = selected.has(note.id);
            return (
              <button
                type="button"
                key={note.id}
                ref={(element) => {
                  if (element) noteRefs.current.set(note.id, element);
                  else noteRefs.current.delete(note.id);
                }}
                className={`pr__note${isSelected ? ' is-selected' : ''}${outOfScale ? ' is-out' : ''}`}
                tabIndex={note.id === focusableNoteId ? 0 : -1}
                aria-label={noteAccessibilityLabel(displayedNote, isSelected, !outOfScale)}
                aria-pressed={isSelected}
                aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Shift+PageUp Shift+PageDown Home End Enter Space Control+A Meta+A Control+D Meta+D Delete Backspace Escape"
                style={{
                  top: i * rowHeight + noteInset,
                  left: displayedNote.startBeat * ppb,
                  width: Math.max(4, displayedNote.durationBeats * ppb - 1),
                  height: rowHeight - noteInset * 2,
                  opacity: 0.45 + (displayedNote.velocity / 127) * 0.55,
                }}
                onPointerDown={(e) => onNotePointerDown(e, note)}
                onKeyDown={(event) => onNoteKeyDown(event, note)}
                onFocus={() => {
                  setKeyboardNoteId(note.id);
                  setKeyboardAnnouncement(`${midiToNoteName(displayedNote.pitch)}にフォーカスしました。`);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.detail === 0) selectNotes([note.id]);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                title={`${midiToNoteName(displayedNote.pitch)} / 強さ ${displayedNote.velocity}`}
              >
                <span className="pr__note-resize" />
              </button>
            );
          })}

          {/* Alt-drag copies are visual-only until pointerup commits them. */}
          {notePreview?.mode === 'duplicate'
            ? notePreview.notes.map((note) => {
                const i = PIANO_HIGH_MIDI - note.pitch;
                if (i < 0 || i >= rows.length) return null;
                const pc = ((note.pitch % 12) + 12) % 12;
                const outOfScale = scaleInfo.scalePcs.size > 0 && !scaleInfo.scalePcs.has(pc);
                return (
                  <div
                    key={`preview-${note.id}`}
                    className={`pr__note-preview-copy${outOfScale ? ' is-out' : ''}`}
                    style={{
                      top: i * rowHeight + noteInset,
                      left: note.startBeat * ppb,
                      width: Math.max(4, note.durationBeats * ppb - 1),
                      height: rowHeight - noteInset * 2,
                    }}
                    aria-hidden="true"
                  />
                );
              })
            : null}

          {/* marquee */}
          {marquee ? (
            <div
              className="pr__marquee"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.w,
                height: marquee.h,
              }}
            />
          ) : null}
        </div>
      </div>

      <VelocityLane
        clipId={clip.id}
        notes={visibleNotes}
        ppb={ppb}
        width={gridWidth}
        selectedIds={selected}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Velocity lane — drag bars to set the velocity of the hit / selected note.
// ---------------------------------------------------------------------------

const LANE_HEIGHT = 64;

function VelocityLane(props: {
  clipId: string;
  notes: readonly NoteEvent[];
  ppb: number;
  width: number;
  selectedIds: ReadonlySet<string>;
}) {
  const { clipId, notes, ppb, width, selectedIds } = props;
  const laneRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{
    pointerId: number;
    noteId: string;
  } | null>(null);
  const [preview, setPreview] = useState<{ noteId: string; velocity: number } | null>(null);

  const velocityFromY = useCallback((clientY: number): number => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return DEFAULT_VELOCITY;
    const ratio = 1 - (clientY - rect.top) / rect.height;
    return Math.max(1, Math.min(127, Math.round(ratio * 127)));
  }, []);

  useEffect(() => {
    draggingRef.current = null;
    setPreview(null);
  }, [clipId]);

  const onBarDown = useCallback(
    (e: React.PointerEvent, noteId: string) => {
      if (draggingRef.current || !e.isPrimary || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const velocity = velocityFromY(e.clientY);
      draggingRef.current = { pointerId: e.pointerId, noteId };
      setPreview({ noteId, velocity });
      if (!capturePointer(laneRef.current, e.pointerId)) {
        draggingRef.current = null;
        setPreview(null);
      }
    },
    [velocityFromY],
  );
  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const velocity = velocityFromY(e.clientY);
      setPreview({ noteId: drag.noteId, velocity });
    },
    [velocityFromY],
  );
  const onUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const velocity = velocityFromY(e.clientY);
      draggingRef.current = null;
      setPreview(null);
      commitNoteUpdates(clipId, [{ id: drag.noteId, patch: { velocity } }]);
    },
    [clipId, velocityFromY],
  );
  const onCancel = useCallback((e: React.PointerEvent) => {
    const drag = draggingRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    draggingRef.current = null;
    setPreview(null);
  }, []);

  return (
    <div className="pr__velocity">
      <span className="pr__velocity-label">強さ</span>
      <div
        ref={laneRef}
        className="pr__velocity-lane"
        style={{ width, height: LANE_HEIGHT }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onLostPointerCapture={onCancel}
      >
        {notes.map((note) => {
          const displayedVelocity = preview?.noteId === note.id ? preview.velocity : note.velocity;
          const h = (displayedVelocity / 127) * LANE_HEIGHT;
          const isSel = selectedIds.has(note.id);
          return (
            <div
              key={note.id}
              className={`pr__velbar${isSel ? ' is-selected' : ''}`}
              style={{ left: note.startBeat * ppb, height: h, bottom: 0 }}
              onPointerDown={(e) => onBarDown(e, note.id)}
              title={`強さ ${displayedVelocity}`}
            />
          );
        })}
      </div>
    </div>
  );
}
