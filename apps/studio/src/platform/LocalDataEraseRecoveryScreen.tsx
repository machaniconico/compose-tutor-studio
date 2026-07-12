import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NativeEraseRecoveryAttempt,
  NativeEraseRecoveryScreenRequest,
} from './nativeLocalDataErase';

export function shouldShowEraseRecoveryRetry(
  attempt: NativeEraseRecoveryAttempt | null,
): boolean {
  return attempt === null || attempt.retryable;
}

/** Minimal fail-closed shell shown while a crash-interrupted erase is resumed. */
export function LocalDataEraseRecoveryScreen({
  autoStart,
  initialMessage,
  retry,
}: NativeEraseRecoveryScreenRequest) {
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<NativeEraseRecoveryAttempt | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const showRetry = shouldShowEraseRecoveryRetry(attempt);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setAttempt(null);
    const result = await retry();
    setAttempt(result);
    setBusy(false);
  }, [busy, retry]);

  useEffect(() => {
    if (autoStart) void run();
    // Auto-resume is deliberately a one-shot mount action. Subsequent attempts
    // require the explicit button and reuse the controller's durable status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!busy && showRetry) retryButtonRef.current?.focus();
  }, [busy, showRetry]);

  return (
    <main
      className="local-data-erase-recovery"
      aria-labelledby="erase-recovery-title"
    >
      <section className="local-data-erase-recovery__panel">
        <h1 id="erase-recovery-title">ローカルデータの消去を復旧中</h1>
        <p
          className="local-data-erase-recovery__status"
          role="status"
          aria-live="polite"
        >
          {busy
            ? '消去処理を安全に再開しています…'
            : attempt?.ok
              ? attempt.message
              : initialMessage}
        </p>
        {attempt && !attempt.ok ? (
          <p className="local-data-erase-recovery__alert" role="alert">
            {attempt.message}
          </p>
        ) : null}
        {showRetry ? (
          <button
            ref={retryButtonRef}
            className="local-data-erase-recovery__retry"
            type="button"
            onClick={() => void run()}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? '消去中…' : '消去を再試行'}
          </button>
        ) : null}
      </section>
    </main>
  );
}
