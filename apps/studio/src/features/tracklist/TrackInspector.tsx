import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AudioAsset, Track, TrackRole } from '@cts/project-model';
import { useStore, type AudioAssetRuntimeIssue } from '../../state/store';
import {
  deleteStudioTrack,
  duplicateStudioTrack,
  moveStudioTrack,
  renameStudioTrack,
  setStudioTrackRole,
  setStudioTrackPreset,
  trackCommandErrorMessage,
} from '../../state/trackActions';
import { pushToast } from '../../state/tutorialBridge';
import { Dialog } from '../common/Dialog';
import {
  STUDIO_SYNTH_PRESETS,
  TRACK_TYPE_LABEL,
  canonicalSynthPresetName,
  focusTrackAddControl,
  focusTrackSelectionControl,
  isLearningTrack,
} from './trackPresentation';
import { audioAssetPresentationStatus } from '../audioTrack/audioAssetPresentation';

function playbackStoppedNotice(stopped: boolean): string {
  return stopped
    ? ' 再生を停止し、位置を保持しました。もう一度再生すると変更が反映されます。'
    : '';
}

/** Track controls that belong in the roomy inspector rather than 220px list rows. */
export function TrackInspector() {
  const tracks = useStore((state) => state.project.tracks);
  const audioAssets = useStore((state) => state.project.audioAssets);
  const audioAssetIssues = useStore((state) => state.audioAssetIssues);
  const selectedTrackId = useStore((state) => state.editor.selectedTrackId);
  const track = tracks.find((candidate) => candidate.id === selectedTrackId) ?? null;

  if (!track) {
    return (
      <section className="panel-section track-inspector">
        <p className="panel-section__title">トラック</p>
        <p className="empty-hint">左の一覧からトラックを選んでください。</p>
      </section>
    );
  }

  return (
    <TrackInspectorForm
      key={track.id}
      track={track}
      tracks={tracks}
      audioAssets={audioAssets}
      audioAssetIssues={audioAssetIssues}
    />
  );
}

type TrackInspectorFormProps = Readonly<{
  track: Track;
  tracks: readonly Track[];
  audioAssets: readonly AudioAsset[];
  audioAssetIssues: Readonly<Record<string, AudioAssetRuntimeIssue>>;
}>;

type TrackInspectorStatus = Readonly<{
  message: string;
  kind: 'info' | 'error';
}>;

const TRACK_ROLE_OPTIONS: readonly Readonly<{ value: TrackRole; label: string }>[] = [
  { value: 'general', label: '一般' },
  { value: 'learning.chords', label: 'コード学習' },
  { value: 'learning.bass', label: 'ベース学習' },
  { value: 'learning.melody', label: 'メロディ学習' },
];

