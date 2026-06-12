import { TransportBar } from './features/transport/TransportBar';
import { TrackList } from './features/tracklist/TrackList';
import { ChordLane } from './features/chordTrack/ChordLane';
import { EditorArea } from './features/editor/EditorArea';
import { InspectorPanel } from './features/inspector/InspectorPanel';
import { MixerStrip } from './features/mixer/MixerStrip';
import { ToastStack } from './features/tutorial/ToastStack';
import { OnboardingOverlay } from './features/onboarding/OnboardingOverlay';
import { StartScreen } from './features/startScreen/StartScreen';

/** Root layout: CSS-grid studio shell wiring the feature panels together. */
export function App() {
  return (
    <div className="app-shell">
      <TransportBar />
      <TrackList />
      <div className="center-pane">
        <ChordLane />
        <EditorArea />
      </div>
      <InspectorPanel />
      <MixerStrip />
      <ToastStack />
      <OnboardingOverlay />
      <StartScreen />
    </div>
  );
}
