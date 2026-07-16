import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { Dialog } from '../common/Dialog';
import { pushToast } from '../../state/tutorialBridge';
import { SOURCE_AUDIO_ACCEPT, type SourceAudioDescriptor } from '../../audio/sourceAudio';
import { studioRuntime } from '../../platform/runtime';
import { AudioResourceReservationError } from '../../audio/audioResourceReservation';
import {
  NativeFileGatewayError,
  NATIVE_AUDIO_OPEN_ENVELOPE_MAX_BYTES,
  nativeFileGateway,
} from '../../platform/nativeFileGateway';
import {
  importStudioAudioTrack,
  studioAudioActionErrorMessage,
  withStudioNativeAudioSelection,
} from '../../state/audioTrackActions';
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

type AddTrackChoice = AddStudioTrackKind | 'audio';

const DEFAULT_TRACK_NAMES: Readonly<Record<AddTrackChoice, string>> = {
  ...DEFAULT_TRACK_NAME,
  audio: '新しいオーディオ',
};

function nativeAudioErrorMessage(error: unknown): string {
  if (error instanceof AudioResourceReservationError) {
    return studioAudioActionErrorMessage('resource-limit-exceeded');
  }
  if (error instanceof NativeFileGatewayError) {
    if (error.code === 'file-too-large') {
      return studioAudioActionErrorMessage('source-too-large');
    }
    if (error.code === 'invalid-file' || error.code === 'invalid-filename') {
      return studioAudioActionErrorMessage('source-invalid');
    }
  }
  return '音声ファイルを開けませんでした。アクセス権を確認して、もう一度お試しください。';
}

