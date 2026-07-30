import type { AudioWarpWorkerLike } from './audioWarpWorker';
// @ts-ignore Vite resolves this local worker URL; the non-Vite E2E config does not.
import audioWarpThreadUrl from './audioWarp.worker.ts?worker&url';

/**
 * The only reviewed browser Worker constructor in production source.
 *
 * The release preflight pins this file by SHA-256. The emitted URL is a
 * same-origin Vite asset, and the worker module is independently scanned by
 * the no-network policy.
 */
export function createLocalAudioWarpThread(): AudioWarpWorkerLike {
  const WorkerConstructor = globalThis.Worker;
  if (typeof WorkerConstructor === 'undefined') {
    throw new Error('Elastic Audio Worker is unavailable in this browser.');
  }
  const thread = Reflect.construct(
    WorkerConstructor,
    [audioWarpThreadUrl, { type: 'module' }],
  ) as Worker;
  return {
    postMessage: (message, transfer) => {
      if (transfer) thread.postMessage(message, transfer);
      else thread.postMessage(message);
    },
    addEventListener: (type, listener) => thread.addEventListener(type, listener),
    removeEventListener: (type, listener) => thread.removeEventListener(type, listener),
    terminate: () => thread.terminate(),
  };
}
