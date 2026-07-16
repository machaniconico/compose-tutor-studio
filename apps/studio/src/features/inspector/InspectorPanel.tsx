import { useMemo, type Ref } from 'react';
import { resolveClipContent, type NoteEvent } from '@cts/project-model';
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
import {
  DeferredFeature,
  type DeferredFeatureLoader,
} from '../common/DeferredFeature';
import { handleTabKeyDown } from '../common/tabs';
import { TrackInspector } from '../tracklist/TrackInspector';

type EmptyProps = Record<string, never>;

const loadAssistantPanel: DeferredFeatureLoader<EmptyProps> = () =>
  import('../assistant/AssistantPanel').then((module) => ({
    default: module.AssistantPanel,
  }));

const loadTutorialPanel: DeferredFeatureLoader<EmptyProps> = () =>
  import('../tutorial/TutorialPanel').then((module) => ({
    default: module.TutorialPanel,
  }));

function preloadRightTab(tab: RightTab): void {
  if (tab === 'assistant') void loadAssistantPanel().catch(() => undefined);
  if (tab === 'tutorial') void loadTutorialPanel().catch(() => undefined);
}

const FUNCTION_LABEL: Record<HarmonicFunction, string> = {
  T: 'トニック（安定）',
  SD: 'サブドミナント（展開）',
  D: 'ドミナント（緊張）',
  Other: 'その他',
};

export type RightTab = 'inspector' | 'assistant' | 'tutorial';

const TABS: { id: RightTab; label: string }[] = [
  { id: 'inspector', label: 'インスペクター' },
  { id: 'assistant', label: 'アシスタント' },
  { id: 'tutorial', label: 'チュートリアル' },
];

const TAB_ORDER = TABS.map(({ id }) => id);
const rightTabId = (tab: RightTab): string => `right-tab-${tab}`;
const rightTabPanelId = (tab: RightTab): string =>
  `right-tabpanel-${tab}`;

type InspectorPanelProps = {
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  /** Lets the onboarding flow focus the tutorial destination after its dialog closes. */
  tutorialTabRef?: Ref<HTMLButtonElement>;
};

/** Controlled right column tab host: inspector / assistant / tutorial. */
export function InspectorPanel({
  activeTab,
  onTabChange,
  tutorialTabRef,
}: InspectorPanelProps) {
  return (
    <aside className="inspector-panel" aria-label="インスペクタ">
      <div
        className="right-tabs"
        role="tablist"
        aria-label="右パネル切替"
        onFocusCapture={() => {
          preloadRightTab('assistant');
          preloadRightTab('tutorial');
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={rightTabId(t.id)}
            aria-controls={rightTabPanelId(t.id)}
            aria-selected={activeTab === t.id}
            tabIndex={activeTab === t.id ? 0 : -1}
            className={activeTab === t.id ? 'is-active' : ''}
            ref={t.id === 'tutorial' ? tutorialTabRef : undefined}
            onClick={() => onTabChange(t.id)}
            onKeyDown={(event) =>
              handleTabKeyDown(
                event,
                TAB_ORDER,
                t.id,
                onTabChange,
                rightTabId,
              )
            }
            onFocus={() => preloadRightTab(t.id)}
            onPointerEnter={() => preloadRightTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {TABS.map(({ id }) => {
        const active = activeTab === id;
        return (
          <div
            key={id}
            className="right-tabs__body"
            id={rightTabPanelId(id)}
            role="tabpanel"
            aria-labelledby={rightTabId(id)}
            hidden={!active}
            tabIndex={active ? 0 : -1}
          >
            {active && id === 'inspector' ? <InspectorContent /> : null}
            {active && id === 'assistant' ? (
              <DeferredFeature
                load={loadAssistantPanel}
                componentProps={{}}
                loadingLabel="アシスタントを読み込んでいます…"
                errorLabel="アシスタントを読み込めませんでした。アプリを再読み込んでください。"
              />
            ) : null}
            {active && id === 'tutorial' ? (
              <DeferredFeature
                load={loadTutorialPanel}
                componentProps={{}}
                loadingLabel="チュートリアルを読み込んでいます…"
                errorLabel="チュートリアルを読み込めませんでした。アプリを再読み込んでください。"
              />
            ) : null}
          </div>
        );
      })}
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

  return (
    <>
      <TrackInspector />
      {chord ? <ChordInspector key={chord.id} /> : null}
      {!chord && note ? <NoteInspector note={note.note} startBeat={note.startBeat} /> : null}
      {!chord && !note ? (
        <div className="panel-section">
          <p className="panel-section__title">操作ヒント</p>
          <ul className="inspector-hints">
            <li>上のコードトラックでコードを選ぶと、構成音や機能の解説が出ます。</li>
            <li>空いている小節をクリックするとコードを追加できます。</li>
            <li>ピアノロールでノートをクリックすると、その音の役割を説明します。</li>
            <li>「アシスタント」タブからベースやメロディを自動生成できます。</li>
          </ul>
        </div>
      ) : null}
    </>
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
      const instance = track.clips.find((c) => c.id === selectedClipId);
      const clip = instance ? resolveClipContent(project, instance) : null;
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
