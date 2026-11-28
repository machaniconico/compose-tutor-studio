import { useState } from 'react';
import {
  ACCOMPANIMENT_MOODS,
  generateAccompanimentSet,
  type AccompanimentMood,
} from '../../state/accompanimentGeneration';
import { useStore } from '../../state/store';

const PART_EXPLANATIONS = [
  { part: 'コード', text: 'コードの音を重ねて、和音の響きを作ります。となり合うコードでは近い高さの音を選びます。' },
  { part: 'ベース', text: '小節の頭にルート音を置いて、曲の土台を支えます。低い音域(E1〜G3)に収めています。' },
  { part: 'ドラム', text: 'キックとスネアのくり返しで拍を感じやすくします。曲のスウィングの設定に合わせて鳴ります。' },
] as const;

/** おまかせ伴奏: コードトラックから、コード・ベース・ドラムの新しいトラックを 1 回で作る(Undo 1 段)。 */
export function AutoAccompanimentAssistant() {
  const hasChords = useStore((s) => s.project.chordTrack.length > 0);
  const [mood, setMood] = useState<AccompanimentMood>('straight');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const onGenerate = () => {
    const result = generateAccompanimentSet({ mood });
    setMessage(result.ok ? { ok: true, text: result.message } : { ok: false, text: result.reason });
  };

  return (
    <section className="panel-section" aria-label="おまかせ伴奏">
      <p className="panel-section__title">おまかせ伴奏</p>
      {hasChords ? (
        <>
          <p className="assistant__hint">
            コードトラックから、コード・ベース・ドラムの新しいトラックを 1 回で作ります。いまのトラックには触れず、「元に戻す」1 回で消せます。
          </p>
          <label className="assistant__accompaniment-mood">
            雰囲気
            <select value={mood} onChange={(event) => setMood(event.currentTarget.value as AccompanimentMood)}>
              {Object.entries(ACCOMPANIMENT_MOODS).map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <button type="button" className="assistant__generate" onClick={onGenerate}>
            おまかせで伴奏を作る
          </button>
          {message ? (
            <p className={`assistant__comping-message${message.ok ? '' : ' is-error'}`} role={message.ok ? 'status' : 'alert'}>
              {message.text}
            </p>
          ) : null}
          {message?.ok ? (
            <ul className="assistant__reasons">
              {PART_EXPLANATIONS.map(({ part, text }) => (
                <li key={part}><strong>{part}</strong> {text}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="empty-hint">コードトラックにコードを置くと、おまかせで伴奏を作れます。</p>
      )}
    </section>
  );
}
