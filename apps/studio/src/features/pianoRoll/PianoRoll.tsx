import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import type { Clip, NoteEvent, Track } from '@cts/project-model';
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
  duplicateNotes,
  quantizeNotes,
  removeNotes,
} from '../../state/editorActions';

const ROW_HEIGHT = 16;
const RESIZE_HANDLE_PX = 6;
const DEFAULT_VELOCITY = 100;

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
  const editor = useStore((s) => s.editor);
  const selectNotes = useStore((s) => s.selectNotes);
  const addNote = useStore((s) => s.addNote);
  const updateNote = useStore((s) => s.updateNote);
  const setZoomX = useStore((s) => s.setZoomX);
  const toggleScaleSnap = useStore((s) => s.toggleScaleSnap);
  const toggleChordToneHighlight = useStore((s) => s.toggleChordToneHighlight);

  const clip = findClip(project.tracks, editor.selectedClipId);
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
  const lengthBeats = project.lengthBars * project.timeSignature[0];
  const gridWidth = lengthBeats * ppb;
  const selected = useMemo(() => new Set(editor.selectedNoteIds), [editor.selectedNoteIds]);

  const notes = clip?.type === 'midi' ? clip.notes ?? [] : [];

  // --- keyboard shortcuts (ignored while typing in inputs) ---
  useEffect(() => {
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
      if ((e.key === 'Delete' || e.key === 'Backspace') && clip && ids.length > 0) {
        e.preventDefault();
        removeNotes(clip.id, ids);
        selectNotes([]);
      } else if ((e.key === 'q' || e.key === 'Q') && clip && ids.length > 0) {
        e.preventDefault();
        quantizeNotes(clip.id, ids, gridSnap);
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        toggleScaleSnap();
      } else if (e.key === 'c' || e.key === 'C') {
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
    gridSnap,
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
      for (const snap of drag.snapshot) {
        let nextStart = snap.startBeat + beatDelta;
        nextStart = shift ? Math.max(0, nextStart) : snapBeat(nextStart, gridSnap);
        let nextPitch = clampPitch(snap.pitch - rowDelta);
        if (editor.scaleSnap) {
          nextPitch = clampPitch(snapPitchToPitchClasses(nextPitch, scaleInfo.scalePcs));
        }
        updateNote(clip.id, snap.id, { startBeat: nextStart, pitch: nextPitch });
      }
    },
    [clip, ppb, gridSnap, editor.scaleSnap, scaleInfo.scalePcs, updateNote],
  );

  const onNotePointerDown = useCallback(
    (e: React.PointerEvent, note: NoteEvent) => {
      if (!clip) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
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

      // Alt+drag duplicates the selection, then drags the copies.
      let dragIds = nextSelected.includes(note.id) ? nextSelected : [note.id];
      if (e.altKey && !isResize) {
        const created = duplicateNotes(clip.id, dragIds, 0);
        if (created.length > 0) {
          dragIds = created;
          selectNotes(created);
        }
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
    [clip, localPoint, ppb, selected, editor.selectedNoteIds, selectNotes],
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
    setMarquee(null);
  }, [marquee, notes, ppb, editor.selectedNoteIds, selectNotes]);

  const onGridDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!clip || clip.type !== 'midi') return;
      const { x, y } = localPoint(e);
      const beat = snapBeat(xToBeat(x, ppb), gridSnap);
      let pitch = clampPitch(yToPitch(y, ROW_HEIGHT));
      if (editor.scaleSnap) pitch = clampPitch(snapPitchToPitchClasses(pitch, scaleInfo.scalePcs));
      addNote(clip.id, {
        pitch,
        startBeat: beat,
        durationBeats: gridSnap,
        velocity: DEFAULT_VELOCITY,
      });
    },
    [clip, localPoint, ppb, gridSnap, editor.scaleSnap, scaleInfo.scalePcs, addNote],
  );

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
        <p className="pr__hint">
          ダブルクリックでノート追加 / ドラッグで移動（Shiftで自由位置）/ 右端で長さ変更 /
          Alt+ドラッグで複製 / Q=クオンタイズ / Delete=削除
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
                style={{ height: ROW_HEIGHT }}
              >
                {isC ? <span className="pr__key-label">{midiToNoteName(midi)}</span> : null}
              </div>
            );
          })}
        </div>

        <div
          ref={gridRef}
          className="pr__grid"
          style={{ width: gridWidth, height: gridHeight }}
          onPointerDown={onGridPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onGridDoubleClick}
        >
          {/* pitch-row tints */}
          {rows.map((midi, i) => {
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
            const isBar = beat % project.timeSignature[0] === 0;
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
          {notes.map((note) => {
            const i = PIANO_HIGH_MIDI - note.pitch;
            if (i < 0 || i >= rows.length) return null;
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
        </div>
      </div>

      <VelocityLane
        clipId={clip.id}
        notes={notes}
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
  const updateNote = useStore((s) => s.updateNote);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<string | null>(null);

  const velocityFromY = (clientY: number): number => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return DEFAULT_VELOCITY;
    const ratio = 1 - (clientY - rect.top) / rect.height;
    return Math.max(1, Math.min(127, Math.round(ratio * 127)));
  };

  const onBarDown = (e: React.PointerEvent, noteId: string) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    draggingRef.current = noteId;
    updateNote(clipId, noteId, { velocity: velocityFromY(e.clientY) });
  };
  const onMove = (e: React.PointerEvent) => {
    const id = draggingRef.current;
    if (!id) return;
    updateNote(clipId, id, { velocity: velocityFromY(e.clientY) });
  };
  const onUp = () => {
    draggingRef.current = null;
  };

  return (
    <div className="pr__velocity">
      <span className="pr__velocity-label">強さ</span>
      <div
        ref={laneRef}
        className="pr__velocity-lane"
        style={{ width, height: LANE_HEIGHT }}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {notes.map((note) => {
          const h = (note.velocity / 127) * LANE_HEIGHT;
          const isSel = selectedIds.has(note.id);
          return (
            <div
              key={note.id}
              className={`pr__velbar${isSel ? ' is-selected' : ''}`}
              style={{ left: note.startBeat * ppb, height: h, bottom: 0 }}
              onPointerDown={(e) => onBarDown(e, note.id)}
              title={`強さ ${note.velocity}`}
            />
          );
        })}
      </div>
    </div>
  );
}
