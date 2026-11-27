import { useId, useMemo, useState } from 'react';
import { buildClipIndex, resolveClipContent } from '@cts/project-model';
import { useStore } from '../../state/store';
import {
  addDetectedChord,
  initialBarRange,
  suggestChordsForRange,
} from '../../state/chordDetectActions';

/**
 * コードレーンのヘッダーから開く「コードを調べる」ポップオーバー(行を増やさない)。
 * ピアノロールで選んでいるクリップと、選んでいる音を調べる。
 */
export function ChordDetectPopover() {
  const project = useStore((s) => s.project);
  const clipId = useStore((s) => s.editor.selectedClipId);
  const pickedIds = useStore((s) => s.editor.selectedNoteIds);
  // リンクしたクリップは、元のクリップの音を自分の位置で持つものとして扱う。
  const clip = useMemo(() => {
    const own = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
    return own ? resolveClipContent(project, own, buildClipIndex(project)) : null;
  }, [project, clipId]);
  const selectedNoteIds = useMemo(() => {
    const ids = new Set(clip?.type === 'midi' ? (clip.notes ?? []).map((note) => note.id) : []);
    return pickedIds.filter((id) => ids.has(id));
  }, [clip, pickedIds]);
  const [open, setOpen] = useState(false);
  const [startText, setStartText] = useState('1');
  const [endText, setEndText] = useState('1');
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'ng' } | null>(null);
  const recording = useStore((s) => s.audioRecordingOperationId !== null);
  const menuId = useId();

  function toggle() {
    if (!open) {
      const range = initialBarRange(project, clip, selectedNoteIds);
      setStartText(String(range.startBar + 1));
      setEndText(String(range.endBar));
      setMessage(null);
    }
    setOpen(!open);
  }

  // 画面の 1 始まり(開始〜終了、終了を含む)を内部の [開始, 終了) に直す。
  const range = useMemo(() => ({
    startBar: Number(startText) - 1,
    endBar: Number(endText),
  }), [startText, endText]);
  const result = useMemo(
    () => (open ? suggestChordsForRange(project, clip, selectedNoteIds, range) : null),
    [open, project, clip, selectedNoteIds, range],
  );

  return (
    <div className="pr__popover-anchor chord-lane__detect">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={clip?.type !== 'midi'}
        aria-label="コードを調べる…"
        title="選んだ音(または小節の範囲)から、合いそうなコード名を調べます"
        onClick={toggle}
      >
        コード検出
      </button>
      {open ? (
        <div
          id={menuId}
          className="pr__popover pr__popover--right"
          role="group"
          aria-label="コードの候補"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="pr__zoom">
            <label className="pr__field">
              <span>小節</span>
              <input
                type="number"
                min={1}
                max={project.lengthBars}
                value={startText}
                aria-label="調べる範囲の最初の小節"
                onChange={(e) => { setStartText(e.target.value); setMessage(null); }}
              />
            </label>
            <label className="pr__field">
              <span>から</span>
              <input
                type="number"
                min={1}
                max={project.lengthBars}
                value={endText}
                aria-label="調べる範囲の最後の小節"
                onChange={(e) => { setEndText(e.target.value); setMessage(null); }}
              />
              <span>まで</span>
            </label>
          </div>
          <p className="pr__popover-help">
            {selectedNoteIds.length > 0
              ? `選んだ ${selectedNoteIds.length} 個の音だけで調べます。`
              : '範囲の中のすべての音で調べます。'}
            あくまで目安です。
          </p>
          {result && result.suggestions.length > 0 ? (
            <ol className="pr__chord-suggestions">
              {result.suggestions.map((s) => (
                <li key={s.symbol}>
                  <div>
                    <strong>{s.rank === 1 ? 'いちばん近い候補' : 'ほかの可能性'}: {s.symbol}</strong>
                    <button
                      type="button"
                      disabled={recording}
                      aria-label={`${s.symbol} をコードトラックに足す`}
                      title={recording ? '録音中は足せません' : 'この範囲いっぱいのコードとして足します(元に戻せます)'}
                      onClick={() => {
                        const added = addDetectedChord(s.symbol, range);
                        setMessage(added.ok ? { text: added.message, tone: 'ok' } : { text: added.reason, tone: 'ng' });
                      }}
                    >
                      足す
                    </button>
                  </div>
                  <p className="pr__popover-help">{s.reason}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="pr__popover-help">{result?.emptyMessage}</p>
          )}
          {message ? (
            <p className="pr__popover-help" role={message.tone === 'ng' ? 'alert' : 'status'}>{message.text}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
