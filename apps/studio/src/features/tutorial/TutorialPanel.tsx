// チュートリアル tab host. Shows the lesson runner when a lesson is active,
// otherwise the course/lesson browser. Wired to @cts/tutorial-engine via the
// tutorial bridge (src/state/tutorialBridge.ts). A toggle opens the glossary.

import { useState } from 'react';
import { useTutorialBridge } from './useTutorialBridge';
import { LessonBrowser } from './LessonBrowser';
import { LessonRunner } from './LessonRunner';
import { GlossaryPanel } from './GlossaryPanel';

/** Tutorial panel: browser ⇄ runner depending on whether a lesson is active. */
export function TutorialPanel() {
  const { engineState } = useTutorialBridge();
  const [showGlossary, setShowGlossary] = useState(false);
  const lessonActive = engineState !== null && engineState.status !== 'idle';

  return (
    <div className="tutorial-panel">
      <button
        type="button"
        className="tutorial-panel__glossary-toggle"
        aria-pressed={showGlossary}
        onClick={() => setShowGlossary((v) => !v)}
      >
        {showGlossary ? '← レッスンにもどる' : '用語集をひらく'}
      </button>
      {/* Keep the lesson mounted while the glossary is open so a half-answered exercise survives. */}
      <div hidden={showGlossary}>{lessonActive ? <LessonRunner /> : <LessonBrowser />}</div>
      {showGlossary ? <GlossaryPanel /> : null}
    </div>
  );
}
