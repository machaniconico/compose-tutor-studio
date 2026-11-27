import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { ChordEvent } from '@cts/project-model';
import { beatsPerBar } from '@cts/project-model';
import {
  PROGRESSION_TEMPLATES,
  getDiatonicChords,
  suggestNextChords,
  type CompingPattern,
  type HarmonicFunction,
} from '@cts/theory-engine';
import { useStore, watchDragEnd } from '../../state/store';
import { pxPerBeat, timelineWidth } from '../timeline';
import { Playhead, TimelineRuler } from '../transport/TimelineRuler';
import {
  addChordWithAnalysis,
  applyCompingToTrack,
  applyProgressionTemplate,
  chordNotesTargetTrackId,
  hasChordsInNotesTarget,
  projectBeatsPerBar,
} from '../../state/editorActions';
import { ChordPopover } from './ChordPopover';
import { auditionChord } from './paletteData';

const COMPING_PATTERNS = {
  whole: { label: '全音符', description: 'コードが続く間、すべての音を一緒に伸ばします。' },
  eighths: { label: '8分刻み', description: '半拍ごとに、コードの音を一緒に鳴らします。' },
  arpUp: { label: '上行アルペジオ', description: 'コードの音を、1拍ごとに低い音から順に鳴らします。' },
  arpUpDown: { label: '上下アルペジオ', description: 'コードの音を、1拍ごとに上ってから下ります。' },
  stab: { label: 'スタブ', description: '各拍の頭で、コードの音を短く鳴らします。' },
} satisfies Record<CompingPattern, { label: string; description: string }>;

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

/** Undo transaction owner: a stale pointer event only closes a chord drag's own step. */
const CHORD_DRAG = Symbol('chordDrag');

