export const DEFAULT_NATIVE_CLOSE_HANDOFF_TIMEOUT_MS = 10_000;

export type NativeCloseHandoffOutcome = 'accepted' | 'unknown';

function boundedTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : DEFAULT_NATIVE_CLOSE_HANDOFF_TIMEOUT_MS;
}

/**
 * Dispatch the final native close exactly once and bound only its response.
 * Any false, rejection, or timeout is terminal unknown: native destruction may
 * already be scheduled, so callers must never retry the command in-process.
 */
export async function settleNativeCloseHandoff(
  finishClose: () => Promise<boolean> | boolean,
  timeoutMs?: number,
): Promise<NativeCloseHandoffOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<NativeCloseHandoffOutcome>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), boundedTimeout(timeoutMs));
  });
  const response: Promise<NativeCloseHandoffOutcome> = Promise.resolve()
    .then(finishClose)
    .then(
      (accepted): NativeCloseHandoffOutcome =>
        accepted ? 'accepted' : 'unknown',
      (): NativeCloseHandoffOutcome => 'unknown',
    );
  const outcome = await Promise.race([response, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}
