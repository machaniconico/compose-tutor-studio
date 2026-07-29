import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import {
  barToBeatAt,
  beatToBarPosition,
  type AudioAsset,
  type AudioClip,
  type MusicalTimeIndex,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { useStore, type AudioAssetRuntimeIssue } from '../../state/store';
import {
  deleteStudioAudioClip,
  duplicateStudioAudioClip,
  moveStudioAudioClip,
  setStudioAudioClipFades,
  setStudioAudioClipGain,
  setStudioAudioClipLoop,
  splitStudioAudioClip,
  studioAudioActionErrorMessage,
  trimStudioAudioClipLeft,
  trimStudioAudioClipRight,
  type StudioAudioClipCommandResult,
} from '../../state/audioTrackActions';
import { pushToast } from '../../state/tutorialBridge';
import {
  addStudioAudioClipToTakeFolder,
  groupSelectedStudioAudioClipIntoTakeFolder,
  matchingAudioClipIdsForTakeFolder,
  studioCompingErrorMessage,
} from '../../state/compingActions';
import { audioAssetPresentationStatus } from '../audioTrack/audioAssetPresentation';

type AudioClipEditorProps = Readonly<{
  clip: AudioClip;
  trackName: string;
  asset: AudioAsset | null;
  issue: AudioAssetRuntimeIssue | null;
  musicalTime: MusicalTimeIndex;
  trackId: string;
}>;

type EditorStatus = Readonly<{
  kind: 'status' | 'error';
  message: string;
}>;

function beatAsBarNumber(musicalTime: MusicalTimeIndex, beat: number): number {
  const position = beatToBarPosition(musicalTime, beat);
  const barStart = barToBeatAt(musicalTime, position.bar);
  const barEnd = barToBeatAt(musicalTime, position.bar + 1);
  const length = barEnd - barStart;
  return position.bar + (length > 0 ? position.beatInBar / length : 0);
}

export function audioBarNumberToBeat(
  musicalTime: MusicalTimeIndex,
  barNumber: number,
): number | null {
  if (
    !Number.isFinite(barNumber)
    || barNumber < 0
    || barNumber > Number.MAX_SAFE_INTEGER - 1
  ) return null;
  const bar = Math.floor(barNumber);
  const fraction = barNumber - bar;
  if (!Number.isSafeInteger(bar)) return null;
  try {
    const start = barToBeatAt(musicalTime, bar);
    const end = fraction === 0 ? start : barToBeatAt(musicalTime, bar + 1);
    const beat = start + (end - start) * fraction;
    return Number.isFinite(beat) ? beat : null;
  } catch {
    return null;
  }
}

export function parseAudioNumericDraft(draft: string): number | null {
  if (draft.trim().length === 0) return null;
  const parsed = Number(draft);
  return Number.isFinite(parsed) ? parsed : null;
}

function conciseNumber(value: number, precision = 6): string {
  return Number(value.toFixed(precision)).toString();
}

function framesToMilliseconds(frames: number, sampleRate: number): string {
  return conciseNumber((frames / sampleRate) * 1_000);
}

function millisecondsToFrames(milliseconds: number, sampleRate: number): number | null {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const frames = Math.round((milliseconds / 1_000) * sampleRate);
  return Number.isSafeInteger(frames) ? frames : null;
}

function readyAsset(asset: AudioAsset | null): ReadyAudioAsset | null {
  return asset?.availability === 'ready' ? asset : null;
}

function audioAssetRecoveryGuidance(
  asset: AudioAsset | null,
  issue: AudioAssetRuntimeIssue | null,
): string | null {
  if (issue === 'unavailable') {
    return '端末ストレージの空き容量とアプリのアクセス権を確認してから、画面を再読み込みしてください。配置と編集情報は保持されています。';
  }
  if (issue === 'changed') {
    return '正常な音声素材が残っている元の端末・プロファイルで開き直してください。プロジェクトJSONだけには音声本体が含まれず、配置と編集情報は保持されています。';
  }
  if (!asset || asset.availability === 'unresolved' || issue === 'missing') {
    return '元の音声素材が残っている端末・プロファイルで開き直してください。プロジェクトJSONだけには音声本体が含まれず、配置と編集情報は保持されています。';
  }
  return null;
}

function operationNotice(
  result: StudioAudioClipCommandResult,
  successMessage: string,
): EditorStatus {
  if (!result.ok) {
    return { kind: 'error', message: studioAudioActionErrorMessage(result.code) };
  }
  if (!result.changed) return { kind: 'status', message: '値は変更されていません。' };
  return {
    kind: 'status',
    message: `${successMessage}${
      result.playbackStopped
        ? ' 再生を停止し、再生位置は保持しました。'
        : ''
    }`,
  };
}

type CommitNumberInputProps = Readonly<{
  label: string;
  value: string;
  onCommit: (value: number) => boolean;
  min?: number;
  max?: number;
  step?: number | 'any';
  disabled?: boolean;
  describedBy?: string;
}>;

function CommitNumberInput({
  label,
  value,
  onCommit,
  min,
  max,
  step = 'any',
  disabled = false,
  describedBy,
}: CommitNumberInputProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    const parsed = parseAudioNumericDraft(draft);
    if (parsed !== null && parsed === Number(value)) {
      setDraft(value);
      return;
    }
    if (parsed === null || !onCommit(parsed)) setDraft(value);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(value);
      event.currentTarget.blur();
    }
  };

  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
      />
    </label>
  );
}