/** Create one immediately usable instrument or drum track. */
export function AddTrackDialog({ onClose, onCreated }: AddTrackDialogProps) {
  const [kind, setKind] = useState<AddTrackChoice>('instrument');
  const [name, setName] = useState(DEFAULT_TRACK_NAMES.instrument);
  const [preset, setPreset] = useState(STUDIO_SYNTH_PRESETS[0]?.name ?? 'softPad');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const isNative = studioRuntime.kind === 'native';

  useEffect(() => {
    // React StrictMode replays effects in development. Restore the mounted
    // marker in setup so the replay cleanup cannot permanently suppress import
    // completion updates for the still-mounted dialog.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const changeKind = (nextKind: AddTrackChoice): void => {
    const currentDefault = DEFAULT_TRACK_NAMES[kind];
    setKind(nextKind);
    if (name === currentDefault) setName(DEFAULT_TRACK_NAMES[nextKind]);
    setError(null);
    setStatus(null);
  };

  const importAudio = async (
    fileName: string,
    blob: Blob,
    byteLength: number,
    descriptor?: SourceAudioDescriptor,
  ): Promise<void> => {
    if (busyRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(null);
    setStatus('音声を端末内で読み込んでいます…');
    const result = await importStudioAudioTrack({
      fileName,
      blob,
      byteLength,
      trackName: name,
      ...(descriptor ? { descriptor } : {}),
      signal: controller.signal,
      onProgress: (next) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setProgress(Math.max(0, Math.min(100, Math.round(next.fraction * 100))));
        setStatus(
          next.phase === 'resampling'
            ? '音声を48 kHzへ変換しています…'
            : 'プロジェクト用WAVを作成しています…',
        );
      },
    });
    if (!mountedRef.current || abortRef.current !== controller) return;
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      const message = studioAudioActionErrorMessage(result.code);
      setProgress(null);
      setStatus(result.code === 'cancelled' ? message : 'オーディオトラックを追加できませんでした。');
      setError(result.code === 'cancelled' ? null : message);
      return;
    }
    setProgress(100);
    const deduplicated = result.deduplicated ? ' 同じ音声素材は重複保存していません。' : '';
    const stopped = result.playbackStopped
      ? ' 再生を停止し、位置を保持しました。'
      : '';
    pushToast(`「${result.trackName}」を追加しました。${deduplicated}${stopped}`, 'success');
    onClose();
    onCreated(result.trackId);
  };

  const chooseNativeAudio = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus('音声ファイルを選んでいます…');
    try {
      await withStudioNativeAudioSelection(
        NATIVE_AUDIO_OPEN_ENVELOPE_MAX_BYTES,
        async (sourceReservation) => {
          const selected = await nativeFileGateway.openAudio();
          if (!mountedRef.current) return;
          if (selected.status === 'cancelled') {
            setStatus('音声ファイルの選択をキャンセルしました。プロジェクトは変更されていません。');
            return;
          }
          const blob = sourceReservation.createBlobForImmediateImport(
            selected.bytes,
            selected.descriptor.mimeType,
          );
          busyRef.current = false;
          setBusy(false);
          await importAudio(
            selected.fileName,
            blob,
            selected.bytes.byteLength,
            selected.descriptor,
          );
        },
      );
    } catch (caught) {
      if (mountedRef.current) {
        setError(nativeAudioErrorMessage(caught));
        setStatus('音声ファイルを開けませんでした。');
      }
    } finally {
      if (mountedRef.current && !abortRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const chooseBrowserAudio = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busyRef.current) return;
    void importAudio(file.name, file, file.size);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busyRef.current) return;
    if (name.trim().length === 0 || Array.from(name.trim()).length > 128) {
      setError('名前は空白以外の128文字以内で入力してください。');
      return;
    }
    if (kind === 'audio') {
      if (isNative) void chooseNativeAudio();
      else fileInputRef.current?.click();
      return;
    }
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

  const requestClose = (): void => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Dialog
      title="トラックを追加"
      onClose={requestClose}
      className="dialog--track-add"
      busy={busy}
    >
      <form className="track-add" onSubmit={submit}>
        <fieldset className="track-add__types">
          <legend>トラックの種類</legend>
          <label>
            <input
              type="radio"
              name="track-kind"
              value="instrument"
              checked={kind === 'instrument'}
              disabled={busy}
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
              disabled={busy}
              onChange={() => changeKind('drum')}
            />
            <span>
              <strong>ドラムトラック</strong>
              <small>ステップ入力でリズムを作れます。</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="track-kind"
              value="audio"
              checked={kind === 'audio'}
              disabled={busy}
              onChange={() => changeKind('audio')}
            />
            <span>
              <strong>オーディオトラック</strong>
              <small>WAV、MP3、M4A、AACを48 kHz・PCM16へ変換して端末内へ保存します。プロジェクトJSONには音声本体を含まないため、JSON単体では別端末へ移せません。</small>
            </span>
          </label>
        </fieldset>

        <label className="track-add__field">
          <span>名前</span>
          <input
            data-modal-initial-focus
            type="text"
            value={name}
            disabled={busy}
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
              disabled={busy}
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

        {kind === 'audio' ? (
          <div className="track-add__audio-help">
            <p>元ファイルは変更せず、48 kHz・PCM16のWAVへ変換して、この端末の素材保存領域へ保存します。</p>
            <p>プロジェクトJSONには音声本体を含まないため、JSON単体を別端末へ移しても再生できません。</p>
            <p>追加後はアレンジャーで移動、左右トリム、ゲイン、フェード、ループ、分割ができます。</p>
          </div>
        ) : null}

        <p className="track-add__future">
          バストラックはルーティングの実装後に利用できます。
        </p>

        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept={SOURCE_AUDIO_ACCEPT}
          tabIndex={-1}
          onChange={chooseBrowserAudio}
        />

        {status ? (
          <p className="track-add__status" role="status" aria-live="polite">
            {status}
            {progress !== null ? ` ${progress}%` : ''}
          </p>
        ) : null}

        {error ? (
          <p className="track-management__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="track-management__actions">
          <button type="button" onClick={requestClose}>
            {busy ? '読み込みを中止して閉じる' : 'キャンセル'}
          </button>
          <button type="submit" className="track-management__primary" disabled={busy}>
            {busy
              ? '処理中…'
              : kind === 'audio'
                ? '音声を選んで追加'
                : '追加'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
