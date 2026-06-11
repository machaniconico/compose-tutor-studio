import { useState } from 'react';
import type { BassMode, GeneratedNote, MelodyAnalysis, MelodyFinding } from '@cts/theory-engine';
import { analyzeMelody } from '@cts/theory-engine';
import { useStore } from '../../state/store';
import {
  chordTrackInputs,
  firstMidiClipOfTrack,
  generateBassIntoClip,
  generateMelodyIntoClip,
  projectBeatsPerBar,
} from '../../state/editorActions';
import type { CoachAdapter, CoachSuggestion } from '../../coach/adapter';
import { MockCoach } from '../../coach/mockCoach';

/** デフォルトのコーチ実装 (DI差し替え可能) */
const defaultCoach: CoachAdapter = new MockCoach();

const BASS_MODES: { value: BassMode; label: string; hint: string }[] = [
  { value: 'rootOnly', label: 'ルートのみ', hint: '各コードのルート音を拍頭に置きます。最もシンプルです。' },
  { value: 'rootFifth', label: 'ルート+5度', hint: 'ルートと5度を組み合わせ、厚みを出します。' },
  { value: 'walkingSimple', label: 'シンプルウォーキング', hint: '次のコードへ滑らかにつなぐ経過音を加えます。' },
  { value: 'octavePulse', label: 'オクターブ', hint: 'ルートとオクターブ上を交互に刻み、躍動感を出します。' },
];

type AssistantPanelProps = {
  /** AIコーチのDI差し替え用。省略時は MockCoach を使用。 */
  coach?: CoachAdapter;
};

/** Bass + Melody + AI Coach assistant. */
export function AssistantPanel({ coach = defaultCoach }: AssistantPanelProps) {
  return (
    <div className="assistant">
      <BassAssistant />
      <MelodyAssistant />
      <CoachAssistant coach={coach} />
    </div>
  );
}

function BassAssistant() {
  const project = useStore((s) => s.project);
  const [mode, setMode] = useState<BassMode>('rootOnly');
  const [reasons, setReasons] = useState<GeneratedNote[]>([]);

  const clip = firstMidiClipOfTrack(project, 'Bass');

  const onGenerate = () => {
    if (!clip) return;
    const generated = generateBassIntoClip(clip.id, mode);
    setReasons(generated);
  };

  return (
    <section className="panel-section">
      <p className="panel-section__title">ベース生成</p>
      {clip ? (
        <>
          <div className="assistant__modes">
            {BASS_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`assistant__mode${mode === m.value ? ' is-active' : ''}`}
                onClick={() => setMode(m.value)}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="assistant__hint">{BASS_MODES.find((m) => m.value === mode)?.hint}</p>
          <button type="button" className="assistant__generate" onClick={onGenerate}>
            生成
          </button>
          {reasons.length > 0 ? (
            <ul className="assistant__reasons">
              {reasons.map((r, i) => (
                <li key={i}>{r.reason}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="empty-hint">ベーストラックが見つかりません。</p>
      )}
    </section>
  );
}

const SEVERITY_ICON: Record<MelodyFinding['severity'], string> = {
  info: '◎',
  warn: '⚠',
};

function MelodyAssistant() {
  const project = useStore((s) => s.project);
  const [seed, setSeed] = useState(1);
  const [analysis, setAnalysis] = useState<MelodyAnalysis | null>(null);

  const clip = firstMidiClipOfTrack(project, 'Melody');

  const onGenerate = () => {
    if (!clip) return;
    // Seed = note count + project length so repeat clicks vary deterministically.
    const nextSeed = seed + project.lengthBars;
    generateMelodyIntoClip(clip.id, nextSeed);
    setSeed(nextSeed);
    setAnalysis(null);
  };

  const onReview = () => {
    if (!clip) return;
    const liveClip = useStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clip.id);
    const notes = (liveClip?.notes ?? []).map((n) => ({
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
    }));
    const current = useStore.getState().project;
    try {
      const result = analyzeMelody({
        key: current.key,
        scale: current.scale,
        chords: chordTrackInputs(current),
        notes,
        beatsPerBar: projectBeatsPerBar(current),
      });
      setAnalysis(result);
    } catch {
      setAnalysis(null);
    }
  };

  return (
    <section className="panel-section">
      <p className="panel-section__title">メロディ</p>
      {clip ? (
        <>
          <div className="assistant__melody-buttons">
            <button type="button" className="assistant__generate" onClick={onGenerate}>
              スケールメロディを生成
            </button>
            <button type="button" onClick={onReview}>
              メロディを添削
            </button>
          </div>

          {analysis ? (
            <div className="assistant__review">
              <div className="assistant__score">
                <span>スコア</span>
                <strong>{Math.round(analysis.score * 100)}%</strong>
              </div>
              <ul className="assistant__findings">
                {analysis.findings.map((f, i) => (
                  <li key={i} className={`assistant__finding is-${f.severity}`}>
                    <span className="assistant__finding-icon" aria-hidden="true">
                      {SEVERITY_ICON[f.severity]}
                    </span>
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="empty-hint">メロディトラックが見つかりません。</p>
      )}
    </section>
  );
}

type CoachAssistantProps = {
  coach: CoachAdapter;
};

/** AIコーチセクション: 改善提案一覧と「なぜ?」説明を表示 */
function CoachAssistant({ coach }: CoachAssistantProps) {
  const project = useStore((s) => s.project);
  const [suggestions, setSuggestions] = useState<CoachSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const onAnalyze = async () => {
    setLoading(true);
    setSuggestions([]);
    setExpandedIndex(null);
    try {
      const result = await coach.suggestImprovements(project);
      setSuggestions(result);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (i: number) => {
    setExpandedIndex(expandedIndex === i ? null : i);
  };

  return (
    <section className="panel-section">
      <p className="panel-section__title">AIコーチ</p>
      <p className="assistant__hint">
        現在のプロジェクトを分析して、初心者向けの改善アドバイスを提案します。
      </p>
      <button
        type="button"
        className="assistant__generate"
        onClick={onAnalyze}
        disabled={loading}
      >
        {loading ? '分析中...' : '改善提案を見る'}
      </button>
      {suggestions.length > 0 ? (
        <ul className="assistant__coach-suggestions">
          {suggestions.map((s, i) => (
            <li key={i} className="assistant__coach-suggestion">
              <button
                type="button"
                className="assistant__coach-suggestion-header"
                onClick={() => toggleExpand(i)}
                aria-expanded={expandedIndex === i}
              >
                <span className="assistant__coach-suggestion-title">{s.title}</span>
                {s.targetTrack ? (
                  <span className="assistant__coach-suggestion-track">{s.targetTrack}</span>
                ) : null}
                <span className="assistant__coach-suggestion-toggle" aria-hidden="true">
                  {expandedIndex === i ? '▲' : '▼'}
                </span>
              </button>
              {expandedIndex === i ? (
                <div className="assistant__coach-suggestion-body">
                  <p className="assistant__coach-suggestion-reason">
                    <strong>なぜ?</strong> {s.reason}
                  </p>
                  <p className="assistant__coach-suggestion-action">
                    <strong>やってみよう:</strong> {s.action}
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
