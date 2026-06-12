import { useMemo, useState } from 'react';
import type { ChordEvent, Project } from '@cts/project-model';
import { parseChord, realizeProgression, suggestNextChords } from '@cts/theory-engine';
import { buildChordEvent, projectBeatsPerBar, updateChordSymbol } from '../../state/editorActions';
import { useStore } from '../../state/store';
import {
  borrowedPalette,
  diatonicPalette,
  dominantPalette,
  progressionPalette,
  type PaletteTab,
} from './paletteData';

const TABS: { id: PaletteTab; label: string }[] = [
  { id: 'diatonic', label: 'Diatonic' },
  { id: 'progressions', label: 'Progressions' },
  { id: 'borrowed', label: 'Borrowed' },
  { id: 'dominant', label: 'Dominant' },
];

/** Live parse feedback for the free-text input. */
function parseFeedback(symbol: string, key: string): { ok: boolean; text: string } {
  const trimmed = symbol.trim();
  if (trimmed === '') return { ok: false, text: 'コード名を入力してください（例: C, Am, Fmaj7）。' };
  try {
    const parsed = parseChord(trimmed, key);
    const notes = parsed.notes.join(' ');
    const bassText = trimmed.includes('/') ? ` / ベース音: ${parsed.bass}` : '';
    return { ok: true, text: `${parsed.root} ${parsed.quality}${bassText} / 構成音: ${notes}` };
  } catch {
    return { ok: false, text: 'このコード名は読み取れませんでした。綴りを確認してください。' };
  }
}

/**
 * Inline chord edit popover. Free-text input with live parse feedback, a
 * diatonic palette (I ii iii IV V vi vii°), a suggestion list with Japanese
 * reasons, and a delete button.
 */
