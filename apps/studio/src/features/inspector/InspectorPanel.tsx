import { useMemo, useState } from 'react';
import { suggestNextChords, type HarmonicFunction } from '@cts/theory-engine';
import { useStore } from '../../state/store';
import { appendChordAfterLast } from '../../state/editorActions';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { TutorialPanel } from '../tutorial/TutorialPanel';
import { useInspection } from './useInspection';
import type { NoteInspectionResult, ChordInspectionResult, KeyScaleOverview } from './useInspection';

type RightTab = 'inspector' | 'assistant' | 'tutorial';

const TABS: { id: RightTab; label: string }[] = [
  { id: 'inspector', label: 'インスペクター' },
  { id: 'assistant', label: 'アシスタント' },
  { id: 'tutorial', label: 'チュートリアル' },
];

/** Right column tab host: inspector / assistant / tutorial. */
export function InspectorPanel() {
  const [tab, setTab] = useState<RightTab>('inspector');

  return (
    <aside className="inspector-panel" aria-label="インスペクタ">
      <div className="right-tabs" role="tablist" aria-label="右パネル切替">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'is-active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="right-tabs__body" role="tabpanel">
        {tab === 'inspector' ? <InspectorContent /> : null}
        {tab === 'assistant' ? <AssistantPanel /> : null}
        {tab === 'tutorial' ? <TutorialPanel /> : null}
      </div>
    </aside>
  );
}

/** The inspector content itself: dispatches to note/chord/overview views. */
function InspectorContent() {
  const state = useInspection();

  if (state.kind === 'note') return <NoteInspector data={state.data} />;
  if (state.kind === 'chord') return <ChordInspector data={state.data} />;
  return <KeyScaleView data={state.data} />;
}

// ---------------------------------------------------------------------------
// Note Inspector
// ---------------------------------------------------------------------------

/** Selected-note inspector: pitch name, scale degree, chord tone classification. */
function NoteInspector({ data }: { data: NoteInspectionResult }) {
  const relationLabel = data.noteAnalysis
    ? relationToLabel(data.noteAnalysis.relation)
    : data.inScale
      ? 'スケール内'
      : 'スケール外';

  return (
    <div className="panel-section">
      <p className="panel-section__title">ノート情報</p>
      <div className="chord-headline">{data.noteName}</div>

      <div className="kv">
        <span>音名</span>
        <span>{data.noteName}</span>
      </div>

      {data.scaleDegree ? (
        <div className="kv">
          <span>キー内の度数</span>
          <span>{data.scaleDegree}度</span>
        </div>
      ) : null}

      <div className="kv">
        <span>スケール</span>
        <span>{data.inScale ? '内（自然な音）' : '外（色付けの音）'}</span>
      </div>

      {data.currentChordSymbol ? (
        <div className="kv">
          <span>現在のコード</span>
          <span>{data.currentChordSymbol}</span>
        </div>
      ) : null}

      {data.degreeInChord ? (
        <div className="kv">
          <span>コード内の役割</span>
          <span>{data.degreeInChord}（{relationLabel}）</span>
        </div>
      ) : (
        <div className="kv">
          <span>コードとの関係</span>
          <span>{relationLabel}</span>
        </div>
      )}

      {data.noteAnalysis ? (
        <p className="inspector-explain">{data.noteAnalysis.message}</p>
      ) : null}
      {/* キー文脈説明: コード選択が併存する場合でも、スケール外音のクロマチック説明を常に表示する */}
      {!data.inScale ? (
        <p className="inspector-explain">{data.keyContext}</p>
      ) : !data.noteAnalysis ? (
        <p className="inspector-explain">{data.keyContext}</p>
      ) : null}
    </div>
  );
}

function relationToLabel(relation: string): string {
  switch (relation) {
    case 'chordTone':
      return 'コードトーン（安定音）';
    case 'scaleTone':
      return 'スケール音（経過音向き）';
    case 'tension':
      return 'テンション（色付け音）';
    case 'nonScale':
      return 'スケール外（経過音・アプローチ音）';
    default:
      return relation;
  }
}

// ---------------------------------------------------------------------------
// Chord Inspector
// ---------------------------------------------------------------------------

/** Full chord analysis display with "next chord" buttons. */
function ChordInspector({ data }: { data: ChordInspectionResult }) {
  const project = useStore((s) => s.project);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);

  const nextChords = useMemo(() => {
    const chord = project.chordTrack.find((c) => c.id === selectedChordId);
    if (!chord) return [];
    const before = [...project.chordTrack]
      .sort((a, b) => a.startBeat - b.startBeat)
      .filter((c) => c.startBeat <= chord.startBeat)
      .map((c) => c.symbol);
    try {
      return suggestNextChords({ key: project.key, scale: project.scale, currentProgression: before });
    } catch {
      return [];
    }
  }, [project.chordTrack, project.key, project.scale, selectedChordId]);

  const notes = data.notes.length > 0 ? data.notes.join('・') : '—';

  return (
    <div className="panel-section">
      <p className="panel-section__title">コード解析</p>
      <div className="chord-headline">{data.symbol}</div>

      <div className="kv">
        <span>構成音</span>
        <span>{notes}</span>
      </div>
      <div className="kv">
        <span>度数</span>
        <span>{data.degree}</span>
      </div>
      <div className="kv">
        <span>機能</span>
        <span>{data.functionLabel}</span>
      </div>

      <div className="kv">
        <span>テンション</span>
        <span>{data.tension.length > 0 ? data.tension.join('・') : 'なし（基本形）'}</span>
      </div>

      {data.explanation ? (
        <p className="inspector-explain">{data.explanation}</p>
      ) : null}

      {nextChords.length > 0 ? (
        <div className="inspector-next">
          <p className="panel-section__title">次に進みやすいコード</p>
          <div className="inspector-next__buttons">
            {nextChords.map((n, i) => (
              <button
                key={`${n.symbol}-${i}`}
                type="button"
                className="inspector-next__btn"
                title={n.reason}
                onClick={() => appendChordAfterLast(n.symbol)}
              >
                {n.symbol}
              </button>
            ))}
          </div>
          <p className="inspector-next__reason">{nextChords[0]?.reason}</p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key/Scale Overview (nothing selected)
// ---------------------------------------------------------------------------

/** Shown when nothing is selected: current key and scale summary. */
function KeyScaleView({ data }: { data: KeyScaleOverview }) {
  return (
    <div className="panel-section">
      <p className="panel-section__title">キー / スケール概要</p>

      <div className="kv">
        <span>キー</span>
        <span>{data.key}</span>
      </div>
      <div className="kv">
        <span>スケール</span>
        <span>{data.scaleLabel}</span>
      </div>
      {data.scaleNotes.length > 0 ? (
        <div className="kv">
          <span>構成音</span>
          <span>{data.scaleNotes.join('・')}</span>
        </div>
      ) : null}

      <ul className="inspector-hints">
        <li>上のコードトラックでコードを選ぶと、構成音や機能の解説が出ます。</li>
        <li>空いている小節をクリックするとコードを追加できます。</li>
        <li>ピアノロールでノートをクリックすると、その音の役割を説明します。</li>
        <li>「アシスタント」タブからベースやメロディを自動生成できます。</li>
      </ul>
    </div>
  );
}
