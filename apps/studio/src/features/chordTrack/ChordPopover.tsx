import { useMemo, useState } from 'react';
import type { ChordEvent, Project } from '@cts/project-model';
import {
  getDiatonicChords,
  parseChord,
  suggestNextChords,
} from '@cts/theory-engine';
import { updateChordSymbol } from '../../state/editorActions';
import { useStore } from '../../state/store';

/** Live parse feedback for the free-text input. */
function parseFeedback(symbol: string, key: string): { ok: boolean; text: string } {
  const trimmed = symbol.trim();
  if (trimmed === '') return { ok: false, text: 'コード名を入力してください（例: C, Am, Fmaj7）。' };
  try {
    const parsed = parseChord(trimmed, key);
    const notes = parsed.notes.join(' ');
    return { ok: true, text: `${parsed.root} ${parsed.quality} / 構成音: ${notes}` };
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
  const [text, setText] = useState(chord.symbol);

  const feedback = useMemo(() => parseFeedback(text, project.key), [text, project.key]);

  const diatonic = useMemo(() => {
    try {
      return getDiatonicChords(project.key, project.scale);
    } catch {
      return [];
    }
  }, [project.key, project.scale]);

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

  const commit = (symbol: string) => {
    if (symbol.trim() === '') return;
    updateChordSymbol(chord.id, symbol.trim());
    onClose();
  };

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
          placeholder="例: C, Am, Fmaj7, G7"
        />
        <button type="submit" className="is-active" disabled={!feedback.ok}>
          適用
        </button>
      </form>
      <p className={`chord-pop__feedback${feedback.ok ? ' is-ok' : ' is-warn'}`}>{feedback.text}</p>

      <div className="chord-pop__section">
        <p className="chord-pop__label">ダイアトニック</p>
        <div className="chord-pop__palette">
          {diatonic.map((d) => (
            <button
              type="button"
              key={d.degree}
              className="chord-pop__chip"
              onClick={() => commit(d.symbol)}
              title={`${d.degree} / ${d.symbol}`}
            >
              <span className="chord-pop__chip-roman">{d.degree}</span>
              <span className="chord-pop__chip-sym">{d.symbol}</span>
            </button>
          ))}
        </div>
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
