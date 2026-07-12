// TutorialEngine — main engine class

import type { Project } from '@cts/project-model';
import { gradeExercise } from './exercises.js';
import { checkGoalOnEvent, evaluateProjectPredicate } from './goals.js';
import type {
  AppEvent,
  EngineState,
  Exercise,
  ExerciseAnswer,
  FeedbackResult,
  GradeResult,
  SavedProgress,
  TutorialLesson,
  TutorialLessonStep,
} from './types.js';

export class TutorialEngine {
  private lesson: TutorialLesson | null = null;
  private stepIndex = 0;
  private status: EngineState['status'] = 'idle';
  /** Per-step event counts, keyed by stepId */
  private eventCounts: Map<string, number> = new Map();
  /** Cycling hint index per step */
  private hintIndices: Map<string, number> = new Map();

  // ─── Load ──────────────────────────────────────────────────────────────────

  loadLesson(lesson: TutorialLesson, savedProgress?: SavedProgress): void {
    this.lesson = lesson;
    this.eventCounts = new Map();
    this.hintIndices = new Map();

    if (savedProgress && savedProgress.lessonId === lesson.id) {
      this.stepIndex = Math.min(
        savedProgress.currentStep,
        lesson.steps.length - 1,
      );
      this.status =
        savedProgress.status === 'completed' ? 'completed' : 'inProgress';
      if (savedProgress.eventCounts) {
        for (const [k, v] of Object.entries(savedProgress.eventCounts)) {
          this.eventCounts.set(k, v);
        }
      }
    } else {
      this.stepIndex = 0;
      this.status = 'inProgress';
    }
  }

  // ─── State ─────────────────────────────────────────────────────────────────

  getState(): EngineState {
    if (!this.lesson) {
      return {
        lessonId: '',
        stepIndex: 0,
        status: 'idle',
        currentStep: null,
      };
    }
    const step = this.lesson.steps[this.stepIndex] ?? null;
    return {
      lessonId: this.lesson.id,
      stepIndex: this.stepIndex,
      status: this.status,
      currentStep: step,
    };
  }

  // ─── Handle Event ──────────────────────────────────────────────────────────

  handleEvent(event: AppEvent, project: Project): FeedbackResult {
    if (!this.lesson || this.status !== 'inProgress') {
      return { advanced: false, completedLesson: false };
    }

    const step = this.lesson.steps[this.stepIndex];
    if (!step) {
      return { advanced: false, completedLesson: false };
    }

    const currentCount = this.eventCounts.get(step.id) ?? 0;
    const { satisfied, newEventCount } = checkGoalOnEvent(
      step.goal,
      event,
      project,
      currentCount,
    );

    this.eventCounts.set(step.id, newEventCount);

    if (!satisfied) {
      return { advanced: false, completedLesson: false };
    }

    return this.advanceStep();
  }

  /** Re-evaluate the current state-backed goal without inventing an AppEvent. */
  reconcileProject(project: Project): FeedbackResult {
    if (!this.lesson || this.status !== 'inProgress') {
      return { advanced: false, completedLesson: false };
    }
    const step = this.lesson.steps[this.stepIndex];
    if (
      !step ||
      step.goal.kind !== 'project' ||
      !evaluateProjectPredicate(step.goal.predicate, project)
    ) {
      return { advanced: false, completedLesson: false };
    }
    return this.advanceStep();
  }

  // ─── Answer Exercise ───────────────────────────────────────────────────────

  answerExercise(answer: ExerciseAnswer): GradeResult & FeedbackResult {
    const noOp: GradeResult & FeedbackResult = {
      correct: false,
      feedback: 'レッスンが読み込まれていないか、演習ステップではありません。',
      advanced: false,
      completedLesson: false,
    };

    if (!this.lesson || this.status !== 'inProgress') return noOp;

    const step = this.lesson.steps[this.stepIndex];
    if (!step) return noOp;
    if (step.goal.kind !== 'exercise') {
      return {
        correct: false,
        feedback: 'このステップは演習ではありません。',
        advanced: false,
        completedLesson: false,
      };
    }
    const exercise = step.exercise;
    if (!exercise) {
      return {
        correct: false,
        feedback: '演習データが見つかりません。',
        advanced: false,
        completedLesson: false,
      };
    }

    const grade = gradeExercise(exercise, answer);
    if (!grade.correct) {
      return { ...grade, advanced: false, completedLesson: false };
    }

    const progression = this.advanceStep();
    return { ...grade, ...progression };
  }

  // ─── Hints ─────────────────────────────────────────────────────────────────

  requestHint(): string | null {
    if (!this.lesson || this.status !== 'inProgress') return null;
    const step = this.lesson.steps[this.stepIndex];
    if (!step || step.hints.length === 0) return null;

    const current = this.hintIndices.get(step.id) ?? 0;
    const hint = step.hints[current] ?? step.hints[0] ?? null;
    // Cycle to the next hint
    this.hintIndices.set(step.id, (current + 1) % step.hints.length);
    return hint;
  }

  // ─── Progress Serialization ────────────────────────────────────────────────

  toProgress(): SavedProgress | null {
    if (!this.lesson) return null;
    const counts: Record<string, number> = {};
    for (const [k, v] of this.eventCounts.entries()) {
      counts[k] = v;
    }
    return {
      lessonId: this.lesson.id,
      status: this.status,
      currentStep: this.stepIndex,
      updatedAt: new Date().toISOString(),
      eventCounts: counts,
    };
  }

  fromProgress(lesson: TutorialLesson, progress: SavedProgress): void {
    this.loadLesson(lesson, progress);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private advanceStep(): FeedbackResult {
    if (!this.lesson) return { advanced: false, completedLesson: false };

    const isLastStep = this.stepIndex >= this.lesson.steps.length - 1;

    if (isLastStep) {
      this.status = 'completed';
      return {
        advanced: true,
        completedLesson: true,
        message: `「${this.lesson.title}」のレッスンが完了しました！よくできました！`,
      };
    }

    this.stepIndex += 1;
    const nextStep = this.lesson.steps[this.stepIndex];
    return {
      advanced: true,
      completedLesson: false,
      message: nextStep ? `次のステップ：「${nextStep.title}」` : undefined,
    };
  }

  /** Expose current step's exercise for the UI (read-only) */
  getCurrentExercise(): Exercise | null {
    if (!this.lesson) return null;
    const step = this.lesson.steps[this.stepIndex];
    return step?.exercise ?? null;
  }
}
