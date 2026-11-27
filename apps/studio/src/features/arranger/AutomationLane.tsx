import { memo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  addPoint, beatTick, evaluateAutomation, MAX_AUTOMATION_POINTS, movePoint, PPQ, removePoint,
  type AutomationLane as Lane, type AutomationPoint, type Track,
} from '@cts/project-model';
import { setVolumeAutomation } from '../../state/editorActions';
import { useStore } from '../../state/store';

const EMPTY_LANE: Lane = { points: [] };
const PLOT_HEIGHT = 80;
const GAIN_PADDING = 12;
const GAIN_HEIGHT = PLOT_HEIGHT - 2 * GAIN_PADDING;

type Drag = {
  index: number;
  lane: Lane;
  pointerId: number;
  clientX: number;
  clientY: number;
};

export const AutomationLane = memo(function AutomationLane({ track, ppb, barBeats, songEnd, visibleBeats }: {
  track: Track;
  ppb: number;
  barBeats: number;
  songEnd: number;
  visibleBeats: number;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AutomationPoint | null>(null);
  const drag = useRef<Drag | null>(null);
  const saved = track.automation?.volume;
  const lane = saved ?? EMPTY_LANE;
  const chartLane = preview && drag.current?.lane === lane ? movePoint(lane, drag.current.index, preview) : lane;
  const atLimit = lane.points.length >= MAX_AUTOMATION_POINTS;
  const put = (next: Lane) => {
    if (next !== lane) setVolumeAutomation(track.id, saved, next);
  };
  const pointAt = (beat: number, value: number): AutomationPoint => ({
    beat: Math.max(0, Math.min(visibleBeats, beatTick(beat) / PPQ)),
    value: Math.max(0, Math.min(1, Math.round(value * 100) / 100)),
  });
  const yAt = (value: number) => GAIN_PADDING + (1 - value) * GAIN_HEIGHT;
  const fade = (fadeIn: boolean) => {
    const bar = Math.min(barBeats, songEnd);
    put({ points: fadeIn
      ? [{ beat: 0, value: 0 }, { beat: bar, value: 1 }]
      : [{ beat: songEnd - bar, value: 1 }, { beat: songEnd, value: 0 }] });
  };

  const handleKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number, point: AutomationPoint) => {
    const step = event.shiftKey ? 1 : 0.25;
    let next: Lane;
    switch (event.key) {
      case 'ArrowLeft': next = movePoint(lane, index, pointAt(point.beat - step, point.value)); break;
      case 'ArrowRight': next = movePoint(lane, index, pointAt(point.beat + step, point.value)); break;
      case 'ArrowDown': next = movePoint(lane, index, pointAt(point.beat, point.value - 0.05)); break;
      case 'ArrowUp': next = movePoint(lane, index, pointAt(point.beat, point.value + 0.05)); break;
      case 'Delete':
      case 'Backspace': next = removePoint(lane, index); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    put(next);
  };

  const dragPoint = (event: PointerEvent<HTMLButtonElement>, current: Drag): AutomationPoint | null => {
    const x = event.clientX - current.clientX;
    const y = event.clientY - current.clientY;
    if (current.lane !== lane || Math.hypot(x, y) <= 3) return null;
    const point = lane.points[current.index]!;
    return pointAt(point.beat + x / ppb, point.value - y / GAIN_HEIGHT);
  };

  const stopDrag = () => {
    drag.current = null;
    setPreview(null);
  };

  // Duplicates are drawn at the effective (last saved) value, as in playback.
  const curve = !open ? [] : [
    { beat: 0, value: evaluateAutomation(chartLane, 0) },
    ...chartLane.points.filter((point, index, points) =>
      point.beat > 0 && point.beat < visibleBeats && point.beat !== points[index + 1]?.beat),
    { beat: visibleBeats, value: evaluateAutomation(chartLane, visibleBeats) },
  ];

  return (
    <details className="automation" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label={`${track.name}の音量の変化`}>音量の変化</summary>
      {open && <>
        <div className="automation__controls">
          <div>
            <button type="button" onClick={() => fade(true)}>フェードイン</button>
            <button type="button" onClick={() => fade(false)}>フェードアウト</button>
            <button type="button" disabled={atLimit} onClick={() => {
              const beat = useStore.getState().transport.positionBeat;
              put(addPoint(lane, pointAt(beat, evaluateAutomation(lane, beat))));
            }}>再生位置に点を追加</button>
          </div>
          <p>少しずつ音量を上げて、曲の始まりをやわらかくします。フェードを選ぶと今ある点を置き換えます。</p>
          <p>クリックで点を追加、ドラッグや矢印キーで移動、ダブルクリックや Delete キーで削除できます。</p>
          <p>上ほど音が大きく、下端は無音です。変更は次の再生から聞けます。</p>
          {atLimit && <p role="status">このトラックには点を {MAX_AUTOMATION_POINTS} 個まで置けます。</p>}
        </div>
        <div
          className="automation__plot"
          data-testid={`automation-plot-${track.id}`}
          style={{ height: PLOT_HEIGHT, backgroundSize: `${barBeats * ppb}px 100%` }}
          onClick={(event) => {
            if (event.target !== event.currentTarget || atLimit) return;
            const rect = event.currentTarget.getBoundingClientRect();
            put(addPoint(lane, pointAt((event.clientX - rect.left) / ppb,
              1 - (event.clientY - rect.top - GAIN_PADDING) / GAIN_HEIGHT)));
          }}
        >
          {curve.slice(1).map((point, index) => {
            const previous = curve[index]!;
            const dx = (point.beat - previous.beat) * ppb;
            const dy = yAt(point.value) - yAt(previous.value);
            return <span key={index} className="automation__line" aria-hidden="true" style={{
              left: previous.beat * ppb, top: yAt(previous.value), width: Math.hypot(dx, dy),
              transform: `rotate(${Math.atan2(dy, dx)}rad)`,
            }} />;
          })}
          {lane.points.map((point, index) => {
            const displayed = drag.current?.index === index && preview ? preview : point;
            if (displayed.beat > visibleBeats) return null;
            const label = `曲の始まりから ${+displayed.beat.toFixed(3)} 拍、音量 ${Math.round(displayed.value * 100)}%`;
            return <button
              key={index}
              type="button"
              className="automation__point"
              aria-label={label}
              title={label}
              style={{ left: displayed.beat * ppb, top: yAt(displayed.value) }}
              onKeyDown={(event) => handleKeys(event, index, point)}
              onDoubleClick={() => put(removePoint(lane, index))}
              onPointerDown={(event) => {
                if (event.button !== 0 || drag.current) return;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                drag.current = { index, lane, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (current?.pointerId === event.pointerId) setPreview(dragPoint(event, current));
              }}
              onPointerUp={(event) => {
                const current = drag.current;
                if (current?.pointerId !== event.pointerId) return;
                const next = dragPoint(event, current);
                stopDrag();
                if (next) put(movePoint(lane, current.index, next));
              }}
              onLostPointerCapture={stopDrag}
              onPointerCancel={stopDrag}
            />;
          })}
        </div>
      </>}
    </details>
  );
});
