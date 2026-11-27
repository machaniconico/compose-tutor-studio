import { useState } from 'react';
import type { BassMode, GeneratedNote, MelodyAnalysis, MelodyFinding } from '@cts/theory-engine';
import { ACCOMPANIMENT_MOODS, analyzeMelody, type AccompanimentMood } from '@cts/theory-engine';
import { resolveEditTarget } from '@cts/project-model';
import { useStore } from '../../state/store';
import {
  chordTrackInputs,
  firstMidiClipOfTrack,
  generateBassIntoClip,
  generateMelodyIntoClip,
  projectBeatsPerBar,
  writeAccompaniment,
  type ClipGenerationFailure,
} from '../../state/editorActions';
import type { CoachAdapter, CoachSuggestion } from '../../coach/adapter';
import { MockCoach } from '../../coach/mockCoach';
import { simplifyExplanation } from '../inspector/difficultyText';

const GENERATION_NOTICE: Record<ClipGenerationFailure, string> = {
  missingTarget: '音符を書き込むクリップを開けません。リンク元のクリップがあるか確認しましょう。',
  noChords: 'このクリップの範囲にはコードがないため、何も生成しませんでした(今ある音符はそのままです)。' +
    'コードトラックでクリップと同じ位置にコードを置くか、クリップをコードのある位置へ動かしましょう。',
  noNotes: 'この範囲に収まる音符が作れませんでした。クリップやコードを長くしてみましょう。',
  loopRange: '繰り返しの1回分に収まらない音符があるため、今ある音符を残しました。' +
    '繰り返しの長さを伸ばすか、繰り返しを止めてから生成しましょう。',
  eventLimit: '生成すると繰り返しで鳴る音の数が上限を超えるため、今ある音符を残しました。' +
    '繰り返すクリップを短くするか、音の数を減らしましょう。',
};

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

export function AssistantPanel({ coach = defaultCoach }: AssistantPanelProps) {
  return (
    <div className="assistant">
      <AccompanimentAssistant />
      <BassAssistant />
      <MelodyAssistant />
      <CoachAssistant coach={coach} />
    </div>
  );
}

const ACCOMPANIMENT_EXPLANATIONS = [
  { part: 'ドラム', text: 'くり返すリズムで、拍を感じやすくします。' },
  { part: 'ベース', text: 'コードのルート音を中心に、低い音で曲を支えます。' },
  { part: '和音', text: 'コードに合う音を重ねます。となり合うコードでは、近い高さの音を選びます。' },
];

function AccompanimentAssistant() {
  const difficulty = useStore((s) => s.editor.difficulty);
  const [mood, setMood] = useState<AccompanimentMood>('straight');
  const [seed, setSeed] = useState(0);
  const [status, setStatus] = useState('');

  const onGenerate = () => {
    const result = writeAccompaniment({ seed, mood, complexity: 0.5, intensity: 0.5 });
    if (result.ok) setSeed(seed + 1);
    setStatus(result.ok ? 'ドラム・ベース・和音の伴奏を作りました。' : result.reason);
  };

  return (
    <section className="panel-section">
      <p className="panel-section__title">伴奏をおまかせ</p>
      <label className="assistant__accompaniment-mood">
        雰囲気
        <select value={mood} onChange={(event) => setMood(event.currentTarget.value as AccompanimentMood)}>
          {Object.entries(ACCOMPANIMENT_MOODS).map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </label>
      <button type="button" className="assistant__generate assistant__accompaniment-button" onClick={onGenerate}>
        {seed === 0 ? '伴奏を作る' : '伴奏を作り直す'}
      </button>
      {status && <p className="assistant__hint" role="status">{status}</p>}
      {seed > 0 && (
        <ul className="assistant__reasons">
          {ACCOMPANIMENT_EXPLANATIONS.map(({ part, text }) => (
            <li key={part}><strong>{part}</strong> {simplifyExplanation(text, difficulty)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BassAssistant() {
  const project = useStore((s) => s.project);
  const [mode, setMode] = useState<BassMode>('rootOnly');
  const [reasons, setReasons] = useState<GeneratedNote[]>([]);
  const [failure, setFailure] = useState<ClipGenerationFailure | null>(null);

  const clip = firstMidiClipOfTrack(project, 'Bass');

  const onGenerate = () => {
    if (!clip) return;
    setFailure(null);
    setReasons(generateBassIntoClip(clip.id, mode, setFailure));
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
          {failure ? (
            <p className="assistant__hint" role="status">
              {GENERATION_NOTICE[failure]}
            </p>
          ) : null}
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
  const [failure, setFailure] = useState<ClipGenerationFailure | null>(null);

  const clip = firstMidiClipOfTrack(project, 'Melody');

  const onGenerate = () => {
    if (!clip) return;
    // Seed = note count + project length so repeat clicks vary deterministically.
    const nextSeed = seed + project.lengthBars;
    setFailure(null);
    const generated = generateMelodyIntoClip(clip.id, nextSeed, setFailure);
    if (generated.length === 0) return;
    setSeed(nextSeed);
    setAnalysis(null);
  };

  const onReview = () => {
    if (!clip) return;
    const current = useStore.getState().project;
    const liveClip = current.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id);
    // リンクのクリップは参照先の音符を自分の位置で鳴らす。ノートはクリップ相対なので、
    // このクリップの開始拍を足してコードトラックと同じ絶対拍に直して解析する
    const owner = resolveEditTarget(current, clip.id);
    const clipStart = liveClip?.startBeat ?? 0;
    const notes = (owner?.notes ?? []).map((n) => ({
      pitch: n.pitch,
      startBeat: clipStart + n.startBeat,
      durationBeats: n.durationBeats,
    }));
    setFailure(null);
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
          {failure ? (
            <p className="assistant__hint" role="status">
              {GENERATION_NOTICE[failure]}
            </p>
          ) : null}

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
