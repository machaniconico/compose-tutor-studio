// Lightweight modal dialog: backdrop + centered panel. Closes on Escape and on
// backdrop click. While open it registers in dialogState so global keyboard
// shortcuts are suppressed.

import { useEffect, type ReactNode } from 'react';
import { registerDialog } from './dialogState';

type DialogProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional extra class on the panel for width variations. */
  className?: string;
};

/** A focus-trapping-free but Escape/backdrop-dismissible modal. */
export function Dialog({ title, onClose, children, className }: DialogProps) {
  useEffect(() => {
    const unregister = registerDialog();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unregister();
    };
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dialog__header">
          <h2 className="dialog__title">{title}</h2>
          <button
            type="button"
            className="dialog__close"
            aria-label="閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="dialog__body">{children}</div>
      </div>
    </div>
  );
}
