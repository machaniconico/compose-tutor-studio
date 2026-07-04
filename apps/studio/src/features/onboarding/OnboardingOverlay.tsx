// First-launch welcome overlay. Auto-shows once when there are no saved projects
// and the 'cts.onboarded' flag is unset, and can be re-opened any time from the
// transport bar's "はじめてガイド" button. Its open/close state is lifted to App
// so the persistent entry point survives the first dismissal. Escape/backdrop
// dismiss it; it registers as a modal dialog so global shortcuts are suppressed.

import { useEffect } from 'react';
import { useStore } from '../../state/store';
import { startLesson } from '../../state/tutorialBridge';
import { registerDialog } from '../common/dialogState';

const ONBOARDED_KEY = 'cts.onboarded';
/** The first live beginner lesson (content/*), the guided entry point for a true beginner. */
const FIRST_LESSON_ID = 'basic-1';

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
  { n: '①', text: '再生ボタンを押して、音を聞いてみましょう。' },
  { n: '②', text: 'コードを選ぶと、なぜその響きになるのか理由が見られます。' },
  { n: '③', text: '「チュートリアル」タブで、作曲を学びながら進められます。' },
];

type OnboardingOverlayProps = {
  /** Whether the overlay is currently shown. Controlled by App. */
  open: boolean;
  /** Close the overlay. */
  onClose: () => void;
};

/** Welcome overlay shown on first launch and re-openable from the guide button. */
export function OnboardingOverlay({ open, onClose }: OnboardingOverlayProps) {
  // While open, register as a modal dialog (suppresses global shortcuts) and
  // close on Escape — matching the shared Dialog component's conventions.
  useEffect(() => {
    if (!open) return;
    const unregister = registerDialog();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // Match backdrop / "あとで": remember we've onboarded so the overlay
        // does not auto-reappear on the next reload.
        markOnboarded();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unregister();
    };
  }, [open, onClose]);

  if (!open) return null;

  // "あとで" / backdrop: remember we've onboarded, then dismiss.
  const skip = () => {
    markOnboarded();
    onClose();
  };

  // Primary CTA: start the first guided lesson, then dismiss so the user lands
  // in the tutorial rather than an empty studio. Open the「チュートリアル」tab to
  // follow along.
  const begin = () => {
    markOnboarded();
    startLesson(FIRST_LESSON_ID);
    onClose();
  };

  return (
    <div className="onboarding-backdrop" role="presentation" onClick={skip}>
      <div
        className="onboarding"
        role="dialog"
        aria-modal="true"
        aria-label="ようこそ"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="onboarding__title">Compose Tutor Studio へようこそ</h2>
        <p className="onboarding__lead">
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
        <div className="onboarding__actions">
          <button type="button" className="onboarding__start" onClick={begin}>
            レッスンをはじめる
          </button>
          <button type="button" className="onboarding__skip" onClick={skip}>
            あとで
          </button>
        </div>
      </div>
    </div>
  );
}
