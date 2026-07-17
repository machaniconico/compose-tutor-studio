import { useEffect, useRef, useState } from 'react';
import {
  MAX_MICROPHONE_CAPTURE_SECONDS,
  MicrophoneCaptureError,
  startMicrophoneCapture,
  type MicrophoneCaptureSession,
  type MicrophonePcmCapture,
} from '../../audio/microphoneCapture';
import { getAudioEngine } from '../../audio/engine';
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
  beginStudioAudioTrackRecording,
  bindStudioAudioTrackRecordingToPlayback,
  discardStudioAudioTrackRecording,
  recordStudioAudioTrack,
  studioAudioActionErrorMessage,
  type StudioAudioActionErrorCode,
  type StudioAudioTrackRecordingHandle,
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
  | 'stopping'
  | 'processing'
  | 'error';

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

/** Record one dry, bounded take to a frozen new or existing Audio Track target. */
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

  const finishCaptureError = (caught: unknown, generation: number): void => {
    captureStopRequestedRef.current = true;
    stopPairedPlayback();
    discardRecordingOwnership();
    if (!mountedRef.current || generation !== generationRef.current) return;
    abortRef.current = null;
    sessionRef.current = null;
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
    stopPairedPlayback();
    if (!mountedRef.current || generation !== generationRef.current) {
      discardRecordingOwnership();
      return;
    }
    finalizingRef.current = true;
    sessionRef.current = null;
    setPhase('processing');
    setProgress(0);
    setStatus('録音を48 kHzのWAVへ変換しています…');
    const controller = new AbortController();
    abortRef.current = controller;
    const recordingHandle = recordingHandleRef.current;
    recordingHandleRef.current = null;

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
            next.phase === 'resampling'
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
      const compensation = latencyCompensationMode === 'estimated'
        ? ' 推定レイテンシ補正を適用しました。'
        : Number(latencyAdjustmentText) === 0
          ? ''
          : ' 手動の録音位置補正を適用しました。';
      pushToast(
        `「${result.trackName}」へ録音を保存し、伴奏と同期した位置へ配置しました。${compensation}${deduplicated}`,
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
      finalizingRef.current = false;
      abortRef.current = null;
    }
  };

  const beginRecording = async (): Promise<void> => {
    if (
      recordingHandleRef.current !== null
      || (phase !== 'idle' && phase !== 'error')
    ) return;
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
    const ownership = beginStudioAudioTrackRecording({
      target: targetTrackId === undefined
        ? { kind: 'new-track', trackName }
        : { kind: 'existing-audio-track', trackId: targetTrackId },
    });
    if (!ownership.ok) {
      setError(recordingBeginFailureMessage(ownership.code));
      setStatus('録音は開始していません。');
      setPhase('error');
      return;
    }
    recordingHandleRef.current = ownership.handle;
    const projectSnapshot = useStore.getState().project;
    const engineActivation = getAudioEngine().ensureContext();
    void engineActivation.catch(() => undefined);
    const generation = ++generationRef.current;
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
          armAtFrame,
        }) => {
          if (
            context !== activated.context
            || contextGeneration !== activated.contextGeneration
          ) {
            throw new MicrophoneCaptureError('synchronization-failed');
          }
          const clock = await startSynchronizedRecordingPlayback({
            operationId: ownership.handle.operationId,
            projectSnapshot,
            startBeat: ownership.startBeat,
            signal: controller.signal,
            armCapture: async (playbackContext, startFrame, playbackGeneration) => {
              if (
                playbackContext !== context
                || playbackGeneration !== contextGeneration
              ) {
                throw new MicrophoneCaptureError('synchronization-failed');
              }
              await armAtFrame(startFrame);
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
          stopPairedPlayback();
          if (cancelRequestedRef.current) {
            discardRecordingOwnership();
            if (mountedRef.current && generation === generationRef.current) {
              sessionRef.current = null;
              onClose();
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
        captureStopRequestedRef.current = true;
        setPhase('stopping');
        void session.stop().catch(() => undefined);
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
    abortRef.current?.abort();
    sessionRef.current?.cancel();
    stopPairedPlayback();
  };

  const stopRecording = (): void => {
    if (phase !== 'recording' || !sessionRef.current) return;
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
    if (!['requesting', 'countdown', 'preparing', 'recording', 'processing', 'error'].includes(phase)) return;
    const frame = window.requestAnimationFrame(() => {
      if (phase === 'recording') stopButtonRef.current?.focus();
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
  }, [phase]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeTransport = useStore.subscribe((state, previous) => {
      if (
        previous.transport.phase !== 'stopped'
        && state.transport.phase === 'stopped'
        && sessionRef.current !== null
        && !cancelRequestedRef.current
        && !captureStopRequestedRef.current
        && !finalizingRef.current
      ) {
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
      abortRef.current?.abort();
      sessionRef.current?.cancel();
      stopPairedPlayback();
      // Permission/capture owns browser resources until its promise settles.
      // Its existing success/error callback releases the opaque lease after
      // the worklet, stream, and AudioContext have actually been cleaned up.
      if (!finalizingRef.current && !captureCleanupPending) {
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

  return (
    <Dialog
      title="マイクをオーディオトラックへ録音"
      className="dialog--audio-track-recording"
      onClose={cancelRecording}
      closeDisabled={closeLocked}
      busy={phase === 'requesting' || phase === 'preparing' || phase === 'stopping' || phase === 'processing'}
    >
      <div className="audio-track-recording">
        <p className="audio-track-recording__lead">
          最大60秒の音声を端末内だけで録音します。3秒のカウント後、準備が整い次第、現在位置から伴奏と録音を同時に始め、{recordingTarget}へ配置します。
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
                <option value="estimated">自動（推定）</option>
                <option value="off">自動補正なし（手動のみ）</option>
              </select>
              <small id="audio-track-recording-latency-help">
                自動はブラウザと入力・出力デバイスの申告値による推定です。実測校正ではありません。
              </small>
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
            <p>録音音声はエフェクトを通さないドライ音です。ループ録音は現在未対応です。</p>
            {status ? <p className="audio-track-recording__status" role="status">{status}</p> : null}
            {error ? <p className="track-management__error" role="alert">{error}</p> : null}
            <div className="audio-track-recording__actions">
              <button
                ref={startButtonRef}
                type="button"
                className="track-management__primary"
                data-modal-initial-focus
                onClick={() => void beginRecording()}
              >
                {phase === 'error' ? 'マイクを再試行' : '録音を開始'}
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
              録音開始まで{countdown}秒
            </p>
            <p>カウントのあと、伴奏と録音を同じオーディオ時計で開始します。</p>
            <button ref={cancelButtonRef} type="button" onClick={cancelRecording}>キャンセル</button>
          </>
        ) : null}

        {phase === 'preparing' ? (
          <>
            <p role="status" aria-live="polite">伴奏と録音を同期する準備をしています…</p>
            <p>準備ができ次第、同じオーディオ時計で開始します。</p>
            <button ref={cancelButtonRef} type="button" onClick={cancelRecording}>キャンセル</button>
          </>
        ) : null}

        {phase === 'recording' || phase === 'stopping' ? (
          <>
            <p className="audio-track-recording__state" role="status" aria-live="polite">
              <span aria-hidden="true" className="audio-track-recording__indicator" />
              {phase === 'recording' ? '録音中・伴奏再生中' : '録音と伴奏を終了しています…'}
            </p>
            <p className="audio-track-recording__time" role="timer" aria-label="録音時間">
              {formatElapsed(elapsedSeconds)} / 1:00
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
                録音を終了して保存
              </button>
              <button type="button" disabled={phase === 'stopping'} onClick={cancelRecording}>
                録音を破棄
              </button>
            </div>
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
