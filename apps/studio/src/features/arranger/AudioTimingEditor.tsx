import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  addAudioWarpTimingPoint,
  moveAudioWarpTimingPoint,
  removeAudioWarpTimingPoint,
  type AudioClip,
  type AudioWarp,
  type AudioWarpEditErrorCode,
  type AudioWarpMarker,
} from '@cts/project-model';

const MIN_SEGMENT_FRAMES = 1_920;
const MIN_BEAT_GAP = 0.001;

type Props = Readonly<{
  clip: AudioClip;
  warp: AudioWarp;
  onCommit: (warp: AudioWarp | undefined, message: string) => boolean;
  onReject?: (code: AudioWarpEditErrorCode) => void;
  disabled: boolean;
}>;

function markerPercent(clip: AudioClip, marker: AudioWarpMarker): number {
  return ((marker.targetBeatOffset / clip.lengthBeats) * 100);
}

function nearestIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

export function AudioTimingEditor({
  clip,
  warp,
  onCommit,
  onReject = () => undefined,
  disabled,
}: Props) {
  const [selected, setSelected] = useState(0);
  const [previewBeat, setPreviewBeat] = useState<number | null>(null);
  const dragStart = useRef<number | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const markers = warp.markers;
  const selectedIndex = nearestIndex(selected, markers.length);
  const selectedMarker = markers[selectedIndex]!;

  useEffect(() => {
    if (selected !== selectedIndex) setSelected(selectedIndex);
  }, [selected, selectedIndex]);
  useEffect(() => {
    if (disabled) return;
    if (pendingFocus.current === null) return;
    const next = nearestIndex(pendingFocus.current, markers.length);
    pendingFocus.current = null;
    setSelected(next);
    requestAnimationFrame(() => buttons.current.get(next)?.focus());
  }, [disabled, markers]);
  useEffect(() => {
    if (!disabled) return;
    dragStart.current = null;
    setPreviewBeat(null);
  }, [disabled]);

  const focus = (index: number): void => {
    const next = nearestIndex(index, markers.length);
    setSelected(next);
    requestAnimationFrame(() => buttons.current.get(next)?.focus());
  };

  const focusAfterCommit = (index: number): void => {
    pendingFocus.current = index;
    setSelected(index);
  };

  const commitWithFocus = (
    nextWarp: AudioWarp | undefined,
    message: string,
    index: number,
  ): boolean => {
    if (disabled) return false;
    focusAfterCommit(index);
    if (onCommit(nextWarp, message)) return true;
    pendingFocus.current = null;
    focus(selectedIndex);
    return false;
  };

  const commitMove = (index: number, targetBeatOffset: number): boolean => {
    if (disabled) return false;
    const marker = markers[index];
    if (!marker || targetBeatOffset === marker.targetBeatOffset) return false;
    const result = moveAudioWarpTimingPoint(warp, index, {
      ...marker,
      targetBeatOffset,
    });
    if (!result.ok) {
      onReject(result.error.code);
      return false;
    }
    if (!result.changed) return false;
    return onCommit(result.audioWarp, 'タイミング点を移動しました。');
  };

  const beatFromPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
    index: number,
  ): number => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return markers[index]!.targetBeatOffset;
    const raw = ((event.clientX - rect.left) / rect.width) * clip.lengthBeats;
    const previous = markers[index - 1]?.targetBeatOffset ?? 0;
    const next = markers[index + 1]?.targetBeatOffset ?? clip.lengthBeats;
    return Math.max(previous + MIN_BEAT_GAP, Math.min(next - MIN_BEAT_GAP, raw));
  };

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): boolean => {
    if (event.key === 'PageUp') focus(index - 1);
    else if (event.key === 'PageDown') focus(index + 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(markers.length - 1);
    else return false;
    event.preventDefault();
    return true;
  };

  const onMarkerKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (disabled) return;
    if (navigate(event, index)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dragStart.current = null;
      setPreviewBeat(null);
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      const result = removeAudioWarpTimingPoint(warp, index);
      if (!result.ok) {
        onReject(result.error.code);
        return;
      }
      if (!result.changed) return;
      commitWithFocus(
        result.audioWarp,
        'タイミング点を削除しました。',
        Math.min(index, result.audioWarp.markers.length - 1),
      );
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && index > 0
      && index < markers.length - 1) {
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const amount = event.altKey ? 0.001 : 0.01;
      const previous = markers[index - 1]!.targetBeatOffset + MIN_BEAT_GAP;
      const next = markers[index + 1]!.targetBeatOffset - MIN_BEAT_GAP;
      commitMove(
        index,
        Math.max(previous, Math.min(next, selectedMarker.targetBeatOffset + direction * amount)),
      );
    }
  };

  const addPoint = (): void => {
    if (disabled) return;
    let segment = 0;
    let widest = -1;
    for (let index = 0; index < markers.length - 1; index += 1) {
      const width = markers[index + 1]!.sourceFrame - markers[index]!.sourceFrame;
      if (width > widest) {
        widest = width;
        segment = index;
      }
    }
    const left = markers[segment]!;
    const right = markers[segment + 1]!;
    if (right.sourceFrame - left.sourceFrame < MIN_SEGMENT_FRAMES * 2) {
      onReject('invalid-marker');
      return;
    }
    const marker = {
      sourceFrame: Math.round((left.sourceFrame + right.sourceFrame) / 2),
      targetBeatOffset: (left.targetBeatOffset + right.targetBeatOffset) / 2,
    };
    const result = addAudioWarpTimingPoint(warp, marker);
    if (!result.ok) {
      onReject(result.error.code);
      return;
    }
    if (!result.changed) return;
    const index = result.audioWarp.markers.findIndex(
      (candidate) => candidate.sourceFrame === marker.sourceFrame,
    );
    commitWithFocus(result.audioWarp, 'タイミング点を追加しました。', index);
  };

  const removeSelected = (): void => {
    if (disabled) return;
    const result = removeAudioWarpTimingPoint(warp, selectedIndex);
    if (!result.ok) {
      onReject(result.error.code);
      return;
    }
    if (!result.changed) return;
    commitWithFocus(
      result.audioWarp,
      'タイミング点を削除しました。',
      Math.min(selectedIndex, result.audioWarp.markers.length - 1),
    );
  };

  return (
    <section className="audio-timing-editor" aria-label="タイミング補正">
      <p>点の横位置を動かすと、その素材フレームが鳴る拍を変えます。元の音声は変更しません。</p>
      <div className="audio-warp-editor__timeline-scroll">
        <div className="audio-warp-editor__timeline" aria-label="タイミング点">
          <svg viewBox="0 0 1000 180" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 90 C120 20 190 160 300 80 S520 30 620 100 S820 150 1000 75" />
          </svg>
          {markers.map((marker, index) => {
            const beat = previewBeat !== null && selectedIndex === index
              ? previewBeat
              : marker.targetBeatOffset;
            const position = markerPercent(
              clip,
              { ...marker, targetBeatOffset: beat },
            );
            return (
              <button
                key={`${marker.sourceFrame}-${index}`}
                ref={(node) => {
                  if (node) buttons.current.set(index, node);
                  else buttons.current.delete(index);
                }}
                type="button"
                disabled={disabled}
                className={`audio-timing-editor__point${selectedIndex === index ? ' is-selected' : ''}`}
                style={{
                  left: `clamp(22px, ${position}%, calc(100% - 22px))`,
                }}
                aria-label={`タイミング点 ${index + 1}、素材フレーム ${marker.sourceFrame}、${beat.toFixed(3)}拍`}
                aria-pressed={selectedIndex === index}
                tabIndex={selectedIndex === index ? 0 : -1}
                onFocus={() => setSelected(index)}
                onKeyDown={(event) => onMarkerKeyDown(event, index)}
                onPointerDown={(event) => {
                  if (disabled || index === 0 || index === markers.length - 1) return;
                  dragStart.current = marker.targetBeatOffset;
                  setSelected(index);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (disabled || dragStart.current === null) return;
                  setPreviewBeat(beatFromPointer(event, index));
                }}
                onPointerUp={(event) => {
                  if (disabled || dragStart.current === null) return;
                  const next = previewBeat ?? beatFromPointer(event, index);
                  dragStart.current = null;
                  setPreviewBeat(null);
                  commitMove(index, next);
                }}
                onPointerCancel={() => {
                  dragStart.current = null;
                  setPreviewBeat(null);
                }}
              >
                <span aria-hidden="true">{index + 1}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="audio-warp-editor__toolbar" role="group" aria-label="タイミング点操作">
        <button type="button" disabled={disabled} onClick={addPoint}>点を追加</button>
        <button
          type="button"
          disabled={
            disabled
            || selectedIndex === 0
            || selectedIndex === markers.length - 1
          }
          onClick={removeSelected}
        >
          選択した点を削除
        </button>
        <button
          type="button"
          disabled={disabled || markers.length <= 2}
          onClick={() => {
            if (disabled) return;
            const next = {
              ...warp,
              markers: [markers[0]!, markers.at(-1)!],
            };
            commitWithFocus(
              next.pitchRegions.length === 0 ? undefined : next,
              'タイミング補正をリセットしました。',
              0,
            );
          }}
        >
          タイミングをリセット
        </button>
      </div>

      <div className="audio-warp-editor__inspector" aria-label="選択タイミング点のインスペクター">
        <label>
          <span>素材フレーム</span>
          <input
            type="number"
            value={selectedMarker.sourceFrame}
            disabled={
              disabled
              || selectedIndex === 0
              || selectedIndex === markers.length - 1
            }
            min={(markers[selectedIndex - 1]?.sourceFrame ?? clip.sourceStartFrame) + MIN_SEGMENT_FRAMES}
            max={(markers[selectedIndex + 1]?.sourceFrame
              ?? clip.sourceStartFrame + clip.sourceFrameCount) - MIN_SEGMENT_FRAMES}
            onChange={(event) => {
              if (disabled) return;
              const sourceFrame = Number(event.target.value);
              const result = moveAudioWarpTimingPoint(warp, selectedIndex, {
                ...selectedMarker,
                sourceFrame,
              });
              if (!result.ok) {
                onReject(result.error.code);
              } else if (result.changed) {
                onCommit(result.audioWarp, 'タイミング点を移動しました。');
              }
            }}
          />
        </label>
        <label>
          <span>移動先（拍）</span>
          <input
            type="number"
            value={selectedMarker.targetBeatOffset}
            step="0.001"
            disabled={
              disabled
              || selectedIndex === 0
              || selectedIndex === markers.length - 1
            }
            onChange={(event) => commitMove(selectedIndex, Number(event.target.value))}
          />
        </label>
      </div>
    </section>
  );
}
