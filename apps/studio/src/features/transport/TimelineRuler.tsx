import { useMemo, useState } from 'react';
import { barToBeatAt, compileMusicalTime } from '@cts/project-model';
import { useStore } from '../../state/store';
import { pxPerBeat, timelineWidth } from '../timeline';
import { RULER_DRAG_MIN_PX, loopRangeFromDrag, rulerXToBeat } from './rulerLogic';

const AUTOMATION_PASS_MESSAGE =
  'オートメーションを記録中です。ループ範囲や再生位置を変えるには、再生を止めてください。';

type Drag = { fromX: number; toX: number; moved: boolean };

const MAX_RULER_BARS = 2_000;

/**
 * Bar ruler over the editors. Click to move the playhead (while stopped);
 * drag to pick the loop range. Both snap to whole beats. The loop range is
 * runtime transport state, so a drag is not an undo step.
 */
export function TimelineRuler() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const phase = useStore((s) => s.transport.phase);
  const loopEnabled = useStore((s) => s.transport.loopEnabled);
  const loopStartBeat = useStore((s) => s.transport.loopStartBeat);
  const loopEndBeat = useStore((s) => s.transport.loopEndBeat);
  const recordingLocked = useStore((s) => s.audioRecordingOperationId !== null);
  const setPosition = useStore((s) => s.setPosition);
  const setLoopRange = useStore((s) => s.setLoopRange);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [message, setMessage] = useState('');

  const lengthBeats = project.lengthBeats;
  const ppb = pxPerBeat(zoomX);
  const bars = useMemo(() => {
    const index = compileMusicalTime({
      lengthBeats: project.lengthBeats,
      tempoMap: project.tempoMap,
      timeSignatureMap: project.timeSignatureMap,
    });
    const result: { bar: number; beat: number }[] = [];
    for (let bar = 0; bar < MAX_RULER_BARS; bar += 1) {
      const beat = barToBeatAt(index, bar);
      if (beat >= project.lengthBeats) break;
      result.push({ bar, beat });
    }
    return result;
  }, [project.lengthBeats, project.tempoMap, project.timeSignatureMap]);

  const xOf = (e: { clientX: number; currentTarget: Element }): number =>
    e.clientX - e.currentTarget.getBoundingClientRect().left;

  const preview = drag?.moved
    ? loopRangeFromDrag(
        rulerXToBeat(drag.fromX, ppb, lengthBeats),
        rulerXToBeat(drag.toX, ppb, lengthBeats),
        lengthBeats,
      )
    : null;
  const band = preview?.ok
    ? preview
    : loopEndBeat > loopStartBeat
      ? { startBeat: loopStartBeat, endBeat: loopEndBeat }
      : null;

  const finish = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag) return;
    setDrag(null);
    const x = xOf(e);
    // Same condition P03 uses to refuse fader drags; seek / loop would end the pass.
    if (useStore.getState().automationRecording.passActive) {
      setMessage(AUTOMATION_PASS_MESSAGE);
      return;
    }
    if (recordingLocked) {
      setMessage('録音中はループ範囲や再生位置を変えられません。');
      return;
    }
    if (Math.abs(x - drag.fromX) < RULER_DRAG_MIN_PX) {
      if (phase !== 'stopped') {
        setMessage('再生中は位置を移動できません。停止してからクリックしてください。');
        return;
      }
      setPosition(rulerXToBeat(drag.fromX, ppb, lengthBeats));
      setMessage('');
      return;
    }
    const range = loopRangeFromDrag(
      rulerXToBeat(drag.fromX, ppb, lengthBeats),
      rulerXToBeat(x, ppb, lengthBeats),
      lengthBeats,
    );
    if (!range.ok) {
      setMessage(range.reason);
      return;
    }
    if (!setLoopRange(range.startBeat, range.endBeat)) {
      setMessage('いまはループ範囲を変えられません。');
      return;
    }
    setMessage('');
  };

  return (
    <div className="timeline-ruler-wrap">
      <div
        className="timeline-ruler"
        data-testid="timeline-ruler"
        style={{ width: timelineWidth(Math.max(0, lengthBeats), zoomX) }}
        title="クリックでその位置へ移動。左右にドラッグすると、くり返し再生する範囲(ループ)を選べます(1拍単位)"
        aria-label="タイムラインの定規。クリックで再生位置を移動、ドラッグでループ範囲を選びます"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (useStore.getState().automationRecording.passActive) {
            setMessage(AUTOMATION_PASS_MESSAGE);
            return;
          }
          const x = xOf(e);
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDrag({ fromX: x, toX: x, moved: false });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const x = xOf(e);
          setDrag({ ...drag, toX: x, moved: drag.moved || Math.abs(x - drag.fromX) >= RULER_DRAG_MIN_PX });
        }}
        onPointerUp={finish}
        onPointerCancel={() => setDrag(null)}
      >
        {band && band.endBeat > band.startBeat ? (
          <div
            className={`timeline-ruler__loop${preview ? ' is-preview' : ''}${loopEnabled || preview ? '' : ' is-off'}`}
            data-testid="loop-range-band"
            aria-hidden="true"
            style={{ left: band.startBeat * ppb, width: (band.endBeat - band.startBeat) * ppb }}
          />
        ) : null}
        {bars.map(({ bar, beat }) => (
          <span key={bar} className="timeline-ruler__bar" style={{ left: beat * ppb }}>
            {bar + 1}
          </span>
        ))}
      </div>
      <p className="timeline-ruler__message" role="status" aria-live="polite">{message}</p>
    </div>
  );
}
