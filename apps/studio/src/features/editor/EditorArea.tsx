import { useStore } from '../../state/store';
import type { EditorView } from '../../state/store';
import { PianoRoll } from '../pianoRoll/PianoRoll';
import { DrumGrid } from '../drums/DrumGrid';
import { Arranger } from '../arranger/Arranger';
import { AutomationLaneEditor } from '../automation/AutomationLaneEditor';
import { TempoMapEditor } from '../tempoMap/TempoMapEditor';
import { TakeCompEditor } from '../comping/TakeCompEditor';
import { handleTabKeyDown } from '../common/tabs';

function isUnmodifiedCharacterKey(event: React.KeyboardEvent, key: string): boolean {
  return (
    !event.repeat &&
    event.key.toLowerCase() === key &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

const TABS: { view: EditorView; label: string }[] = [
  { view: 'pianoRoll', label: 'ピアノロール' },
  { view: 'drums', label: 'ドラム' },
  { view: 'arranger', label: 'アレンジ' },
  { view: 'automation', label: 'オートメーション' },
  { view: 'tempoMap', label: 'テンポ / 拍子' },
  { view: 'comping', label: 'テイク編集' },
];

const TAB_ORDER = TABS.map(({ view }) => view);
const editorTabId = (view: EditorView): string => `editor-tab-${view}`;
const editorTabPanelId = (view: EditorView): string =>
  `editor-tabpanel-${view}`;

/** Tabbed editor host switching between the six editors. */
export function EditorArea() {
  const activeView = useStore((s) => s.editor.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const scaleSnap = useStore((s) => s.editor.scaleSnap);
  const chordToneHighlight = useStore((s) => s.editor.chordToneHighlight);
  const toggleScaleSnap = useStore((s) => s.toggleScaleSnap);
  const toggleChordToneHighlight = useStore((s) => s.toggleChordToneHighlight);

  return (
    <div className="editor-area">
      <div className="editor-toolbar">
        <div className="editor-tabs" role="tablist" aria-label="エディタ切替">
          {TABS.map(({ view, label }) => (
            <button
              type="button"
              key={view}
              role="tab"
              id={editorTabId(view)}
              aria-controls={editorTabPanelId(view)}
              aria-selected={activeView === view}
              tabIndex={activeView === view ? 0 : -1}
              className={activeView === view ? 'is-active' : ''}
              onClick={() => setActiveView(view)}
              onKeyDown={(event) =>
                handleTabKeyDown(
                  event,
                  TAB_ORDER,
                  view,
                  setActiveView,
                  editorTabId,
                )
              }
            >
              {label}
            </button>
          ))}
        </div>

        {activeView === 'pianoRoll' ? (
          <div className="editor-options" role="group" aria-label="ピアノロール表示設定">
            <button
              type="button"
              className={scaleSnap ? 'is-active' : ''}
              aria-label="スケールスナップ"
              aria-pressed={scaleSnap}
              aria-keyshortcuts="S"
              aria-describedby="scale-snap-status"
              onClick={() => toggleScaleSnap()}
              onKeyDown={(event) => {
                if (isUnmodifiedCharacterKey(event, 's')) {
                  event.preventDefault();
                  toggleScaleSnap();
                }
              }}
            >
              スケールスナップ{' '}
              <span className="badge" aria-hidden="true">
                {scaleSnap ? 'オン' : 'オフ'}
              </span>
            </button>
            <span
              id="scale-snap-status"
              className="visually-hidden"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {scaleSnap
                ? 'スケールスナップはオンです。追加（複製を含む）または移動した音を現在のスケール内へ補正します。'
                : 'スケールスナップはオフです。音の高さを補正せずに入力します。'}
            </span>
            <button
              type="button"
              className={chordToneHighlight ? 'is-active' : ''}
              aria-label="コードトーン"
              aria-pressed={chordToneHighlight}
              aria-keyshortcuts="C"
              onClick={() => toggleChordToneHighlight()}
              onKeyDown={(event) => {
                if (isUnmodifiedCharacterKey(event, 'c')) {
                  event.preventDefault();
                  toggleChordToneHighlight();
                }
              }}
            >
              コードトーン{' '}
              <span className="badge" aria-hidden="true">
                {chordToneHighlight ? 'オン' : 'オフ'}
              </span>
            </button>
          </div>
        ) : null}
      </div>

      {TABS.map(({ view }) => {
        const active = activeView === view;
        return (
          <div
            key={view}
            className="editor-body"
            id={editorTabPanelId(view)}
            role="tabpanel"
            aria-labelledby={editorTabId(view)}
            hidden={!active}
            tabIndex={active ? 0 : -1}
          >
            {active && view === 'pianoRoll' ? <PianoRoll /> : null}
            {active && view === 'drums' ? <DrumGrid /> : null}
            {active && view === 'arranger' ? <Arranger /> : null}
            {active && view === 'automation' ? <AutomationLaneEditor /> : null}
            {active && view === 'tempoMap' ? <TempoMapEditor /> : null}
            {active && view === 'comping' ? <TakeCompEditor /> : null}
          </div>
        );
      })}
    </div>
  );
}
