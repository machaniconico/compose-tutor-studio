import { useEffect, useId, useRef, useState } from 'react';
import { MAX_SWING_PERCENT, isGrooveResolvedMode } from '@cts/project-model';
import { useStore } from '../../state/store';
import { setHiHatChoke, setProjectSwing } from '../../state/grooveActions';

/** 曲全体のスウィングとハイハットのチョーク。インスペクターの折りたたみ 1 つに収める。 */
export function GroovePanel() {
  const swing = useStore((state) => state.project.swing);
  const hiHatChoke = useStore((state) => state.project.hiHatChoke);
  const resolvedMode = useStore((state) => isGrooveResolvedMode(state.project));
  const busy = useStore(
    (state) => state.projectOperationBusy || state.audioRecordingOperationId !== null,
  );
  const helpId = useId();
  const [notice, setNotice] = useState('');
  // ドラッグ中は表示だけを動かし、曲(と自動保存)には触れない。離した時に 1 回だけ確定する。
  // Escape・フォーカス喪失・タブが隠れた・取り外しでは何も書かずに元へ戻す。
  const [dragValue, setDragValue] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const updateDrag = (value: number | null): void => {
    dragRef.current = value;
    setDragValue(value);
  };
  const cancelDrag = (): void => {
    if (dragRef.current !== null) updateDrag(null);
  };
  const endDrag = (): void => {
    const value = dragRef.current;
    if (value === null) return;
    updateDrag(null);
    report(setProjectSwing(value));
  };
  const beginDrag = (): void => updateDrag(Number.isFinite(swing) ? swing : 0);
  useEffect(() => {
    if (dragValue === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancelDrag();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') cancelDrag();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [dragValue === null]);
  useEffect(() => () => { dragRef.current = null; }, []);
  const report = (result: ReturnType<typeof setProjectSwing>): void => {
    setNotice(result.ok ? '' : result.reason);
  };

  const value = dragValue ?? (Number.isFinite(swing) ? swing : 0);
  return (
    <details className="groove-panel">
      <summary>ノリ(スウィング・チョーク)</summary>
      <label className="groove-panel__row">
        <span>スウィング {value}%</span>
        <input
          type="range"
          min={0}
          max={MAX_SWING_PERCENT}
          step={1}
          value={value}
          aria-label="スウィング"
          aria-valuetext={`${value}%`}
          aria-describedby={helpId}
          disabled={busy}
          onPointerDown={beginDrag}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onBlur={cancelDrag}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancelDrag();
          }}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (dragRef.current !== null) updateDrag(next);
            else report(setProjectSwing(next));
          }}
        />
      </label>
      <label className="groove-panel__row groove-panel__check">
        <input
          type="checkbox"
          checked={hiHatChoke === true}
          disabled={busy}
          onChange={(event) => report(setHiHatChoke(event.currentTarget.checked))}
        />
        <span>ハイハットのチョーク</span>
      </label>
      <small id={helpId}>
        スウィングをかけると、裏の16分音符が少し後ろにずれて、はずむノリになります。
        チョークをオンにすると、開いたハイハットが、次に閉じたハイハットが鳴ったところで止まります。
        {resolvedMode
          ? ' ノリを使っている間は、音の出だしが1ティック(1拍の480分の1)未満だけ動くことがあります。'
          : ''}
      </small>
      {notice ? <small role="status">{notice}</small> : null}
    </details>
  );
}
