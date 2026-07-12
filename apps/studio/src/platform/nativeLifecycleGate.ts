export type NativeLifecycleOwner = 'idle' | 'normal-close' | 'erase';

export type NativeLifecycleGate = Readonly<{
  /** Atomically owns the native lifecycle until failure release or destruction. */
  tryClaimNormalClose: () => boolean;
  /** Releases only a failed normal-close claim. Successful handoff stays owned. */
  releaseNormalClose: () => void;
  /** One-way, idempotent claim. An erase claim is never released in-process. */
  tryClaimErase: () => boolean;
  owner: () => NativeLifecycleOwner;
}>;

/**
 * Synchronous mutual exclusion between the normal durability close pipeline
 * and irreversible local-data erasure. JavaScript runs each claim without an
 * interleaving await, so exactly one path can cross its first async boundary.
 */
export function createNativeLifecycleGate(): NativeLifecycleGate {
  let current: NativeLifecycleOwner = 'idle';
  return {
    tryClaimNormalClose: () => {
      if (current !== 'idle') return false;
      current = 'normal-close';
      return true;
    },
    releaseNormalClose: () => {
      if (current === 'normal-close') current = 'idle';
    },
    tryClaimErase: () => {
      if (current === 'erase') return true;
      if (current !== 'idle') return false;
      current = 'erase';
      return true;
    },
    owner: () => current,
  };
}

export const nativeLifecycleGate = createNativeLifecycleGate();
