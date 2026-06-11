// Small deterministic-ish uid helper. No external dependencies.
// Produces collision-resistant short ids suitable for in-memory project entities.

let counter = 0;

/**
 * Generate a unique id with an optional prefix.
 * Combines a monotonic counter, a timestamp, and a small random suffix so ids
 * stay unique even when generated in the same millisecond.
 */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}${counter.toString(36)}${rand}`;
}
