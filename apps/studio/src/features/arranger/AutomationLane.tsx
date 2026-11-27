import { memo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  addPoint, AUTOMATION_PARAMETERS, AUTOMATION_PARAMETER_INFO, beatTick, evaluateAutomation,
  MAX_AUTOMATION_POINTS, movePoint, PPQ, removePoint,
  type AutomationLane as Lane, type AutomationParameter, type AutomationPoint, type Track,
} from '@cts/project-model';
import { setTrackAutomation } from '../../state/editorActions';
import { useStore } from '../../state/store';

const EMPTY_LANE: Lane = { points: [] };
const PLOT_HEIGHT = 80;
const PLOT_PADDING = 12;
const VALUE_HEIGHT = PLOT_HEIGHT - 2 * PLOT_PADDING;
const PARAMETER_HELP = {
  volume: '上ほど音が大きく、下端は無音です。',
  pan: '上ほど右、下ほど左から聞こえます。真ん中ではミキサーの位置を保ちます。',
  cutoff: '上ほど音が明るく、下ほどこもった音になります。',
};

function pointValueLabel(parameter: AutomationParameter, value: number): string {
  if (parameter === 'cutoff') return `明るさ ${+value.toFixed(2)} 倍`;
  if (parameter === 'pan') return value === 0 ? '左右 ミキサーの位置'
    : `${value < 0 ? '左' : '右'}へ ${Math.round(Math.abs(value) * 100)}%`;
  return `音量 ${Math.round(value * 100)}%`;
}

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
  const [parameter, setParameter] = useState<AutomationParameter>('volume');
  const [preview, setPreview] = useState<AutomationPoint | null>(null);
  const drag = useRef<Drag | null>(null);
  const saved = track.automation?.[parameter];
  const lane = saved ?? EMPTY_LANE;
  const chartLane = preview && drag.current?.lane === lane ? movePoint(lane, drag.current.index, preview, parameter) : lane;
  const atLimit = lane.points.length >= MAX_AUTOMATION_POINTS;
  const put = (next: Lane) => {
    if (next !== lane) setTrackAutomation(track.id, parameter, saved, next);
  };
  const { min, max } = AUTOMATION_PARAMETER_INFO[parameter];
  const snapBeat = (beat: number) => Math.max(0, Math.min(visibleBeats, beatTick(beat) / PPQ));
  const toHeight = (value: number) => parameter === 'cutoff' ? (1 + Math.log10(value)) / 2 : (value - min) / (max - min);
  const pointAt = (beat: number, height: number): AutomationPoint => {
    const value = parameter === 'cutoff' ? 10 ** (height * 2 - 1) : min + height * (max - min);
    return {
      beat: snapBeat(beat),
      value: Math.max(min, Math.min(max, Math.round(value * 100) / 100)),
    };
  };
  const yAt = (value: number) => PLOT_PADDING + (1 - toHeight(value)) * VALUE_HEIGHT;
  const add = (point: AutomationPoint) => put(addPoint(lane, point, parameter));
  const fade = (fadeIn: boolean) => {
    const bar = Math.min(barBeats, songEnd);
    put({ points: fadeIn
      ? [{ beat: 0, value: 0 }, { beat: bar, value: 1 }]
      : [{ beat: songEnd - bar, value: 1 }, { beat: songEnd, value: 0 }] });
  };

  const handleKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number, point: AutomationPoint) => {
    const step = event.shiftKey ? 1 : 0.25;
    const height = toHeight(point.value);
    let next: Lane;
    switch (event.key) {
      case 'ArrowLeft': next = movePoint(lane, index, { beat: snapBeat(point.beat - step), value: point.value }, parameter); break;
      case 'ArrowRight': next = movePoint(lane, index, { beat: snapBeat(point.beat + step), value: point.value }, parameter); break;
      case 'ArrowDown': next = movePoint(lane, index, pointAt(point.beat, height - 0.05), parameter); break;
      case 'ArrowUp': next = movePoint(lane, index, pointAt(point.beat, height + 0.05), parameter); break;
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
    const next = pointAt(point.beat + x / ppb, toHeight(point.value) - y / VALUE_HEIGHT);
    return y === 0 ? { ...next, value: point.value } : next;
  };

  const stopDrag = () => {
    drag.current = null;
    setPreview(null);
  };

  // Duplicates are drawn at the effective (last saved) value, as in playback.
  const curve = !open ? [] : [
    { beat: 0, value: evaluateAutomation(chartLane, 0, parameter) },
    ...chartLane.points.filter((point, index, points) =>
      point.beat > 0 && point.beat < visibleBeats && point.beat !== points[index + 1]?.beat),
    { beat: visibleBeats, value: evaluateAutomation(chartLane, visibleBeats, parameter) },
  ];

  return (
    <details className="automation" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label={`${track.name}の音の変化`}>音の変化</summary>
      {open && <>
        <div className="automation__controls">
          <div>
            <label className="automation__parameter">
              変えるもの
              <select value={parameter} onChange={(event) => {
                stopDrag();
                setParameter(event.currentTarget.value as AutomationParameter);
              }}>
                {AUTOMATION_PARAMETERS.map((key) => <option key={key} value={key}>{AUTOMATION_PARAMETER_INFO[key].label}</option>)}
              </select>
            </label>
            {parameter === 'volume' && <>
              <button type="button" onClick={() => fade(true)}>フェードイン</button>
              <button type="button" onClick={() => fade(false)}>フェードアウト</button>
            </>}
            <button type="button" disabled={atLimit} onClick={() => {
              const beat = useStore.getState().transport.positionBeat;
              add(pointAt(beat, toHeight(evaluateAutomation(lane, beat, parameter))));
            }}>再生位置に点を追加</button>
          </div>
          {parameter === 'volume' && <p>フェードを選ぶと音量の点を置き換えます。</p>}
          <p>クリックで点を追加、ドラッグや矢印キーで移動、ダブルクリックや Delete キーで削除できます。</p>
          <p>{PARAMETER_HELP[parameter]}変更は次の再生から聞けます。</p>
          {atLimit && <p role="status">この項目には点を {MAX_AUTOMATION_POINTS} 個まで置けます。</p>}
        </div>
        <div
          className="automation__plot"
          data-testid={`automation-plot-${track.id}`}
          style={{ height: PLOT_HEIGHT, backgroundSize: `${barBeats * ppb}px 100%` }}
          onClick={(event) => {
            if (event.target !== event.currentTarget || atLimit) return;
            const rect = event.currentTarget.getBoundingClientRect();
            add(pointAt((event.clientX - rect.left) / ppb,
              1 - (event.clientY - rect.top - PLOT_PADDING) / VALUE_HEIGHT));
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
            const label = `曲の始まりから ${+displayed.beat.toFixed(3)} 拍、${pointValueLabel(parameter, displayed.value)}`;
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
                if (next) put(movePoint(lane, current.index, next, parameter));
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
