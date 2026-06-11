// Injectable clock. Defaults to the real system clock but can be overridden in
// tests or callers that need deterministic timestamps.

export type Clock = () => Date;

/** Default clock backed by the real system time. */
export const systemClock: Clock = () => new Date();

/** Return an ISO-8601 timestamp string from the given clock. */
export function nowIso(clock: Clock = systemClock): string {
  return clock().toISOString();
}
