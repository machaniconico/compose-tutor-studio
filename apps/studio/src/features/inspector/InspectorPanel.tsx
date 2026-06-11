import { useStore } from '../../state/store';
import { PITCH_CLASS_NAMES, pitchClass } from '../../state/music';
import { TutorialPanel } from '../tutorial/TutorialPanel';

const FUNCTION_LABEL: Record<string, string> = {
  T: 'トニック',
  SD: 'サブドミナント',
  D: 'ドミナント',
  Other: 'その他',
};

/** Right column: selected chord info + tutorial panel toggle (placeholders). */
export function InspectorPanel() {
  const chordTrack = useStore((s) => s.project.chordTrack);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);

  const chord = chordTrack.find((c) => c.id === selectedChordId) ?? null;

  return (
    <aside className="inspector-panel" aria-label="インスペクタ">
      <div className="panel-section">
        <p className="panel-section__title">コード情報</p>
        {chord ? (
          <>
            <div className="kv">
              <span>コード</span>
              <span>{chord.symbol}</span>
            </div>
            <div className="kv">
              <span>ルート</span>
              <span>{chord.root}</span>
            </div>
            <div className="kv">
              <span>種類</span>
              <span>{chord.quality}</span>
            </div>
            {chord.degree ? (
              <div className="kv">
                <span>度数</span>
                <span>{chord.degree}</span>
              </div>
            ) : null}
            {chord.function ? (
              <div className="kv">
                <span>機能</span>
                <span>{FUNCTION_LABEL[chord.function] ?? chord.function}</span>
              </div>
            ) : null}
            <div className="kv">
              <span>構成音</span>
              <span>{chord.notes.map((n) => PITCH_CLASS_NAMES[pitchClass(n)]).join(' ')}</span>
            </div>
          </>
        ) : (
          <p className="empty-hint">コードトラックからコードを選択してください。</p>
        )}
      </div>

      <TutorialPanel />
    </aside>
  );
}
