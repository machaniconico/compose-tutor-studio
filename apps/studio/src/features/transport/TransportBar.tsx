import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from 'react';
import { useStore, type TransportState } from '../../state/store';
import {
  beatToBarPosition,
  compileMusicalTime,
  MIN_EVENT_DURATION_BEATS,
  type MusicalTimeIndex,
  type MusicalKey,
  type ScaleName,
} from '@cts/project-model';
import { initAudioBridge } from '../../audio/playback';
import { ProjectMenu } from '../projectMenu/ProjectMenu';
import { ExportMenu } from '../export/ExportMenu';
import { VocalCutTool } from '../vocalCut/VocalCutTool';
import { downloadBlob } from '../export/download';
import { exportEmergencyProjectBackup } from '../export/emergencyProjectBackup';
import { SaveControl } from './SaveControl';
import { studioRuntime } from '../../platform/runtime';
import { pushToast } from '../../state/tutorialBridge';
import { AudioTrackRecordingDialog } from '../audioTrack/AudioTrackRecordingDialog';
import { Dialog } from '../common/Dialog';

const KEYS: MusicalKey[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'F#'];

const SCALES: { value: ScaleName; label: string }[] = [
  { value: 'major', label: 'メジャー' },
  { value: 'naturalMinor', label: 'ナチュラルマイナー' },
  { value: 'harmonicMinor', label: 'ハーモニックマイナー' },
  { value: 'melodicMinor', label: 'メロディックマイナー' },
  { value: 'majorPentatonic', label: 'メジャーペンタ' },
  { value: 'minorPentatonic', label: 'マイナーペンタ' },
  { value: 'blues', label: 'ブルース' },
];

export const MAX_PUNCH_ROLL_BEATS = 16;

type TransportBarProps = {
  /** Re-open the first-launch onboarding / guided entry point. */
  onOpenGuide: () => void;
  /** Focus destination after the onboarding is dismissed without starting. */
  guideButtonRef?: Ref<HTMLButtonElement>;
};

type PlaybackLifecycleControlProps = {
  transport: TransportState;
  onPlay: () => void;
  onStop: () => void;
  playDisabled?: boolean;
};

/** Format an absolute beat against the project's active time-signature map. */
export function formatMusicalPosition(
  musicalTime: MusicalTimeIndex,
  beat: number,
): string {
  const safeBeat = Number.isFinite(beat) ? Math.max(0, beat) : 0;
  const position = beatToBarPosition(musicalTime, safeBeat);
  const denominator = position.timeSignature[1];
  const quarterNotesPerNotatedBeat = 4 / denominator;
  const beatInMeasure = Math.floor(position.beatInBar / quarterNotesPerNotatedBeat) + 1;
  return `${position.bar + 1}.${beatInMeasure}`;
}

export function formatLoopRangeSummary(
  musicalTime: MusicalTimeIndex,
  startBeat: number,
  endBeat: number,
): string {
  return `${formatMusicalPosition(musicalTime, startBeat)}–${formatMusicalPosition(
    musicalTime,
    endBeat,
  )}`;
}

type LoopRangeDraftValidation =
  | Readonly<{ ok: true; startBeat: number; endBeat: number }>
  | Readonly<{ ok: false; error: string }>;

export function validateLoopRangeDraft(
  startValue: string,
  endValue: string,
  projectLength: number,
): LoopRangeDraftValidation {
  if (startValue.trim() === '' || endValue.trim() === '') {
    return { ok: false, error: '開始拍と終了拍を入力してください。' };
  }
  const startBeat = Number(startValue);
  const endBeat = Number(endValue);
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat)) {
    return { ok: false, error: '拍位置は数値で入力してください。' };
  }
  if (
    !Number.isFinite(projectLength)
    || projectLength <= 0
    || startBeat < 0
    || startBeat > projectLength
    || endBeat < 0
    || endBeat > projectLength
  ) {
    return { ok: false, error: `範囲は0〜${projectLength}拍の中で指定してください。` };
  }
  if (endBeat <= startBeat) {
    return { ok: false, error: '終了拍は開始拍より後にしてください。' };
  }
  if (endBeat - startBeat < MIN_EVENT_DURATION_BEATS) {
    return { ok: false, error: 'ループ範囲が短すぎます。' };
  }
  return { ok: true, startBeat, endBeat };
}

