import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { beatsPerBar, type ChordEvent, type Project } from '@cts/project-model';
import {
  analyzeChord,
  getDiatonicChords,
  parseChord,
  qualityLabel,
  suggestNextChords,
  type ChordSuggestion,
  type ChordSuggestionTag,
} from '@cts/theory-engine';
import { updateChordSymbol } from '../../state/editorActions';
import { useStore } from '../../state/store';

const SUGGESTION_GROUPS: {
  tag: ChordSuggestionTag;
  label: string;
  tone: string;
  background: string;
}[] = [
  {
    tag: 'diatonic',
    label: 'ダイアトニック',
    tone: 'var(--accent)',
    background: 'rgba(105, 220, 190, 0.12)',
  },
  {
    tag: 'borrowed',
    label: '借用和音',
    tone: '#d7a7ff',
    background: 'rgba(215, 167, 255, 0.14)',
  },
  {
    tag: 'secondaryDominant',
    label: 'セカンダリドミナント',
    tone: '#ffbc7a',
    background: 'rgba(255, 188, 122, 0.14)',
  },
];

const FUNCTION_TEXT = {
  T: '安定するトニック',
  SD: '展開を準備するサブドミナント',
  D: '次へ進ませるドミナント',
  Other: '色付けの和音',
} as const;

/** Live parse feedback for the free-text input. */
function parseFeedback(symbol: string, key: string): { ok: boolean; text: string } {
  const trimmed = symbol.trim();
  if (trimmed === '') return { ok: false, text: 'コード名を入力してください（例: C, Am, Fmaj7）。' };
  try {
    const parsed = parseChord(trimmed, key);
    const notes = parsed.notes.join(' ');
    return { ok: true, text: `${parsed.root} ${qualityLabel(parsed.quality)} / 構成音: ${notes}` };
  } catch {
    return { ok: false, text: 'このコード名は読み取れませんでした。綴りを確認してください。' };
  }
}

export type ChordPopoverCloseReason = 'dismiss' | 'outside' | 'commit' | 'delete';

function suggestionTag(suggestion: ChordSuggestion): ChordSuggestionTag {
  return suggestion.tag ?? 'diatonic';
}

function beginnerSummary(suggestion: ChordSuggestion): string {
  const tag = suggestionTag(suggestion);
  if (tag === 'borrowed') {
    return '同じ主音の短調から借りて、切なさや影を少し足します。';
  }
  if (tag === 'secondaryDominant') {
    return '次の行き先を一時的に強く照らす、寄り道のドミナントです。';
  }
  return suggestion.reason;
}

function detailLines(suggestion: ChordSuggestion, project: Project): string[] {
  const tag = suggestionTag(suggestion);
  const origin = suggestion.origin ?? (tag === 'diatonic' ? 'キーの中の基本和音' : 'キーの外からの色');

  if (tag === 'diatonic') {
    return [`由来: ${origin}`, `機能: ${suggestion.reason}`];
  }

  try {
    const analysis = analyzeChord({
      symbol: suggestion.symbol,
      key: project.key,
      scale: project.scale,
    });
    const fn = analysis.function ? FUNCTION_TEXT[analysis.function] : '色付けの和音';
    if (tag === 'borrowed') {
      return [
        `由来: ${origin}。同じ主音を持つ短調の色を一時的に借ります。`,
        `機能: ${analysis.degree ? `${analysis.degree}として` : ''}${fn}の役割を持つことがあります。`,
        '響き: 明るい流れの中に、少し切なさ・陰り・映画的な広がりを足します。',
      ];
    }
    return [
      `由来: ${origin}。ダイアトニック和音へ向かうための一時的なV7です。`,
      `機能: ${analysis.secondaryDominantOf ?? '次の和音'}へ進みたい力を作るドミナントです。`,
      '響き: 一瞬だけ緊張が強まり、次のコードに着いたときの納得感が増します。',
    ];
  } catch {
    if (tag === 'borrowed') {
      return [
        `由来: ${origin}。同じ主音を持つ短調の色を一時的に借ります。`,
        '機能: キーの外の音で、進行に新しい表情を足します。',
        '響き: 少し切ない、影のある響きになります。',
      ];
    }
    return [
      `由来: ${origin}。次の和音へ向かうための一時的なドミナントです。`,
      '機能: 行き先へ進みたい力を強めます。',
      '響き: 緊張してから解決する動きがはっきりします。',
    ];
  }
}

/**
 * Inline chord edit popover. Free-text input with live parse feedback, a
 * diatonic palette (I ii iii IV V vi vii°), a suggestion list with Japanese
 * reasons, and a delete button.
 */
