// Lesson runner — drives a single active lesson. Shows the current step's
// title / instruction (何をするか) / explanation (なぜか), a hint button cycling
// engine hints, a progress bar (step x/y), the exercise UI for exercise steps,
// and a 中断 button that returns to the browser keeping progress.
// For project-predicate goals, also shows a 3-stage feedback panel:
//   結果 (成功/惜しい/要修正) / 理由 / 次の一手

import {
  explainPredicate,
  getLessonById,
  type PredicateFeedback,
  type TutorialLessonStep,
} from '@cts/tutorial-engine';
import { requestHint, stopLesson } from '../../state/tutorialBridge';
import { useStore } from '../../state/store';
import { useTutorialBridge } from './useTutorialBridge';
import { ExerciseView } from './ExerciseView';

/** Render the active lesson, or null when none is running. */
export function LessonRunner() {
  const { engineState, hint } = useTutorialBridge();
  const project = useStore((s) => s.project);
  if (!engineState || engineState.status === 'idle') return null;

  const lesson = getLessonById(engineState.lessonId);
  const total = lesson ? lesson.steps.length : 0;
  const stepNo = Math.min(engineState.stepIndex + 1, Math.max(total, 1));
  const step: TutorialLessonStep | null = engineState.currentStep;
  const completed = engineState.status === 'completed';
  const progressPct = total > 0 ? Math.round((stepNo / total) * 100) : 0;

  // Compute predicate feedback when the current step goal is project-based.
  const predicateFeedback: PredicateFeedback | null =
    step && step.goal.kind === 'project'
      ? explainPredicate(step.goal.predicate, project)
      : null;

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

          {predicateFeedback ? (
            <div className="lesson-runner__feedback">
              {/* Row 1: 結果ラベル (success / close / needs_work) */}
              <div
                className={[
                  'lesson-runner__feedback-status',
                  predicateFeedback.grade === 'success'
                    ? 'lesson-runner__feedback-status--success'
                    : predicateFeedback.grade === 'close'
                      ? 'lesson-runner__feedback-status--close'
                      : 'lesson-runner__feedback-status--needs-work',
                ].join(' ')}
              >
                {predicateFeedback.grade === 'success'
                  ? '✅ 成功'
                  : predicateFeedback.grade === 'close'
                    ? '🟡 惜しい'
                    : '🔴 要修正'}
              </div>
              {/* Row 2: 理由 (独立した行) */}
              <div className="lesson-runner__block lesson-runner__feedback-reason">
                <span className="lesson-runner__label">理由</span>
                <p>{predicateFeedback.reason}</p>
              </div>
              {/* Row 3: 次の一手 (未達時のみ) */}
              {!predicateFeedback.satisfied && predicateFeedback.nextAction ? (
                <div className="lesson-runner__block lesson-runner__feedback-action">
                  <span className="lesson-runner__label">次の一手</span>
                  <p>{predicateFeedback.nextAction}</p>
                </div>
              ) : null}
            </div>
          ) : null}

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
