/**
 * Process-wide, one-way fence for renderer-owned persistence.
 *
 * Erasing native data and clearing WebView storage are separate physical
 * operations. The fence closes the race in which tutorial/onboarding or a
 * page-lifecycle handler could recreate renderer data between those steps.
 */
let rendererStorageFenced = false;

export function fenceRendererStorageWrites(): void {
  rendererStorageFenced = true;
}

export function areRendererStorageWritesFenced(): boolean {
  return rendererStorageFenced;
}

/** Test isolation only. Production code must never reopen the fence. */
export function __resetRendererStorageFenceForTest(): void {
  rendererStorageFenced = false;
}