export function ChordPopover(props: {
  id: string;
  project: Project;
  chord: ChordEvent;
  triggerElement: HTMLButtonElement | null;
  anchorLeft: number;
  anchorTop: number;
  maxHeight: number;
  onClose: (reason: ChordPopoverCloseReason) => void;
}) {
  const { id, project, chord, triggerElement, anchorLeft, anchorTop, maxHeight, onClose } = props;
  const removeChord = useStore((s) => s.removeChord);
  const updateChord = useStore((s) => s.updateChord);
  const [text, setText] = useState(chord.symbol);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const triggerElementRef = useRef(triggerElement);
  onCloseRef.current = onClose;
  triggerElementRef.current = triggerElement;
  const titleId = useId();
  const feedbackId = useId();
  const bpb = beatsPerBar(project.timeSignature);
  const startBar = Math.floor(chord.startBeat / bpb) + 1;
  const durationBars = Math.max(1, Math.round(chord.durationBeats / bpb));
  const maxDurationBars = Math.max(1, project.lengthBars - startBar + 1);
  const portalRoot = triggerElement?.closest<HTMLElement>('.app-shell') ?? document.body;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.select();

    const contains = (container: Node | null, target: EventTarget | null) =>
      container !== null && target instanceof Node && container.contains(target);

    const closeOutside = (event: PointerEvent | FocusEvent) => {
      const popover = popoverRef.current;
      if (
        contains(popover, event.target) ||
        contains(triggerElementRef.current, event.target)
      ) {
        return;
      }
      onCloseRef.current('outside');
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current('dismiss');
        return;
      }
      // Buttons and <summary> inside the editor own Space. Do not let the
      // transport's global Space shortcut run as a second action.
      if (
        (event.key === ' ' || event.code === 'Space') &&
        contains(popoverRef.current, event.target)
      ) {
        event.stopPropagation();
      }
    };

    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

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

  const groupedSuggestions = useMemo(
    () =>
      SUGGESTION_GROUPS.map((group) => ({
        ...group,
        suggestions: suggestions.filter((s) => suggestionTag(s) === group.tag),
      })).filter((group) => group.suggestions.length > 0),
    [suggestions],
  );

  const commit = (symbol: string) => {
    const nextSymbol = symbol.trim();
    if (!parseFeedback(nextSymbol, project.key).ok) return;
    updateChordSymbol(chord.id, nextSymbol);
    onClose('commit');
  };

  const moveToBar = (nextBar: number) => {
    const boundedBar = Math.min(project.lengthBars, Math.max(1, Math.round(nextBar)));
    const boundedDuration = Math.min(
      durationBars,
      Math.max(1, project.lengthBars - boundedBar + 1),
    );
    updateChord(chord.id, {
      startBeat: (boundedBar - 1) * bpb,
      durationBeats: boundedDuration * bpb,
    });
  };

  const resizeToBars = (nextDuration: number) => {
    const boundedDuration = Math.min(
      maxDurationBars,
      Math.max(1, Math.round(nextDuration)),
    );
    updateChord(chord.id, { durationBeats: boundedDuration * bpb });
  };

  return createPortal(
    <div
      ref={popoverRef}
      id={id}
      className="chord-pop"
      role="dialog"
      aria-modal={false}
      aria-labelledby={titleId}
      data-shortcuts-suspended="true"
      style={{ left: anchorLeft, top: anchorTop, maxHeight }}
    >
      <div className="chord-pop__head">
        <strong id={titleId}>コードを編集: {chord.symbol}</strong>
        <button
          type="button"
          className="chord-pop__close"
          onClick={() => onClose('dismiss')}
          aria-label="コード編集を閉じる"
        >
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
        <label className="chord-pop__field">
          <span>コード名</span>
          <input
            ref={inputRef}
            className="chord-pop__input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={feedbackId}
            aria-invalid={!feedback.ok}
            autoComplete="off"
            spellCheck={false}
            placeholder="例: C, Am, Fmaj7, G7"
          />
        </label>
        <button type="submit" className="is-active" disabled={!feedback.ok}>
          適用
        </button>
      </form>
      <p
        id={feedbackId}
        className={`chord-pop__feedback${feedback.ok ? ' is-ok' : ' is-warn'}`}
        role="status"
        aria-live="polite"
      >
        {feedback.text}
      </p>

      <div className="chord-pop__timing" role="group" aria-label="コードの配置">
        <label>
          <span>開始小節</span>
          <input
            type="number"
            min={1}
            max={project.lengthBars}
            step={1}
            value={startBar}
            onChange={(event) => moveToBar(Number(event.target.value))}
          />
        </label>
        <label>
          <span>長さ（小節）</span>
          <input
            type="number"
            min={1}
            max={maxDurationBars}
            step={1}
            value={durationBars}
            onChange={(event) => resizeToBars(Number(event.target.value))}
          />
        </label>
      </div>

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
          {groupedSuggestions.map((group) => (
            <div key={group.tag} style={{ marginTop: 'var(--sp-1)' }}>
              <p
                className="chord-pop__label"
                style={{ color: group.tone, textTransform: 'none', letterSpacing: 0 }}
              >
                {group.label}
              </p>
              <ul className="chord-pop__suggestions">
                {group.suggestions.map((s, i) => {
                  const lines = detailLines(s, project);
                  const advancedText = lines.join('\n');
                  return (
                    <li
                      key={`${s.symbol}-${group.tag}-${i}`}
                      style={{
                        alignItems: 'flex-start',
                        borderLeft: `3px solid ${group.tone}`,
                        background: group.background,
                        borderRadius: '6px',
                        padding: 'var(--sp-1)',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => commit(s.symbol)}
                        title={advancedText}
                        style={{ borderColor: group.tone }}
                      >
                        {s.symbol}
                      </button>
                      <div className="chord-pop__reason">
                        <span style={{ color: group.tone, fontWeight: 700 }}>
                          {s.origin ?? group.label}
                        </span>
                        <br />
                        {beginnerSummary(s)}
                        {group.tag !== 'diatonic' ? (
                          <details style={{ marginTop: 2 }}>
                            <summary>由来・機能・響き</summary>
                            {lines.map((line) => (
                              <span key={line} style={{ display: 'block' }}>
                                {line}
                              </span>
                            ))}
                          </details>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <div className="chord-pop__foot">
        <button
          type="button"
          className="chord-pop__delete"
          onClick={() => {
            removeChord(chord.id);
            onClose('delete');
          }}
        >
          このコードを削除
        </button>
      </div>
    </div>,
    portalRoot,
  );
}
