import { useStore } from '../../state/store';
import {
  STEP_LENGTHS,
  setStepLength,
  startStepInput,
  stepInputBack,
  stepInputRest,
  stopStepInput,
  useStepInput,
} from '../../state/stepInput';

type Props = {
  clipId: string;
  onAnnounce: (message: string) => void;
  onStarted?: () => void;
};

/** ステップ入力のオン/オフ・音符の長さ・休符・1 つ戻る。「ゆらぎ…」のポップオーバー内に置く(ツールバーに幅がないため)。 */
export function StepInputSection({ clipId, onAnnounce, onStarted }: Props) {
  const active = useStepInput((state) => state.active && state.clipId === clipId);
  const stepTicks = useStepInput((state) => state.stepTicks);
  const canBack = useStepInput((state) => state.history.length > 0);
  const recording = useStore((state) => state.audioRecordingOperationId !== null || state.midiRecordingActive);

  return (
    <div role="group" aria-label="ステップ入力" className="pr__step-input">
      <label className="pr__field">
        <span>ステップ入力: 音符の長さ</span>
        <select
          value={stepTicks}
          aria-label="ステップ入力の音符の長さ"
          onChange={(event) => setStepLength(Number(event.currentTarget.value))}
        >
          {STEP_LENGTHS.map((length) => (
            <option key={length.ticks} value={length.ticks}>{length.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={recording && !active}
        onClick={() => {
          if (active) {
            stopStepInput();
            onAnnounce('ステップ入力を終えました。');
          } else {
            const started = startStepInput(clipId);
            onAnnounce(started.message);
            if (started.ok) onStarted?.();
          }
        }}
      >
        {active ? 'ステップ入力を終える' : 'ステップ入力を始める'}
      </button>
      <div role="group" aria-label="ステップ入力の操作">
        <button type="button" disabled={!active} onClick={() => onAnnounce(stepInputRest().message)}>
          休符(Enter)
        </button>
        <button type="button" disabled={!active || !canBack} onClick={() => onAnnounce(stepInputBack().message)}>
          1 つ戻る(Backspace)
        </button>
      </div>
      <small>
        {active
          ? '左の鍵盤を押すと、カーソルの位置に音が入って先へ進みます。1 音ごとに元に戻せます。'
          : '始めると、再生ヘッドの位置(クリップの外なら先頭)から 1 音ずつ入力できます。'}
      </small>
    </div>
  );
}
