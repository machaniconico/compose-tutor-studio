// Tracks modal ordering so global shortcuts stay suppressed and only the topmost
// dialog owns document-level focus/Escape handling.

const stack: symbol[] = [];

export type DialogRegistration = Readonly<{
  unregister: () => void;
  isTopmost: () => boolean;
}>;

/** Register an open dialog and expose whether it currently owns the modal stack. */
export function registerDialog(): DialogRegistration {
  const token = Symbol('modal-dialog');
  stack.push(token);
  let disposed = false;
  return {
    unregister: () => {
      if (disposed) return;
      disposed = true;
      const index = stack.lastIndexOf(token);
      if (index >= 0) stack.splice(index, 1);
    },
    isTopmost: () => !disposed && stack[stack.length - 1] === token,
  };
}

/** True while at least one modal dialog is open. */
export function isAnyDialogOpen(): boolean {
  return stack.length > 0;
}
