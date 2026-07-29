export type VisibilityLifecycleTarget = EventTarget & {
  readonly visibilityState: string;
};

export type PersistenceLifecycleActions = Readonly<{
  /** Starts an ordinary repository flush while the page can still await work. */
  flushAsync: () => Promise<unknown> | unknown;
  /** Must finish durable work before returning; used only for pagehide/unload. */
  flushSynchronously: () => boolean;
  hasUnsavedChanges: () => boolean;
}>;

export type RuntimeCaptureLifecycleActions = Readonly<{
  /** Returns true after either a successful punch-out or a proven no-op. */
  finalize: (boundary: 'pagehide') => boolean;
  /** Pagehide cannot be blocked; cancellation is the deterministic safe fallback. */
  cancel: () => boolean;
}>;

export type AutomationGestureLifecycleActions = Readonly<{
  /** Releases every active Touch gesture using the scheduler-owned clock. */
  endActiveGestures: () => boolean;
}>;

const AUTOMATION_GESTURE_RELEASE_EVENTS = Object.freeze([
  'pointerup',
  'pointercancel',
  'keyup',
  'change',
  'blur',
] as const);

/**
 * Native range controls emit input continuously but expose release through
 * different events for pointer, keyboard, and assistive-technology input.
 */
export function registerAutomationGestureLifecycle(
  actions: AutomationGestureLifecycleActions,
  page?: EventTarget,
): () => void {
  const pageTarget = page ?? (typeof window === 'undefined' ? undefined : window);
  const handleRelease = (): void => {
    try {
      actions.endActiveGestures();
    } catch {
      // The coordinator retains the pass and exposes its recoverable status.
    }
  };
  for (const eventName of AUTOMATION_GESTURE_RELEASE_EVENTS) {
    pageTarget?.addEventListener(eventName, handleRelease);
  }
  return () => {
    for (const eventName of AUTOMATION_GESTURE_RELEASE_EVENTS) {
      pageTarget?.removeEventListener(eventName, handleRelease);
    }
  };
}

/**
 * Finalize a runtime-only automation pass before persistence's pagehide flush.
 * If validation/CAS cannot succeed, pagehide cannot await user recovery, so the
 * pass is cancelled without changing Project/history/save state.
 */
export function registerRuntimeCaptureLifecycle(
  actions: RuntimeCaptureLifecycleActions,
  page?: EventTarget,
): () => void {
  const pageTarget = page ?? (typeof window === 'undefined' ? undefined : window);
  const handlePageHide = (): void => {
    let finalized = false;
    try {
      finalized = actions.finalize('pagehide');
    } catch {
      finalized = false;
    }
    if (!finalized) {
      try {
        actions.cancel();
      } catch {
        // Project remains unchanged; page disposal owns the remaining runtime.
      }
    }
  };
  pageTarget?.addEventListener('pagehide', handlePageHide);
  return () => pageTarget?.removeEventListener('pagehide', handlePageHide);
}

/**
 * Starts an early async flush on backgrounding, then uses only the repository's
 * explicit synchronous capability during page disposal. A remaining dirty/error
 * state activates the browser's standard unsaved-changes warning.
 */
export function registerPersistenceLifecycle(
  actions: PersistenceLifecycleActions,
  page?: EventTarget,
  visibilityDoc?: VisibilityLifecycleTarget,
): () => void {
  const pageTarget = page ?? (typeof window === 'undefined' ? undefined : window);
  const documentTarget =
    visibilityDoc ?? (typeof document === 'undefined' ? undefined : document);

  const handlePageHide = (): void => {
    actions.flushSynchronously();
  };
  const handleVisibilityChange = (): void => {
    if (documentTarget?.visibilityState === 'hidden') {
      void actions.flushAsync();
    }
  };
  const handleBeforeUnload = (event: Event): void => {
    actions.flushSynchronously();
    if (!actions.hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = false;
  };

  pageTarget?.addEventListener('pagehide', handlePageHide);
  pageTarget?.addEventListener('beforeunload', handleBeforeUnload);
  documentTarget?.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    pageTarget?.removeEventListener('pagehide', handlePageHide);
    pageTarget?.removeEventListener('beforeunload', handleBeforeUnload);
    documentTarget?.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