function TrackInspectorForm({
  track,
  tracks,
  audioAssets,
  audioAssetIssues,
}: TrackInspectorFormProps) {
  const [nameDraft, setNameDraft] = useState(track.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [status, setStatus] = useState<TrackInspectorStatus | null>(null);
  const index = tracks.findIndex((candidate) => candidate.id === track.id);
  const isMaster = track.type === 'master';
  const isLearning = isLearningTrack(track);
  const canMoveUp =
    !isMaster && index > 0 && tracks[index - 1]?.type !== 'master';
  const canMoveDown =
    !isMaster && index >= 0 && index < tracks.length - 1 && tracks[index + 1]?.type !== 'master';
  const synthInstrument =
    track.type === 'instrument' && track.instrument?.type === 'synth'
      ? track.instrument
      : null;
  const synthPreset = synthInstrument?.preset ?? null;
  const displayedPreset = synthPreset === null ? null : canonicalSynthPresetName(synthPreset);
  const referencedAudioAssets = track.type === 'audio'
    ? Array.from(new Set(
        track.clips
          .filter((clip) => clip.type === 'audio' && clip.audioAssetId)
          .map((clip) => clip.audioAssetId as string),
      )).map((id) => audioAssets.find((asset) => asset.id === id) ?? null)
    : [];

  const showInfo = (message: string): void => setStatus({ message, kind: 'info' });
  const showError = (message: string): void => setStatus({ message, kind: 'error' });

  useEffect(() => {
    setNameDraft(track.name);
  }, [track.name]);

  const submitName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = renameStudioTrack(track.id, nameDraft);
    if (!result.ok) {
      const message = trackCommandErrorMessage(result.code);
      showError(message);
      return;
    }
    setNameDraft(result.trackName);
    const message = result.changed
      ? `トラック名を「${result.trackName}」へ変更しました。`
      : 'トラック名は変更されていません。';
    showInfo(message);
    if (result.changed) pushToast(message, 'success');
  };

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setNameDraft(track.name);
    showInfo('名前の変更を取り消しました。');
  };

  const move = (direction: 'up' | 'down'): void => {
    const result = moveStudioTrack(track.id, direction);
    if (!result.ok) {
      showError(trackCommandErrorMessage(result.code));
      return;
    }
    const message = result.changed
      ? `「${track.name}」を${direction === 'up' ? '上' : '下'}へ移動しました。${playbackStoppedNotice(result.playbackStopped)}`
      : 'これ以上移動できません。';
    showInfo(message);
    if (result.changed) pushToast(message, 'success');
  };

  const duplicate = (): void => {
    const result = duplicateStudioTrack(track.id);
    if (!result.ok) {
      showError(trackCommandErrorMessage(result.code));
      return;
    }
    const message = `「${track.name}」を「${result.trackName}」として複製しました。${playbackStoppedNotice(result.playbackStopped)}`;
    showInfo(message);
    pushToast(message, 'success');
    focusTrackSelectionControl(result.trackId);
  };

  const changePreset = (preset: string): void => {
    const result = setStudioTrackPreset(track.id, preset);
    if (!result.ok) {
      showError(trackCommandErrorMessage(result.code));
      return;
    }
    const selected = STUDIO_SYNTH_PRESETS.find((candidate) => candidate.name === preset);
    const message = result.changed
      ? `音色を「${selected?.label ?? preset}」へ変更しました。${playbackStoppedNotice(result.playbackStopped)}`
      : '音色は変更されていません。';
    showInfo(message);
    if (result.changed) pushToast(message, 'success');
  };

  const changeRole = (role: TrackRole): void => {
    const result = setStudioTrackRole(track.id, role);
    if (!result.ok) {
      showError(trackCommandErrorMessage(result.code));
      return;
    }
    const label = TRACK_ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
    const message = result.changed
      ? `トラックの役割を「${label}」へ変更しました。${playbackStoppedNotice(result.playbackStopped)}`
      : 'トラックの役割は変更されていません。';
    showInfo(message);
    if (result.changed) pushToast(message, 'success');
  };

  return (
    <section className="panel-section track-inspector" aria-labelledby="track-inspector-title">
      <div className="track-inspector__heading">
        <p className="panel-section__title" id="track-inspector-title">
          選択中のトラック
        </p>
        <span className="badge">{TRACK_TYPE_LABEL[track.type]}</span>
      </div>

      <strong className="track-inspector__name">{track.name}</strong>

      {isMaster ? (
        <p className="track-inspector__help">
          マスタートラックは名前・順序・複製・削除を変更できません。
        </p>
      ) : (
        <form className="track-inspector__rename" onSubmit={submitName}>
          <label>
            <span>名前</span>
            <input
              type="text"
              value={nameDraft}
              autoComplete="off"
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={onNameKeyDown}
            />
          </label>
          <button type="submit" disabled={nameDraft === track.name}>
            名前を変更
          </button>
        </form>
      )}

      {isLearning && !isMaster ? (
        <p className="track-inspector__help">
          名前を変更しても学習用の役割は保持されます。この役割を持つトラックは削除できません。
        </p>
      ) : null}

      {track.type === 'instrument' ? (
        <label className="track-inspector__preset">
          <span>学習での役割</span>
          <select
            aria-label={`${track.name} 学習での役割`}
            value={track.role}
            onChange={(event) => changeRole(event.target.value as TrackRole)}
          >
            {TRACK_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <small>同じ学習役割は1トラックだけです。選び直すと役割がこのトラックへ移ります。</small>
        </label>
      ) : null}

      {synthPreset !== null ? (
        <label className="track-inspector__preset">
          <span>内蔵音色</span>
          <select
            aria-label={`${track.name} 音色`}
            value={displayedPreset ?? synthPreset}
            onChange={(event) => changePreset(event.target.value)}
          >
            {displayedPreset === null ? (
              <option value={synthPreset}>
                {synthPreset.length > 0
                  ? `現在の互換音色（${synthPreset}）`
                  : '現在の互換音色（未設定）'}
              </option>
            ) : null}
            {STUDIO_SYNTH_PRESETS.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.label}
              </option>
            ))}
          </select>
          <small>
            {displayedPreset
              ? STUDIO_SYNTH_PRESETS.find((preset) => preset.name === displayedPreset)?.description
              : '保存済みの音色を保持しています。別の音色を選ぶと新しい形式へ変更します。'}
          </small>
        </label>
      ) : null}

      {track.type === 'audio' ? (
        <div className="track-inspector__audio-assets" aria-label={`${track.name} 音声素材`}>
          <span>音声素材</span>
          {referencedAudioAssets.length === 0 ? (
            <p className="track-inspector__help">このトラックには音声クリップがありません。</p>
          ) : (
            <ul>
              {referencedAudioAssets.map((asset, index) => {
                const issue = asset ? audioAssetIssues[asset.id] ?? null : 'missing';
                const presentation = audioAssetPresentationStatus(asset, issue);
                return (
                  <li key={asset?.id ?? `missing-${index}`}>
                    <strong>
                      {asset?.availability === 'ready' ? asset.originalName : '参照情報なし'}
                    </strong>
                    {asset?.availability === 'ready' ? (
                      <small>
                        {(asset.sampleRate / 1_000).toFixed(1)} kHz・{asset.channelCount === 1 ? 'モノラル' : `${asset.channelCount} ch`}・{(asset.frameCount / asset.sampleRate).toFixed(2)}秒
                      </small>
                    ) : null}
                    <span className={presentation.problem ? 'is-problem' : ''}>
                      {presentation.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <small>配置、トリム、ゲイン、フェード、分割はアレンジャーでクリップを選んで編集します。</small>
        </div>
      ) : null}

      {!isMaster ? (
        <div className="track-inspector__operations" role="group" aria-label={`${track.name} 管理`}>
          <button type="button" disabled={!canMoveUp} onClick={() => move('up')}>
            上へ移動
          </button>
          <button type="button" disabled={!canMoveDown} onClick={() => move('down')}>
            下へ移動
          </button>
          <button type="button" onClick={duplicate}>
            複製
          </button>
          {!isLearning ? (
            <button type="button" className="track-inspector__delete" onClick={() => setDeleteOpen(true)}>
              削除
            </button>
          ) : null}
        </div>
      ) : null}

      {status ? (
        <p
          className={`track-inspector__status is-${status.kind}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
          aria-live={status.kind === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {status.message}
        </p>
      ) : null}

      {deleteOpen ? (
        <DeleteTrackDialog track={track} onClose={() => setDeleteOpen(false)} />
      ) : null}
    </section>
  );
}

type DeleteTrackDialogProps = Readonly<{
  track: Track;
  onClose: () => void;
}>;

/** Explicit confirmation with a safe initial focus and post-delete focus handoff. */
export function DeleteTrackDialog({ track, onClose }: DeleteTrackDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const noteCount = track.clips.reduce(
    (total, clip) => total + (clip.notes?.length ?? 0) + (clip.drumEvents?.length ?? 0),
    0,
  );

  const confirm = (): void => {
    const result = deleteStudioTrack(track.id);
    if (!result.ok) {
      setError(trackCommandErrorMessage(result.code));
      return;
    }
    onClose();
    pushToast(
      `「${track.name}」を削除しました。元に戻す操作で復元できます。${playbackStoppedNotice(result.playbackStopped)}`,
      'success',
    );
    if (result.selectedTrackId) focusTrackSelectionControl(result.selectedTrackId);
    else focusTrackAddControl();
  };

  return (
    <Dialog title="トラックを削除" onClose={onClose}>
      <div className="track-delete">
        <p>
          {track.type === 'audio'
            ? `「${track.name}」と、音声クリップ${track.clips.length}個を削除します。音声素材は元に戻す操作のため保持されます。`
            : `「${track.name}」と、クリップ${track.clips.length}個・イベント${noteCount}個を削除します。`}
        </p>
        <p className="track-delete__undo">削除後も「元に戻す」で内容ごと復元できます。</p>
        {error ? (
          <p className="track-management__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="track-management__actions">
          <button type="button" data-modal-initial-focus onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="track-inspector__delete" onClick={confirm}>
            削除する
          </button>
        </div>
      </div>
    </Dialog>
  );
}
