import { useMemo, useState } from 'react';
import type { NoteEvent } from '@cts/project-model';
import {
  analyzeChord,
  analyzeNoteAgainstChordAndScale,
  midiToNoteName,
  suggestNextChords,
  type HarmonicFunction,
} from '@cts/theory-engine';
import { useStore } from '../../state/store';
import { appendChordAfterLast } from '../../state/editorActions';
import { useScaleInfo } from '../pianoRoll/useScaleInfo';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { TutorialPanel } from '../tutorial/TutorialPanel';

const FUNCTION_LABEL: Record<HarmonicFunction, string> = {
  T: 'トニック（安定）',
  SD: 'サブドミナント（展開）',
  D: 'ドミナント（緊張）',
  Other: 'その他',
};

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

/** The inspector content itself: selected chord, selected note, or a hint. */
function InspectorContent() {
  const project = useStore((s) => s.project);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);
  const selectedNoteIds = useStore((s) => s.editor.selectedNoteIds);

  const chord = project.chordTrack.find((c) => c.id === selectedChordId) ?? null;
  const note = useSelectedNote(selectedNoteIds);

  if (chord) return <ChordInspector key={chord.id} />;
  if (note) return <NoteInspector note={note.note} startBeat={note.startBeat} />;
  return (
    <div className="panel-section">
      <p className="panel-section__title">操作ヒント</p>
      <ul className="inspector-hints">
        <li>上のコードトラックでコードを選ぶと、構成音や機能の解説が出ます。</li>
        <li>空いている小節をクリックするとコードを追加できます。</li>
        <li>ピアノロールでノートをクリックすると、その音の役割を説明します。</li>
        <li>「アシスタント」タブからベースやメロディを自動生成できます。</li>
      </ul>
    </div>
  );
}

/** Resolve the (single) selected note from the selected clip. */
function useSelectedNote(
  selectedNoteIds: readonly string[],
): { note: NoteEvent; startBeat: number } | null {
  const project = useStore((s) => s.project);
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  return useMemo(() => {
    if (selectedNoteIds.length === 0) return null;
    const id = selectedNoteIds[selectedNoteIds.length - 1];
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      const found = clip?.notes?.find((n) => n.id === id);
      if (found) return { note: found, startBeat: found.startBeat };
    }
    return null;
  }, [project.tracks, selectedClipId, selectedNoteIds]);
}

/** Full chord analysis display with "next chord" buttons. */
function ChordInspector() {
  const project = useStore((s) => s.project);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);
  const chord = project.chordTrack.find((c) => c.id === selectedChordId);

  const analysis = useMemo(() => {
    if (!chord) return null;
    try {
      return analyzeChord({ symbol: chord.symbol, key: project.key, scale: project.scale });
    } catch {
      return null;
    }
  }, [chord, project.key, project.scale]);

  const nextChords = useMemo(() => {
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
  }, [chord, project.chordTrack, project.key, project.scale]);

  if (!chord) return null;
  const fnLabel = analysis?.function ? FUNCTION_LABEL[analysis.function] : '—';
  const notes = analysis?.notes?.length ? analysis.notes.join(' ') : '—';

  return (
    <div className="panel-section">
      <p className="panel-section__title">コード解析</p>
      <div className="chord-headline">{chord.symbol}</div>
      <div className="kv">
        <span>構成音</span>
        <span>{notes}</span>
      </div>
      <div className="kv">
        <span>度数</span>
        <span>{analysis?.degree ?? chord.degree ?? '—'}</span>
      </div>
      <div className="kv">
        <span>機能</span>
        <span>{fnLabel}</span>
      </div>
      {analysis?.explanation ? (
        <p className="inspector-explain">{analysis.explanation}</p>
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

/** Selected-note inspector: pitch name, scale membership, classification. */
function NoteInspector(props: { note: NoteEvent; startBeat: number }) {
  const { note } = props;
  const project = useStore((s) => s.project);
  const scaleInfo = useScaleInfo(project);

  const pc = ((note.pitch % 12) + 12) % 12;
  const inScale = scaleInfo.scalePcs.has(pc);
  const chord = scaleInfo.chordAtBeat(note.startBeat);

  const classification = useMemo(() => {
    if (!chord) {
      return inScale
        ? 'この音はスケール内の音です。安定して使えます。'
        : 'この音はスケール外の音です。経過音やテンションとして使えます。';
    }
    try {
      const result = analyzeNoteAgainstChordAndScale(
        note.pitch,
        chord.symbol,
        project.key,
        project.scale,
      );
      return result.message;
    } catch {
      return '';
    }
  }, [chord, inScale, note.pitch, project.key, project.scale]);

  return (
    <div className="panel-section">
      <p className="panel-section__title">ノート情報</p>
      <div className="chord-headline">{midiToNoteName(note.pitch)}</div>
      <div className="kv">
        <span>スケール</span>
        <span>{inScale ? '内（自然な音）' : '外（色付けの音）'}</span>
      </div>
      <div className="kv">
        <span>強さ</span>
        <span>{note.velocity}</span>
      </div>
      {chord ? (
        <div className="kv">
          <span>現在のコード</span>
          <span>{chord.symbol}</span>
        </div>
      ) : null}
      {classification ? <p className="inspector-explain">{classification}</p> : null}
    </div>
  );
}
