import { useMemo, useState } from 'react';
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
import {
  analyzeProjectForCoaching,
  coachCategoryLabel,
  melodyNotesOnProjectTimeline,
  type CoachSeverity,
} from '../../state/coach';

const BASS_MODES: { value: BassMode; label: string; hint: string }[] = [
  { value: 'rootOnly', label: 'ルートのみ', hint: '各コードのルート音を拍頭に置きます。最もシンプルです。' },
  { value: 'rootFifth', label: 'ルート+5度', hint: 'ルートと5度を組み合わせ、厚みを出します。' },
  { value: 'walkingSimple', label: 'シンプルウォーキング', hint: '次のコードへ滑らかにつなぐ経過音を加えます。' },
  { value: 'octavePulse', label: 'オクターブ', hint: 'ルートとオクターブ上を交互に刻み、躍動感を出します。' },
];

/** Bass + Melody assistant, plus the local (network-free) composition coach. */
export function AssistantPanel() {
  return (
    <div className="assistant">
      <CoachPanel />
      <BassAssistant />
      <MelodyAssistant />
    </div>
  );
}

const COACH_ICON: Record<CoachSeverity, string> = {
  good: '◎',
  tip: '💡',
  warn: '⚠',
};

/**
 * ローカル完結の作曲コーチ。現在のプロジェクトを解析して説明付きの日本語提案を出す。
 * 外部ネットワークは使わず、store の project が変わるたびに再計算する。
 */
function CoachPanel() {
  const project = useStore((s) => s.project);
  // project 参照が変わったときだけ再解析(純粋関数なのでメモ化して無駄な再計算を避ける)。
  const suggestions = useMemo(() => analyzeProjectForCoaching(project), [project]);

  return (
    <section className="panel-section">
      <p className="panel-section__title">作曲コーチ</p>
      <p className="assistant__hint">
        いまの曲を見て、次の一手を提案します(この解析はすべて端末内で完結します)。
      </p>
      {suggestions.length > 0 ? (
        <ul className="assistant__coach">
          {suggestions.map((s) => (
            <li key={s.id} className={`assistant__coach-item is-${s.severity}`}>
              <span className="assistant__coach-icon" aria-hidden="true">
                {COACH_ICON[s.severity]}
              </span>
              <div className="assistant__coach-body">
                <p className="assistant__coach-title">
                  <span className="assistant__coach-cat">{coachCategoryLabel(s.category)}</span>
                  {s.title}
                </p>
                <p className="assistant__coach-detail">{s.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-hint">いまのところ大きな改善点はありません。良い調子です。</p>
      )}
    </section>
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
    if (generated === null) return;
    setReasons(generated);
  };

  return (
    <section className="panel-section">
      <p className="panel-section__title">ベース生成</p>
      {clip ? (
        <>
          <div className="assistant__modes" role="group" aria-label="ベース生成モード">
            {BASS_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`assistant__mode${mode === m.value ? ' is-active' : ''}`}
                aria-pressed={mode === m.value}
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
    const generated = generateMelodyIntoClip(clip.id, nextSeed);
    if (generated === null) return;
    setSeed(nextSeed);
    setAnalysis(null);
  };

  const onReview = () => {
    if (!clip) return;
    const current = useStore.getState().project;
    const melodyTrack = current.tracks.find(
      (track) => track.name.toLowerCase() === 'melody',
    );
    const notes = melodyNotesOnProjectTimeline(current, melodyTrack);
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
