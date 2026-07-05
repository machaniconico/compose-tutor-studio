import { installBeforeUnloadFlush, type BeforeUnloadTarget } from './persistence';
import { useStore } from './store';

/** Register app-level persistence guards that protect debounced project edits. */
export function installProjectSaveGuards(target?: BeforeUnloadTarget | null): () => void {
  return installBeforeUnloadFlush(() => useStore.getState().flushPendingSave(), target);
}
