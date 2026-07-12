// First-launch welcome overlay. Auto-shows once when there are no saved projects
// and the 'cts.onboarded' flag is unset, and can be re-opened any time from the
// transport bar's "はじめてガイド" button. Its open/close state is lifted to App
// so the persistent entry point survives the first dismissal. Escape/backdrop
// dismiss it; it registers as a modal dialog so global shortcuts are suppressed.

import { useId } from 'react';
import { useStore } from '../../state/store';
import { areRendererStorageWritesFenced } from '../../platform/rendererStorageFence';
import { useModalDialog } from '../common/useModalDialog';

const ONBOARDED_KEY = 'cts.onboarded';

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // sandboxed contexts can throw
  }
  return null;
}

/** Persist the "seen onboarding" flag so it does not auto-show again. */
function markOnboarded(): void {
  if (areRendererStorageWritesFenced()) return;
  const storage = getStorage();
  try {
    storage?.setItem(ONBOARDED_KEY, '1');
  } catch {
    // best-effort
  }
}

/** Decide whether this is a first launch worth auto-showing onboarding. */
export function shouldShowOnboarding(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  if (storage.getItem(ONBOARDED_KEY)) return false;
  return useStore.getState().listSavedProjects().length === 0;
}

const STEPS = [
  { n: '①', text: '最初のコードを置いて、曲の土台を作ります。' },
  { n: '②', text: '4つのコードを並べ、8小節の進行へ広げます。' },
  { n: '③', text: 'できた進行を再生し、響きを確かめます。' },
];

type OnboardingOverlayProps = {
  /** Whether the overlay is currently shown. Controlled by App. */
  open: boolean;
  /** Close the overlay. */
  onClose: () => void;
  /** Create the first-song project and reveal its composition lesson. */
  onLessonStarted: () => Promise<boolean>;
  /** Prevent duplicate project creation while the primary handoff is running. */
  lessonStartPending: boolean;
  /** Beginner-facing explanation when the project could not be prepared. */
  lessonStartError: string | null;
};

/** Welcome overlay shown on first launch and re-openable from the guide button. */
export function OnboardingOverlay({
  open,
  onClose,
  onLessonStarted,
  lessonStartPending,
  lessonStartError,
}: OnboardingOverlayProps) {
  const titleId = useId();
  const descriptionId = useId();

  // "あとで" / backdrop: remember we've onboarded, then dismiss.
  const skip = () => {
    if (lessonStartPending) return;
    markOnboarded();
    onClose();
  };
  const dialogRef = useModalDialog({
    open,
    onEscape: skip,
    escapeDisabled: lessonStartPending,
    // App chooses between the guide trigger and tutorial destination.
    restoreFocus: false,
  });

  if (!open) return null;

  // The parent owns the atomic project switch and closes this dialog only after
  // the new project is durable and the lesson has started.
  const begin = async () => {
    if (lessonStartPending) return;
    if (await onLessonStarted()) markOnboarded();
  };

  return (
    <div
      className="onboarding-backdrop"
      data-modal-layer
      role="presentation"
      onClick={skip}
    >
      <div
        ref={dialogRef}
        className="onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={lessonStartPending}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="onboarding__title" id={titleId}>
          Compose Tutor Studio へようこそ
        </h2>
        <p className="onboarding__lead" id={descriptionId}>
          作曲をしながら音楽の仕組みを学べるアプリです。まずは3ステップから。
        </p>
        <ol className="onboarding__steps">
          {STEPS.map((s) => (
            <li key={s.n} className="onboarding__step">
              <span className="onboarding__step-n">{s.n}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
        {lessonStartError ? (
          <p className="onboarding__error" role="alert">
            {lessonStartError}
          </p>
        ) : null}
        <div className="onboarding__actions">
          <button
            type="button"
            className="onboarding__start"
            data-modal-initial-focus
            onClick={() => void begin()}
            aria-disabled={lessonStartPending}
            aria-busy={lessonStartPending}
          >
            {lessonStartPending ? '最初の1曲を準備中…' : '最初の1曲を作る'}
          </button>
          <button
            type="button"
            className="onboarding__skip"
            onClick={skip}
            disabled={lessonStartPending}
          >
            あとで
          </button>
        </div>
      </div>
    </div>
  );
}
