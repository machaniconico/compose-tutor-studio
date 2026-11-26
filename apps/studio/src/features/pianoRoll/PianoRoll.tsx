import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fitClipToNotes, useStore, watchDragEnd } from '../../state/store';
import { findShortcut } from '../../state/keymap';
import type { Clip, NoteEvent, Project, Track } from '@cts/project-model';
import { beatsPerBar, resolveLinkSource } from '@cts/project-model';
import { midiToNoteName } from '@cts/theory-engine';
import { pxPerBeat } from '../timeline';
import { Playhead, TimelineRuler } from '../transport/TimelineRuler';
import { isAnyDialogOpen } from '../common/dialogState';
import { useScaleInfo } from './useScaleInfo';
import { PREVIEW_DURATION_MS, previewNote } from '../../audio/livePreview';
import {
  GRID_SNAP_OPTIONS,
  GRID_SNAP_LABELS,
  PIANO_HIGH_MIDI,
  PIANO_LOW_MIDI,
  beatToX,
  clampPitch,
  initialPitchWindow,
  notesInRows,
  pitchSpan,
  windowScrollTop,
  normalizeRect,
  pitchToY,
  quantizeNotes as quantizeNoteStarts,
  rectsOverlap,
  snapBeat,
  snapPitchToPitchClasses,
  visibleRowRange,
  xToBeat,
  yToPitch,
} from './gridMath';
import { duplicateNotes, removeNotes } from '../../state/editorActions';
import { pushToast } from '../../state/tutorialBridge';

const ROW_HEIGHT = 16;
/** Height of the sticky ruler above the rows (styles.css: 20px + 2px margin). */
const RULER_HEIGHT = 22;
const RESIZE_HANDLE_PX = 6;
const DEFAULT_VELOCITY = 100;
const MIN_VELOCITY = 1;
const MAX_VELOCITY = 127;
/** Extra rows rendered above/below the viewport (covers the sticky ruler too). */
const ROW_OVERSCAN = 8;

/** Find a clip across all tracks. */
function findClip(tracks: readonly Track[], clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

/** Visible MIDI rows, high pitch at the top. */
function buildRows(): number[] {
  const rows: number[] = [];
  for (let midi = PIANO_HIGH_MIDI; midi >= PIANO_LOW_MIDI; midi -= 1) rows.push(midi);
  return rows;
}

function clampVelocity(velocity: number): number {
  if (!Number.isFinite(velocity)) return DEFAULT_VELOCITY;
  return Math.max(MIN_VELOCITY, Math.min(MAX_VELOCITY, Math.round(velocity)));
}

function mapClipNotes(
  project: Project,
  clipId: string,
  updateNotes: (notes: readonly NoteEvent[]) => NoteEvent[],
): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === clipId ? { ...clip, notes: updateNotes(clip.notes ?? []) } : clip,
      ),
    })),
  };
}

function hasVelocityChanges(
  baseVelocities: ReadonlyMap<string, number>,
  nextVelocities: ReadonlyMap<string, number>,
): boolean {
  for (const [id, velocity] of nextVelocities) {
    if (baseVelocities.get(id) !== velocity) return true;
  }
  return false;
}

/** Undo transaction owner: a stale pointer event only closes a note drag's own step. */
const NOTE_DRAG = Symbol('noteDrag');

type DragState = {
  kind: 'move' | 'resize' | 'marquee';
  noteId: string | null;
  startX: number;
  startY: number;
  originStart: number;
  originDuration: number;
  originPitch: number;
  snapshot: { id: string; startBeat: number; pitch: number }[];
  shiftKey: boolean;
};

type VelocityDragState = {
  noteIds: string[];
  baseVelocities: Map<string, number>;
  anchorVelocity: number;
  nextVelocities: Map<string, number>;
};

/**
 * Interactive piano roll for the selected MIDI clip.
 *
 * Interactions: double-click empty cell adds a note; drag a note to move it
 * (snap to grid, Shift disables time snap); right-edge drag resizes; Alt+drag
 * duplicates; click selects, Shift+click multi-selects; drag on empty area is
 * a marquee. Q quantizes, Delete removes, S/C toggle scale-snap / chord-tone.
 */
