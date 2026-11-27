import { useState } from 'react';
import type { Project } from '@cts/project-model';
import { Dialog } from '../common/Dialog';
import {
  TRANSPOSE_AUDIO_NOTE,
  TRANSPOSE_MAX_SEMITONES,
  TRANSPOSE_MIN_SEMITONES,
  transposedKeyName,
  transposeSong,
} from '../../state/transposeActions';
import { pushToast } from '../../state/tutorialBridge';

/** Whole-song transpose: pick a number of semitones, see the new key, apply. */
export function TransposeSongDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [semitones, setSemitones] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const hasAudio = project.tracks.some((t) => t.clips.some((c) => c.type === 'audio'));
  const key = transposedKeyName(project, semitones) ?? '(対応するキーなし)';

  const onApply = (): void => {
    const result = transposeSong(semitones);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    if (result.changed) pushToast(`曲全体を移調しました。新しいキーは ${result.key} です。`, 'info');
    onClose();
  };

  return (
    <Dialog title="曲全体を移調" className="dialog--transpose-song" onClose={onClose}>
      <div className="transpose-song">
        <p>ノートとコード名を、まとめて半音単位で高く・低くします。キーも一緒に変わります。</p>
        <div className="field">
          <label htmlFor="transpose-song-semitones">移調する半音の数</label>
          <input
            id="transpose-song-semitones"
            type="number"
            step={1}
            min={TRANSPOSE_MIN_SEMITONES}
            max={TRANSPOSE_MAX_SEMITONES}
            value={semitones}
            onChange={(e) => {
              setError(null);
              setSemitones(Math.trunc(Number(e.target.value)) || 0);
            }}
          />
        </div>
        <p>
          今のキー {project.key} から、新しいキー <output aria-label="移調後のキー">{key}</output> になります。
        </p>
        <p className="transpose-song__note">
          {hasAudio ? '録音した音声が入っています。' : ''}
          {TRANSPOSE_AUDIO_NOTE}
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="transpose-song__actions">
          <button type="button" onClick={onClose}>
            やめる
          </button>
          <button type="button" onClick={onApply}>
            移調する
          </button>
        </div>
      </div>
    </Dialog>
  );
}
