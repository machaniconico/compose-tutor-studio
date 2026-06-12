import { useMemo } from 'react';
import { suggestNextChords } from '@cts/theory-engine';
import { useStore, type RightPanelTab } from '../../state/store';
import { appendChordAfterLast } from '../../state/editorActions';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { TutorialPanel } from '../tutorial/TutorialPanel';
import { useInspection } from './useInspection';
import type { NoteInspectionResult, ChordInspectionResult, KeyScaleOverview } from './useInspection';
import {
  harmonicFunctionLabel,
  degreeLabel,
  tensionLabel,
  advancedChordNote,
  noteRelationLabel,
  scalePresenceLabel,
  simplifyExplanation,
  type Difficulty,
} from './difficultyText';

const TABS: { id: RightPanelTab; label: string }[] = [
  { id: 'inspector', label: 'インスペクター' },
  { id: 'assistant', label: 'アシスタント' },
  { id: 'tutorial', label: 'チュートリアル' },
];

/**
 * Right column tab host: inspector / assistant / tutorial.
 * The active tab lives in the store (`rightPanelTab`) so other features —
 * e.g. the start screen's「チュートリアルをはじめる」— can switch tabs too.
 */
export function InspectorPanel() {
  const tab = useStore((s) => s.rightPanelTab);
  const setTab = useStore((s) => s.setRightPanelTab);

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
  const difficulty = useStore((s) => s.editor.difficulty);

  if (state.kind === 'note') return <NoteInspector data={state.data} difficulty={difficulty} />;
  if (state.kind === 'chord') return <ChordInspector data={state.data} difficulty={difficulty} />;
  return <KeyScaleView data={state.data} difficulty={difficulty} />;
}

// ---------------------------------------------------------------------------
// Note Inspector
// ---------------------------------------------------------------------------

/** Selected-note inspector: pitch name, scale degree, chord tone classification. */
function NoteInspector({ data, difficulty }: { data: NoteInspectionResult; difficulty: Difficulty }) {
  const relationLabel = data.noteAnalysis
    ? noteRelationLabel(data.noteAnalysis.relation, difficulty)
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
        <span>{scalePresenceLabel(data.inScale, difficulty)}</span>
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

// ---------------------------------------------------------------------------
// Chord Inspector
// ---------------------------------------------------------------------------

/** Full chord analysis display with "next chord" buttons. */
function ChordInspector({ data, difficulty }: { data: ChordInspectionResult; difficulty: Difficulty }) {
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
  const advancedNote = difficulty === 'advanced'
    ? advancedChordNote(data.harmonicFunction, data.degree)
    : '';

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
        <span>{degreeLabel(data.degree, difficulty)}</span>
      </div>
      <div className="kv">
        <span>機能</span>
        <span>{harmonicFunctionLabel(data.harmonicFunction, difficulty)}</span>
      </div>

      <div className="kv">
        <span>テンション</span>
        <span>{tensionLabel(data.tension, difficulty)}</span>
      </div>

      {data.explanation ? (
        <p className="inspector-explain">{simplifyExplanation(data.explanation, difficulty)}</p>
      ) : null}

      {advancedNote ? (
        <p className="inspector-explain inspector-explain--advanced">{advancedNote}</p>
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
function KeyScaleView({ data, difficulty }: { data: KeyScaleOverview; difficulty: Difficulty }) {
  const hints =
    difficulty === 'beginner'
      ? [
          'コードトラックでコードをタップすると、そのコードのわかりやすい説明が出ます。',
          '小節をクリックするとコードを追加できます。',
          'ピアノロールでノートを選ぶと、その音の意味を教えてくれます。',
          '「アシスタント」タブでベースやメロディを自動で作れます。',
        ]
      : difficulty === 'advanced'
        ? [
            'コードトラックでコードを選ぶと度数・機能・テンション・セカンダリドミナント応用の詳細が表示されます。',
            '空いている小節をクリックするとコードを追加できます。',
            'ピアノロールでノートを選ぶとコードトーン/テンション/ノンスケール音の詳細分析が出ます。',
            '「アシスタント」タブからベースやメロディを自動生成できます。',
          ]
        : [
            '上のコードトラックでコードを選ぶと、構成音や機能の解説が出ます。',
            '空いている小節をクリックするとコードを追加できます。',
            'ピアノロールでノートをクリックすると、その音の役割を説明します。',
            '「アシスタント」タブからベースやメロディを自動生成できます。',
          ];

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
        {hints.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}
