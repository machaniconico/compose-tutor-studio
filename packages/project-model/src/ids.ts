// Deterministic unique id generator. Uses a module-level counter — no
// Math.random() or Date.now() — so it is safe in test environments that
// require reproducibility.

let _counter = 0;

/**
 * Return a unique id of the form `<prefix>-<n>`.
 * The counter resets only when the module is re-evaluated (i.e. per JS realm).
 */
export function makeId(prefix = 'id'): string {
  _counter += 1;
  return `${prefix}-${_counter}`;
}

/** Reset the counter (for deterministic tests only). */
export function _resetIdCounter(): void {
  _counter = 0;
}