export type PunchRangeDraftValidation =
  | Readonly<{
    ok: true;
    punchInBeat: number;
    punchOutBeat: number;
    preRollBeats: number;
    postRollBeats: number;
  }>
  | Readonly<{ ok: false; error: string }>;

/** Validate all Auto Punch fields before either runtime locator mutation runs. */
export function validatePunchRangeDraft(
  punchInValue: string,
  punchOutValue: string,
  preRollValue: string,
  postRollValue: string,
  projectLength: number,
): PunchRangeDraftValidation {
  if (punchInValue.trim() === '' || punchOutValue.trim() === '') {
    return { ok: false, error: 'パンチイン拍とパンチアウト拍を入力してください。' };
  }
  const punchInBeat = Number(punchInValue);
  const punchOutBeat = Number(punchOutValue);
  if (!Number.isFinite(punchInBeat) || !Number.isFinite(punchOutBeat)) {
    return { ok: false, error: 'パンチ位置は数値で入力してください。' };
  }
  if (
    !Number.isFinite(projectLength)
    || projectLength <= 0
    || punchInBeat < 0
    || punchInBeat > projectLength
    || punchOutBeat < 0
    || punchOutBeat > projectLength
  ) {
    return {
      ok: false,
      error: `パンチ範囲は0〜${projectLength}拍の中で指定してください。`,
    };
  }
  if (punchOutBeat <= punchInBeat) {
    return { ok: false, error: 'パンチアウト拍はパンチイン拍より後にしてください。' };
  }
  if (punchOutBeat - punchInBeat < MIN_EVENT_DURATION_BEATS) {
    return { ok: false, error: 'パンチ範囲が短すぎます。' };
  }
  if (preRollValue.trim() === '' || postRollValue.trim() === '') {
    return { ok: false, error: 'プリロールとポストロールを入力してください。' };
  }
  const preRollBeats = Number(preRollValue);
  const postRollBeats = Number(postRollValue);
  if (
    !Number.isSafeInteger(preRollBeats)
    || !Number.isSafeInteger(postRollBeats)
    || preRollBeats < 0
    || preRollBeats > MAX_PUNCH_ROLL_BEATS
    || postRollBeats < 0
    || postRollBeats > MAX_PUNCH_ROLL_BEATS
  ) {
    return {
      ok: false,
      error: `プリロールとポストロールは0〜${MAX_PUNCH_ROLL_BEATS}の整数拍で指定してください。`,
    };
  }
  return {
    ok: true,
    punchInBeat,
    punchOutBeat,
    preRollBeats: preRollBeats === 0 ? 0 : preRollBeats,
    postRollBeats: postRollBeats === 0 ? 0 : postRollBeats,
  };
}

export function isPunchEditingLocked(
  phase: TransportState['phase'],
  projectOperationBusy: boolean,
  audioRecordingOperationId: number | null,
): boolean {
  return (
    phase !== 'stopped'
    || projectOperationBusy
    || audioRecordingOperationId !== null
  );
}

function editableLoopRange(
  startBeat: number,
  endBeat: number,
  projectLength: number,
): Readonly<{ startBeat: number; endBeat: number }> {
  if (
    Number.isFinite(startBeat)
    && Number.isFinite(endBeat)
    && startBeat >= 0
    && endBeat <= projectLength
    && endBeat - startBeat >= MIN_EVENT_DURATION_BEATS
  ) {
    return { startBeat, endBeat };
  }
  return { startBeat: 0, endBeat: projectLength };
}

type LoopRangeControlProps = {
  enabled: boolean;
  expanded: boolean;
  disabled: boolean;
  summary: string;
  onToggle: () => void;
  onEdit: () => void;
};

