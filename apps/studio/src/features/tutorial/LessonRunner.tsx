// Lesson runner — drives a single active lesson. Shows the current step's
// title / instruction (何をするか) / explanation (なぜか), a hint button cycling
// engine hints, a progress bar (step x/y), the exercise UI for exercise steps,
// and a 中断 button that returns to the browser keeping progress.

import {
  getLessonById,
  type TutorialLessonStep,
} from '@cts/tutorial-engine';
import { requestHint, stopLesson } from '../../state/tutorialBridge';
import { useTutorialBridge } from './useTutorialBridge';
import { ExerciseView } from './ExerciseView';

/** Render the active lesson, or null when none is running. */
export function LessonRunner() {
  const { engineState, hint } = useTutorialBridge();
  if (!engineState || engineState.status === 'idle') return null;

  const lesson = getLessonById(engineState.lessonId);
  const total = lesson ? lesson.steps.length : 0;
  const stepNo = Math.min(engineState.stepIndex + 1, Math.max(total, 1));
  const step: TutorialLessonStep | null = engineState.currentStep;
  const completed = engineState.status === 'completed';
  const progressPct = total > 0 ? Math.round((stepNo / total) * 100) : 0;

  return (
    <div className="lesson-runner">
      <div className="lesson-runner__bar">
        <button type="button" className="lesson-runner__back" onClick={() => stopLesson()}>
          ← 中断して一覧へ戻る
        </button>
        <span className="lesson-runner__progress-text">
          ステップ {stepNo} / {total}
        </span>
      </div>

      <div className="lesson-runner__progress" aria-hidden="true">
        <div className="lesson-runner__progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      <h3 className="lesson-runner__lesson-title">{lesson?.title}</h3>

      {completed ? (
        <div className="lesson-runner__done">
          <p className="lesson-runner__done-emoji">🎉</p>
          <p>このレッスンは完了しました！おつかれさまでした。</p>
          <button type="button" className="lesson-runner__back" onClick={() => stopLesson()}>
            一覧へ戻る
          </button>
        </div>
      ) : step ? (
        <div className="lesson-runner__step">
          <p className="lesson-runner__step-title">{step.title}</p>

          <div className="lesson-runner__block">
            <span className="lesson-runner__label">やること</span>
            <p>{step.instruction}</p>
          </div>

          <div className="lesson-runner__block lesson-runner__why">
            <span className="lesson-runner__label">なぜ？</span>
            <p>{step.explanation}</p>
          </div>

          {step.goal.kind === 'exercise' && step.exercise ? (
            <ExerciseView exercise={step.exercise} />
          ) : null}

          {step.hints.length > 0 ? (
            <div className="lesson-runner__hints">
              <button
                type="button"
                className="lesson-runner__hint-btn"
                onClick={() => requestHint()}
              >
                ヒントを見る
              </button>
              {hint ? <p className="lesson-runner__hint">💡 {hint}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
