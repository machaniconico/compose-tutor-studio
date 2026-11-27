import { useState, type FormEvent } from 'react';
import { MAX_PROJECT_LENGTH_BARS } from '@cts/project-model';
import {
  setStudioSongLengthBars,
  studioSongLengthErrorMessage,
  studioSongLengthStatusMessage,
  type StudioSongLengthResult,
} from '../../state/songLengthActions';
import { useStore } from '../../state/store';

type Notice = Readonly<{ kind: 'error' | 'status'; message: string }>;

export function SongLengthPanel() {
  const lengthBars = useStore((state) => state.project.lengthBars);
  const lengthBeats = useStore((state) => state.project.lengthBeats);
  const locked = useStore(
    (state) => state.projectOperationBusy || state.audioRecordingOperationId !== null,
  );
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const report = (result: StudioSongLengthResult): void => {
    if (!result.ok) {
      setNotice({
        kind: 'error',
        message: studioSongLengthErrorMessage(
          result.code,
          result.blockers,
          MAX_PROJECT_LENGTH_BARS,
        ),
      });
      return;
    }
    setNotice({ kind: 'status', message: studioSongLengthStatusMessage(result) });
  };

  const change = (bars: number): void => {
    report(setStudioSongLengthBars(bars));
    setDraft('');
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = draft.trim();
    change(trimmed === '' ? Number.NaN : Number(trimmed));
  };

  return (
    <section className="song-length-panel" aria-labelledby="song-length-title">
      <h3 id="song-length-title">曲の長さ</h3>
      <p>
        いまの長さ: <strong>{lengthBars}小節</strong>（{lengthBeats}拍）。小節の数は、曲の最後に足したり減らしたりして変えられます。
      </p>
      <div role="group" aria-label="曲の長さを変更">
        <button
          type="button"
          disabled={locked || lengthBars >= MAX_PROJECT_LENGTH_BARS}
          onClick={() => change(lengthBars + 1)}
        >
          末尾に1小節追加
        </button>
        <button
          type="button"
          disabled={locked || lengthBars <= 1}
          onClick={() => change(lengthBars - 1)}
        >
          末尾の1小節を削除
        </button>
        <form onSubmit={submit}>
          <label>
            小節数を指定
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_PROJECT_LENGTH_BARS}
              step={1}
              value={draft}
              placeholder={String(lengthBars)}
              disabled={locked}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button type="submit" disabled={locked}>変更</button>
        </form>
      </div>
      {locked ? (
        <p role="status">録音中またはプロジェクト処理中は曲の長さを変更できません。</p>
      ) : null}
      {notice !== null ? (
        <p role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</p>
      ) : null}
    </section>
  );
}