type ChordDrag = {
  chordId: string;
  kind: 'move' | 'resize';
  startX: number;
  originStart: number;
  originDuration: number;
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
  const selectedTrackId = useStore((s) => s.editor.selectedTrackId);
  const selectChord = useStore((s) => s.selectChord);
  const updateChord = useStore((s) => s.updateChord);
  const beginTransaction = useStore((s) => s.beginTransaction);
  const setInspectorContent = useStore((s) => s.setInspectorContent);

  const [popoverChordId, setPopoverChordId] = useState<string | null>(null);
  const [pattern, setPattern] = useState<CompingPattern>('whole');
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<ChordDrag | null>(null);
  const movedRef = useRef(false);

  const bpb = beatsPerBar(project.timeSignature);
  const lengthBeats = project.lengthBars * bpb;
  const width = timelineWidth(lengthBeats, zoomX);
  const ppb = pxPerBeat(zoomX);

  const sortedChords = useMemo(
    () => [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat),
    [project.chordTrack],
  );

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

  const onGridClick = useCallback(
    (e: React.MouseEvent) => {
      // Only react to clicks on the empty grid (not on a chip).
      if (e.target !== gridRef.current) return;
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const bar = Math.floor(x / (bpb * ppb));
      const startBeat = bar * bpb;
      const occupied = sortedChords.some(
        (c) => startBeat >= c.startBeat && startBeat < c.startBeat + c.durationBeats,
      );
      if (occupied) return;
      addChordWithAnalysis(smartDefaultSymbol(startBeat), startBeat, bpb);
    },
    [bpb, ppb, sortedChords, smartDefaultSymbol],
  );

  const onChipPointerDown = useCallback(
    (e: React.PointerEvent, chord: ChordEvent, kind: 'move' | 'resize') => {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      movedRef.current = false;
      beginTransaction(CHORD_DRAG);
      watchDragEnd(CHORD_DRAG, e.pointerId);
      dragRef.current = {
        chordId: chord.id,
        kind,
        startX: e.clientX,
        originStart: chord.startBeat,
        originDuration: chord.durationBeats,
      };
    },
    [beginTransaction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Undo or a lost window focus closed the transaction: this drag is over.
      if (!useStore.getState().ownsTransaction(CHORD_DRAG)) {
        dragRef.current = null;
        return;
      }
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 3) movedRef.current = true;
      const barsDelta = Math.round(dx / (bpb * ppb));
      if (drag.kind === 'move') {
        const nextStart = Math.max(0, drag.originStart + barsDelta * bpb);
        const maxStart = lengthBeats - drag.originDuration;
        updateChord(drag.chordId, { startBeat: Math.min(nextStart, Math.max(0, maxStart)) });
      } else {
        const nextDuration = Math.max(bpb, drag.originDuration + barsDelta * bpb);
        const maxDuration = lengthBeats - drag.originStart;
        updateChord(drag.chordId, { durationBeats: Math.min(nextDuration, maxDuration) });
      }
    },
    [bpb, ppb, lengthBeats, updateChord],
  );

  const onPointerEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const notesTargetId = chordNotesTargetTrackId(project, selectedTrackId);
  const notesTarget = project.tracks.find((t) => t.id === notesTargetId);
  const overlapsTarget = notesTarget ? hasChordsInNotesTarget(project, notesTarget) : false;
  const showOverlapHint = notesTarget !== undefined && !overlapsTarget;
  const overlapHintId = useId();
  const patternId = useId();
  const patternDescriptionId = useId();

  const popoverChord = popoverChordId
    ? project.chordTrack.find((c) => c.id === popoverChordId) ?? null
    : null;

  return (
    <section className="chord-lane" aria-label="コードトラック">
      <div className="chord-lane__header">
        <strong>コードトラック</strong>
        <span className="chord-lane__count">{project.chordTrack.length} 個</span>
        <TemplatePicker />
        <label htmlFor={patternId}>伴奏パターン</label>
        <select
          id={patternId}
          aria-describedby={patternDescriptionId}
          value={pattern}
          onChange={(e) => setPattern(e.currentTarget.value as CompingPattern)}
        >
          {Object.entries(COMPING_PATTERNS).map(([value, { label }]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={!overlapsTarget}
          aria-describedby={showOverlapHint ? overlapHintId : undefined}
          onClick={() => {
            if (notesTargetId) applyCompingToTrack(notesTargetId, pattern);
          }}
          title={
            notesTarget
              ? `コードトラックの和音を「${notesTarget.name}」のクリップにノートとして書き込みます。音のつながりが滑らかになる並び（ボイスリーディング）を選びます。書き込んだ後は普通のノートとして編集できます。`
              : 'ノートを書き込む楽器トラックを選んでください。'
          }
        >
          コードをノートにする
        </button>
        <span id={patternDescriptionId}>{COMPING_PATTERNS[pattern].description}</span>
        {showOverlapHint && (
          <span id={overlapHintId}>書き込み先のクリップに重なるコードがありません。</span>
        )}
      </div>

      {/* The ruler and grid scroll together so every bar stays reachable when zoomed in. */}
      <div className="chord-lane__scroll" data-testid="chord-lane-scroll">
        <TimelineRuler />
        <div
          ref={gridRef}
          className="chord-lane__grid"
          style={{ width }}
          onClick={onGridClick}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {/* bar guides */}
          {Array.from({ length: project.lengthBars }, (_, bar) => (
            <div key={`bar-${bar}`} className="chord-lane__bar" style={{ left: bar * bpb * ppb }} />
          ))}

          {project.chordTrack.map((chord) => {
            const isSelected = chord.id === selectedChordId;
            return (
              <div
                key={chord.id}
                className={`chord-chip ${functionClass(chord.function)}${isSelected ? ' is-selected' : ''}`}
                style={{ left: chord.startBeat * ppb, width: chord.durationBeats * ppb }}
                onPointerDown={(e) => onChipPointerDown(e, chord, 'move')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (movedRef.current) return;
                  auditionChord(project, chord.symbol);
                  selectChord(chord.id);
                  setInspectorContent(`chord:${chord.id}`);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  selectChord(chord.id);
                  setPopoverChordId(chord.id);
                }}
                title={`${chord.symbol}${chord.degree ? `（${chord.degree}）` : ''}`}
              >
                <span className="chord-chip__symbol">{chord.symbol}</span>
                {chord.degree ? <span className="chord-chip__degree">{chord.degree}</span> : null}
                <span
                  className="chord-chip__resize"
                  onPointerDown={(e) => onChipPointerDown(e, chord, 'resize')}
                  aria-hidden="true"
                />
              </div>
            );
          })}
          <Playhead ppb={ppb} />
        </div>
      </div>

      {popoverChord ? (
        <ChordPopover
          project={project}
          chord={popoverChord}
          onClose={() => setPopoverChordId(null)}
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
