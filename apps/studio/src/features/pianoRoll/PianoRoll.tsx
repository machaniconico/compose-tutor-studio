import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import type { Clip, NoteEvent, Project, Track } from '@cts/project-model';
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
  quantizeNotes as quantizeNoteStarts,
  rectsOverlap,
  snapBeat,
  snapPitchToPitchClasses,
  xToBeat,
  yToPitch,
} from './gridMath';
import { duplicateNotes, removeNotes } from '../../state/editorActions';

const ROW_HEIGHT = 16;
const RESIZE_HANDLE_PX = 6;
const DEFAULT_VELOCITY = 100;
const MIN_VELOCITY = 1;
const MAX_VELOCITY = 127;

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
  const editor = useStore((s) => s.editor);
  const selectNotes = useStore((s) => s.selectNotes);
  const addNote = useStore((s) => s.addNote);
  const updateNote = useStore((s) => s.updateNote);
  const applyProjectChange = useStore((s) => s.applyProjectChange);
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

    applyProjectChange((project) =>
      mapClipNotes(project, clip.id, (clipNotes) =>
        clipNotes.map((note) => quantizedById.get(note.id) ?? note),
      ),
    );
  }, [applyProjectChange, clip, editor.selectedNoteIds, gridSnap, notes]);

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
        quantizeSelectedNotes();
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
