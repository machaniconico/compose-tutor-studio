import { useState, type FormEvent } from 'react';
import { Dialog } from '../common/Dialog';
import { pushToast } from '../../state/tutorialBridge';
import {
  addStudioTrack,
  trackCommandErrorMessage,
  type AddStudioTrackKind,
} from '../../state/trackActions';
import { STUDIO_SYNTH_PRESETS } from './trackPresentation';

type AddTrackDialogProps = Readonly<{
  onClose: () => void;
  onCreated: (trackId: string) => void;
}>;

const DEFAULT_TRACK_NAME: Readonly<Record<AddStudioTrackKind, string>> = {
  instrument: '新しい楽器',
  drum: '新しいドラム',
};

/** Create one immediately usable instrument or drum track. */
export function AddTrackDialog({ onClose, onCreated }: AddTrackDialogProps) {
  const [kind, setKind] = useState<AddStudioTrackKind>('instrument');
  const [name, setName] = useState(DEFAULT_TRACK_NAME.instrument);
  const [preset, setPreset] = useState(STUDIO_SYNTH_PRESETS[0]?.name ?? 'softPad');
  const [error, setError] = useState<string | null>(null);

  const changeKind = (nextKind: AddStudioTrackKind): void => {
    const currentDefault = DEFAULT_TRACK_NAME[kind];
    setKind(nextKind);
    if (name === currentDefault) setName(DEFAULT_TRACK_NAME[nextKind]);
    setError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = addStudioTrack({
      kind,
      name,
      ...(kind === 'instrument' ? { preset } : {}),
    });
    if (!result.ok) {
      setError(trackCommandErrorMessage(result.code));
      return;
    }
    pushToast(
      `「${result.trackName}」を追加しました。${
        result.playbackStopped
          ? '再生を停止し、位置を保持しました。もう一度再生すると変更が反映されます。'
          : ''
      }`,
      'success',
    );
    onClose();
    onCreated(result.trackId);
  };

  return (
    <Dialog title="トラックを追加" onClose={onClose} className="dialog--track-add">
      <form className="track-add" onSubmit={submit}>
        <fieldset className="track-add__types">
          <legend>トラックの種類</legend>
          <label>
            <input
              type="radio"
              name="track-kind"
              value="instrument"
              checked={kind === 'instrument'}
              onChange={() => changeKind('instrument')}
            />
            <span>
              <strong>楽器トラック</strong>
              <small>ピアノロールでメロディやコードを作れます。</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="track-kind"
              value="drum"
              checked={kind === 'drum'}
              onChange={() => changeKind('drum')}
            />
            <span>
              <strong>ドラムトラック</strong>
              <small>ステップ入力でリズムを作れます。</small>
            </span>
          </label>
        </fieldset>

        <label className="track-add__field">
          <span>名前</span>
          <input
            data-modal-initial-focus
            type="text"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </label>

        {kind === 'instrument' ? (
          <label className="track-add__field">
            <span>音色</span>
            <select
              aria-label="音色"
              aria-describedby="add-track-preset-description"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
            >
              {STUDIO_SYNTH_PRESETS.map((option) => (
                <option key={option.name} value={option.name}>
                  {option.label}
                </option>
              ))}
            </select>
            <small id="add-track-preset-description">
              {STUDIO_SYNTH_PRESETS.find((option) => option.name === preset)?.description}
            </small>
          </label>
        ) : null}

        <p className="track-add__future">
          オーディオトラックは音声素材管理、バストラックはルーティングの実装後に利用できます。
        </p>

        {error ? (
          <p className="track-management__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="track-management__actions">
          <button type="button" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="track-management__primary">
            追加
          </button>
        </div>
      </form>
    </Dialog>
  );
}
