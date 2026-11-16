import { useRef, useState } from 'react';
import { beatsPerBar as beatsPerBarOf } from '@cts/project-model';
import { useStore } from '../../state/store';
import { restartAt } from '../../audio/playback';
import { pxPerBeat, timelineWidth, xToSeekBeat } from '../timeline';

/** Pointer travel (px) that turns a press on the ruler into a loop-range drag. */
const LOOP_DRAG_MIN_PX = 4;

/**
 * Loop range for a ruler drag from `fromX` to `toX` (px from the song start):
 * every bar the drag touches, snapped to bar lines and kept inside the song.
 * A right-to-left drag is swapped, so `endBeat` is always after `startBeat`.
 */
export function dragToLoopRange(
  fromX: number,
  toX: number,
  zoomX: number,
  beatsPerBar: number,
  lengthBeats: number,
): { startBeat: number; endBeat: number } {
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const lastBarStart = Math.max(0, lengthBeats - bpb);
  const barStart = (x: number): number =>
    Math.min(xToSeekBeat(x, zoomX, bpb, lengthBeats, 'bar'), lastBarStart);
  const a = barStart(fromX);
  const b = barStart(toX);
  return { startBeat: Math.min(a, b), endBeat: Math.max(a, b) + bpb };
}

/**
 * Bar-number ruler above a timeline. Click to jump the playhead to the clicked
 * bar; Shift+click jumps to the clicked beat. While playing, playback resumes
 * from the new position. Dragging sideways sets the loop range (whole bars).
 * `originBeat` is the song beat at the ruler's left edge, for editors drawn
 * relative to a clip.
 */
export function TimelineRuler(props: { originBeat?: number }) {
  const { originBeat = 0 } = props;
  const lengthBars = useStore((s) => s.project.lengthBars);
  const beatsPerBar = useStore((s) => beatsPerBarOf(s.project.timeSignature));
  const zoomX = useStore((s) => s.editor.zoomX);
  const loopRange = useStore((s) => s.project.loopRange);
  const loopEnabled = useStore((s) => s.transport.loopEnabled);
  const setPosition = useStore((s) => s.setPosition);
  const setLoopRange = useStore((s) => s.setLoopRange);
  // Drag in progress, as song-relative px; `moved` once it passed the threshold.
  const [drag, setDrag] = useState<{ fromX: number; toX: number; moved: boolean } | null>(null);
  // A drag ends with a click event too; that click must not seek.
  const suppressClick = useRef(false);

  const lengthBeats = lengthBars * beatsPerBar;
  const ppb = pxPerBeat(zoomX);
  const songX = (e: { clientX: number; currentTarget: Element }): number =>
    e.clientX - e.currentTarget.getBoundingClientRect().left + originBeat * ppb;

  const preview = drag?.moved
    ? dragToLoopRange(drag.fromX, drag.toX, zoomX, beatsPerBar, lengthBeats)
    : null;
  const band = preview ?? loopRange ?? null;
  const bandLeft = band ? Math.max(0, (band.startBeat - originBeat) * ppb) : 0;
  const bandRight = band ? (band.endBeat - originBeat) * ppb : 0;

  return (
    <div
      className="timeline-ruler"
      data-testid="timeline-ruler"
      style={{ width: timelineWidth(Math.max(0, lengthBeats - originBeat), zoomX) }}
      title="クリックでその小節の頭へ移動(Shiftを押しながらクリックで拍単位)。左右にドラッグすると、くり返し再生する小節(ループ範囲)を選べます"
      aria-label="タイムラインの定規。クリックでその小節の頭へ移動、ドラッグでループ範囲を選びます"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        suppressClick.current = false;
        const x = songX(e);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDrag({ fromX: x, toX: x, moved: false });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const x = songX(e);
        setDrag({ ...drag, toX: x, moved: drag.moved || Math.abs(x - drag.fromX) >= LOOP_DRAG_MIN_PX });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        setDrag(null);
        const x = songX(e);
        if (!drag.moved && Math.abs(x - drag.fromX) < LOOP_DRAG_MIN_PX) return;
        suppressClick.current = true;
        setLoopRange(dragToLoopRange(drag.fromX, x, zoomX, beatsPerBar, lengthBeats));
      }}
      onPointerCancel={() => setDrag(null)}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        const beat = xToSeekBeat(
          songX(e),
          zoomX,
          beatsPerBar,
          lengthBeats,
          e.shiftKey ? 'beat' : 'bar',
        );
        if (useStore.getState().transport.isPlaying) restartAt(beat);
        else setPosition(beat);
      }}
    >
      {band && bandRight > bandLeft ? (
        <div
          className={`timeline-ruler__loop${preview ? ' is-preview' : ''}${loopEnabled || preview ? '' : ' is-off'}`}
          data-testid="loop-range-band"
          aria-hidden="true"
          style={{ left: bandLeft, width: bandRight - bandLeft }}
        />
      ) : null}
      {Array.from({ length: lengthBars }, (_, bar) => {
        const left = (bar * beatsPerBar - originBeat) * ppb;
        return left < 0 ? null : (
          <span key={bar} className="timeline-ruler__bar" style={{ left }}>
            {bar + 1}
          </span>
        );
      })}
    </div>
  );
}

/** Vertical playhead line at the transport position; `offsetPx` shifts it. */
export function Playhead(props: { ppb: number; offsetBeats?: number; hidden?: boolean }) {
  const positionBeat = useStore((s) => s.transport.positionBeat);
  const { ppb, offsetBeats = 0, hidden = false } = props;
  return (
    <div
      className={`playhead${hidden ? ' is-hidden' : ''}`}
      data-testid="playhead"
      aria-hidden="true"
      style={{ left: (positionBeat - offsetBeats) * ppb }}
    />
  );
}
