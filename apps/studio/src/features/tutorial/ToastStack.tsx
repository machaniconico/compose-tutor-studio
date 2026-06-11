// Fixed-position toast stack. Toasts originate from the tutorial bridge (lesson
// progress / completion) and the export/project menus (errors, confirmations).

import { dismissToast } from '../../state/tutorialBridge';
import { useTutorialBridge } from './useTutorialBridge';

/** Renders the live toast stack in the bottom-right corner. */
export function ToastStack() {
  const { toasts } = useTutorialBridge();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__msg">{t.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="閉じる"
            onClick={() => dismissToast(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
