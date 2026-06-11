// Local id + clock helpers for the studio skeleton.
//
// NOTE: @cts/project-model also ships `uid()` and `nowIso()` helpers, but they
// are not re-exported from its package entry yet (a parallel agent is wiring
// those exports). To keep this skeleton self-contained and type-only on the
// package, we keep small local copies here. A later pass can swap these for the
// package helpers once they are exported.

let counter = 0;

/** Generate a unique id with an optional prefix. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}${counter.toString(36)}${rand}`;
}

/** Return an ISO-8601 timestamp for the current moment. */
export function nowIso(): string {
  return new Date().toISOString();
}
