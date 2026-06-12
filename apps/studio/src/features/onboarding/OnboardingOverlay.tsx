// First-launch welcome overlay. Shows once when there are no saved projects and
// the 'cts.onboarded' flag is unset. Dismissible; never blocks the app (it sits
// above the UI but can be closed immediately and is non-modal in spirit).
// While the start screen is open this stays hidden — it only appears after the
// user has picked an entry there.

import { useState } from 'react';
import { useStore } from '../../state/store';

const ONBOARDED_KEY = 'cts.onboarded';

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // sandboxed contexts can throw
  }
  return null;
}

/** Decide whether this is a first launch worth onboarding. */
function shouldShow(savedCount: number): boolean {
  const storage = getStorage();
  if (!storage) return false;
  if (storage.getItem(ONBOARDED_KEY)) return false;
  return savedCount === 0;
}

const STEPS = [
  { n: '①', text: '再生ボタンを押して、音を聞いてみましょう。' },
  { n: '②', text: 'コードを選ぶと、なぜその響きになるのか理由が見られます。' },
  { n: '③', text: '「チュートリアル」タブで、作曲を学びながら進められます。' },
];

/** Welcome overlay shown on first launch (after the start screen is closed). */
export function OnboardingOverlay() {
  // Snapshot saved-project count once on mount.
  const savedCount = useStore.getState().listSavedProjects().length;
  const [visible, setVisible] = useState(() => shouldShow(savedCount));
  const startScreenOpen = useStore((s) => s.startScreenOpen);

  // The start screen owns the first impression; onboarding waits its turn.
  if (startScreenOpen || !visible) return null;

  const dismiss = () => {
    const storage = getStorage();
    try {
      storage?.setItem(ONBOARDED_KEY, '1');
    } catch {
      // best-effort
    }
    setVisible(false);
  };

  return (
    <div className="onboarding-backdrop" role="presentation" onClick={dismiss}>
      <div
        className="onboarding"
        role="dialog"
        aria-modal="false"
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
        <button type="button" className="onboarding__start" onClick={dismiss}>
          はじめる
        </button>
      </div>
    </div>
  );
}
