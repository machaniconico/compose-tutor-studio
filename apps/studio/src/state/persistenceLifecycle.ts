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
