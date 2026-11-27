import { useId, useState } from 'react';
import { useStore } from '../../state/store';
import {
  MAX_HUMANIZE_TIMING_TICKS,
  MAX_HUMANIZE_VELOCITY,
  humanizeNotes,
  quantizeNotesWithStrength,
  type GrooveEditResult,
} from '../../state/grooveActions';

type Props = {
  clipId: string;
  noteIds: readonly string[];
  gridSnap: number;
  onAnnounce: (message: string) => void;
};

/** 新しい乱数の種。保存はせず、「ヒューマナイズ」を押すたびに作る。 */
function freshSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/** 強さ付きクオンタイズとヒューマナイズ。ツールバーの折りたたみ 1 つに収める。 */
export function NoteGroovePopover({ clipId, noteIds, gridSnap, onAnnounce }: Props) {
  const [strength, setStrength] = useState(100);
  const [timingTicks, setTimingTicks] = useState(20);
  const [velocity, setVelocity] = useState(8);
  const [notice, setNotice] = useState('');
  const statusId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const recording = useStore((state) => state.audioRecordingOperationId !== null);
  const idle = recording || noteIds.length === 0;

  const finish = (result: GrooveEditResult, done: string): void => {
    const message = result.ok ? (result.message ?? done) : result.reason;
    setNotice(message);
    onAnnounce(message);
  };

  return (
    <div className="pr__popover-anchor">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        title="強さつきクオンタイズ・ヒューマナイズ"
        onClick={() => setOpen((value) => !value)}
      >
        ゆらぎ…
      </button>
      {open ? (
      <div
        id={panelId}
        className="pr__popover"
        role="group"
        aria-label="強さつきクオンタイズとヒューマナイズ"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <label className="pr__field">
          <span>クオンタイズの強さ {strength}%</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={strength}
            aria-label="クオンタイズの強さ"
            onChange={(event) => setStrength(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button
          type="button"
          disabled={idle}
          onClick={() => finish(quantizeNotesWithStrength(clipId, noteIds, gridSnap, strength), '')}
        >
          選択ノートを強さつきで寄せる
        </button>
        <label className="pr__field">
          <span>タイミングのゆれ ±{timingTicks}ティック</span>
          <input
            type="range"
            min={0}
            max={MAX_HUMANIZE_TIMING_TICKS}
            step={1}
            value={timingTicks}
            aria-label="タイミングのゆれ"
            onChange={(event) => setTimingTicks(event.currentTarget.valueAsNumber)}
          />
        </label>
        <label className="pr__field">
          <span>強さのゆれ ±{velocity}</span>
          <input
            type="range"
            min={0}
            max={MAX_HUMANIZE_VELOCITY}
            step={1}
            value={velocity}
            aria-label="強さのゆれ"
            onChange={(event) => setVelocity(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button
          type="button"
          disabled={idle}
          onClick={() =>
            finish(humanizeNotes(clipId, noteIds, { timingTicks, velocity, seed: freshSeed() }), '')}
        >
          選択ノートをヒューマナイズ
        </button>
        <small id={statusId} role="status">
          {notice || 'ノートを選ぶと使えます。押すたびに違うゆれ方になり、元に戻すで取り消せます。'}
        </small>
      </div>
      ) : null}
    </div>
  );
}
