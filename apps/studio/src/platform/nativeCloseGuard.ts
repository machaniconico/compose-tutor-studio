import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  nativeLifecycleGate,
  type NativeLifecycleGate,
} from './nativeLifecycleGate';

export type NativeCloseRequestedEvent = Readonly<{
  preventDefault: () => void;
}>;

export type NativeCloseWindow = Readonly<{
  onCloseRequested: (
    handler: (event: NativeCloseRequestedEvent) => void | Promise<void>,
  ) => Promise<() => void>;
}>;

export type NativeCloseFailureStage =
  | 'erase'
  | 'edit-fence'
  | 'authorization'
  | 'flush'
  | 'recovery'
  | 'window-close';

export type NativeCloseGuardActions = Readonly<{
  /** Checked synchronously after cancellation; true blocks every normal close path. */
  isEraseInProgress?: () => boolean;
  /** Acquires the Store mutation fence before the first asynchronous close stage. */
  tryFenceEdits?: () => boolean;
  /** Releases only a reversible Store mutation fence. */
  releaseEditFence?: () => void;
  /** Claims the id that Rust issued for this real native close event. */
  claimCloseRequest: () => Promise<string | null> | string | null;
  /** Resolves true only when all queued edits are durably committed. */
  flushAsync: () => Promise<boolean> | boolean;
  /** Emergency local journal used when the async canonical commit cannot settle. */
  flushSynchronously: () => boolean;
  /** Rust consumes the event id, closes the repository, then destroys main. */
  finishClose: (requestId: string) => Promise<boolean> | boolean;
  onBlocked?: (stage: NativeCloseFailureStage) => void;
}>;

export type NativeCloseGuardOptions = Readonly<{
  window?: NativeCloseWindow;
  timeoutMs?: number;
  lifecycleGate?: NativeLifecycleGate;
}>;

const DEFAULT_CLOSE_STAGE_TIMEOUT_MS = 10_000;

type Settled<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected' | 'timed-out' }>;

async function settleWithin<T>(
  operation: () => Promise<T> | T,
  timeoutMs: number,
): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs);
  });
  const settled: Promise<Settled<T>> = Promise.resolve()
    .then(operation)
    .then(
      (value): Settled<T> => ({ status: 'fulfilled', value }),
      (): Settled<T> => ({ status: 'rejected' }),
    );
  const result = await Promise.race([settled, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function positiveTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : DEFAULT_CLOSE_STAGE_TIMEOUT_MS;
}

/**
 * Intercepts native close before Tauri destroys the WebView. The handler never
 * lets a Promise-only save claim durability: on failure/timeout it requires an
 * exact synchronous recovery-journal write, otherwise the window remains open.
 */
export async function registerNativeCloseGuard(
  actions: NativeCloseGuardActions,
  options: NativeCloseGuardOptions = {},
): Promise<() => void> {
  const closeWindow = options.window ?? getCurrentWindow();
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const lifecycleGate = options.lifecycleGate ?? nativeLifecycleGate;
  let closing = false;

  const eraseIsActive = (): boolean => {
    if (!actions.isEraseInProgress) return false;
    try {
      return actions.isEraseInProgress();
    } catch {
      return true;
    }
  };

  return closeWindow.onCloseRequested(async (event) => {
    // Tauri destroys the window after an async handler unless cancellation is
    // recorded synchronously, before the first await.
    event.preventDefault();
    if (closing) return;
    if (eraseIsActive() || !lifecycleGate.tryClaimNormalClose()) return;
    let editFenceClaimed = false;
    if (actions.tryFenceEdits) {
      try {
        editFenceClaimed = actions.tryFenceEdits();
      } catch {
        editFenceClaimed = false;
      }
      if (!editFenceClaimed) {
        lifecycleGate.releaseNormalClose();
        actions.onBlocked?.('edit-fence');
        return;
      }
    }
    closing = true;
    let handedOff = false;
    let finalHandoffStarted = false;

    try {
      const claimed = await settleWithin(actions.claimCloseRequest, timeoutMs);
      if (
        claimed.status !== 'fulfilled' ||
        typeof claimed.value !== 'string' ||
        claimed.value.length === 0
      ) {
        actions.onBlocked?.('authorization');
        return;
      }
      const requestId = claimed.value;
      if (eraseIsActive()) {
        actions.onBlocked?.('erase');
        return;
      }

      const flushed = await settleWithin(actions.flushAsync, timeoutMs);
      // This callback is independent evidence in addition to the lifecycle
      // claim. Recheck after every async boundary and before recovery writes.
      if (eraseIsActive()) {
        actions.onBlocked?.('erase');
        return;
      }
      if (flushed.status !== 'fulfilled' || !flushed.value) {
        let recovered = false;
        try {
          recovered = actions.flushSynchronously();
        } catch {
          // A thrown storage getter is equivalent to a failed recovery write.
        }
        if (eraseIsActive()) {
          actions.onBlocked?.('erase');
          return;
        }
        if (!recovered) {
          actions.onBlocked?.(
            flushed.status === 'fulfilled' ? 'recovery' : 'flush',
          );
          return;
        }
      }

      // Rust atomically consumes the OS-issued id, closes SQLite, and schedules
      // destruction. Once invoked, a lost response cannot be distinguished from
      // accepted shutdown, so neither close retry nor erase may reclaim lifecycle.
      finalHandoffStarted = true;
      const windowClosed = await settleWithin(
        () => actions.finishClose(requestId),
        timeoutMs,
      );
      if (windowClosed.status !== 'fulfilled' || !windowClosed.value) {
        actions.onBlocked?.('window-close');
        return;
      }
      handedOff = true;
    } finally {
      // Before final handoff, a failed durability/repository stage is retryable.
      // Once finishClose was invoked, Rust may own destruction even without a
      // response, so the normal-close claim deliberately remains permanent.
      if (!handedOff && !finalHandoffStarted) {
        closing = false;
        try {
          if (editFenceClaimed) actions.releaseEditFence?.();
        } catch {
          // The window remains cancelled; lifecycle ownership must still be
          // released so a later close/erase can make a fresh safe attempt.
        } finally {
          lifecycleGate.releaseNormalClose();
        }
      }
    }
  });
}
