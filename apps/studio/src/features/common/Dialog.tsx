// Accessible modal dialog: backdrop + centered panel. Focus is contained while
// open and restored to the invoking control after close.

import { useId, type ReactNode } from 'react';
import { useModalDialog } from './useModalDialog';

type DialogProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional extra class on the panel for width variations. */
  className?: string;
  /**
   * Keep an atomic operation on screen. Every dismiss path is disabled.
   */
  closeDisabled?: boolean;
  /** Announce that the dialog contents are being updated by an operation. */
  busy?: boolean;
};

/** Escape/backdrop-dismissible modal with shared focus and background isolation. */
export function Dialog({
  title,
  onClose,
  children,
  className,
  closeDisabled = false,
  busy = closeDisabled,
}: DialogProps) {
  const titleId = useId();
  const requestClose = (): void => {
    if (!closeDisabled) onClose();
  };
  const dialogRef = useModalDialog({
    onEscape: requestClose,
    escapeDisabled: closeDisabled,
  });

  return (
    <div
      className="dialog-backdrop"
      data-modal-layer
      onClick={requestClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={`dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dialog__header">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="dialog__close"
            aria-label="閉じる"
            disabled={closeDisabled}
            onClick={requestClose}
          >
            ×
          </button>
        </header>
        <div className="dialog__body">{children}</div>
      </div>
    </div>
  );
}
