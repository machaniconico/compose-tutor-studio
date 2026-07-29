import { useEffect, useRef, useState } from 'react';
import {
  compileMusicalTime,
  MAX_AUDIO_TAKES_PER_FOLDER,
  secondsBetweenBeats,
} from '@cts/project-model';
import {
  MAX_MICROPHONE_CAPTURE_SECONDS,
  MIN_MICROPHONE_CAPTURE_SECONDS,
  MicrophoneCaptureError,
  startMicrophoneCapture,
  type MicrophoneCaptureSession,
  type MicrophonePcmCapture,
} from '../../audio/microphoneCapture';
import { getAudioEngine } from '../../audio/engine';
import {
  RecordingLatencyCalibrationError,
  startRecordingLatencyCalibration,
} from '../../audio/recordingLatencyCalibration';
import {
  startSynchronizedRecordingPlayback,
  stopSynchronizedRecordingPlayback,
} from '../../audio/playback';
import {
  MicrophoneInputDeviceError,
  enumerateMicrophoneInputDevices,
  subscribeToMicrophoneInputDeviceChanges,
  type MicrophoneInputDevice,
} from '../../audio/microphoneInputDevices';
import {
  createPunchRecordingCoordinator,
  type PunchRecordingCoordinator,
} from '../../audio/punchRecordingCoordinator';
import {
  beginStudioAudioTrackRecording,
  beginStudioRecordingLatencyCalibration,
  bindStudioAudioTrackRecordingToPlayback,
  commitStudioRecordingLatencyCalibration,
  discardStudioAudioTrackRecording,
  discardStudioRecordingLatencyCalibration,
  markStudioAudioTrackPunchPostrollComplete,
  prepareStudioAudioTrackCycleCapture,
  prepareStudioAudioTrackPunchCapture,
  recordStudioAudioTrack,
  studioAudioActionErrorMessage,
  type StudioAudioActionErrorCode,
  type StudioAudioCycleRecording,
  type StudioAudioPunchRecording,
  type StudioAudioTrackRecordingHandle,
  type StudioRecordingLatencyCalibrationHandle,
} from '../../state/audioTrackActions';
import {
  MAX_RECORDING_LATENCY_ADJUSTMENT_MS,
  MIN_RECORDING_LATENCY_ADJUSTMENT_MS,
  useStore,
  type RecordingLatencyCompensationMode,
} from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import { Dialog } from '../common/Dialog';
import { microphoneCaptureFailureMessage } from '../common/microphoneCaptureFailureMessage';

type RecordingPhase =
  | 'idle'
  | 'requesting'
  | 'countdown'
  | 'preparing'
  | 'recording'
  | 'postroll'
  | 'stopping'
  | 'processing'
  | 'error';

type CalibrationView =
  | 'closed'
  | 'instructions'
  | 'running'
  | 'success'
  | 'error';

const CALIBRATION_INPUT_ROUTE_CHANGED = Symbol('calibration-input-route-changed');

type AudioTrackRecordingDialogProps = Readonly<{
  trackName: string;
  /** When present, append the take to this existing Audio Track. */
  targetTrackId?: string;
  onClose: () => void;
  onCreated: (trackId: string) => void;
  onBack?: () => void;
}>;

function formatElapsed(seconds: number): string {
  const bounded = Math.max(0, Math.min(MAX_MICROPHONE_CAPTURE_SECONDS, Math.floor(seconds)));
  const minutes = Math.floor(bounded / 60);
  return `${minutes}:${String(bounded % 60).padStart(2, '0')}`;
}

function formatCycleDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '計算できません';
  if (seconds < 10) return `${seconds.toFixed(1)}秒`;
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  return minutes > 0
    ? `${minutes}分${remainingSeconds > 0 ? `${remainingSeconds}秒` : ''}`
    : `${rounded}秒`;
}