/** Non-destructive Audio Clip controls backed by one immutable project commit per gesture. */
export function AudioClipEditor({
  clip,
  trackName,
  asset,
  issue,
  musicalTime,
  trackId,
}: AudioClipEditorProps) {
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const helpId = useId();
  const compingHelpId = useId();
  const project = useStore((state) => state.project);
  const projectOperationBusy = useStore((state) => state.projectOperationBusy);
  const audioRecordingOperationId = useStore((state) => state.audioRecordingOperationId);
  const savePhase = useStore((state) => state.saveState.phase);
  const audioAssetIssues = useStore((state) => state.audioAssetIssues);
  const selectedTakeFolderId = useStore((state) => state.editor.selectedTakeFolderId);
  const persisted = readyAsset(asset);
  const availability = audioAssetPresentationStatus(asset, issue);
  const recoveryGuidance = audioAssetRecoveryGuidance(asset, issue);
  const startBar = beatAsBarNumber(musicalTime, clip.startBeat);
  const endBeat = clip.startBeat + clip.lengthBeats;
  const endBar = beatAsBarNumber(musicalTime, endBeat);
  const splitBar = beatAsBarNumber(musicalTime, clip.startBeat + clip.lengthBeats / 2);
  const [splitDraft, setSplitDraft] = useState(conciseNumber(splitBar));
  const sampleRate = persisted?.sampleRate ?? 48_000;
  const sourceSeconds = clip.sourceFrameCount / sampleRate;
  const assetSeconds = persisted ? persisted.frameCount / persisted.sampleRate : null;
  const editable = persisted !== null && !availability.problem;
  const matchingClipIds = matchingAudioClipIdsForTakeFolder(project, clip.id);
  const matchingFolder = project.audioTakeFolders.find(
    (folder) => (
      folder.id === selectedTakeFolderId
      && folder.trackId === trackId
      && folder.startBeat === clip.startBeat
      && folder.lengthBeats === clip.lengthBeats
    ),
  ) ?? project.audioTakeFolders.find(
    (folder) => (
      folder.trackId === trackId
      && folder.startBeat === clip.startBeat
      && folder.lengthBeats === clip.lengthBeats
    ),
  );
  const matchingAssetProblem = matchingClipIds.some((clipId) => {
    const candidate = project.tracks
      .find((track) => track.id === trackId)
      ?.clips.find((item) => item.id === clipId);
    if (
      candidate?.type !== 'audio'
      || typeof candidate.audioAssetId !== 'string'
    ) return true;
    const candidateAsset = project.audioAssets.find(
      (item) => item.id === candidate.audioAssetId,
    );
    return candidateAsset?.availability !== 'ready'
      || audioAssetIssues[candidate.audioAssetId] !== undefined;
  });
  const compingDisabledReason = projectOperationBusy
    ? 'プロジェクトを切り替え中のため、テイクを変更できません。'
    : audioRecordingOperationId !== null
      ? '録音中または録音素材の保存中のため、テイクを変更できません。'
      : savePhase === 'pending'
        ? 'プロジェクトを保存中のため、完了後にテイクを変更してください。'
        : !editable || matchingAssetProblem
          ? '音声素材を確認できないため、テイクを変更できません。'
          : null;
  const groupDisabledReason = compingDisabledReason
    ?? (
      matchingFolder
        ? 'この区間には既存のテイクフォルダーがあります。「既存テイクへ追加」を使ってください。'
        : null
    )
    ?? (
      matchingClipIds.length < 2
        ? '同じトラック・位置・長さのオーディオクリップが2つ以上必要です。'
        : null
    );
  const addDisabledReason = compingDisabledReason
    ?? (
      matchingClipIds.includes(clip.id)
        ? null
        : 'このクリップはループ中か、フォルダー全区間を満たす音声が残っていないため追加できません。'
    );

  useEffect(() => setSplitDraft(conciseNumber(splitBar)), [clip.id, splitBar]);

  const apply = (
    operation: () => StudioAudioClipCommandResult,
    successMessage: string,
  ): boolean => {
    const next = operationNotice(operation(), successMessage);
    setStatus(next);
    if (next.kind === 'status' && next.message !== '値は変更されていません。') {
      pushToast(successMessage, 'success');
      return true;
    }
    return next.kind === 'status';
  };

  const commitBar = (
    value: number,
    operation: (beat: number) => StudioAudioClipCommandResult,
    message: string,
  ): boolean => {
    const beat = audioBarNumberToBeat(musicalTime, value);
    if (beat === null) {
      setStatus({ kind: 'error', message: '小節位置は0以上の数値で入力してください。' });
      return false;
    }
    return apply(() => operation(beat), message);
  };

  const commitFades = (fadeInMs: number, fadeOutMs: number): boolean => {
    const fadeInFrames = millisecondsToFrames(fadeInMs, sampleRate);
    const fadeOutFrames = millisecondsToFrames(fadeOutMs, sampleRate);
    if (fadeInFrames === null || fadeOutFrames === null) {
      setStatus({ kind: 'error', message: 'フェードは0以上のミリ秒で入力してください。' });
      return false;
    }
    return apply(
      () => setStudioAudioClipFades(clip.id, fadeInFrames, fadeOutFrames),
      'フェードを更新しました。',
    );
  };

  return (
    <section className="arranger__clip-editor audio-clip-editor" aria-label="選択オーディオクリップの編集">
      <div className="arranger__clip-summary audio-clip-editor__summary">
        <strong>{trackName}</strong>
        <span>オーディオクリップ</span>
      </div>

      <div className="audio-clip-editor__asset">
        <div>
          <span className="audio-clip-editor__eyebrow">音声素材</span>
          <strong>{persisted?.originalName ?? '参照情報なし'}</strong>
          {persisted ? (
            <small>
              {(persisted.sampleRate / 1_000).toFixed(1)} kHz・{persisted.channelCount === 1 ? 'モノラル' : `${persisted.channelCount} ch`}・{assetSeconds?.toFixed(2)}秒
            </small>
          ) : null}
        </div>
        <span className={`audio-clip-editor__asset-status${availability.problem ? ' is-problem' : ''}`}>
          {availability.label}
        </span>
      </div>

      {recoveryGuidance ? (
        <p className="audio-clip-editor__asset-recovery" role="alert">
          {recoveryGuidance}
        </p>
      ) : null}

      <div className="audio-clip-editor__fields">
        <CommitNumberInput
          label="配置開始（小節・0から）"
          value={conciseNumber(startBar)}
          min={0}
          disabled={!editable}
          describedBy={helpId}
          onCommit={(value) => commitBar(value, (beat) => moveStudioAudioClip(clip.id, beat), '配置を移動しました。')}
        />
        <CommitNumberInput
          label="左端トリム（小節）"
          value={conciseNumber(startBar)}
          min={0}
          disabled={!editable || clip.loop}
          describedBy={helpId}
          onCommit={(value) => commitBar(value, (beat) => trimStudioAudioClipLeft(clip.id, beat), '左端をトリムしました。')}
        />
        <CommitNumberInput
          label="右端トリム（小節）"
          value={conciseNumber(endBar)}
          min={0}
          disabled={!editable}
          describedBy={helpId}
          onCommit={(value) => commitBar(value, (beat) => trimStudioAudioClipRight(clip.id, beat), '右端をトリムしました。')}
        />
        <CommitNumberInput
          label="クリップゲイン（dB）"
          value={conciseNumber(clip.gainDb)}
          min={-96}
          max={24}
          step={0.1}
          disabled={!editable}
          describedBy={helpId}
          onCommit={(value) => apply(() => setStudioAudioClipGain(clip.id, value), 'クリップゲインを更新しました。')}
        />
        <CommitNumberInput
          label="フェードイン（ms）"
          value={framesToMilliseconds(clip.fadeInFrames, sampleRate)}
          min={0}
          disabled={!editable}
          describedBy={helpId}
          onCommit={(value) => commitFades(value, Number(framesToMilliseconds(clip.fadeOutFrames, sampleRate)))}
        />
        <CommitNumberInput
          label="フェードアウト（ms）"
          value={framesToMilliseconds(clip.fadeOutFrames, sampleRate)}
          min={0}
          disabled={!editable}
          describedBy={helpId}
          onCommit={(value) => commitFades(Number(framesToMilliseconds(clip.fadeInFrames, sampleRate)), value)}
        />
      </div>

      <p id={helpId} className="arranger__timing-hint">
        配置開始は素材を変えずに移動します。左右トリムは元ファイルを変更せず、使う範囲だけを調整します。現在の素材範囲は{sourceSeconds.toFixed(2)}秒です。
      </p>

      <div className="audio-clip-editor__comping">
        <div>
          <strong>テイク編集</strong>
          <small>
            同じ区間の録音をまとめ、使う範囲だけを切り替えます。元の音声は変更しません。
          </small>
        </div>
        <div role="group" aria-label="テイク編集への追加">
          <button
            type="button"
            disabled={groupDisabledReason !== null}
            aria-describedby={compingHelpId}
            onClick={() => {
              const result = groupSelectedStudioAudioClipIntoTakeFolder(clip.id);
              if (!result.ok) {
                setStatus({ kind: 'error', message: studioCompingErrorMessage(result.code) });
                return;
              }
              pushToast('同じ区間のクリップをテイクにまとめました。', 'success');
            }}
          >
            同じ区間をテイク化
          </button>
          {matchingFolder ? (
            <button
              type="button"
              disabled={addDisabledReason !== null}
              aria-describedby={compingHelpId}
              onClick={() => {
                const result = addStudioAudioClipToTakeFolder(matchingFolder.id, clip.id);
                if (!result.ok) {
                  setStatus({ kind: 'error', message: studioCompingErrorMessage(result.code) });
                  return;
                }
                setStatus({
                  kind: 'status',
                  message: result.changed
                    ? '既存のテイクフォルダへ追加しました。仕上がりは変更していません。'
                    : '値は変更されていません。',
                });
              }}
            >
              既存テイクへ追加
            </button>
          ) : null}
        </div>
        <p id={compingHelpId}>
          {matchingFolder
            ? (
              addDisabledReason
              ?? 'このクリップを既存のテイクフォルダーへ追加できます。'
            )
            : (
              groupDisabledReason
              ?? `${matchingClipIds.length}個の同一区間クリップをまとめられます。`
            )}
        </p>
      </div>

      <label className="arranger__loop-toggle">
        <input
          type="checkbox"
          checked={clip.loop}
          disabled={!editable}
          onChange={(event) => {
            apply(
              () => setStudioAudioClipLoop(clip.id, event.target.checked),
              event.target.checked ? '素材のループをオンにしました。' : '素材のループをオフにしました。',
            );
          }}
        />
        <span>素材範囲をクリップ末尾まで繰り返す</span>
      </label>

      <div className="audio-clip-editor__split">
        <label>
          <span>分割位置（小節）</span>
          <input
            type="number"
            value={splitDraft}
            min={0}
            step="any"
            disabled={!editable || clip.loop}
            aria-describedby={helpId}
            onChange={(event) => setSplitDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setSplitDraft(conciseNumber(splitBar));
              }
            }}
          />
        </label>
        <button
          type="button"
          disabled={!editable || clip.loop}
          onClick={() => {
            const value = parseAudioNumericDraft(splitDraft);
            if (value === null) {
              setStatus({ kind: 'error', message: '分割位置を数値で入力してください。' });
              return;
            }
            if (!commitBar(value, (beat) => splitStudioAudioClip(clip.id, beat), 'クリップを分割しました。')) {
              setSplitDraft(conciseNumber(splitBar));
            }
          }}
        >
          この位置で分割
        </button>
      </div>

      <div className="arranger__clip-actions" role="group" aria-label="オーディオクリップ操作">
        <button
          type="button"
          disabled={!editable}
          onClick={() => apply(
            () => duplicateStudioAudioClip(clip.id, clip.startBeat + clip.lengthBeats),
            '独立コピーを右へ作成しました。',
          )}
        >
          独立コピーを右へ
        </button>
        <button
          type="button"
          disabled
          title="オーディオクリップは音声素材だけを共有し、編集値は常に独立します。"
        >
          連動コピーは利用不可
        </button>
        <button
          type="button"
          className="audio-clip-editor__delete"
          onClick={() => setDeleteArmed(true)}
        >
          クリップを削除
        </button>
      </div>

      {deleteArmed ? (
        <div className="audio-clip-editor__delete-confirm" role="group" aria-label="クリップ削除の確認">
          <p>この配置を削除します。音声素材は元に戻す操作のため保持されます。</p>
          <button type="button" onClick={() => setDeleteArmed(false)}>キャンセル</button>
          <button
            type="button"
            className="audio-clip-editor__delete"
            onClick={() => {
              const result = deleteStudioAudioClip(clip.id);
              const next = operationNotice(result, 'クリップを削除しました。元に戻す操作で復元できます。');
              setStatus(next);
              if (result.ok) pushToast('オーディオクリップを削除しました。元に戻す操作で復元できます。', 'success');
              else setDeleteArmed(false);
            }}
          >
            削除する
          </button>
        </div>
      ) : null}

      {status ? (
        <p
          className={`arranger__clip-notice${status.kind === 'error' ? ' is-error' : ''}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
          aria-live={status.kind === 'error' ? 'assertive' : 'polite'}
        >
          {status.message}
        </p>
      ) : null}
    </section>
  );
}
