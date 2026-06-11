// Tracks how many modal dialogs are currently open so global keyboard shortcuts
// (e.g. the piano-roll handler) can be suppressed while a dialog has focus.

let openCount = 0;

/** Register an open dialog. Returns a disposer that unregisters it. */
export function registerDialog(): () => void {
  openCount += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    openCount = Math.max(0, openCount - 1);
  };
}

/** True while at least one modal dialog is open. */
export function isAnyDialogOpen(): boolean {
  return openCount > 0;
}
