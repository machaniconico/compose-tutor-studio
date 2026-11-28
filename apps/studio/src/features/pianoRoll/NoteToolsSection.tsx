import { useState } from 'react';
import { useStore } from '../../state/store';
import {
  joinSelectedNotes,
  legatoSelectedNotes,
  rampSelectedVelocity,
  splitSelectedNotesAtPlayhead,
  staccatoSelectedNotes,
} from '../../state/noteToolActions';
import type { NoteEditResult } from '../../state/noteEditActions';

type Props = {
  clipId: string;
  noteIds: readonly string[];
  onAnnounce: (message: string) => void;
};

/** 音の長さ・つなぎ・分割・強さの変化。「ゆらぎ…」のポップオーバー内に置く(ツールバーに幅がないため)。 */
export function NoteToolsSection({ clipId, noteIds, onAnnounce }: Props) {
  const [from, setFrom] = useState(40);
  const [to, setTo] = useState(110);
  const recording = useStore((state) => state.audioRecordingOperationId !== null || state.midiRecordingActive);
  const idle = recording || noteIds.length === 0;
  const show = (result: NoteEditResult): void => onAnnounce(result.ok ? result.message : result.reason);

  return (
    <div role="group" aria-label="ノート操作" className="pr__note-tools">
      <div className="pr__note-tools-grid">
        <button type="button" disabled={idle} title="選んだ音を、次の音の始まりまでのばします" onClick={() => show(legatoSelectedNotes(clipId, noteIds))}>
          なめらかにつなぐ
        </button>
        <button type="button" disabled={idle} title="選んだ音の長さを半分にして、歯切れよくします" onClick={() => show(staccatoSelectedNotes(clipId, noteIds))}>
          短く切る
        </button>
        <button type="button" disabled={idle} title="同じ高さで隣り合う音を 1 つにします" onClick={() => show(joinSelectedNotes(clipId, noteIds))}>
          1 つにつなげる
        </button>
        <button type="button" disabled={idle} title="再生ヘッドの位置で、選んだ音を 2 つに分けます" onClick={() => show(splitSelectedNotesAtPlayhead(clipId, noteIds))}>
          再生位置で分ける
        </button>
      </div>
      <div className="pr__note-tools-ramp">
        <label className="pr__field">
          <span>強さ はじめ</span>
          <input
            type="number"
            min={1}
            max={127}
            step={1}
            value={from}
            aria-label="強さの変化のはじめ"
            onChange={(event) => setFrom(event.currentTarget.valueAsNumber)}
          />
        </label>
        <label className="pr__field">
          <span>おわり</span>
          <input
            type="number"
            min={1}
            max={127}
            step={1}
            value={to}
            aria-label="強さの変化のおわり"
            onChange={(event) => setTo(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button type="button" disabled={idle} title="最初の音から最後の音へ、強さを少しずつ変えます" onClick={() => show(rampSelectedVelocity(clipId, noteIds, from, to))}>
          強さを少しずつ変える
        </button>
      </div>
    </div>
  );
}
