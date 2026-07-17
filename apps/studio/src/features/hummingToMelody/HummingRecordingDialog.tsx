import { useEffect, useRef, useState } from 'react';
import type { HeavyAudioResourceReservation } from '../../audio/audioResourceReservation';
import {
  MAX_MICROPHONE_CAPTURE_SECONDS,
  MicrophoneCaptureError,
  startMicrophoneCapture,
  type MicrophoneCaptureSession,
  type MicrophonePcmCapture,
} from '../../audio/microphoneCapture';
import { reserveMicrophoneCaptureResources } from '../../audio/microphoneCaptureReservation';
import { Dialog } from '../common/Dialog';
import { microphoneCaptureFailureMessage } from '../common/microphoneCaptureFailureMessage';

type RecordingPhase =
  | 'idle'
  | 'requesting'
  | 'countdown'
  | 'recording'
  | 'stopping'
  | 'error';

type HummingRecordingDialogProps = Readonly<{
  onClose: () => void;
  onCaptured: (capture: MicrophonePcmCapture) => void;
  onChooseFile: () => void;
}>;

export { microphoneCaptureFailureMessage } from '../common/microphoneCaptureFailureMessage';

function formatElapsed(seconds: number): string {
  const bounded = Math.max(0, Math.min(MAX_MICROPHONE_CAPTURE_SECONDS, Math.floor(seconds)));
  const minutes = Math.floor(bounded / 60);
  const remainder = bounded % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function HummingRecordingDialog({
  onClose,
  onCaptured,
  onChooseFile,
}: HummingRecordingDialogProps) {
  const [phase, setPhase] = useState<RecordingPhase>('idle');
  const [countdown, setCountdown] = useState(3);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<MicrophoneCaptureSession | null>(null);
  const reservationRef = useRef<HeavyAudioResourceReservation | null>(null);
  const cancelRequestedRef = useRef(false);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const waitCancelButtonRef = useRef<HTMLButtonElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);

  const releaseReservation = (): void => {
    reservationRef.current?.release();
    reservationRef.current = null;
  };

  const finishWithError = (caught: unknown, generation: number): void => {
    releaseReservation();
    if (!mountedRef.current || generation !== generationRef.current) return;
    abortRef.current = null;
    sessionRef.current = null;
    if (
      cancelRequestedRef.current &&
      caught instanceof MicrophoneCaptureError &&
      caught.code === 'cancelled'
    ) {
      onClose();
      return;
    }
    setError(microphoneCaptureFailureMessage(caught));
    setLevel(0);
    setPhase('error');
  };

  const beginRecording = async (): Promise<void> => {
    if (
      reservationRef.current !== null
      || (phase !== 'idle' && phase !== 'error')
    ) return;
    const generation = ++generationRef.current;
    cancelRequestedRef.current = false;
    setError(null);
    setElapsedSeconds(0);
    setLevel(0);
    setPhase('requesting');
    try {
      reservationRef.current = reserveMicrophoneCaptureResources();
      const controller = new AbortController();
      abortRef.current = controller;
      const session = await startMicrophoneCapture({
        signal: controller.signal,
        countdownSeconds: 3,
        maxDurationSeconds: MAX_MICROPHONE_CAPTURE_SECONDS,
        onCountdown: (secondsRemaining) => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setCountdown(secondsRemaining);
          setPhase('countdown');
        },
        onLevel: (nextLevel) => {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setLevel(nextLevel);
        },
      });
      if (!mountedRef.current || generation !== generationRef.current) {
        session.cancel();
        void session.result.then(
          () => releaseReservation(),
          () => releaseReservation(),
        );
        return;
      }
      abortRef.current = null;
      sessionRef.current = session;
      setPhase('recording');
      void session.result.then(
        (capture) => {
          releaseReservation();
          if (!mountedRef.current || generation !== generationRef.current) return;
          sessionRef.current = null;
          onClose();
          if (cancelRequestedRef.current) return;
          onCaptured(capture);
        },
        (caught: unknown) => finishWithError(caught, generation),
      );
    } catch (caught) {
      finishWithError(caught, generation);
    }
  };

  const cancelRecording = (): void => {
    if (phase === 'idle' || phase === 'error') {
      onClose();
      return;
    }
    cancelRequestedRef.current = true;
    setPhase('stopping');
    abortRef.current?.abort();
    sessionRef.current?.cancel();
  };

  const stopRecording = (): void => {
    if (phase !== 'recording' || !sessionRef.current) return;
    setPhase('stopping');
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
    if (
      phase !== 'requesting' &&
      phase !== 'countdown' &&
      phase !== 'error' &&
      phase !== 'recording'
    ) return;
    const frame = window.requestAnimationFrame(() => {
      if (phase === 'error') retryButtonRef.current?.focus();
      else if (phase === 'recording') stopButtonRef.current?.focus();
      else waitCancelButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const captureCleanupPending = abortRef.current !== null || sessionRef.current !== null;
      abortRef.current?.abort();
      sessionRef.current?.cancel();
      // The pending capture callback releases memory only after platform
      // cleanup has stopped the worklet, stream, and AudioContext.
      if (!captureCleanupPending) releaseReservation();
    };
  }, []);

  const closeLocked =
    phase === 'requesting' ||
    phase === 'countdown' ||
    phase === 'recording' ||
    phase === 'stopping';

  return (
    <Dialog
      title="鼻歌をマイクで録音"
      className="dialog--humming-recording"
      onClose={onClose}
      closeDisabled={closeLocked}
      busy={phase === 'requesting' || phase === 'stopping'}
    >
      <div className="humming-recording">
        <p className="assistant__hint">
          伴奏を止め、単音で歌ってください。録音と解析は端末内だけで行い、録音データはプロジェクトへ保存しません。
        </p>

        {phase === 'idle' || phase === 'error' ? (
          <>
            <p>最大60秒です。開始後に3秒のカウントが入ります。</p>
            {error ? <p className="assistant__humming-error" role="alert">{error}</p> : null}
            <div className="humming-recording__actions">
              <button
                ref={retryButtonRef}
                type="button"
                className="assistant__generate"
                data-modal-initial-focus
                onClick={() => void beginRecording()}
              >
                {phase === 'error' ? 'マイクを再試行' : '録音を開始'}
              </button>
              <button type="button" onClick={onChooseFile}>音声ファイルを使う</button>
              <button type="button" onClick={onClose}>キャンセル</button>
            </div>
          </>
        ) : null}

        {phase === 'requesting' ? (
          <>
            <p role="status" aria-live="polite">マイクの使用許可を待っています…</p>
            <button ref={waitCancelButtonRef} type="button" onClick={cancelRecording}>
              キャンセル
            </button>
          </>
        ) : null}

        {phase === 'countdown' ? (
          <>
            <p className="humming-recording__countdown" role="status" aria-live="assertive">
              録音開始まで{countdown}秒
            </p>
            <p>カウントのあとに歌い始めてください。</p>
            <button ref={waitCancelButtonRef} type="button" onClick={cancelRecording}>
              キャンセル
            </button>
          </>
        ) : null}

        {phase === 'recording' || phase === 'stopping' ? (
          <>
            <p className="humming-recording__state" role="status" aria-live="polite">
              <span aria-hidden="true" className="humming-recording__indicator" />
              {phase === 'recording' ? '録音中' : '録音を終了しています…'}
            </p>
            <p className="humming-recording__time" role="timer" aria-label="録音時間">
              {formatElapsed(elapsedSeconds)} / 1:00
            </p>
            <div
              className="humming-recording__meter"
              role="meter"
              aria-label="マイク入力レベル"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <span style={{ transform: `scaleX(${level})` }} />
            </div>
            <p className="assistant__hint">メーターが動かない場合は、マイクの入力先と音量を確認してください。</p>
            <div className="humming-recording__actions">
              <button
                ref={stopButtonRef}
                type="button"
                className="assistant__generate"
                disabled={phase !== 'recording'}
                onClick={stopRecording}
              >
                録音を終了して解析
              </button>
              <button type="button" disabled={phase === 'stopping'} onClick={cancelRecording}>
                録音を破棄
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