export function PianoRoll() {
  const project = useStore((s) => s.project);
  const projectOpenVersion = useStore((s) => s.projectOpenVersion);
  const editor = useStore((s) => s.editor);
  const selectClip = useStore((s) => s.selectClip);
  const selectTrack = useStore((s) => s.selectTrack);
  const selectNotes = useStore((s) => s.selectNotes);
  const addNote = useStore((s) => s.addNote);
  const updateNote = useStore((s) => s.updateNote);
  const updateNotes = useStore((s) => s.updateNotes);
  const applyProjectChange = useStore((s) => s.applyProjectChange);
  const setZoomX = useStore((s) => s.setZoomX);
  const toggleScaleSnap = useStore((s) => s.toggleScaleSnap);
  const toggleChordToneHighlight = useStore((s) => s.toggleChordToneHighlight);
  const togglePreviewOnPlace = useStore((s) => s.togglePreviewOnPlace);
  const beginTransaction = useStore((s) => s.beginTransaction);
  const commitTransaction = useStore((s) => s.commitTransaction);

  const selectedClip = findClip(project.tracks, editor.selectedClipId);
  const linkedClip = selectedClip?.type === 'midi' && selectedClip.aliasOf !== undefined ? selectedClip : null;
  const clip = linkedClip ? null : selectedClip;
  const clipInstrument = clip
    ? project.tracks.find((t) => t.clips.some((c) => c.id === clip.id))?.instrument
    : undefined;
  const scaleInfo = useScaleInfo(project);

  const [gridSnap, setGridSnap] = useState(1);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const ppb = pxPerBeat(editor.zoomX);
  const rows = useMemo(() => buildRows(), []);
  const gridHeight = rows.length * ROW_HEIGHT;
  const bpb = beatsPerBar(project.timeSignature);
  const lengthBeats = project.lengthBars * bpb;
  const gridWidth = lengthBeats * ppb;
  const selected = useMemo(() => new Set(editor.selectedNoteIds), [editor.selectedNoteIds]);
  const positionBeat = useStore((s) => s.transport.positionBeat);

  const notes = clip?.type === 'midi' ? clip.notes ?? [] : [];

  // Vertical scroll + simple virtualization: only rows in view are rendered.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const clipId = clip?.id ?? null;
  useLayoutEffect(() => {
    if (!clipId) return;
    // Open on the clip's note range plus an octave of margin (C3..C5 when empty),
    // centred in the viewport so the notes are in view even when it is short.
    // Notes outside the 88 keys (a saved file may hold any MIDI 0..127) have no
    // row, so they do not pull the view; they stay stored as they are.
    const pitches = notesRef.current
      .map((n) => n.pitch)
      .filter((p) => p >= PIANO_LOW_MIDI && p <= PIANO_HIGH_MIDI);
    const win = initialPitchWindow(pitches);
    const el = scrollRef.current;
    const height = el?.clientHeight || (win.high - win.low + 1) * ROW_HEIGHT + RULER_HEIGHT;
    // The sticky ruler covers the top of the scroll area, so rows get the rest.
    const top = windowScrollTop(
      win,
      height - RULER_HEIGHT,
      ROW_HEIGHT,
      rows.length,
      PIANO_HIGH_MIDI,
      pitchSpan(pitches) ?? undefined,
    );
    if (el) el.scrollTop = top;
    setView({ top: el ? el.scrollTop : top, height });
  }, [clipId, projectOpenVersion, rows.length]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setView((prev) => ({ top: el.scrollTop, height: el.clientHeight || prev.height }));
  }, []);
  // A resize that does not scroll (e.g. a taller window) still changes which
  // rows are visible, so re-measure on resize.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => onScroll());
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', onScroll);
    return () => window.removeEventListener('resize', onScroll);
  }, [clipId, onScroll]);
  const { first: firstRow, last: lastRow } = visibleRowRange(
    view.top,
    view.height,
    ROW_HEIGHT,
    rows.length,
    ROW_OVERSCAN,
  );
  const visibleRows = rows.slice(firstRow, lastRow + 1);
  // Notes indexed by row, so only notes on rendered rows are mounted.
  const notesByRow = useMemo(() => {
    const byRow = new Map<number, NoteEvent[]>();
    for (const note of notes) {
      const row = PIANO_HIGH_MIDI - note.pitch;
      if (row < 0 || row >= rows.length) continue;
      const list = byRow.get(row);
      if (list) list.push(note);
      else byRow.set(row, [note]);
    }
    return byRow;
  }, [notes, rows.length]);
  // The note under an active pointer stays mounted while it is dragged, even
  // when scrolled out of view, so it keeps its pointer capture.
  const [heldNoteId, setHeldNoteId] = useState<string | null>(null);
  const renderedNotes = useMemo(() => {
    const out = notesInRows(notesByRow, firstRow, lastRow);
    if (heldNoteId !== null && !out.some((n) => n.id === heldNoteId)) {
      const held = notes.find((n) => n.id === heldNoteId);
      const row = held ? PIANO_HIGH_MIDI - held.pitch : -1;
      if (held && row >= 0 && row < rows.length) out.push(held);
    }
    return out;
  }, [notesByRow, firstRow, lastRow, heldNoteId, notes, rows.length]);

  const previewKey = useCallback(
    (midi: number) => {
      void previewNote(clipInstrument, midi, DEFAULT_VELOCITY, PREVIEW_DURATION_MS).catch(() =>
        pushToast(
          '試聴の音を鳴らせませんでした。もう一度鍵盤をクリックするか、OSの音声出力を確認してください。',
          'error',
        ),
      );
    },
    [clipInstrument],
  );

  const quantizeSelectedNotes = useCallback(() => {
    if (!clip || clip.type !== 'midi' || editor.selectedNoteIds.length === 0) return;
    const ids = new Set(editor.selectedNoteIds);
    const selectedNotes = notes.filter((note) => ids.has(note.id));
    const quantized = quantizeNoteStarts(selectedNotes, gridSnap);
    const changed = quantized.some(
      (note, index) => note.startBeat !== selectedNotes[index]?.startBeat,
    );
    if (!changed) return;
    const quantizedById = new Map(quantized.map((note) => [note.id, note]));

    // A note quantized onto or past the end of the clip lengthens it (same undo step).
    applyProjectChange((project) => {
      const next = mapClipNotes(project, clip.id, (clipNotes) =>
        clipNotes.map((note) => quantizedById.get(note.id) ?? note),
      );
      return {
        ...next,
        tracks: next.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((c) => (c.id === clip.id ? fitClipToNotes(c) : c)),
        })),
      };
    });
  }, [applyProjectChange, clip, editor.selectedNoteIds, gridSnap, notes]);

  // --- keyboard shortcuts (ignored while typing in inputs) ---
  useEffect(() => {
    if (linkedClip) return;
    function isEditableTarget(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      if (isAnyDialogOpen()) return;
      if (editor.activeView !== 'pianoRoll') return;
      const ids = editor.selectedNoteIds;
      const action = findShortcut('pianoRoll', e);
      if (action === 'deleteSelectedNotes' && clip && ids.length > 0) {
        e.preventDefault();
        removeNotes(clip.id, ids);
        selectNotes([]);
        // Deleting the dragged note removes the pointer capture: a drag ends here.
        commitTransaction(NOTE_DRAG);
      } else if (action === 'quantizeSelection' && clip && ids.length > 0) {
        e.preventDefault();
        quantizeSelectedNotes();
      } else if (action === 'toggleScaleSnap') {
        e.preventDefault();
        toggleScaleSnap();
      } else if (action === 'toggleChordToneHighlight') {
        e.preventDefault();
        toggleChordToneHighlight();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    editor.activeView,
    editor.selectedNoteIds,
    clip,
    linkedClip,
    commitTransaction,
    quantizeSelectedNotes,
    selectNotes,
    toggleScaleSnap,
    toggleChordToneHighlight,
  ]);

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const commitMove = useCallback(
    (drag: DragState, dx: number, dy: number, shift: boolean) => {
      if (!clip) return;
      const beatDelta = xToBeat(dx, ppb);
      const rowDelta = Math.round(dy / ROW_HEIGHT);
      const patches = new Map<string, { startBeat: number; pitch: number }>();
      for (const snap of drag.snapshot) {
        let nextStart = snap.startBeat + beatDelta;
        nextStart = shift ? Math.max(0, nextStart) : snapBeat(nextStart, gridSnap);
        let nextPitch = clampPitch(snap.pitch - rowDelta);
        if (editor.scaleSnap) {
          nextPitch = clampPitch(snapPitchToPitchClasses(nextPitch, scaleInfo.scalePcs, PIANO_LOW_MIDI, PIANO_HIGH_MIDI));
        }
        patches.set(snap.id, { startBeat: nextStart, pitch: nextPitch });
      }
      if (patches.size > 0) updateNotes(clip.id, patches);
    },
    [clip, ppb, gridSnap, editor.scaleSnap, scaleInfo.scalePcs, updateNotes],
  );

  const onNotePointerDown = useCallback(
    (e: React.PointerEvent, note: NoteEvent) => {
      if (!clip) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setHeldNoteId(note.id);
      const { x } = localPoint(e);
      const noteRightX = beatToX(note.startBeat + note.durationBeats, ppb);
      const isResize = Math.abs(x - noteRightX) <= RESIZE_HANDLE_PX;

      // selection handling
      let nextSelected: string[];
      if (e.shiftKey) {
        nextSelected = selected.has(note.id)
          ? editor.selectedNoteIds.filter((id) => id !== note.id)
          : [...editor.selectedNoteIds, note.id];
      } else if (!selected.has(note.id)) {
        nextSelected = [note.id];
      } else {
        nextSelected = editor.selectedNoteIds;
      }
      selectNotes(nextSelected);
      beginTransaction(NOTE_DRAG);
      watchDragEnd(NOTE_DRAG, e.pointerId);

      // Alt+drag duplicates the selection, then drags the copies.
      let dragIds = nextSelected.includes(note.id) ? nextSelected : [note.id];
      if (e.altKey && !isResize) {
        const created = duplicateNotes(clip.id, dragIds, 0);
        if (created.length === 0) return;
        dragIds = created;
        selectNotes(created);
      }

      const live = clip.notes ?? [];
      const snapshot = dragIds
        .map((id) => live.find((n) => n.id === id))
        .filter((n): n is NoteEvent => n !== undefined)
        .map((n) => ({ id: n.id, startBeat: n.startBeat, pitch: n.pitch }));

      dragRef.current = {
        kind: isResize ? 'resize' : 'move',
        noteId: note.id,
        startX: e.clientX,
        startY: e.clientY,
        originStart: note.startBeat,
        originDuration: note.durationBeats,
        originPitch: note.pitch,
        snapshot,
        shiftKey: e.shiftKey,
      };
    },
    [beginTransaction, clip, localPoint, ppb, selected, editor.selectedNoteIds, selectNotes],
  );

  const onGridPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const { x, y } = localPoint(e);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = {
        kind: 'marquee',
        noteId: null,
        startX: e.clientX,
        startY: e.clientY,
        originStart: x,
        originDuration: 0,
        originPitch: y,
        snapshot: [],
        shiftKey: e.shiftKey,
      };
      setMarquee({ x, y, w: 0, h: 0 });
      if (!e.shiftKey) selectNotes([]);
    },
    [localPoint, selectNotes],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Undo or a lost window focus closed the transaction: this drag is over.
      if (drag.kind !== 'marquee' && !useStore.getState().ownsTransaction(NOTE_DRAG)) {
        dragRef.current = null;
        return;
      }
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.kind === 'move') {
        commitMove(drag, dx, dy, e.shiftKey);
      } else if (drag.kind === 'resize' && clip && drag.noteId) {
        const beatDelta = xToBeat(dx, ppb);
        let nextDuration = drag.originDuration + beatDelta;
        nextDuration = e.shiftKey
          ? Math.max(0.0625, nextDuration)
          : Math.max(
              gridSnap,
              snapBeat(drag.originStart + nextDuration, gridSnap) - drag.originStart,
            );
        updateNote(clip.id, drag.noteId, { durationBeats: nextDuration });
      } else if (drag.kind === 'marquee') {
        const { x, y } = localPoint(e);
        const rect = normalizeRect(drag.originStart, drag.originPitch, x, y);
        setMarquee(rect);
      }
    },
    [clip, commitMove, ppb, gridSnap, updateNote, localPoint],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.kind === 'marquee' && marquee) {
      const hitIds = notes
        .filter((n) => {
          const noteRect = {
            x: beatToX(n.startBeat, ppb),
            y: (PIANO_HIGH_MIDI - n.pitch) * ROW_HEIGHT,
            w: Math.max(4, n.durationBeats * ppb),
            h: ROW_HEIGHT,
          };
          return rectsOverlap(noteRect, marquee);
        })
        .map((n) => n.id);
      if (hitIds.length > 0) {
        const base = drag.shiftKey ? editor.selectedNoteIds : [];
        selectNotes(Array.from(new Set([...base, ...hitIds])));
      }
    }
    dragRef.current = null;
    setHeldNoteId(null);
    setMarquee(null);
  }, [marquee, notes, ppb, editor.selectedNoteIds, selectNotes]);

  const onPointerCancel = useCallback(() => {
    dragRef.current = null;
    setHeldNoteId(null);
    setMarquee(null);
  }, []);

  const onGridDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!clip || clip.type !== 'midi') return;
      const { x, y } = localPoint(e);
      let beat = snapBeat(xToBeat(x, ppb), gridSnap);
      // A looping clip only sounds its first repeat's content, so a note placed
      // in a later repeat goes into the first one: it then sounds at the click
      // (and in every repeat) instead of being saved silent.
      const period = clip.contentLengthBeats ?? clip.lengthBeats;
      if (clip.loop && period > 0 && beat >= period) {
        beat %= period;
        // Float remainders a hair under the period mean "the next repeat's start".
        if (period - beat < 1e-9) beat = 0;
      }
      let pitch = clampPitch(yToPitch(y, ROW_HEIGHT));
      if (editor.scaleSnap) pitch = clampPitch(snapPitchToPitchClasses(pitch, scaleInfo.scalePcs, PIANO_LOW_MIDI, PIANO_HIGH_MIDI));
      const added = addNote(clip.id, {
        pitch,
        startBeat: beat,
        durationBeats: gridSnap,
        velocity: DEFAULT_VELOCITY,
      });
      if (added && editor.previewOnPlace) previewKey(pitch);
    },
    [
      clip,
      localPoint,
      ppb,
      gridSnap,
      editor.scaleSnap,
      editor.previewOnPlace,
      scaleInfo.scalePcs,
      addNote,
      previewKey,
    ],
  );

  if (linkedClip) {
    const source = resolveLinkSource(linkedClip, project.tracks.flatMap((track) => track.clips));
    return (
      <div className="empty-hint">
        {typeof source === 'string' ? (
          <p>{source}</p>
        ) : (
          <>
            <p>このクリップは別のクリップと中身を共有しています。音を変えるには元のクリップを編集します。</p>
            {source.type === 'midi' && (
              <button
                type="button"
                onClick={() => {
                  selectTrack(source.trackId);
                  selectClip(source.id);
                  selectNotes([]);
                }}
              >
                元のクリップを開く
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  if (!clip || clip.type !== 'midi') {
    return (
      <div className="empty-hint">
        トラック一覧からMIDIクリップを選ぶと、ここでノートを編集できます。
      </div>
    );
  }

  return (
    <div className="pr">
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
        <button
          type="button"
          onClick={quantizeSelectedNotes}
          disabled={editor.selectedNoteIds.length === 0}
        >
          選択をクオンタイズ
        </button>
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
        <label className="pr__field" title="ノートを置いたとき、そのトラックの音で短く鳴らします">
          <input
            type="checkbox"
            checked={editor.previewOnPlace}
            onChange={togglePreviewOnPlace}
          />
          <span>置いたら試聴</span>
        </label>
        <p className="pr__hint">
          左の鍵盤クリックで試聴 / ダブルクリックでノート追加 / ドラッグで移動（Shiftで自由位置）/ 右端で長さ変更 /
          Alt+ドラッグで複製 / Q=クオンタイズ / Delete=削除
        </p>
      </div>

      <div className="pr__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="pr__keyboard" style={{ height: gridHeight }}>
          {visibleRows.map((midi, j) => {
            const pc = ((midi % 12) + 12) % 12;
            const inScale = scaleInfo.scalePcs.has(pc);
            const isC = pc === 0;
            return (
              <div
                key={midi}
                role="button"
                tabIndex={0}
                aria-label={`${midiToNoteName(midi)} を試聴`}
                data-testid={`piano-key-${midi}`}
                className={`pr__key${inScale ? ' is-scale' : ''}${isC ? ' is-c' : ''}`}
                style={{ top: (firstRow + j) * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={() => previewKey(midi)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  // Keep Space/Enter from also reaching the global shortcuts.
                  e.preventDefault();
                  e.stopPropagation();
                  previewKey(midi);
                }}
              >
                {isC ? <span className="pr__key-label">{midiToNoteName(midi)}</span> : null}
              </div>
            );
          })}
        </div>

        <div className="pr__main">
        <TimelineRuler originBeat={clip.startBeat} />
        <div
          ref={gridRef}
          className="pr__grid"
          style={{ width: gridWidth, height: gridHeight }}
          onPointerDown={onGridPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onDoubleClick={onGridDoubleClick}
        >
          {/* pitch-row tints */}
          {visibleRows.map((midi, j) => {
            const i = firstRow + j;
            const pc = ((midi % 12) + 12) % 12;
            const inScale = scaleInfo.scalePcs.has(pc);
            return (
              <div
                key={midi}
                className={`pr__row${inScale ? ' is-scale' : ''}`}
                style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
              />
            );
          })}

          {/* bar / beat gridlines */}
          {Array.from({ length: lengthBeats + 1 }, (_, beat) => {
            const isBar = beat % bpb === 0;
            return (
              <div
                key={`gl-${beat}`}
                className={`pr__gridline${isBar ? ' is-bar' : ''}`}
                style={{ left: beat * ppb }}
              />
            );
          })}

          {/* chord-tone highlight per region (when C on) */}
          {editor.chordToneHighlight
            ? project.chordTrack.map((chord) =>
                visibleRows.map((midi, j) => {
                  const i = firstRow + j;
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
                        top: i * ROW_HEIGHT,
                        height: ROW_HEIGHT,
                        left: chord.startBeat * ppb,
                        width: chord.durationBeats * ppb,
                      }}
                    />
                  );
                }),
              )
            : null}

          {/* notes */}
          {renderedNotes.map((note) => {
            const i = PIANO_HIGH_MIDI - note.pitch;
            const pc = ((note.pitch % 12) + 12) % 12;
            const outOfScale = scaleInfo.scalePcs.size > 0 && !scaleInfo.scalePcs.has(pc);
            const isSelected = selected.has(note.id);
            return (
              <div
                key={note.id}
                className={`pr__note${isSelected ? ' is-selected' : ''}${outOfScale ? ' is-out' : ''}`}
                style={{
                  top: i * ROW_HEIGHT + 1,
                  left: note.startBeat * ppb,
                  width: Math.max(4, note.durationBeats * ppb - 1),
                  height: ROW_HEIGHT - 2,
                  opacity: 0.45 + (note.velocity / 127) * 0.55,
                }}
                onPointerDown={(e) => onNotePointerDown(e, note)}
                title={`${midiToNoteName(note.pitch)} / 強さ ${note.velocity}`}
              >
                <span className="pr__note-resize" />
              </div>
            );
          })}

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
          <Playhead
            ppb={ppb}
            offsetBeats={clip.startBeat}
            hidden={positionBeat < clip.startBeat}
          />
        </div>
        </div>
      </div>

      <VelocityLane
        clipId={clip.id}
        notes={notes}
        ppb={ppb}
        width={gridWidth}
        selectedIds={selected}
        applyProjectChange={applyProjectChange}
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
  applyProjectChange: (fn: (project: Project) => Project) => void;
}) {
  const { clipId, notes, ppb, width, selectedIds, applyProjectChange } = props;
  const laneRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<VelocityDragState | null>(null);
  const [previewVelocities, setPreviewVelocities] = useState<Map<string, number> | null>(null);
  const selectedNotes = useMemo(
    () => notes.filter((note) => selectedIds.has(note.id)),
    [notes, selectedIds],
  );
  const selectedAverageVelocity = useMemo(() => {
    if (selectedNotes.length === 0) return null;
    const sum = selectedNotes.reduce((total, note) => total + note.velocity, 0);
    return Math.round(sum / selectedNotes.length);
  }, [selectedNotes]);
  const [velocityInput, setVelocityInput] = useState('');

  useEffect(() => {
    setVelocityInput(selectedAverageVelocity === null ? '' : String(selectedAverageVelocity));
  }, [selectedAverageVelocity]);

  const velocityFromY = (clientY: number): number => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return DEFAULT_VELOCITY;
    const ratio = 1 - (clientY - rect.top) / rect.height;
    return clampVelocity(ratio * MAX_VELOCITY);
  };

  const buildRelativeVelocityMap = useCallback(
    (
      noteIds: readonly string[],
      baseVelocities: ReadonlyMap<string, number>,
      anchorVelocity: number,
      targetVelocity: number,
    ): Map<string, number> => {
      const delta = clampVelocity(targetVelocity) - anchorVelocity;
      const nextVelocities = new Map<string, number>();
      for (const id of noteIds) {
        const baseVelocity = baseVelocities.get(id);
        if (baseVelocity !== undefined) {
          nextVelocities.set(id, clampVelocity(baseVelocity + delta));
        }
      }
      return nextVelocities;
    },
    [],
  );

  const commitVelocityMap = useCallback(
    (velocityById: ReadonlyMap<string, number>) => {
      applyProjectChange((project) =>
        mapClipNotes(project, clipId, (clipNotes) =>
          clipNotes.map((note) => {
            const velocity = velocityById.get(note.id);
            return velocity === undefined || velocity === note.velocity
              ? note
              : { ...note, velocity };
          }),
        ),
      );
    },
    [applyProjectChange, clipId],
  );

  const onBarDown = (e: React.PointerEvent, noteId: string) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const anchorNote = notes.find((note) => note.id === noteId);
    if (!anchorNote) return;
    const noteIds = selectedIds.has(noteId)
      ? notes.filter((note) => selectedIds.has(note.id)).map((note) => note.id)
      : [noteId];
    const baseVelocities = new Map(
      noteIds
        .map((id) => notes.find((note) => note.id === id))
        .filter((note): note is NoteEvent => note !== undefined)
        .map((note) => [note.id, note.velocity]),
    );
    const nextVelocities = buildRelativeVelocityMap(
      noteIds,
      baseVelocities,
      anchorNote.velocity,
      velocityFromY(e.clientY),
    );
    draggingRef.current = {
      noteIds,
      baseVelocities,
      anchorVelocity: anchorNote.velocity,
      nextVelocities,
    };
    setPreviewVelocities(nextVelocities);
  };
  const onMove = (e: React.PointerEvent) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const nextVelocities = buildRelativeVelocityMap(
      drag.noteIds,
      drag.baseVelocities,
      drag.anchorVelocity,
      velocityFromY(e.clientY),
    );
    drag.nextVelocities = nextVelocities;
    setPreviewVelocities(nextVelocities);
  };
  const onUp = () => {
    const drag = draggingRef.current;
    if (drag && hasVelocityChanges(drag.baseVelocities, drag.nextVelocities)) {
      commitVelocityMap(drag.nextVelocities);
    }
    draggingRef.current = null;
    setPreviewVelocities(null);
  };

  const commitVelocityInput = () => {
    if (selectedNotes.length === 0) return;
    if (velocityInput.trim() === '') {
      setVelocityInput(selectedAverageVelocity === null ? '' : String(selectedAverageVelocity));
      return;
    }
    const rawVelocity = Number(velocityInput);
    if (!Number.isFinite(rawVelocity)) {
      setVelocityInput(selectedAverageVelocity === null ? '' : String(selectedAverageVelocity));
      return;
    }
    const targetVelocity = clampVelocity(rawVelocity);
    const noteIds = selectedNotes.map((note) => note.id);
    const baseVelocities = new Map(selectedNotes.map((note) => [note.id, note.velocity]));
    const nextVelocities = buildRelativeVelocityMap(
      noteIds,
      baseVelocities,
      selectedAverageVelocity ?? targetVelocity,
      targetVelocity,
    );
    if (hasVelocityChanges(baseVelocities, nextVelocities)) {
      commitVelocityMap(nextVelocities);
    }
    setVelocityInput(String(targetVelocity));
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setVelocityInput(selectedAverageVelocity === null ? '' : String(selectedAverageVelocity));
      e.currentTarget.blur();
    }
  };

  return (
    <div className="pr__velocity">
      <span className="pr__velocity-label">強さ</span>
      <label className="pr__field">
        <span>選択</span>
        <input
          type="number"
          min={MIN_VELOCITY}
          max={MAX_VELOCITY}
          value={velocityInput}
          onChange={(e) => setVelocityInput(e.target.value)}
          onBlur={commitVelocityInput}
          onKeyDown={onInputKeyDown}
          disabled={selectedNotes.length === 0}
          aria-label="選択ノートの強さ"
        />
      </label>
      <div
        ref={laneRef}
        className="pr__velocity-lane"
        style={{ width, height: LANE_HEIGHT }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {notes.map((note) => {
          const velocity = previewVelocities?.get(note.id) ?? note.velocity;
          const h = (velocity / MAX_VELOCITY) * LANE_HEIGHT;
          const isSel = selectedIds.has(note.id);
          return (
            <div
              key={note.id}
              className={`pr__velbar${isSel ? ' is-selected' : ''}`}
              style={{ left: note.startBeat * ppb, height: h, bottom: 0 }}
              onPointerDown={(e) => onBarDown(e, note.id)}
              title={`強さ ${velocity}`}
            />
          );
        })}
      </div>
    </div>
  );
}
