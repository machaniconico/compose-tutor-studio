/**
 * @cts/tutorial-engine — public API barrel
 *
 * DSL types, checker functions, and built-in course data.
 * The class-based engine (TutorialEngine) plus review queue are also exported.
 */

// ─── DSL types (event-driven checker system) ─────────────────────────────────
export type {
  CheckCondition,
  EditEvent,
  Lesson,
  LessonLevel,
  LessonStep,
} from './dsl.js';

// ─── Checker (pure functions) ─────────────────────────────────────────────────
export type { LessonRuntimeState } from './checker.js';
export { applyEvent, checkCondition, evaluateLesson } from './checker.js';

// ─── Built-in courses ─────────────────────────────────────────────────────────
export { course0 } from './courses.js';

// ─── Class-based engine ───────────────────────────────────────────────────────
export { TutorialEngine } from './engine.js';
export type {
  AppEvent,
  AppEventPayloadMap,
  AppEventType,
  BpmChangedPayload,
  ChordAddedPayload,
  ChordChangedPayload,
  ClipCreatedPayload,
  ClockFn,
  Course,
  DrumStepToggledPayload,
  EngineState,
  EventMatch,
  Exercise,
  ExerciseAnswer,
  ExportPayload,
  FeedbackResult,
  GradeResult,
  LessonStatus,
  MultipleChoiceAnswer,
  MultipleChoiceExercise,
  NoteAddedPayload,
  NoteMovedPayload,
  OrderChoicesAnswer,
  OrderChoicesExercise,
  ProjectCreatedPayload,
  ProjectPredicate,
  ReviewRecord,
  SavedProgress,
  ScaleSnapPayload,
  SectionAddedPayload,
  StepGoal,
  TrackVolumeChangedPayload,
  TransportPlayedPayload,
  TutorialLesson,
  TutorialLessonLevel,
  TutorialLessonStep,
} from './types.js';

// ─── Goal evaluator ──────────────────────────────────────────────────────────
export {
  checkGoalOnEvent,
  evaluateEventGoal,
  evaluateProjectPredicate,
} from './goals.js';

// ─── Exercise grader ─────────────────────────────────────────────────────────
export { gradeExercise } from './exercises.js';

// ─── Spaced repetition review queue ──────────────────────────────────────────
export { ReviewQueue } from './review.js';

// ─── Predicate feedback ───────────────────────────────────────────────────────
export { explainPredicate } from './feedback.js';
export type { PredicateFeedback } from './feedback.js';

// ─── Content (ALL_COURSES, ALL_LESSONS, getLessonById) ───────────────────────
export {
  ALL_COURSES,
  ALL_LESSONS,
  BASIC_COURSE,
  BASIC_LESSONS,
  COMPOSE_COURSE,
  COMPOSE_LESSONS,
  COURSE0_COURSE,
  COURSE0_LESSONS,
  getLessonById,
} from './content/index.js';