/** Compact toolbar affordance: state toggle plus a readable, non-editing summary. */
export function LoopRangeControl({
  enabled,
  expanded,
  disabled,
  summary,
  onToggle,
  onEdit,
}: LoopRangeControlProps) {
  return (
    <div className="transport-bar__loop-control" role="group" aria-label="ループ再生">
      <button
        type="button"
        className={enabled ? 'is-active transport-bar__loop-toggle' : 'transport-bar__loop-toggle'}
        aria-pressed={enabled}
        disabled={disabled}
        onClick={onToggle}
      >
        ループ
      </button>
      <button
        type="button"
        className="transport-bar__loop-range"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={`ループ範囲を編集。現在 ${summary}`}
        disabled={disabled}
        onClick={onEdit}
      >
        <span>範囲</span>
        <output>{summary}</output>
      </button>
    </div>
  );
}

type LoopRangeEditorProps = {
  projectLength: number;
  startValue: string;
  endValue: string;
  error: string | null;
  onStartValueChange: (value: string) => void;
  onEndValueChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
};

export function LoopRangeEditor({
  projectLength,
  startValue,
  endValue,
  error,
  onStartValueChange,
  onEndValueChange,
  onSave,
  onClose,
}: LoopRangeEditorProps) {
  const describedBy = error
    ? 'loop-range-help loop-range-error'
    : 'loop-range-help';
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSave();
  };

  return (
    <form className="loop-range-editor" onSubmit={submit}>
      <p id="loop-range-help" className="loop-range-editor__help">
        曲の中で繰り返す開始拍と終了拍を指定します（全長 {projectLength}拍）。
      </p>
      <div className="loop-range-editor__fields">
        <label htmlFor="loop-range-start">
          開始拍
          <input
            id="loop-range-start"
            type="number"
            min={0}
            max={projectLength}
            step={MIN_EVENT_DURATION_BEATS}
            value={startValue}
            aria-describedby={describedBy}
            aria-invalid={error !== null}
            data-modal-initial-focus
            onChange={(event) => onStartValueChange(event.target.value)}
          />
        </label>
        <label htmlFor="loop-range-end">
          終了拍
          <input
            id="loop-range-end"
            type="number"
            min={0}
            max={projectLength}
            step={MIN_EVENT_DURATION_BEATS}
            value={endValue}
            aria-describedby={describedBy}
            aria-invalid={error !== null}
            onChange={(event) => onEndValueChange(event.target.value)}
          />
        </label>
      </div>
      {error ? (
        <p id="loop-range-error" className="loop-range-editor__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="loop-range-editor__actions">
        <button type="button" onClick={onClose}>
          キャンセル
        </button>
        <button type="submit" className="loop-range-editor__save">
          範囲を設定
        </button>
      </div>
    </form>
  );
}

export function LoopRangeDialog(props: LoopRangeEditorProps) {
  return (
    <Dialog title="ループ範囲" className="dialog--loop-range" onClose={props.onClose}>
      <LoopRangeEditor {...props} />
    </Dialog>
  );
}

type PunchRangeControlProps = {
  enabled: boolean;
  expanded: boolean;
  disabled: boolean;
  summary: string;
  preRollBeats: number;
  postRollBeats: number;
  onToggle: () => void;
  onEdit: () => void;
};

/** Compact Auto Punch toggle plus a mapped musical-position summary. */
export function PunchRangeControl({
  enabled,
  expanded,
  disabled,
  summary,
  preRollBeats,
  postRollBeats,
  onToggle,
  onEdit,
}: PunchRangeControlProps) {
  return (
    <div
      className="transport-bar__loop-control transport-bar__punch-control"
      role="group"
      aria-label="オートパンチ録音"
    >
      <button
        type="button"
        className={enabled
          ? 'is-active transport-bar__loop-toggle transport-bar__punch-toggle'
          : 'transport-bar__loop-toggle transport-bar__punch-toggle'}
        aria-pressed={enabled}
        disabled={disabled}
        onClick={onToggle}
      >
        パンチ
      </button>
      <button
        type="button"
        className="transport-bar__loop-range transport-bar__punch-range"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={`パンチ範囲を編集。現在 ${summary}。プリロール${preRollBeats}拍、ポストロール${postRollBeats}拍`}
        disabled={disabled}
        onClick={onEdit}
      >
        <span>範囲</span>
        <output>{summary}</output>
      </button>
    </div>
  );
}

type PunchRangeEditorProps = {
  projectLength: number;
  punchInValue: string;
  punchOutValue: string;
  preRollValue: string;
  postRollValue: string;
  error: string | null;
  disabled?: boolean;
  onPunchInValueChange: (value: string) => void;
  onPunchOutValueChange: (value: string) => void;
  onPreRollValueChange: (value: string) => void;
  onPostRollValueChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
};

export function PunchRangeEditor({
  projectLength,
  punchInValue,
  punchOutValue,
  preRollValue,
  postRollValue,
  error,
  disabled = false,
  onPunchInValueChange,
  onPunchOutValueChange,
  onPreRollValueChange,
  onPostRollValueChange,
  onSave,
  onClose,
}: PunchRangeEditorProps) {
  const describedBy = error
    ? 'punch-range-help punch-range-error'
    : 'punch-range-help';
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!disabled) onSave();
  };

  return (
    <form
      className="loop-range-editor punch-range-editor"
      onSubmit={submit}
    >
      <p
        id="punch-range-help"
        className="loop-range-editor__help punch-range-editor__help"
      >
        指定範囲だけを録音し、前後は再生します（全長 {projectLength}拍）。
        プリロールとポストロールは0〜{MAX_PUNCH_ROLL_BEATS}の整数拍です。
      </p>
      <div className="loop-range-editor__fields punch-range-editor__fields">
        <label htmlFor="punch-range-in">
          パンチイン拍
          <input
            id="punch-range-in"
            type="number"
            min={0}
            max={projectLength}
            step={MIN_EVENT_DURATION_BEATS}
            value={punchInValue}
            aria-describedby={describedBy}
            aria-invalid={error !== null}
            disabled={disabled}
            data-modal-initial-focus
            onChange={(event) => onPunchInValueChange(event.target.value)}
          />
        </label>
        <label htmlFor="punch-range-out">
          パンチアウト拍
          <input
            id="punch-range-out"
            type="number"
            min={0}
            max={projectLength}
            step={MIN_EVENT_DURATION_BEATS}
            value={punchOutValue}
            aria-describedby={describedBy}
            aria-invalid={error !== null}
            disabled={disabled}
            onChange={(event) => onPunchOutValueChange(event.target.value)}
          />
        </label>
        <label htmlFor="punch-range-pre-roll">
          プリロール（拍）
          <input
            id="punch-range-pre-roll"
            type="number"
            min={0}
            max={MAX_PUNCH_ROLL_BEATS}
            step={1}
            value={preRollValue}
            aria-describedby={describedBy}
            aria-invalid={error !== null}
            disabled={disabled}
            onChange={(event) => onPreRollValueChange(event.target.value)}
          />
        </label>
        <label htmlFor="punch-range-post-roll">
          ポストロール（拍）
          <input
            id="punch-range-post-roll"
            type="number"
            min={0}
            max={MAX_PUNCH_ROLL_BEATS}
            step={1}
            value={postRollValue}
            aria-describedby={describedBy}
            aria-invalid={error !== null}
            disabled={disabled}
            onChange={(event) => onPostRollValueChange(event.target.value)}
          />
        </label>
      </div>
      {error ? (
        <p
          id="punch-range-error"
          className="loop-range-editor__error punch-range-editor__error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="loop-range-editor__actions punch-range-editor__actions">
        <button type="button" onClick={onClose}>
          キャンセル
        </button>
        <button
          type="submit"
          className="loop-range-editor__save punch-range-editor__save"
          disabled={disabled}
        >
          パンチ範囲を設定
        </button>
      </div>
    </form>
  );
}

export function PunchRangeDialog(props: PunchRangeEditorProps) {
  return (
    <Dialog
      title="オートパンチ範囲"
      className="dialog--loop-range dialog--punch-range"
      onClose={props.onClose}
    >
      <PunchRangeEditor {...props} />
    </Dialog>
  );
}

type RecordingOpenControlProps = {
  armedTrackName: string | null;
  punchEnabled: boolean;
  disabled: boolean;
  onOpen: () => void;
};

/** Recording target is always textual so Punch readiness never depends on color. */
export function RecordingOpenControl({
  armedTrackName,
  punchEnabled,
  disabled,
  onOpen,
}: RecordingOpenControlProps) {
  const normalizedTrackName = armedTrackName?.trim() || null;
  const punchNeedsArmedTrack = punchEnabled && normalizedTrackName === null;
  const recordingTargetLabel = normalizedTrackName
    ? `録音先: ${normalizedTrackName}`
    : punchNeedsArmedTrack
      ? '録音先: 既存のオーディオトラックをRで録音待機してください'
      : '録音先: 新しいオーディオトラック';

  return (
    <button
      type="button"
      className="transport-bar__record"
      aria-haspopup="dialog"
      aria-label={`録音を開く。${recordingTargetLabel}`}
      title={recordingTargetLabel}
      disabled={disabled}
      onClick={onOpen}
    >
      <span aria-hidden="true" />
      録音
      <small>
        {normalizedTrackName ?? (punchNeedsArmedTrack ? 'R待機が必要' : '新規Track')}
      </small>
    </button>
  );
}

/** Render the async playback lifecycle independently from the rest of the bar. */
export function PlaybackLifecycleControl({
  transport,
  onPlay,
  onStop,
  playDisabled = false,
}: PlaybackLifecycleControlProps) {
  const isStarting = transport.phase === 'starting';
  const isPlaying = transport.phase === 'playing';
  const isActive = transport.phase !== 'stopped';
  const audioIssueMessage =
    transport.audioIssue === 'event-limit-exceeded'
      ? '再生イベントが多すぎます。ノート、ドラム、オーディオクリップ、または連動コピーを減らして、もう一度「再生」を押してください。編集内容はそのままです。'
      : transport.audioIssue === 'audio-asset-missing'
        ? '保存済みの音声素材が見つかりません。素材を保存した端末のアプリデータを確認してください。編集内容はそのままです。'
        : transport.audioIssue === 'audio-asset-changed'
          ? '保存済みの音声素材が変更または破損しているため再生できません。素材の状態を確認してください。編集内容はそのままです。'
          : transport.audioIssue === 'audio-asset-unavailable'
            ? '音声素材の保存領域へ現在アクセスできません。端末の空き容量やアクセス権を確認してください。編集内容はそのままです。'
            : transport.audioIssue === 'audio-decode-failed'
              ? '保存済みの音声素材を読み取れませんでした。素材が対応形式か、破損していないか確認してください。編集内容はそのままです。'
              : transport.audioIssue === 'audio-resource-limit'
                ? '再生時の音声処理またはメモリ上限を超えています。エフェクト、バス、または音声素材の数や長さを減らしてください。編集内容はそのままです。'
      : transport.audioIssue === 'start-failed'
        ? '音を再生できませんでした。出力先と端末の音量を確認して、もう一度「再生」を押してください。編集内容はそのままです。'
        : transport.audioIssue === 'interrupted'
          ? '音声の再生が中断されました。出力先が変わった可能性があります。もう一度「再生」を押してください。編集内容はそのままです。'
          : null;

  return (
    <>
      <button
        type="button"
        className={isPlaying ? 'is-active' : ''}
        aria-busy={isStarting || undefined}
        aria-describedby="transport-playback-status"
        disabled={!isActive && playDisabled}
        onClick={() => (isActive ? onStop() : onPlay())}
      >
        {isStarting ? '開始を中止' : isPlaying ? '一時停止' : '再生'}
      </button>

      <span
        id="transport-playback-status"
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {isStarting ? '音声を開始しています。' : isPlaying ? '再生中です。' : '再生は停止しています。'}
      </span>

      {audioIssueMessage ? (
        <span className="save-indicator save-indicator--error" role="alert" aria-atomic="true">
          {audioIssueMessage}
        </span>
      ) : null}
    </>
  );
}

/** Top transport + project metadata bar. */
export function TransportBar({ onOpenGuide, guideButtonRef }: TransportBarProps) {
  const project = useStore((s) => s.project);
  const transport = useStore((s) => s.transport);
  const isActive = transport.phase !== 'stopped';
  const play = useStore((s) => s.play);
  const stop = useStore((s) => s.stop);
  const setLoopRange = useStore((s) => s.setLoopRange);
  const toggleLoop = useStore((s) => s.toggleLoop);
  const setPunchRange = useStore((s) => s.setPunchRange);
  const setPunchRoll = useStore((s) => s.setPunchRoll);
  const togglePunch = useStore((s) => s.togglePunch);
  const toggleMetronome = useStore((s) => s.toggleMetronome);
  const setBpm = useStore((s) => s.setBpm);
  const setKey = useStore((s) => s.setKey);
  const setScale = useStore((s) => s.setScale);
  const setTitle = useStore((s) => s.setTitle);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.audioRecordingOperationId === null && s.past.length > 0);
  const canRedo = useStore((s) => s.audioRecordingOperationId === null && s.future.length > 0);
  const saveState = useStore((s) => s.saveState);
  const saveToLocalStorage = useStore((s) => s.saveToLocalStorage);
  const projectOperationBusy = useStore((s) => s.projectOperationBusy);
  const audioRecordingOperationId = useStore((s) => s.audioRecordingOperationId);
  const armedAudioTrackId = useStore((s) => s.armedAudioTrackId);
  const emergencyExportLock = useRef(false);
  const [emergencyExportBusy, setEmergencyExportBusy] = useState(false);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [loopRangeDraft, setLoopRangeDraft] = useState<{
    startValue: string;
    endValue: string;
  } | null>(null);
  const [loopRangeError, setLoopRangeError] = useState<string | null>(null);
  const [punchRangeDraft, setPunchRangeDraft] = useState<{
    punchInValue: string;
    punchOutValue: string;
    preRollValue: string;
    postRollValue: string;
  } | null>(null);
  const [punchRangeError, setPunchRangeError] = useState<string | null>(null);
  const recordingControlsLocked = audioRecordingOperationId !== null;
  const punchControlsLocked = isPunchEditingLocked(
    transport.phase,
    projectOperationBusy,
    audioRecordingOperationId,
  );

  // Connect the store to the audio engine once. The bridge confirms the
  // asynchronous starting -> playing transition; this component only sends
  // play/cancel intent.
  useEffect(() => initAudioBridge(), []);

  const musicalTime = useMemo(
    () => compileMusicalTime({
      lengthBeats: project.lengthBeats,
      tempoMap: project.tempoMap,
      timeSignatureMap: project.timeSignatureMap,
    }),
    [project.lengthBeats, project.tempoMap, project.timeSignatureMap],
  );
  const armedAudioTrack = project.tracks.find(
    (track) => track.id === armedAudioTrackId && track.type === 'audio',
  );
  const currentLoopRange = editableLoopRange(
    transport.loopStartBeat,
    transport.loopEndBeat,
    project.lengthBeats,
  );
  const loopRangeSummary = formatLoopRangeSummary(
    musicalTime,
    currentLoopRange.startBeat,
    currentLoopRange.endBeat,
  );
  const currentPunchRange = editableLoopRange(
    transport.punchInBeat,
    transport.punchOutBeat,
    project.lengthBeats,
  );
  const punchRangeSummary = formatLoopRangeSummary(
    musicalTime,
    currentPunchRange.startBeat,
    currentPunchRange.endBeat,
  );
  const openLoopRangeEditor = (): void => {
    setPunchRangeDraft(null);
    setPunchRangeError(null);
    setLoopRangeError(null);
    setLoopRangeDraft({
      startValue: String(currentLoopRange.startBeat),
      endValue: String(currentLoopRange.endBeat),
    });
  };
  const closeLoopRangeEditor = (): void => {
    setLoopRangeDraft(null);
    setLoopRangeError(null);
  };
  const saveLoopRange = (): void => {
    if (!loopRangeDraft) return;
    const result = validateLoopRangeDraft(
      loopRangeDraft.startValue,
      loopRangeDraft.endValue,
      project.lengthBeats,
    );
    if (!result.ok) {
      setLoopRangeError(result.error);
      return;
    }
    if (!setLoopRange(result.startBeat, result.endBeat)) {
      setLoopRangeError(
        audioRecordingOperationId !== null
          ? '録音中はループ範囲を変更できません。'
          : 'ループ範囲を設定できませんでした。曲の長さを確認してください。',
      );
      return;
    }
    closeLoopRangeEditor();
  };
  const openPunchRangeEditor = (): void => {
    if (punchControlsLocked) return;
    setLoopRangeDraft(null);
    setLoopRangeError(null);
    setPunchRangeError(null);
    setPunchRangeDraft({
      punchInValue: String(currentPunchRange.startBeat),
      punchOutValue: String(currentPunchRange.endBeat),
      preRollValue: String(transport.punchPreRollBeats),
      postRollValue: String(transport.punchPostRollBeats),
    });
  };
  const closePunchRangeEditor = (): void => {
    setPunchRangeDraft(null);
    setPunchRangeError(null);
  };
  const savePunchRange = (): void => {
    if (!punchRangeDraft) return;
    if (punchControlsLocked) {
      setPunchRangeError(
        '再生中、プロジェクト処理中、または録音中はパンチ設定を変更できません。',
      );
      return;
    }
    const result = validatePunchRangeDraft(
      punchRangeDraft.punchInValue,
      punchRangeDraft.punchOutValue,
      punchRangeDraft.preRollValue,
      punchRangeDraft.postRollValue,
      project.lengthBeats,
    );
    if (!result.ok) {
      setPunchRangeError(result.error);
      return;
    }
    if (!setPunchRoll(result.preRollBeats, result.postRollBeats)) {
      setPunchRangeError('プリロールとポストロールを設定できませんでした。');
      return;
    }
    if (!setPunchRange(result.punchInBeat, result.punchOutBeat)) {
      setPunchRangeError(
        'パンチ範囲を設定できませんでした。再生状態と曲の長さを確認してください。',
      );
      return;
    }
    closePunchRangeEditor();
  };
  const exportEmergencyBackup = async () => {
    if (emergencyExportLock.current) return;
    emergencyExportLock.current = true;
    setEmergencyExportBusy(true);
    try {
      const result = await exportEmergencyProjectBackup(project, {
        runtime: studioRuntime.kind,
        exportNative: async (bytes, fileName) => {
          const { nativeFileGateway } = await import('../../platform/nativeFileGateway');
          return nativeFileGateway.exportProject(bytes, fileName);
        },
        downloadWeb: downloadBlob,
      });
      if (result.status === 'saved') {
        pushToast('バックアップを書き出しました。', 'success');
      } else if (result.status === 'download-started') {
        pushToast('検証済みバックアップのダウンロードを開始しました。', 'success');
      } else if (result.status === 'invalid-project') {
        pushToast(
          '安全に再読込できるバックアップを作成できませんでした。プロジェクトの内容を確認してください。',
          'error',
        );
      } else if (result.status === 'failed') {
        pushToast(
          'バックアップの書き出しに失敗しました。保存先の権限と空き容量を確認してください。',
          'error',
        );
      }
    } finally {
      emergencyExportLock.current = false;
      setEmergencyExportBusy(false);
    }
  };

  return (
    <>
      <header className="transport-bar">
        <div className="transport-bar__row">
        <ProjectMenu />

        <button
          ref={guideButtonRef}
          type="button"
          className="transport-bar__guide"
          aria-label="はじめてガイドを開く"
          onClick={onOpenGuide}
        >
          はじめてガイド
        </button>

        <PlaybackLifecycleControl
          transport={transport}
          onPlay={play}
          onStop={stop}
          playDisabled={recordingControlsLocked}
        />

        <RecordingOpenControl
          armedTrackName={armedAudioTrack?.name ?? null}
          punchEnabled={transport.punchEnabled}
          disabled={projectOperationBusy || audioRecordingOperationId !== null}
          onOpen={() => setRecordingOpen(true)}
        />

        <button
          type="button"
          aria-label="先頭へ戻す"
          disabled={isActive && transport.positionBeat === 0}
          onClick={() => stop(true)}
        >
          先頭へ
        </button>

        <LoopRangeControl
          enabled={transport.loopEnabled}
          expanded={loopRangeDraft !== null}
          disabled={recordingControlsLocked}
          summary={loopRangeSummary}
          onToggle={toggleLoop}
          onEdit={openLoopRangeEditor}
        />

        <PunchRangeControl
          enabled={transport.punchEnabled}
          expanded={punchRangeDraft !== null}
          disabled={punchControlsLocked}
          summary={punchRangeSummary}
          preRollBeats={transport.punchPreRollBeats}
          postRollBeats={transport.punchPostRollBeats}
          onToggle={togglePunch}
          onEdit={openPunchRangeEditor}
        />

        <button
          type="button"
          className={transport.metronome ? 'is-active' : ''}
          aria-pressed={transport.metronome}
          disabled={recordingControlsLocked}
          onClick={() => toggleMetronome()}
        >
          メトロノーム
        </button>

        <div className="position-display" aria-label="再生位置">
          {formatMusicalPosition(musicalTime, transport.positionBeat)}
        </div>

        <div className="field">
          <label htmlFor="bpm-input">BPM</label>
          <input
            id="bpm-input"
            type="number"
            min={20}
            max={300}
            value={project.bpm}
            disabled={recordingControlsLocked}
            onChange={(e) => setBpm(Number(e.target.value) || project.bpm)}
          />
        </div>

        <div className="field">
          <label htmlFor="key-select">キー</label>
          <select
            id="key-select"
            value={project.key}
            disabled={recordingControlsLocked}
            onChange={(e) => setKey(e.target.value as MusicalKey)}
          >
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="scale-select">スケール</label>
          <select
            id="scale-select"
            value={project.scale}
            disabled={recordingControlsLocked}
            onChange={(e) => setScale(e.target.value as ScaleName)}
          >
            {SCALES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <button type="button" disabled={!canUndo} onClick={() => undo()}>
          元に戻す
        </button>
        <button type="button" disabled={!canRedo} onClick={() => redo()}>
          やり直す
        </button>

        <input
          className="transport-bar__title"
          aria-label="プロジェクト名"
          value={project.title}
          disabled={recordingControlsLocked}
          onChange={(e) => setTitle(e.target.value)}
        />

        <SaveControl
          state={saveState}
          onSave={saveToLocalStorage}
          onEmergencyExport={exportEmergencyBackup}
          emergencyExportBusy={emergencyExportBusy}
        />

        <ExportMenu />
        <VocalCutTool />
        </div>
      </header>
      {recordingOpen ? (
        <AudioTrackRecordingDialog
          trackName={armedAudioTrack?.name ?? 'マイク録音'}
          {...(armedAudioTrack ? { targetTrackId: armedAudioTrack.id } : {})}
          onClose={() => setRecordingOpen(false)}
          onCreated={() => setRecordingOpen(false)}
        />
      ) : null}
      {loopRangeDraft ? (
        <LoopRangeDialog
          projectLength={project.lengthBeats}
          startValue={loopRangeDraft.startValue}
          endValue={loopRangeDraft.endValue}
          error={loopRangeError}
          onStartValueChange={(startValue) => {
            setLoopRangeError(null);
            setLoopRangeDraft((draft) => draft ? { ...draft, startValue } : draft);
          }}
          onEndValueChange={(endValue) => {
            setLoopRangeError(null);
            setLoopRangeDraft((draft) => draft ? { ...draft, endValue } : draft);
          }}
          onSave={saveLoopRange}
          onClose={closeLoopRangeEditor}
        />
      ) : null}
      {punchRangeDraft ? (
        <PunchRangeDialog
          projectLength={project.lengthBeats}
          punchInValue={punchRangeDraft.punchInValue}
          punchOutValue={punchRangeDraft.punchOutValue}
          preRollValue={punchRangeDraft.preRollValue}
          postRollValue={punchRangeDraft.postRollValue}
          error={punchRangeError}
          disabled={punchControlsLocked}
          onPunchInValueChange={(punchInValue) => {
            setPunchRangeError(null);
            setPunchRangeDraft((draft) => draft ? { ...draft, punchInValue } : draft);
          }}
          onPunchOutValueChange={(punchOutValue) => {
            setPunchRangeError(null);
            setPunchRangeDraft((draft) => draft ? { ...draft, punchOutValue } : draft);
          }}
          onPreRollValueChange={(preRollValue) => {
            setPunchRangeError(null);
            setPunchRangeDraft((draft) => draft ? { ...draft, preRollValue } : draft);
          }}
          onPostRollValueChange={(postRollValue) => {
            setPunchRangeError(null);
            setPunchRangeDraft((draft) => draft ? { ...draft, postRollValue } : draft);
          }}
          onSave={savePunchRange}
          onClose={closePunchRangeEditor}
        />
      ) : null}
    </>
  );
}