function awaitAudioActivationOrCancel<T>(
  activation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: T, error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new MicrophoneCaptureError('capture-failed'));
    };
    const onAbort = (): void => finish(undefined, new MicrophoneCaptureError('cancelled'));
    void activation.then(
      (value) => finish(value),
      (error: unknown) => finish(undefined, error),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function recordingBeginFailureMessage(
  code: StudioAudioActionErrorCode,
): string {
  switch (code) {
    case 'decode-busy':
      return '別の音声の読み込み・録音処理が続いています。完了してからもう一度お試しください。';
    case 'resource-limit-exceeded':
      return '録音用のメモリを安全に確保できませんでした。ほかの音声処理を終了してから再試行してください。';
    case 'project-busy':
      return 'プロジェクトを切り替え中、または別の録音が進行中です。完了してから再試行してください。';
    default:
      return studioAudioActionErrorMessage(code);
  }
}

function recordingLatencyCalibrationFailureMessage(error: unknown): string {
  if (!(error instanceof RecordingLatencyCalibrationError)) {
    return '録音レイテンシを実測できませんでした。接続を確認して再試行してください。';
  }
  switch (error.code) {
    case 'permission-denied':
      return 'マイクの使用が許可されませんでした。OSの設定でこのアプリのマイクを許可してください。';
    case 'device-not-found':
      return '校正に使う入力が見つかりません。ケーブルと入力デバイスを確認してください。';
    case 'device-busy':
    case 'busy':
      return '入力デバイスが使用中です。ほかの録音を終了してから再試行してください。';
    case 'device-ended':
      return '校正中に入力デバイスが切断されました。接続を確認してください。';
    case 'insecure-context':
    case 'unsupported':
      return 'この環境では実測校正を安全に実行できません。推定補正または手動補正を使用してください。';
    case 'silence':
      return '戻ってきたテスト信号を検出できません。出力から選択中の入力へケーブルを接続し、音量を少し上げてください。';
    case 'clipped':
      return '戻り信号が大きすぎて歪んでいます。出力または入力ゲインを下げてください。';
    case 'ambiguous':
    case 'low-confidence':
      return '戻り信号を一つに特定できません。スピーカーを使わず、ケーブル接続と周囲の音を確認してください。';
    case 'out-of-range':
      return '往復レイテンシが測定範囲（500 ms）を超えました。接続先とドライバー設定を確認してください。';
    case 'context-changed':
    case 'synchronization-failed':
    case 'probe-scheduling-failed':
    case 'stale-operation':
      return '校正中にオーディオ時計またはデバイスが変わりました。接続を固定して再試行してください。';
    case 'cancelled':
      return '';
    case 'audio-context-failed':
    case 'capture-failed':
    case 'invalid-sample-rate':
    case 'invalid-probe':
    case 'invalid-pcm':
    case 'non-finite-pcm':
    case 'empty-channel':
    case 'channel-length-mismatch':
      return 'テスト信号を安全に解析できませんでした。オーディオ設定を確認して再試行してください。';
  }
}

/** Record one dry take or one atomic fixed-pass cycle to a frozen Audio Track target. */
export function AudioTrackRecordingDialog({
  trackName,
  targetTrackId,
  onClose,
  onCreated,
  onBack,
}: AudioTrackRecordingDialogProps) {
  const [phase, setPhase] = useState<RecordingPhase>('idle');
  const [monitorInput, setMonitorInput] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<readonly MicrophoneInputDevice[]>([]);
  const [inputDeviceListPhase, setInputDeviceListPhase] = useState<
    'loading' | 'ready' | 'unsupported' | 'error'
  >('loading');
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<string | null>(
    useStore.getState().preferredMicrophoneInputDeviceId,
  );
  const [latencyCompensationMode, setLatencyCompensationMode] =
    useState<RecordingLatencyCompensationMode>(
      useStore.getState().recordingLatencyCompensationMode,
    );
  const [latencyAdjustmentText, setLatencyAdjustmentText] = useState(
    String(useStore.getState().recordingLatencyAdjustmentMs),
  );
  const [calibrationView, setCalibrationView] = useState<CalibrationView>('closed');
  const [calibrationCountdown, setCalibrationCountdown] = useState(3);
  const [calibrationStatus, setCalibrationStatus] = useState<string | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  // Appended after the established state slots because interaction tests freeze
  // selected setup values by hook index.
  const [cyclePassCount, setCyclePassCount] = useState(3);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const recordingHandleRef = useRef<StudioAudioTrackRecordingHandle | null>(null);
  const synchronizedPlaybackRequestIdRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<MicrophoneCaptureSession | null>(null);
  const cancelRequestedRef = useRef(false);
  const finalizingRef = useRef(false);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const processingStatusRef = useRef<HTMLParagraphElement>(null);
  const inputDeviceRefreshGenerationRef = useRef(0);
  const captureStopRequestedRef = useRef(false);
  const calibrationHandleRef =
    useRef<StudioRecordingLatencyCalibrationHandle | null>(null);
  const calibrationAbortRef = useRef<AbortController | null>(null);
  const calibrationGenerationRef = useRef(0);
  const calibrationStepFocusRef = useRef<HTMLButtonElement>(null);
  const activeTakeLatencyModeRef =
    useRef<RecordingLatencyCompensationMode | null>(null);
  const activeCycleRef = useRef<StudioAudioCycleRecording | null>(null);
  const activePunchRef = useRef<StudioAudioPunchRecording | null>(null);
  const punchCoordinatorRef = useRef<PunchRecordingCoordinator | null>(null);
  const pendingPunchCaptureRef = useRef<Readonly<{
    capture: MicrophonePcmCapture;
    generation: number;
  }> | null>(null);
  const cycleTransportInterruptedRef = useRef(false);
  const punchTransportInterruptedRef = useRef(false);
  const completedCyclePlaybackRequestIdRef = useRef<number | null>(null);
  const completedPunchPlaybackRequestIdRef = useRef<number | null>(null);

  const discardRecordingOwnership = (): void => {
    const handle = recordingHandleRef.current;
    if (!handle) return;
    recordingHandleRef.current = null;
    discardStudioAudioTrackRecording(handle);
  };

  const stopPairedPlayback = (): void => {
    const requestId = synchronizedPlaybackRequestIdRef.current;
    synchronizedPlaybackRequestIdRef.current = null;
    if (requestId !== null) stopSynchronizedRecordingPlayback(requestId);
  };

  const discardCalibrationOwnership = (): void => {
    const handle = calibrationHandleRef.current;
    if (!handle) return;
    calibrationHandleRef.current = null;
    discardStudioRecordingLatencyCalibration(handle);
  };

  const finishCaptureError = (caught: unknown, generation: number): void => {
    captureStopRequestedRef.current = true;
    if (punchCoordinatorRef.current?.getSnapshot().terminal === 'active') {
      if (cancelRequestedRef.current) punchCoordinatorRef.current.cancel();
      else punchCoordinatorRef.current.interrupt();
    }
    punchCoordinatorRef.current = null;
    pendingPunchCaptureRef.current = null;
    activeTakeLatencyModeRef.current = null;
    activeCycleRef.current = null;
    activePunchRef.current = null;
    completedCyclePlaybackRequestIdRef.current = null;
    completedPunchPlaybackRequestIdRef.current = null;
    stopPairedPlayback();
    discardRecordingOwnership();
    if (!mountedRef.current || generation !== generationRef.current) return;
    abortRef.current = null;
    sessionRef.current = null;
    if (cycleTransportInterruptedRef.current) {
      cycleTransportInterruptedRef.current = false;
      setError('伴奏が途中で停止したため、サイクル録音を破棄しました。');
      setStatus('途中までのテイクは保存していません。もう一度最初から録音できます。');
      setLevel(0);
      setPhase('error');
      return;
    }
    if (punchTransportInterruptedRef.current) {
      punchTransportInterruptedRef.current = false;
      setError('伴奏がポストロール端より前に停止したため、パンチ録音を破棄しました。');
      setStatus('録音した音声は保存していません。もう一度最初から録音できます。');
      setLevel(0);
      setPhase('error');
      return;
    }
    if (
      cancelRequestedRef.current
      && caught instanceof MicrophoneCaptureError
      && caught.code === 'cancelled'
    ) {
      onClose();
      return;
    }
    setError(microphoneCaptureFailureMessage(caught));
    setStatus('録音は保存していません。プロジェクトは変更されていません。');
    setLevel(0);
    setPhase('error');
  };

  const finalizeCapture = async (
    capture: MicrophonePcmCapture,
    generation: number,
  ): Promise<void> => {
    const finalizedCycle = activeCycleRef.current;
    const finalizedPunch = activePunchRef.current;
    stopPairedPlayback();
    if (!mountedRef.current || generation !== generationRef.current) {
      discardRecordingOwnership();
      return;
    }
    finalizingRef.current = true;
    sessionRef.current = null;
    setPhase('processing');
    setProgress(0);
    setStatus(
      finalizedCycle
        ? `${finalizedCycle.passCount}テイクを48 kHzのWAVへ変換しています…`
        : finalizedPunch
          ? 'パンチ範囲を48 kHzのWAVへ変換しています…'
          : '録音を48 kHzのWAVへ変換しています…',
    );
    const controller = new AbortController();
    abortRef.current = controller;
    const recordingHandle = recordingHandleRef.current;
    recordingHandleRef.current = null;
    const appliedLatencyCompensationMode =
      activeTakeLatencyModeRef.current ?? latencyCompensationMode;

    try {
      if (!recordingHandle) {
        throw new Error('recording ownership was lost');
      }
      const result = await recordStudioAudioTrack({
        recordingHandle,
        capture,
        signal: controller.signal,
        trackName,
        fileName: `${trackName.trim() || 'マイク録音'}.wav`,
        onProgress: (next) => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setProgress(Math.round(Math.max(0, Math.min(1, next.fraction)) * 100));
          setStatus(
            finalizedCycle
              ? next.phase === 'resampling'
                ? `${finalizedCycle.passCount}テイクを48 kHzへ変換しています…`
                : `${finalizedCycle.passCount}テイクのプロジェクト用WAVを作成しています…`
              : finalizedPunch
                ? next.phase === 'resampling'
                  ? 'パンチ範囲を48 kHzへ変換しています…'
                  : 'パンチ範囲のプロジェクト用WAVを作成しています…'
                : next.phase === 'resampling'
                  ? '録音を48 kHzへ変換しています…'
                  : 'プロジェクト用WAVを作成しています…',
          );
        },
      });
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (!result.ok) {
        if (result.code === 'cancelled' && cancelRequestedRef.current) {
          onClose();
          return;
        }
        setProgress(null);
        setError(`${studioAudioActionErrorMessage(result.code)} プロジェクトは変更されていません。`);
        setStatus('録音をオーディオトラックへ保存できませんでした。');
        setPhase('error');
        return;
      }
      const deduplicated = result.deduplicated
        ? ' 同じ音声素材は重複保存していません。'
        : '';
      const compensation = appliedLatencyCompensationMode === 'calibrated'
        ? ' 実測レイテンシ補正を適用しました。'
        : appliedLatencyCompensationMode === 'estimated'
          ? ' 推定レイテンシ補正を適用しました。'
          : Number(latencyAdjustmentText) === 0
            ? ''
            : ' 手動の録音位置補正を適用しました。';
      pushToast(
        finalizedPunch && 'takeCount' in result
          ? `「${result.trackName}」のパンチ範囲へ新しいテイクを保存して採用しました。${compensation}${deduplicated}`
          : finalizedPunch
            ? `「${result.trackName}」の空いていたパンチ範囲へ録音を配置しました。${compensation}${deduplicated}`
            : 'takeCount' in result
          ? `「${result.trackName}」へ${result.takeCount}テイクを保存し、テイクフォルダを作成しました。${compensation}${deduplicated}`
          : `「${result.trackName}」へ録音を保存し、伴奏と同期した位置へ配置しました。${compensation}${deduplicated}`,
        'success',
      );
      onCreated(result.trackId);
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setProgress(null);
      setError(
        controller.signal.aborted
          ? null
          : `${microphoneCaptureFailureMessage(caught)} プロジェクトは変更されていません。`,
      );
      setStatus(
        controller.signal.aborted
          ? '録音の保存を中止しました。プロジェクトは変更されていません。'
          : '録音をオーディオトラックへ保存できませんでした。',
      );
      if (controller.signal.aborted && cancelRequestedRef.current) onClose();
      else setPhase('error');
    } finally {
      activeTakeLatencyModeRef.current = null;
      activeCycleRef.current = null;
      activePunchRef.current = null;
      punchCoordinatorRef.current = null;
      pendingPunchCaptureRef.current = null;
      cycleTransportInterruptedRef.current = false;
      punchTransportInterruptedRef.current = false;
      completedCyclePlaybackRequestIdRef.current = null;
      completedPunchPlaybackRequestIdRef.current = null;
      finalizingRef.current = false;
      abortRef.current = null;
    }
  };

  const beginLatencyCalibration = async (): Promise<void> => {
    if (calibrationHandleRef.current !== null || calibrationView === 'running') return;
    const ownership = beginStudioRecordingLatencyCalibration();
    if (!ownership.ok) {
      setCalibrationError(recordingBeginFailureMessage(ownership.code));
      setCalibrationStatus('校正は開始していません。前回の設定は変更していません。');
      setCalibrationView('error');
      return;
    }
    calibrationHandleRef.current = ownership.handle;
    const generation = ++calibrationGenerationRef.current;
    const controller = new AbortController();
    calibrationAbortRef.current = controller;
    setCalibrationError(null);
    setCalibrationStatus('マイクの使用許可を待っています…');
    setCalibrationCountdown(3);
    setCalibrationView('running');

    try {
      const result = await startRecordingLatencyCalibration({
        signal: controller.signal,
        inputDeviceId: ownership.inputDeviceId,
        onCountdown: (secondsRemaining) => {
          if (!mountedRef.current || generation !== calibrationGenerationRef.current) return;
          setCalibrationCountdown(secondsRemaining);
          setCalibrationStatus(`テスト信号まで${secondsRemaining}秒…`);
        },
        onPreparing: () => {
          if (!mountedRef.current || generation !== calibrationGenerationRef.current) return;
          setCalibrationCountdown(0);
          setCalibrationStatus('低レベルのテスト信号を送り、往復時間を測っています…');
        },
        onLevel: (nextLevel) => {
          if (!mountedRef.current || generation !== calibrationGenerationRef.current) return;
          setLevel(nextLevel);
        },
      });
      if (controller.signal.aborted) {
        throw new RecordingLatencyCalibrationError('cancelled');
      }
      if (!mountedRef.current || generation !== calibrationGenerationRef.current) {
        discardCalibrationOwnership();
        return;
      }
      const handle = calibrationHandleRef.current;
      calibrationHandleRef.current = null;
      if (!handle || !commitStudioRecordingLatencyCalibration(handle, result)) {
        throw new RecordingLatencyCalibrationError('stale-operation');
      }
      calibrationAbortRef.current = null;
      setLatencyCompensationMode('calibrated');
      setCalibrationStatus(
        `往復 ${result.roundTripLatencySeconds * 1_000 < 10
          ? (result.roundTripLatencySeconds * 1_000).toFixed(2)
          : (result.roundTripLatencySeconds * 1_000).toFixed(1)} ms`
        + `（${result.latencyFrames} samples）を録音位置補正へ適用しました。`,
      );
      setCalibrationError(null);
      setCalibrationView('success');
    } catch (caught) {
      discardCalibrationOwnership();
      calibrationAbortRef.current = null;
      const inputRouteChanged =
        controller.signal.reason === CALIBRATION_INPUT_ROUTE_CHANGED;
      if (inputRouteChanged) {
        useStore.getState().clearRecordingLatencyCalibration();
      }
      if (!mountedRef.current || generation !== calibrationGenerationRef.current) return;
      if (inputRouteChanged) {
        setLatencyCompensationMode(
          useStore.getState().recordingLatencyCompensationMode,
        );
        setCalibrationStatus(
          '入力デバイス構成が変わったため校正を中止し、以前の実測値も破棄しました。',
        );
        setCalibrationError(null);
        setCalibrationView('instructions');
        return;
      }
      if (
        controller.signal.aborted
        || (caught instanceof RecordingLatencyCalibrationError && caught.code === 'cancelled')
      ) {
        setCalibrationStatus('校正を中止しました。前回の設定は変更していません。');
        setCalibrationError(null);
        setCalibrationView('instructions');
        return;
      }
      setCalibrationError(recordingLatencyCalibrationFailureMessage(caught));
      setCalibrationStatus('実測値は変更していません。接続を確認して再試行できます。');
      setCalibrationView('error');
    } finally {
      setLevel(0);
    }
  };

  const beginRecording = async (): Promise<void> => {
    if (
      recordingHandleRef.current !== null
      || (phase !== 'idle' && phase !== 'error')
    ) return;
    activeTakeLatencyModeRef.current = null;
    activeCycleRef.current = null;
    activePunchRef.current = null;
    punchCoordinatorRef.current = null;
    pendingPunchCaptureRef.current = null;
    cycleTransportInterruptedRef.current = false;
    punchTransportInterruptedRef.current = false;
    completedCyclePlaybackRequestIdRef.current = null;
    completedPunchPlaybackRequestIdRef.current = null;
    const frozenLatencyAdjustmentMs = Number(latencyAdjustmentText);
    if (
      !Number.isSafeInteger(frozenLatencyAdjustmentMs)
      || frozenLatencyAdjustmentMs < MIN_RECORDING_LATENCY_ADJUSTMENT_MS
      || frozenLatencyAdjustmentMs > MAX_RECORDING_LATENCY_ADJUSTMENT_MS
      || !useStore.getState().setRecordingLatencyAdjustmentMs(frozenLatencyAdjustmentMs)
    ) {
      setError('手動補正は-500 msから+500 msの整数で入力してください。');
      setStatus('録音は開始していません。');
      setPhase('error');
      return;
    }
    const frozenInputDeviceId = selectedInputDeviceId;
    const frozenLatencyCompensationMode =
      useStore.getState().recordingLatencyCompensationMode;
    const cycleRequested = useStore.getState().transport.loopEnabled;
    const ownership = beginStudioAudioTrackRecording({
      target: targetTrackId === undefined
        ? { kind: 'new-track', trackName }
        : { kind: 'existing-audio-track', trackId: targetTrackId },
      ...(cycleRequested ? { cyclePassCount: effectiveCyclePassCount } : {}),
    });
    if (!ownership.ok) {
      setError(recordingBeginFailureMessage(ownership.code));
      setStatus('録音は開始していません。');
      setPhase('error');
      return;
    }
    recordingHandleRef.current = ownership.handle;
    activeTakeLatencyModeRef.current = frozenLatencyCompensationMode;
    activeCycleRef.current = ownership.cycle ?? null;
    activePunchRef.current = ownership.punch ?? null;
    const projectSnapshot = useStore.getState().project;
    const engineActivation = getAudioEngine().ensureContext();
    void engineActivation.catch(() => undefined);
    const generation = ++generationRef.current;
    if (ownership.punch !== null) {
      punchCoordinatorRef.current = createPunchRecordingCoordinator({
        onFinalize: () => {
          queueMicrotask(() => {
            const pending = pendingPunchCaptureRef.current;
            if (
              pending === null
              || pending.generation !== generation
              || generation !== generationRef.current
            ) {
              return;
            }
            pendingPunchCaptureRef.current = null;
            void finalizeCapture(pending.capture, pending.generation);
          });
        },
        onDiscard: () => {
          pendingPunchCaptureRef.current = null;
        },
      });
    }
    cancelRequestedRef.current = false;
    captureStopRequestedRef.current = false;
    setError(null);
    setStatus(null);
    setProgress(null);
    setElapsedSeconds(0);
    setLevel(0);
    setPhase('requesting');

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const activated = await awaitAudioActivationOrCancel(engineActivation, controller.signal);
      if (!mountedRef.current || generation !== generationRef.current) {
        throw new MicrophoneCaptureError('cancelled');
      }
      const latencyState = useStore.getState();
      const calibration = latencyState.recordingLatencyCalibration;
      if (
        latencyState.recordingLatencyCompensationMode === 'calibrated'
        && (
          calibration === null
          || calibration.inputDeviceId !== frozenInputDeviceId
          || calibration.contextGeneration !== activated.contextGeneration
          || calibration.sampleRate !== activated.context.sampleRate
        )
      ) {
        abortRef.current = null;
        activeTakeLatencyModeRef.current = null;
        discardRecordingOwnership();
        useStore.getState().clearRecordingLatencyCalibration();
        setLatencyCompensationMode('estimated');
        setError(
          '実測校正が現在の入力またはオーディオ時計と一致しません。'
          + '録音前にもう一度「実測校正」を行ってください。',
        );
        setStatus('録音は開始していません。推定補正へ戻しました。');
        setPhase('error');
        return;
      }
      const session = await startMicrophoneCapture({
        signal: controller.signal,
        countdownSeconds: 3,
        maxDurationSeconds: MAX_MICROPHONE_CAPTURE_SECONDS,
        ...(frozenInputDeviceId ? { inputDeviceId: frozenInputDeviceId } : {}),
        monitorInput,
        borrowedAudioContext: {
          context: activated.context,
          contextGeneration: activated.contextGeneration,
        },
        synchronize: async ({
          context,
          contextGeneration,
          inputLatencySeconds,
          armAtFrame,
        }) => {
          if (
            context !== activated.context
            || contextGeneration !== activated.contextGeneration
          ) {
            throw new MicrophoneCaptureError('synchronization-failed');
          }
          const preparedCycle = ownership.cycle === null
            ? null
            : prepareStudioAudioTrackCycleCapture(ownership.handle, {
                context,
                contextGeneration,
                inputLatencySeconds,
              });
          const preparedPunch = ownership.punch === null
            ? null
            : prepareStudioAudioTrackPunchCapture(ownership.handle, {
                context,
                contextGeneration,
                inputLatencySeconds,
              });
          if (preparedCycle !== null && !preparedCycle.ok) {
            throw new MicrophoneCaptureError('synchronization-failed');
          }
          if (preparedPunch !== null && !preparedPunch.ok) {
            throw new MicrophoneCaptureError('synchronization-failed');
          }
          const clock = await startSynchronizedRecordingPlayback({
            operationId: ownership.handle.operationId,
            projectSnapshot,
            startBeat: ownership.startBeat,
            signal: controller.signal,
            ...(preparedCycle === null ? {} : { cycle: preparedCycle.cycle }),
            ...(preparedPunch === null ? {} : { punch: preparedPunch.punch }),
            ...(preparedCycle === null
              ? {}
              : {
                  onFiniteCycleComplete: (requestId: number) => {
                    completedCyclePlaybackRequestIdRef.current = requestId;
                  },
                }),
            ...(preparedPunch === null
              ? {}
              : {
                  onFinitePunchComplete: (requestId: number) => {
                    if (!markStudioAudioTrackPunchPostrollComplete(
                      ownership.handle,
                      requestId,
                    )) {
                      punchTransportInterruptedRef.current = true;
                      punchCoordinatorRef.current?.interrupt();
                      captureStopRequestedRef.current = true;
                      sessionRef.current?.cancel();
                      return;
                    }
                    completedPunchPlaybackRequestIdRef.current = requestId;
                    punchCoordinatorRef.current?.signalPostrollComplete();
                  },
                }),
            armCapture: async (playbackContext, startFrame, playbackGeneration) => {
              if (
                playbackContext !== context
                || playbackGeneration !== contextGeneration
              ) {
                throw new MicrophoneCaptureError('synchronization-failed');
              }
              if (preparedCycle === null && preparedPunch === null) {
                await armAtFrame(startFrame);
              } else if (preparedCycle !== null) {
                await armAtFrame(
                  startFrame,
                  preparedCycle.effectiveCaptureFrameCount,
                );
              } else {
                await armAtFrame(
                  startFrame,
                  preparedPunch!.effectiveCaptureFrameCount,
                );
              }
            },
          });
          synchronizedPlaybackRequestIdRef.current = clock.requestId;
          if (!bindStudioAudioTrackRecordingToPlayback(ownership.handle, clock)) {
            stopPairedPlayback();
            throw new MicrophoneCaptureError('synchronization-failed');
          }
        },
        onCountdown: (secondsRemaining) => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setCountdown(secondsRemaining);
          setPhase('countdown');
        },
        onPreparing: () => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setPhase('preparing');
        },
        onLevel: (nextLevel) => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setLevel(nextLevel);
        },
      });
      if (!mountedRef.current || generation !== generationRef.current) {
        session.cancel();
        void session.result.then(
          () => discardRecordingOwnership(),
          () => discardRecordingOwnership(),
        );
        return;
      }
      abortRef.current = null;
      sessionRef.current = session;
      void session.result.then(
        (capture) => {
          captureStopRequestedRef.current = true;
          if (activePunchRef.current === null) stopPairedPlayback();
          if (cancelRequestedRef.current) {
            punchCoordinatorRef.current?.cancel();
            punchCoordinatorRef.current = null;
            pendingPunchCaptureRef.current = null;
            activeTakeLatencyModeRef.current = null;
            activeCycleRef.current = null;
            activePunchRef.current = null;
            completedCyclePlaybackRequestIdRef.current = null;
            completedPunchPlaybackRequestIdRef.current = null;
            discardRecordingOwnership();
            if (mountedRef.current && generation === generationRef.current) {
              sessionRef.current = null;
              onClose();
            }
            return;
          }
          if (
            activePunchRef.current !== null
            && capture.stopReason !== 'duration-limit'
          ) {
            punchCoordinatorRef.current?.interrupt();
            punchCoordinatorRef.current = null;
            pendingPunchCaptureRef.current = null;
            activeTakeLatencyModeRef.current = null;
            activePunchRef.current = null;
            completedPunchPlaybackRequestIdRef.current = null;
            stopPairedPlayback();
            discardRecordingOwnership();
            if (mountedRef.current && generation === generationRef.current) {
              sessionRef.current = null;
              setError('パンチアウトまで録音できなかったため、録音を破棄しました。');
              setStatus('途中までの音声は保存していません。');
              setLevel(0);
              setPhase('error');
            }
            return;
          }
          if (
            activeCycleRef.current !== null
            && capture.stopReason !== 'duration-limit'
          ) {
            activeTakeLatencyModeRef.current = null;
            activeCycleRef.current = null;
            completedCyclePlaybackRequestIdRef.current = null;
            discardRecordingOwnership();
            if (mountedRef.current && generation === generationRef.current) {
              sessionRef.current = null;
              setError('サイクル録音が予定テイク数まで完了しなかったため、録音を破棄しました。');
              setStatus('途中までのテイクは保存していません。');
              setLevel(0);
              setPhase('error');
            }
            return;
          }
          if (activePunchRef.current !== null) {
            pendingPunchCaptureRef.current = { capture, generation };
            const coordinator = punchCoordinatorRef.current;
            if (!coordinator || !coordinator.signalCaptureComplete()) {
              pendingPunchCaptureRef.current = null;
              stopPairedPlayback();
              discardRecordingOwnership();
              if (mountedRef.current && generation === generationRef.current) {
                sessionRef.current = null;
                setError('パンチ録音の完了順序を安全に確認できなかったため破棄しました。');
                setStatus('プロジェクトは変更していません。');
                setPhase('error');
              }
              return;
            }
            if (coordinator.getSnapshot().terminal === 'active') {
              if (mountedRef.current && generation === generationRef.current) {
                setPhase('postroll');
                setStatus('パンチアウトしました。伴奏のポストロール完了を待っています…');
                setLevel(0);
              }
            }
            return;
          }
          return finalizeCapture(capture, generation);
        },
        (caught: unknown) => finishCaptureError(caught, generation),
      );
      const pairedRequestId = synchronizedPlaybackRequestIdRef.current;
      const transport = useStore.getState().transport;
      if (
        pairedRequestId === null
        || transport.phase !== 'playing'
        || transport.playbackRequestId !== pairedRequestId
      ) {
        const completedFinitePlayback = ownership.cycle !== null
          && transport.phase === 'stopped'
          && pairedRequestId !== null
          && completedCyclePlaybackRequestIdRef.current === pairedRequestId;
        const completedPunchPlayback = ownership.punch !== null
          && transport.phase === 'stopped'
          && pairedRequestId !== null
          && completedPunchPlaybackRequestIdRef.current === pairedRequestId;
        if (completedFinitePlayback || completedPunchPlayback) {
          // A very short finite cycle may have reached its Nth right boundary
          // while the microphone session promise was settling. Its positive
          // input-latency tail must still complete at the exact armed frame.
          setPhase('recording');
        } else if (ownership.cycle !== null) {
          cycleTransportInterruptedRef.current = true;
          captureStopRequestedRef.current = true;
          setPhase('stopping');
          session.cancel();
        } else if (ownership.punch !== null) {
          punchTransportInterruptedRef.current = true;
          punchCoordinatorRef.current?.interrupt();
          captureStopRequestedRef.current = true;
          setPhase('stopping');
          session.cancel();
        } else {
          captureStopRequestedRef.current = true;
          setPhase('stopping');
          void session.stop().catch(() => undefined);
        }
      } else {
        setPhase('recording');
      }
    } catch (caught) {
      finishCaptureError(caught, generation);
    }
  };

  const cancelRecording = (): void => {
    if (phase === 'idle' || phase === 'error') {
      onClose();
      return;
    }
    cancelRequestedRef.current = true;
    captureStopRequestedRef.current = true;
    setPhase(phase === 'processing' ? 'processing' : 'stopping');
    if (phase === 'processing') setStatus('保存処理を安全に中止しています…');
    const completedPunchCapture =
      punchCoordinatorRef.current?.getSnapshot().captureComplete === true;
    punchCoordinatorRef.current?.cancel();
    abortRef.current?.abort();
    sessionRef.current?.cancel();
    stopPairedPlayback();
    if (completedPunchCapture) {
      punchCoordinatorRef.current = null;
      pendingPunchCaptureRef.current = null;
      activePunchRef.current = null;
      completedPunchPlaybackRequestIdRef.current = null;
      sessionRef.current = null;
      discardRecordingOwnership();
      onClose();
    }
  };

  const closeOrCancelLatencyCalibration = (): void => {
    if (calibrationView === 'running') {
      setCalibrationStatus('校正を安全に中止しています…');
      calibrationAbortRef.current?.abort();
      return;
    }
    setCalibrationError(null);
    setCalibrationStatus(null);
    setCalibrationView('closed');
    setLatencyCompensationMode(useStore.getState().recordingLatencyCompensationMode);
  };

  const stopRecording = (): void => {
    if (phase !== 'recording' || !sessionRef.current) return;
    if (activeCycleRef.current !== null || activePunchRef.current !== null) {
      // A finite cycle is atomic: a user stop never adopts the completed
      // prefix, and Auto Punch never adopts before its natural post-roll.
      cancelRecording();
      return;
    }
    captureStopRequestedRef.current = true;
    setPhase('stopping');
    stopPairedPlayback();
    void sessionRef.current.stop().catch(() => undefined);
  };

  useEffect(() => {
    if (phase !== 'recording') return;
    const updateElapsed = (): void => {
      const session = sessionRef.current;
      if (session) setElapsedSeconds(session.elapsedSeconds());
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 100);
    return () => window.clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (calibrationView === 'closed') startButtonRef.current?.focus();
      else calibrationStepFocusRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [calibrationView]);

  useEffect(() => {
    if (!['requesting', 'countdown', 'preparing', 'recording', 'postroll', 'processing', 'error'].includes(phase)) return;
    const frame = window.requestAnimationFrame(() => {
      if (phase === 'recording' || phase === 'postroll') stopButtonRef.current?.focus();
      else if (phase === 'processing') processingStatusRef.current?.focus();
      else if (phase === 'error') startButtonRef.current?.focus();
      else cancelButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'idle' && phase !== 'error') return;
    let active = true;

    const refresh = async (): Promise<void> => {
      const generation = ++inputDeviceRefreshGenerationRef.current;
      setInputDeviceListPhase('loading');
      try {
        const devices = await enumerateMicrophoneInputDevices();
        if (!active || generation !== inputDeviceRefreshGenerationRef.current) return;
        // An empty id is indistinguishable from the explicit system-default option.
        setInputDevices(devices.filter((device) => device.deviceId.length > 0));
        setInputDeviceListPhase('ready');
      } catch (caught) {
        if (!active || generation !== inputDeviceRefreshGenerationRef.current) return;
        setInputDevices([]);
        setInputDeviceListPhase(
          caught instanceof MicrophoneInputDeviceError && caught.code === 'unsupported'
            ? 'unsupported'
            : 'error',
        );
      }
    };

    void refresh();
    let unsubscribe = (): void => undefined;
    try {
      unsubscribe = subscribeToMicrophoneInputDeviceChanges(() => {
        if (calibrationView === 'running') {
          calibrationAbortRef.current?.abort(CALIBRATION_INPUT_ROUTE_CHANGED);
        } else if (useStore.getState().clearRecordingLatencyCalibration()) {
          setLatencyCompensationMode(
            useStore.getState().recordingLatencyCompensationMode,
          );
        }
        void refresh();
      });
    } catch {
      // Device enumeration can still work when a host does not expose change events.
    }
    return () => {
      active = false;
      inputDeviceRefreshGenerationRef.current += 1;
      unsubscribe();
    };
  }, [calibrationView, phase]);

  useEffect(() => {
    const synchronizeLatencyMode = (): void => {
      setLatencyCompensationMode(
        useStore.getState().recordingLatencyCompensationMode,
      );
    };
    synchronizeLatencyMode();
    return useStore.subscribe((state, previous) => {
      if (
        state.recordingLatencyCompensationMode
        !== previous.recordingLatencyCompensationMode
      ) {
        setLatencyCompensationMode(state.recordingLatencyCompensationMode);
      }
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeTransport = useStore.subscribe((state, previous) => {
      if (
        previous.transport.phase !== 'stopped'
        && state.transport.phase === 'stopped'
        && sessionRef.current !== null
        && !cancelRequestedRef.current
        && !finalizingRef.current
      ) {
        if (activePunchRef.current !== null) {
          const reachedPostrollBoundary =
            synchronizedPlaybackRequestIdRef.current !== null
            && completedPunchPlaybackRequestIdRef.current
              === synchronizedPlaybackRequestIdRef.current;
          if (reachedPostrollBoundary) {
            // The capture may still be collecting only its frozen positive
            // latency tail. Natural post-roll completion is not interruption.
            return;
          }
          const captureAlreadyComplete =
            punchCoordinatorRef.current?.getSnapshot().captureComplete === true;
          punchTransportInterruptedRef.current = true;
          punchCoordinatorRef.current?.interrupt();
          captureStopRequestedRef.current = true;
          setPhase('stopping');
          stopPairedPlayback();
          if (captureAlreadyComplete) {
            sessionRef.current = null;
            punchCoordinatorRef.current = null;
            pendingPunchCaptureRef.current = null;
            activePunchRef.current = null;
            completedPunchPlaybackRequestIdRef.current = null;
            discardRecordingOwnership();
            setError('伴奏がポストロール端より前に停止したため、パンチ録音を破棄しました。');
            setStatus('録音した音声は保存していません。');
            setLevel(0);
            setPhase('error');
          } else {
            sessionRef.current.cancel();
          }
          return;
        }
        if (captureStopRequestedRef.current) return;
        if (activeCycleRef.current !== null) {
          const reachedFinalBoundary =
            synchronizedPlaybackRequestIdRef.current !== null
            && completedCyclePlaybackRequestIdRef.current
              === synchronizedPlaybackRequestIdRef.current;
          if (reachedFinalBoundary) {
            // Finite cycle playback naturally rewinds at the Nth right
            // boundary. Capture can extend beyond it by the frozen positive
            // input-latency tail, so do not stop the microphone here.
            return;
          }
          cycleTransportInterruptedRef.current = true;
          captureStopRequestedRef.current = true;
          setPhase('stopping');
          sessionRef.current.cancel();
          stopPairedPlayback();
          return;
        }
        captureStopRequestedRef.current = true;
        setPhase('stopping');
        void sessionRef.current.stop().catch(() => undefined);
      }
    });
    return () => {
      unsubscribeTransport();
      mountedRef.current = false;
      generationRef.current += 1;
      const captureCleanupPending = abortRef.current !== null || sessionRef.current !== null;
      const completedPunchCapture =
        punchCoordinatorRef.current?.getSnapshot().captureComplete === true;
      abortRef.current?.abort();
      calibrationAbortRef.current?.abort();
      sessionRef.current?.cancel();
      punchCoordinatorRef.current?.cancel();
      punchCoordinatorRef.current = null;
      pendingPunchCaptureRef.current = null;
      activeTakeLatencyModeRef.current = null;
      activeCycleRef.current = null;
      activePunchRef.current = null;
      completedCyclePlaybackRequestIdRef.current = null;
      completedPunchPlaybackRequestIdRef.current = null;
      stopPairedPlayback();
      // Permission/capture owns browser resources until its promise settles.
      // Its existing success/error callback releases the opaque lease after
      // the worklet, stream, and AudioContext have actually been cleaned up.
      if (
        !finalizingRef.current
        && (!captureCleanupPending || completedPunchCapture)
      ) {
        discardRecordingOwnership();
      }
    };
  }, []);

  const closeLocked = !['idle', 'error'].includes(phase);
  const selectedDeviceAbsentFromList = selectedInputDeviceId !== null
    && !inputDevices.some((device) => device.deviceId === selectedInputDeviceId);
  const selectedDeviceMissing = inputDeviceListPhase === 'ready'
    && selectedDeviceAbsentFromList;
  const unavailableSelectedDeviceLabel = selectedDeviceMissing
    ? '前回選択した入力（一覧で未確認）'
    : inputDeviceListPhase === 'loading'
      ? '前回選択した入力（確認中）'
      : '前回選択した入力';
  const recordingTarget = targetTrackId === undefined
    ? '新しいオーディオトラック'
    : `既存トラック「${trackName}」`;
  const currentState = useStore.getState();
  const recordingCycleEnabled = currentState.transport.loopEnabled;
  const recordingPunchEnabled = currentState.transport.punchEnabled;
  let punchDurationSeconds: number | null = null;
  if (recordingPunchEnabled) {
    try {
      const duration = secondsBetweenBeats(
        compileMusicalTime(currentState.project),
        currentState.transport.punchInBeat,
        currentState.transport.punchOutBeat,
      );
      if (Number.isFinite(duration) && duration > 0) {
        punchDurationSeconds = duration;
      }
    } catch {
      punchDurationSeconds = null;
    }
  }
  const punchLatencyTailMayBePositive = (() => {
    const manualSeconds = currentState.recordingLatencyAdjustmentMs / 1_000;
    if (currentState.recordingLatencyCompensationMode === 'off') {
      return manualSeconds > 0;
    }
    if (currentState.recordingLatencyCompensationMode === 'calibrated') {
      const calibration = currentState.recordingLatencyCalibration;
      if (
        calibration === null
        || !Number.isSafeInteger(calibration.latencyFrames)
        || calibration.latencyFrames < 0
        || !Number.isSafeInteger(calibration.sampleRate)
        || calibration.sampleRate <= 0
      ) {
        return true;
      }
      return calibration.latencyFrames / calibration.sampleRate
        + manualSeconds > 0;
    }
    // Host and input latency are only frozen after the shared AudioContext and
    // exact input stream exist, so estimated mode must reserve positive tail.
    return true;
  })();
  const punchDurationLeavesNoLatencyTailRoom =
    recordingPunchEnabled
    && punchDurationSeconds !== null
    && punchDurationSeconds >= MAX_MICROPHONE_CAPTURE_SECONDS - 1e-9
    && punchLatencyTailMayBePositive;
  const punchConfigurationValid = !recordingPunchEnabled
    || (
      targetTrackId !== undefined
      && !recordingCycleEnabled
      && punchDurationSeconds !== null
      && punchDurationSeconds >= MIN_MICROPHONE_CAPTURE_SECONDS
      && punchDurationSeconds <= MAX_MICROPHONE_CAPTURE_SECONDS
      && !punchDurationLeavesNoLatencyTailRoom
    );
  let cyclePassDurationSeconds: number | null = null;
  if (recordingCycleEnabled) {
    try {
      const duration = secondsBetweenBeats(
        compileMusicalTime(currentState.project),
        currentState.transport.loopStartBeat,
        currentState.transport.loopEndBeat,
      );
      if (Number.isFinite(duration) && duration > 0) {
        cyclePassDurationSeconds = duration;
      }
    } catch {
      cyclePassDurationSeconds = null;
    }
  }
  const maximumCyclePassCount = cyclePassDurationSeconds === null
    ? 0
    : Math.min(
        MAX_AUDIO_TAKES_PER_FOLDER,
        Math.floor(MAX_MICROPHONE_CAPTURE_SECONDS / cyclePassDurationSeconds),
      );
  const requiredMinimumCyclePassCount = cyclePassDurationSeconds === null
    ? 2
    : Math.max(
        2,
        Math.ceil(MIN_MICROPHONE_CAPTURE_SECONDS / cyclePassDurationSeconds),
      );
  const minimumCyclePassCount = Math.min(
    MAX_AUDIO_TAKES_PER_FOLDER,
    requiredMinimumCyclePassCount,
  );
  const cycleConfigurationValid = !recordingCycleEnabled
    || maximumCyclePassCount >= requiredMinimumCyclePassCount;
  const recordingConfigurationValid =
    cycleConfigurationValid && punchConfigurationValid;
  const effectiveCyclePassCount = recordingCycleEnabled
    ? Math.min(
        Math.max(minimumCyclePassCount, maximumCyclePassCount),
        Math.max(minimumCyclePassCount, cyclePassCount),
      )
    : cyclePassCount;
  const totalCycleDurationSeconds = cyclePassDurationSeconds === null
    ? null
    : cyclePassDurationSeconds * effectiveCyclePassCount;
  const activeCycle = activeCycleRef.current;
  const activePunch = activePunchRef.current;
  const activeCyclePassDurationSeconds = activeCycle === null
    ? null
    : cyclePassDurationSeconds;
  const activeCyclePassNumber = activeCycle === null
    || activeCyclePassDurationSeconds === null
    ? null
    : Math.min(
        activeCycle.passCount,
        Math.floor(elapsedSeconds / activeCyclePassDurationSeconds) + 1,
      );
  const activeCalibration = useStore.getState().recordingLatencyCalibration;
  const selectedInputLabel = selectedInputDeviceId === null
    ? 'システム既定の入力'
    : inputDevices.find((device) => device.deviceId === selectedInputDeviceId)?.label
      ?? unavailableSelectedDeviceLabel;

  if (calibrationView !== 'closed') {
    return (
      <Dialog
        title="録音レイテンシを実測校正"
        className="dialog--audio-track-recording"
        onClose={closeOrCancelLatencyCalibration}
        closeDisabled={calibrationView === 'running'}
        busy={calibrationView === 'running'}
      >
        <div className="audio-track-recording audio-track-recording__calibration">
          {calibrationView === 'instructions' || calibrationView === 'error' ? (
            <>
              <p className="audio-track-recording__lead">
                現在の出力から「{selectedInputLabel}」へ戻る時間を、短いテスト信号で実測します。
                音声や測定用PCMは保存せず、プロジェクトも変更しません。
              </p>
              <ol className="audio-track-recording__calibration-steps">
                <li>スピーカーをOFFにし、オーディオ出力から選択中の入力へケーブルを接続します。</li>
                <li>出力と入力の音量を低めにします。大きな音やハウリングを避けるため、開放スピーカーとマイクでは実行しないでください。</li>
                <li>オーディオinterface本体とdriver mixerのDirect Monitor / LoopbackをOFFにし、戻り入力を同じ出力へ送り返さないでください。</li>
                <li>「3秒後に実測」を押し、接続と音量を変えずに完了を待ちます。</li>
              </ol>
              <p className="audio-track-recording__calibration-note">
                出力先、入力先、ドライバー設定を変えた場合は再校正してください。
                ブラウザはシステム出力名を確実に取得できないため、自動判定はできません。
              </p>
              {calibrationError ? (
                <p className="track-management__error" role="alert">{calibrationError}</p>
              ) : null}
              {calibrationStatus ? (
                <p className="audio-track-recording__status" role="status">
                  {calibrationStatus}
                </p>
              ) : null}
              <div className="audio-track-recording__actions">
                <button
                  ref={calibrationStepFocusRef}
                  type="button"
                  className="track-management__primary"
                  data-modal-initial-focus
                  disabled={selectedDeviceMissing || selectedInputDeviceId === null}
                  onClick={() => void beginLatencyCalibration()}
                >
                  3秒後に実測
                </button>
                <button type="button" onClick={closeOrCancelLatencyCalibration}>
                  録音設定へ戻る
                </button>
              </div>
            </>
          ) : null}

          {calibrationView === 'running' ? (
            <>
              <p className="audio-track-recording__countdown" role="status" aria-live="assertive">
                {calibrationCountdown > 0 ? `${calibrationCountdown}` : '測定中'}
              </p>
              <p className="audio-track-recording__status" role="status" aria-live="polite">
                {calibrationStatus ?? '校正を準備しています…'}
              </p>
              <div
                className="audio-track-recording__meter"
                role="meter"
                aria-label="校正入力レベル"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(level * 100)}
              >
                <span style={{ transform: `scaleX(${level})` }} />
              </div>
              <p className="audio-track-recording__calibration-note">
                テスト中は入力モニターを強制的にOFFにしています。
              </p>
              <button
                ref={calibrationStepFocusRef}
                type="button"
                onClick={closeOrCancelLatencyCalibration}
              >
                校正を中止
              </button>
            </>
          ) : null}

          {calibrationView === 'success' ? (
            <>
              <p className="audio-track-recording__calibration-success" role="status">
                実測校正が完了しました
              </p>
              <p>{calibrationStatus}</p>
              <p className="audio-track-recording__calibration-note">
                次の録音から実測値に手動オフセットを加えて配置します。
                出力先または入力先を変えたら再校正してください。
              </p>
              <button
                ref={calibrationStepFocusRef}
                type="button"
                className="track-management__primary"
                data-modal-initial-focus
                onClick={closeOrCancelLatencyCalibration}
              >
                録音設定へ戻る
              </button>
            </>
          ) : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="マイクをオーディオトラックへ録音"
      className="dialog--audio-track-recording"
      onClose={cancelRecording}
      closeDisabled={closeLocked}
      busy={
        phase === 'requesting'
        || phase === 'preparing'
        || phase === 'postroll'
        || phase === 'stopping'
        || phase === 'processing'
      }
    >
      <div className="audio-track-recording">
        <p className="audio-track-recording__lead">
          最大60秒の音声を端末内だけで録音します。3秒のカウント後、準備が整い次第、
          {recordingCycleEnabled
            ? 'ループ左端から伴奏と録音を同時に始め、指定回数をテイクフォルダへまとめます。'
            : recordingPunchEnabled
              ? `プリロールから伴奏を始め、パンチ範囲だけを${recordingTarget}へ非破壊録音します。`
              : `現在位置から伴奏と録音を同時に始め、${recordingTarget}へ配置します。`}
        </p>

        {phase === 'idle' || phase === 'error' ? (
          <>
            <div className="audio-track-recording__input-device">
              <label htmlFor="audio-track-recording-input-device">入力デバイス</label>
              <select
                id="audio-track-recording-input-device"
                value={selectedInputDeviceId ?? ''}
                aria-busy={inputDeviceListPhase === 'loading' || undefined}
                onChange={(event) => {
                  const nextDeviceId = event.target.value || null;
                  if (useStore.getState().setPreferredMicrophoneInputDeviceId(nextDeviceId)) {
                    setSelectedInputDeviceId(nextDeviceId);
                    setLatencyCompensationMode(
                      useStore.getState().recordingLatencyCompensationMode,
                    );
                  }
                }}
              >
                <option value="">システム既定</option>
                {selectedDeviceAbsentFromList ? (
                  <option value={selectedInputDeviceId ?? ''}>
                    {unavailableSelectedDeviceLabel}
                  </option>
                ) : null}
                {inputDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                ))}
              </select>
              {inputDeviceListPhase === 'loading' ? <small>入力一覧を確認しています…</small> : null}
              {inputDeviceListPhase === 'unsupported' || inputDeviceListPhase === 'error' ? (
                <small>入力一覧を取得できません。システム既定のマイクは使用できます。</small>
              ) : null}
              {selectedDeviceMissing ? (
                <small className="is-problem" role="alert">
                  選択した入力を現在の一覧で確認できません。接続を確認するか、別の入力を選んでください。
                </small>
              ) : null}
            </div>
            <fieldset className="audio-track-recording__latency">
              <legend>録音位置補正</legend>
              <label htmlFor="audio-track-recording-latency-mode">自動補正</label>
              <select
                id="audio-track-recording-latency-mode"
                value={latencyCompensationMode}
                aria-describedby="audio-track-recording-latency-help"
                onChange={(event) => {
                  const next = event.currentTarget.value as RecordingLatencyCompensationMode;
                  if (useStore.getState().setRecordingLatencyCompensationMode(next)) {
                    setLatencyCompensationMode(next);
                  }
                }}
              >
                {activeCalibration?.inputDeviceId === selectedInputDeviceId ? (
                  <option value="calibrated">
                    実測（{(activeCalibration.latencyFrames / activeCalibration.sampleRate * 1_000).toFixed(1)} ms）
                  </option>
                ) : null}
                <option value="estimated">自動（推定）</option>
                <option value="off">自動補正なし（手動のみ）</option>
              </select>
              <small id="audio-track-recording-latency-help">
                {latencyCompensationMode === 'calibrated'
                  ? '実測値は現在の入力とオーディオ時計専用です。出力先を変えた場合は再校正してください。'
                  : '自動はブラウザと入力・出力デバイスの申告値による推定です。実測校正ではありません。'}
              </small>
              <button
                type="button"
                className="audio-track-recording__calibration-open"
                disabled={selectedDeviceMissing || selectedInputDeviceId === null}
                aria-describedby={
                  selectedInputDeviceId === null
                    ? 'audio-track-recording-calibration-input-help'
                    : undefined
                }
                onClick={() => {
                  setCalibrationError(null);
                  setCalibrationStatus(null);
                  setCalibrationView('instructions');
                }}
              >
                {activeCalibration?.inputDeviceId === selectedInputDeviceId
                  ? '実測校正をやり直す…'
                  : '実測校正…'}
              </button>
              {selectedInputDeviceId === null ? (
                <small id="audio-track-recording-calibration-input-help">
                  実測校正では接続先を固定するため、入力デバイスを明示選択してください。
                  通常録音はシステム既定のまま利用できます。
                </small>
              ) : null}
              <label htmlFor="audio-track-recording-latency-adjustment">
                手動オフセット（ms）
              </label>
              <input
                id="audio-track-recording-latency-adjustment"
                type="number"
                min={MIN_RECORDING_LATENCY_ADJUSTMENT_MS}
                max={MAX_RECORDING_LATENCY_ADJUSTMENT_MS}
                step={1}
                value={latencyAdjustmentText}
                aria-describedby="audio-track-recording-latency-adjustment-help"
                onChange={(event) => setLatencyAdjustmentText(event.currentTarget.value)}
                onBlur={() => {
                  const next = Number(latencyAdjustmentText);
                  if (
                    Number.isSafeInteger(next)
                    && next >= MIN_RECORDING_LATENCY_ADJUSTMENT_MS
                    && next <= MAX_RECORDING_LATENCY_ADJUSTMENT_MS
                    && useStore.getState().setRecordingLatencyAdjustmentMs(next)
                  ) {
                    setLatencyAdjustmentText(String(next));
                  } else {
                    setLatencyAdjustmentText(
                      String(useStore.getState().recordingLatencyAdjustmentMs),
                    );
                  }
                }}
              />
              <small id="audio-track-recording-latency-adjustment-help">
                正の値で録音を早め、負の値で遅らせます（-500〜+500 ms）。
              </small>
            </fieldset>
            <label className="audio-track-recording__monitor">
              <input
                type="checkbox"
                checked={monitorInput}
                onChange={(event) => setMonitorInput(event.target.checked)}
              />
              <span>
                <strong>録音中に入力を聴く</strong>
                <small>初期値はOFFです。ONにする場合は、ハウリングを防ぐためヘッドホンを使用してください。</small>
              </span>
            </label>
            {recordingPunchEnabled ? (
              <fieldset className="audio-track-recording__latency">
                <legend>オートパンチ録音</legend>
                <p>
                  {currentState.transport.punchInBeat}〜
                  {currentState.transport.punchOutBeat}拍
                  {punchDurationSeconds === null
                    ? ''
                    : `（約${formatCycleDuration(punchDurationSeconds)}）`}
                </p>
                <small>
                  プリロール {currentState.transport.punchPreRollBeats}拍から伴奏を聴き、
                  パンチアウト後も {currentState.transport.punchPostRollBeats}拍だけ再生します。
                  既存素材は元テイクとして残し、新しい録音を採用します。
                </small>
                {!punchConfigurationValid ? (
                  <small className="is-problem" role="alert">
                    {punchDurationLeavesNoLatencyTailRoom
                      ? '正の録音タイミング補正の末尾収録を含めて最大60秒です。パンチ範囲を60秒未満にしてください。'
                      : (
                          <>
                            既存のオーディオトラックをRで録音待機にし、
                            パンチ範囲を0.5〜60秒へ設定してください。
                          </>
                        )}
                  </small>
                ) : null}
              </fieldset>
            ) : null}
            {recordingCycleEnabled ? (
              <fieldset className="audio-track-recording__latency">
                <legend>サイクル録音</legend>
                <label htmlFor="audio-track-recording-cycle-pass-count">
                  テイク数
                </label>
                <input
                  id="audio-track-recording-cycle-pass-count"
                  type="number"
                  min={minimumCyclePassCount}
                  max={Math.max(minimumCyclePassCount, maximumCyclePassCount)}
                  step={1}
                  value={effectiveCyclePassCount}
                  aria-describedby="audio-track-recording-cycle-help"
                  disabled={!cycleConfigurationValid}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value);
                    if (!Number.isSafeInteger(next)) return;
                    setCyclePassCount(
                      Math.min(
                        Math.max(minimumCyclePassCount, maximumCyclePassCount),
                        Math.max(minimumCyclePassCount, next),
                      ),
                    );
                  }}
                />
                <small id="audio-track-recording-cycle-help">
                  {cycleConfigurationValid && totalCycleDurationSeconds !== null
                    ? `ループ ${currentState.transport.loopStartBeat}〜${currentState.transport.loopEndBeat}拍を`
                      + `${effectiveCyclePassCount}回（約${formatCycleDuration(totalCycleDurationSeconds)}）録音します。`
                      + ' 完了後に各周を編集可能なテイクとしてまとめます。'
                    : 'このループ範囲では、2〜128テイクかつ合計0.5〜60秒の録音条件を満たせません。範囲を調整してください。'}
                </small>
              </fieldset>
            ) : null}
            <p>
              録音音声はエフェクトを通さないドライ音です。
              {recordingCycleEnabled
                ? ' 途中停止・キャンセルでは全テイクを破棄し、指定回数を完走した場合だけ保存します。'
                : ''}
            </p>
            {status ? <p className="audio-track-recording__status" role="status">{status}</p> : null}
            {error ? <p className="track-management__error" role="alert">{error}</p> : null}
            <div className="audio-track-recording__actions">
              <button
                ref={startButtonRef}
                type="button"
                className="track-management__primary"
                data-modal-initial-focus
                disabled={!recordingConfigurationValid}
                onClick={() => void beginRecording()}
              >
                {phase === 'error'
                  ? 'マイクを再試行'
                  : recordingCycleEnabled
                    ? `${effectiveCyclePassCount}テイクを録音`
                    : recordingPunchEnabled
                      ? 'オートパンチを開始'
                      : '録音を開始'}
              </button>
              {onBack ? <button type="button" onClick={onBack}>録音方法へ戻る</button> : null}
              <button type="button" onClick={onClose}>キャンセル</button>
            </div>
          </>
        ) : null}

        {phase === 'requesting' ? (
          <>
            <p role="status" aria-live="polite">マイクの使用許可を待っています…</p>
            <button ref={cancelButtonRef} type="button" onClick={cancelRecording}>キャンセル</button>
          </>
        ) : null}

        {phase === 'countdown' ? (
          <>
            <p className="audio-track-recording__countdown" role="status" aria-live="assertive">
              {activePunch ? 'プリロール開始' : '録音開始'}まで{countdown}秒
            </p>
            <p>
              {activePunch
                ? 'カウントのあと伴奏を先に始め、指定したパンチイン位置でマイクを正確に録音開始します。'
                : 'カウントのあと、伴奏と録音を同じオーディオ時計で開始します。'}
              {activeCycle ? ` ${activeCycle.passCount}テイクを連続録音します。` : ''}
            </p>
            <button ref={cancelButtonRef} type="button" onClick={cancelRecording}>キャンセル</button>
          </>
        ) : null}

        {phase === 'preparing' ? (
          <>
            <p role="status" aria-live="polite">
              {activePunch
                ? 'パンチイン待機中・プリロールを再生しています…'
                : '伴奏と録音を同期する準備をしています…'}
            </p>
            <p>
              {activePunch
                ? `指定範囲 ${activePunch.punchInBeat}〜${activePunch.punchOutBeat}拍だけを録音します。`
                : '準備ができ次第、同じオーディオ時計で開始します。'}
              {activeCycle ? ' ループ境界と各テイクの長さを固定しています。' : ''}
            </p>
            <button ref={cancelButtonRef} type="button" onClick={cancelRecording}>キャンセル</button>
          </>
        ) : null}

        {phase === 'recording' || phase === 'stopping' ? (
          <>
            <p className="audio-track-recording__state" role="status" aria-live="polite">
              <span aria-hidden="true" className="audio-track-recording__indicator" />
              {phase === 'recording'
                ? activeCycle
                  ? totalCycleDurationSeconds !== null
                    && elapsedSeconds >= totalCycleDurationSeconds
                    ? '最終テイクの入力遅延を収録中'
                    : `サイクル録音中・テイク ${activeCyclePassNumber ?? 1}/${activeCycle.passCount}`
                  : activePunch
                    ? punchDurationSeconds !== null
                      && elapsedSeconds >= punchDurationSeconds
                      ? 'パンチアウト済み・入力遅延の末尾を収録中'
                      : 'パンチ録音中・伴奏再生中'
                    : '録音中・伴奏再生中'
                : activeCycle
                  ? 'サイクル録音を破棄しています…'
                  : activePunch
                    ? 'パンチ録音を破棄しています…'
                    : '録音と伴奏を終了しています…'}
            </p>
            <p className="audio-track-recording__time" role="timer" aria-label="録音時間">
              {formatElapsed(elapsedSeconds)} / {activeCycle && totalCycleDurationSeconds !== null
                ? formatCycleDuration(totalCycleDurationSeconds)
                : activePunch && punchDurationSeconds !== null
                  ? formatCycleDuration(punchDurationSeconds)
                : '1:00'}
            </p>
            <div
              className="audio-track-recording__meter"
              role="meter"
              aria-label="マイク入力レベル"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <span style={{ transform: `scaleX(${level})` }} />
            </div>
            <p className="audio-track-recording__hint">
              メーターが動かない場合はマイクの入力先と音量を確認してください。
            </p>
            <div className="audio-track-recording__actions">
              <button
                ref={stopButtonRef}
                type="button"
                className="track-management__primary"
                disabled={phase !== 'recording'}
                onClick={stopRecording}
              >
                {activeCycle
                  ? 'サイクル録音を中止して破棄'
                  : activePunch
                    ? 'パンチ録音を中止して破棄'
                    : '録音を終了して保存'}
              </button>
              {!activeCycle && !activePunch ? (
                <button type="button" disabled={phase === 'stopping'} onClick={cancelRecording}>
                  録音を破棄
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {phase === 'postroll' ? (
          <>
            <p className="audio-track-recording__state" role="status" aria-live="polite">
              <span aria-hidden="true" className="audio-track-recording__indicator" />
              ポストロール再生中・録音範囲は完了しました
            </p>
            <p>
              パンチ範囲の録音を保持したまま、指定した終端まで伴奏を再生しています。
              完了後に新しいテイクとして保存します。
            </p>
            <button
              ref={stopButtonRef}
              type="button"
              className="track-management__primary"
              onClick={cancelRecording}
            >
              保存せずパンチ録音を破棄
            </button>
          </>
        ) : null}

        {phase === 'processing' ? (
          <>
            <p
              ref={processingStatusRef}
              className="audio-track-recording__status"
              role="status"
              aria-live="polite"
              tabIndex={-1}
            >
              {status ?? '録音を保存しています…'}{progress !== null ? ` ${progress}%` : ''}
            </p>
            <button ref={cancelButtonRef} type="button" onClick={cancelRecording}>
              保存を中止して破棄
            </button>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
