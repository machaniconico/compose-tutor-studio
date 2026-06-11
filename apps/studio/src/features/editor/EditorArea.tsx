import { useStore } from '../../state/store';
import type { EditorView } from '../../state/store';
import { PianoRoll } from '../pianoRoll/PianoRoll';
import { DrumGrid } from '../drums/DrumGrid';
import { Arranger } from '../arranger/Arranger';

const TABS: { view: EditorView; label: string }[] = [
  { view: 'pianoRoll', label: 'ピアノロール' },
  { view: 'drums', label: 'ドラム' },
  { view: 'arranger', label: 'アレンジ' },
];

/** Tabbed editor host switching between the three editors. */
export function EditorArea() {
  const activeView = useStore((s) => s.editor.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const scaleSnap = useStore((s) => s.editor.scaleSnap);
  const chordToneHighlight = useStore((s) => s.editor.chordToneHighlight);
  const toggleScaleSnap = useStore((s) => s.toggleScaleSnap);
  const toggleChordToneHighlight = useStore((s) => s.toggleChordToneHighlight);

  return (
    <div className="editor-area">
      <div className="editor-tabs" role="tablist" aria-label="エディタ切替">
        {TABS.map(({ view, label }) => (
          <button
            type="button"
            key={view}
            role="tab"
            aria-selected={activeView === view}
            className={activeView === view ? 'is-active' : ''}
            onClick={() => setActiveView(view)}
          >
            {label}
          </button>
        ))}

        {activeView === 'pianoRoll' ? (
          <>
            <button
              type="button"
              className={scaleSnap ? 'is-active' : ''}
              aria-pressed={scaleSnap}
              onClick={() => toggleScaleSnap()}
              style={{ marginLeft: 'auto' }}
            >
              スケール表示
            </button>
            <button
              type="button"
              className={chordToneHighlight ? 'is-active' : ''}
              aria-pressed={chordToneHighlight}
              onClick={() => toggleChordToneHighlight()}
            >
              コードトーン
            </button>
          </>
        ) : null}
      </div>

      <div className="editor-body" role="tabpanel">
        {activeView === 'pianoRoll' ? <PianoRoll /> : null}
        {activeView === 'drums' ? <DrumGrid /> : null}
        {activeView === 'arranger' ? <Arranger /> : null}
      </div>
    </div>
  );
}
