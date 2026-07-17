import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useStore, type TransportState } from '../../state/store';
import {
  beatToBarPosition,
  compileMusicalTime,
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
  const toggleLoop = useStore((s) => s.toggleLoop);
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
  const recordingControlsLocked = audioRecordingOperationId !== null;

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
  const recordingTargetLabel = armedAudioTrack
    ? `録音先: ${armedAudioTrack.name}`
    : '録音先: 新しいオーディオトラック';
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

        <button
          type="button"
          className="transport-bar__record"
          aria-haspopup="dialog"
          aria-label={`録音を開く。${recordingTargetLabel}`}
          title={recordingTargetLabel}
          disabled={projectOperationBusy || audioRecordingOperationId !== null}
          onClick={() => setRecordingOpen(true)}
        >
          <span aria-hidden="true" />
          録音
          <small>{armedAudioTrack ? armedAudioTrack.name : '新規Track'}</small>
        </button>

        <button
          type="button"
          aria-label="先頭へ戻す"
          disabled={isActive && transport.positionBeat === 0}
          onClick={() => stop(true)}
        >
          先頭へ
        </button>

        <button
          type="button"
          className={transport.loopEnabled ? 'is-active' : ''}
          aria-pressed={transport.loopEnabled}
          disabled={recordingControlsLocked}
          onClick={() => toggleLoop()}
        >
          ループ
        </button>

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
    </>
  );
}
