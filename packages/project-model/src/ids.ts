// A per-realm nonce prevents persisted ids from repeating after an app reload;
// the counter keeps ids unique and cheap within the current realm.

let _counter = 0;

function createRealmNonce(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().replaceAll('-', '');
    }
  } catch {
    // Fall through for restricted runtimes.
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

const _realmNonce = createRealmNonce();

/**
 * Return a unique id of the form `<prefix>-<realm nonce>-<counter>`.
 */
export function makeId(prefix = 'id'): string {
  _counter += 1;
  return `${prefix}-${_realmNonce}-${_counter.toString(36)}`;
}

/** Reset only the counter (for deterministic tests in the current realm). */
export function _resetIdCounter(): void {
  _counter = 0;
}