export function ChordPopover(props: {
  project: Project;
  chord: ChordEvent;
  onClose: () => void;
}) {
  const { project, chord, onClose } = props;
  const removeChord = useStore((s) => s.removeChord);
  const applyProjectChange = useStore((s) => s.applyProjectChange);
  const [text, setText] = useState(chord.symbol);
  const [activeTab, setActiveTab] = useState<PaletteTab>('diatonic');

  const feedback = useMemo(() => parseFeedback(text, project.key), [text, project.key]);

  const suggestions = useMemo(() => {
    const sorted = [...project.chordTrack].sort((a, b) => a.startBeat - b.startBeat);
    const before = sorted.filter((c) => c.startBeat < chord.startBeat).map((c) => c.symbol);
    try {
      return suggestNextChords({
        key: project.key,
        scale: project.scale,
        currentProgression: before,
      });
    } catch {
      return [];
    }
  }, [project.key, project.scale, project.chordTrack, chord.startBeat]);

  const nextChord = useMemo(() => {
    return [...project.chordTrack]
      .filter((c) => c.id !== chord.id && c.startBeat > chord.startBeat)
      .sort((a, b) => a.startBeat - b.startBeat)[0];
  }, [project.chordTrack, chord.id, chord.startBeat]);

  const diatonic = useMemo(() => {
    try {
      return diatonicPalette(project.key, project.scale);
    } catch {
      return [];
    }
  }, [project.key, project.scale]);

  const progressions = useMemo(() => {
    try {
      return progressionPalette(project.key, project.scale);
    } catch {
      return [];
    }
  }, [project.key, project.scale]);

  const borrowed = useMemo(() => {
    try {
      return borrowedPalette(project.key, project.scale);
    } catch {
      return [];
    }
  }, [project.key, project.scale]);

  const dominant = useMemo(() => {
    try {
      return dominantPalette(project.key, project.scale, nextChord?.symbol);
    } catch {
      return [];
    }
  }, [project.key, project.scale, nextChord?.symbol]);

  const commit = (symbol: string) => {
    if (symbol.trim() === '') return;
    updateChordSymbol(chord.id, symbol.trim());
    onClose();
  };

  const commitProgression = (templateId: string) => {
    try {
      applyProjectChange((currentProject) => {
        const symbols = realizeProgression(templateId, currentProject.key, currentProject.scale);
        if (symbols.length === 0) return currentProject;

        const anchor = currentProject.chordTrack.find((c) => c.id === chord.id) ?? chord;
        const beatsPerBar = projectBeatsPerBar(currentProject);
        const existingByStart = new Map(currentProject.chordTrack.map((c) => [c.startBeat, c]));
        const inserted = symbols.map((symbol, index) => {
          const startBeat = anchor.startBeat + index * beatsPerBar;
          return buildChordEvent(
            currentProject,
            symbol,
            startBeat,
            beatsPerBar,
            existingByStart.get(startBeat)?.id,
          );
        });
        const insertedStarts = new Set(inserted.map((c) => c.startBeat));

        return {
          ...currentProject,
          chordTrack: [
            ...currentProject.chordTrack.filter((c) => !insertedStarts.has(c.startBeat)),
            ...inserted,
          ].sort((a, b) => a.startBeat - b.startBeat),
        };
      });
      onClose();
    } catch {
      // Invalid templates are ignored; palette entries are generated from known templates.
    }
  };

  const chordCandidates =
    activeTab === 'diatonic' ? diatonic : activeTab === 'borrowed' ? borrowed : dominant;

  return (
    <div className="chord-pop" role="dialog" aria-label="コード編集">
      <div className="chord-pop__head">
        <strong>コードを編集</strong>
        <button type="button" className="chord-pop__close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>

      <form
        className="chord-pop__form"
        onSubmit={(e) => {
          e.preventDefault();
          commit(text);
        }}
      >
        <input
          className="chord-pop__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="コード名"
          autoFocus
          placeholder="例: C, Am, Fmaj7, G7, C/E"
        />
        <button type="submit" className="is-active" disabled={!feedback.ok}>
          適用
        </button>
      </form>
      <p className={`chord-pop__feedback${feedback.ok ? ' is-ok' : ' is-warn'}`}>{feedback.text}</p>

      <div className="chord-pop__section">
        <p className="chord-pop__label">コードパレット</p>
        <div className="chord-pop__palette">
          {TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`chord-pop__chip${activeTab === tab.id ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
            >
              <span className="chord-pop__chip-sym">{tab.label}</span>
            </button>
          ))}
        </div>

        {activeTab === 'progressions' ? (
          <ul className="chord-pop__suggestions">
            {progressions.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => commitProgression(p.id)}>
                  {p.name}
                </button>
                <span className="chord-pop__reason">
                  {p.symbols.join(' - ')} / {p.reason}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="chord-pop__suggestions">
            {chordCandidates.map((candidate) => (
              <li key={`${activeTab}-${candidate.degree}-${candidate.symbol}`}>
                <button type="button" onClick={() => commit(candidate.symbol)}>
                  {candidate.symbol}
                </button>
                <span className="chord-pop__reason">
                  {candidate.degree} / {candidate.reason}
                </span>
              </li>
            ))}
          </ul>
        )}

        {activeTab === 'dominant' && nextChord ? (
          <p className="chord-pop__feedback is-ok">次のコード {nextChord.symbol} へ向かう候補です。</p>
        ) : null}
      </div>

      {suggestions.length > 0 ? (
        <div className="chord-pop__section">
          <p className="chord-pop__label">次に進みやすいコード</p>
          <ul className="chord-pop__suggestions">
            {suggestions.map((s, i) => (
              <li key={`${s.symbol}-${i}`}>
                <button type="button" onClick={() => commit(s.symbol)}>
                  {s.symbol}
                </button>
                <span className="chord-pop__reason">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="chord-pop__foot">
        <button
          type="button"
          className="chord-pop__delete"
          onClick={() => {
            removeChord(chord.id);
            onClose();
          }}
        >
          このコードを削除
        </button>
      </div>
    </div>
  );
}
