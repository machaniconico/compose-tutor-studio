import { beatsPerBar as beatsPerBarOf } from '@cts/project-model';
import { useStore } from '../../state/store';
import { restartAt } from '../../audio/playback';
import { pxPerBeat, timelineWidth, xToSeekBeat } from '../timeline';

/**
 * Bar-number ruler above a timeline. Click to jump the playhead to the clicked
 * bar; Shift+click jumps to the clicked beat. While playing, playback resumes
 * from the new position. `originBeat` is the song beat at the ruler's left edge,
 * for editors drawn relative to a clip.
 */
export function TimelineRuler(props: { originBeat?: number }) {
  const { originBeat = 0 } = props;
  const lengthBars = useStore((s) => s.project.lengthBars);
  const beatsPerBar = useStore((s) => beatsPerBarOf(s.project.timeSignature));
  const zoomX = useStore((s) => s.editor.zoomX);
  const setPosition = useStore((s) => s.setPosition);

  const lengthBeats = lengthBars * beatsPerBar;
  const ppb = pxPerBeat(zoomX);

  return (
    <div
      className="timeline-ruler"
      data-testid="timeline-ruler"
      style={{ width: timelineWidth(Math.max(0, lengthBeats - originBeat), zoomX) }}
      title="クリックでその小節の頭へ移動(Shiftを押しながらクリックで拍単位)"
      aria-label="タイムラインの定規。クリックでその小節の頭へ移動します"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const beat = xToSeekBeat(
          e.clientX - rect.left + originBeat * ppb,
          zoomX,
          beatsPerBar,
          lengthBeats,
          e.shiftKey ? 'beat' : 'bar',
        );
        if (useStore.getState().transport.isPlaying) restartAt(beat);
        else setPosition(beat);
      }}
    >
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
