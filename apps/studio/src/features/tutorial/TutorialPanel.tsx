// チュートリアル tab host. Shows the lesson runner when a lesson is active,
// otherwise the course/lesson browser. Wired to @cts/tutorial-engine via the
// tutorial bridge (src/state/tutorialBridge.ts).

import { useTutorialBridge } from './useTutorialBridge';
import { LessonBrowser } from './LessonBrowser';
import { LessonRunner } from './LessonRunner';

/** Tutorial panel: browser ⇄ runner depending on whether a lesson is active. */
export function TutorialPanel() {
  const { engineState } = useTutorialBridge();
  const lessonActive = engineState !== null && engineState.status !== 'idle';

  return (
    <div className="tutorial-panel">
      {lessonActive ? <LessonRunner /> : <LessonBrowser />}
    </div>
  );
}
