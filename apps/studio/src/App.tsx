import { useEffect, useState } from 'react';
import { TransportBar } from './features/transport/TransportBar';
import { TrackList } from './features/tracklist/TrackList';
import { ChordLane } from './features/chordTrack/ChordLane';
import { EditorArea } from './features/editor/EditorArea';
import { InspectorPanel } from './features/inspector/InspectorPanel';
import { MixerStrip } from './features/mixer/MixerStrip';
import { ToastStack } from './features/tutorial/ToastStack';
import {
  OnboardingOverlay,
  shouldShowOnboarding,
} from './features/onboarding/OnboardingOverlay';
import { useStore } from './state/store';
import { isAnyDialogOpen } from './features/common/dialogState';

/** True when focus is in a text-entry field, where shortcuts must not fire. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/** Root layout: CSS-grid studio shell wiring the feature panels together. */
export function App() {
  // Onboarding visibility is lifted here so the transport bar's guide button can
  // re-open it after the first dismissal.
  const [guideOpen, setGuideOpen] = useState(() => shouldShowOnboarding());

  // Global keyboard shortcuts: Space = play/stop, Cmd/Ctrl+S = save. Skipped
  // while typing in a field or while a modal dialog (incl. onboarding) is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isAnyDialogOpen()) return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        const s = useStore.getState();
        if (s.transport.isPlaying) s.stop();
        else s.play();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        useStore.getState().saveToLocalStorage();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <TransportBar onOpenGuide={() => setGuideOpen(true)} />
      <TrackList />
      <div className="center-pane">
        <ChordLane />
        <EditorArea />
      </div>
      <InspectorPanel />
      <MixerStrip />
      <ToastStack />
      <OnboardingOverlay open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  );
}
