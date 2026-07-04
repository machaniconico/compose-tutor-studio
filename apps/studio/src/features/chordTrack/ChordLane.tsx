import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChordEvent } from '@cts/project-model';
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
  projectBeatsPerBar,
} from '../../state/editorActions';
import { ChordPopover } from './ChordPopover';

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
  const selectChord = useStore((s) => s.selectChord);
  const updateChord = useStore((s) => s.updateChord);
  const setInspectorContent = useStore((s) => s.setInspectorContent);

  const [popoverChordId, setPopoverChordId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<ChordDrag | null>(null);
  const movedRef = useRef(false);

  const bpb = project.timeSignature[0];
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

  const addChordAtBar = useCallback(
    (bar: number) => {
      const startBeat = bar * bpb;
      const occupied = sortedChords.some(
        (c) => startBeat >= c.startBeat && startBeat < c.startBeat + c.durationBeats,
      );
      if (occupied) return false;
      addChordWithAnalysis(smartDefaultSymbol(startBeat), startBeat, bpb);
      return true;
    },
    [bpb, sortedChords, smartDefaultSymbol],
  );

  const onGridClick = useCallback(
    (e: React.MouseEvent) => {
      // Only react to clicks on the empty grid (not on a chip).
      if (e.target !== gridRef.current) return;
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const bar = Math.floor(x / (bpb * ppb));
      addChordAtBar(bar);
    },
    [bpb, ppb, addChordAtBar],
  );

  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      for (let bar = 0; bar < project.lengthBars; bar += 1) {
        if (addChordAtBar(bar)) return;
      }
    },
    [project.lengthBars, addChordAtBar],
  );

  const onChipPointerDown = useCallback(
    (e: React.PointerEvent, chord: ChordEvent, kind: 'move' | 'resize') => {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      movedRef.current = false;
      dragRef.current = {
        chordId: chord.id,
        kind,
        startX: e.clientX,
        originStart: chord.startBeat,
        originDuration: chord.durationBeats,
      };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
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

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const popoverChord = popoverChordId
    ? project.chordTrack.find((c) => c.id === popoverChordId) ?? null
    : null;

  return (
    <section className="chord-lane" aria-label="コードトラック">
      <div className="chord-lane__header">
        <strong>コードトラック</strong>
        <span className="chord-lane__count">{project.chordTrack.length} 個</span>
        <TemplatePicker />
      </div>

      <div
        ref={gridRef}
        role="group"
        tabIndex={0}
        aria-label="コードグリッド。EnterまたはSpaceで空いている最初の小節にコードを追加"
        aria-keyshortcuts="Enter Space"
        className="chord-lane__grid"
        style={{ width }}
        onClick={onGridClick}
        onKeyDown={onGridKeyDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* bar guides */}
        {Array.from({ length: project.lengthBars }, (_, bar) => (
          <div key={`bar-${bar}`} className="chord-lane__bar" style={{ left: bar * bpb * ppb }} />
        ))}

        {project.chordTrack.map((chord) => {
          const isSelected = chord.id === selectedChordId;
          return (
            <button
              type="button"
              key={chord.id}
              aria-label={`${chord.symbol} コードを選択`}
              className={`chord-chip ${functionClass(chord.function)}${isSelected ? ' is-selected' : ''}`}
              style={{ left: chord.startBeat * ppb, width: chord.durationBeats * ppb }}
              onPointerDown={(e) => onChipPointerDown(e, chord, 'move')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  movedRef.current = false;
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (movedRef.current) return;
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
            </button>
          );
        })}
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
