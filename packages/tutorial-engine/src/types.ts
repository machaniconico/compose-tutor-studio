// Tutorial Engine — core DSL types
// All user-facing text (instruction, explanation, hints, feedback) is in Japanese.
//
// NOTE: "TutorialLesson", "TutorialLessonStep", "TutorialLessonLevel" are used
// here to avoid name collisions with the existing dsl.ts Lesson/LessonStep/LessonLevel
// in the package barrel (index.ts). Engine internals use these names; the public
// barrel re-exports them with the Tutorial prefix.

import type { DrumLane, Project, SectionType } from '@cts/project-model';

// Re-export Project so consumers don't need to import it separately
export type { Project };

// ─── Course / Lesson ──────────────────────────────────────────────────────────

export type TutorialLessonLevel = 'basic' | 'compose' | 'advanced';

export interface Course {
  id: string;
  title: string;
  description: string;
  lessonIds: string[];
}

/** Alias for Course — used by the TutorialEngine content pipeline */
export type TutorialCourse = Course;

export interface TutorialLesson {
  id: string;
  courseId: string;
  level: TutorialLessonLevel;
  title: string;
  description: string;
  schemaVersion: number;
  steps: TutorialLessonStep[];
}

export interface TutorialLessonStep {
  id: string;
  title: string;
  /** Japanese: tells the user what to do in the app */
  instruction: string;
  /** Japanese: explains the musical "why" */
  explanation: string;
  goal: StepGoal;
  hints: string[];
  exercise?: Exercise;
}

// ─── Project Predicates ───────────────────────────────────────────────────────

/** ドラムパターンの種類（hasDrumPattern 判定用） */
export type DrumPatternType = 'fourOnFloor' | 'eightBeat' | 'backbeat';

/**
 * 音楽的判定predicate（docs/03 §4.2）。
 * 実装は checker.ts の checkProjectPredicate（theory-engine を使った純粋関数）。
 *
 * minRatio 系は「比率で判定」する — スケール外音・非コードトーンを一律に
 * 誤りと断定しないための設計（CLAUDE.md 音楽的正確性規則）。
 */
export type MusicalProjectPredicate =
  /** ベーストラックの小節1拍目に、そのとき鳴っているコードのルート音が置かれている比率 */
  | { type: 'hasBassRootOnDownbeat'; trackName: string; minRatio: number }
  /** メロディが強拍（1拍目・3拍目）に着地したとき、その音がコードトーンである比率 */
  | { type: 'hasMelodyChordToneOnStrongBeat'; trackName: string; minRatio: number }
  /** トラック内ノートのうち、プロジェクトのキー/スケール内の音である比率 */
  | { type: 'hasNotesWithinScale'; trackName: string; minRatio: number }
  /** ドラムトラックに指定種別のパターン（四つ打ち・8ビート・バックビート）があるか */
  | { type: 'hasDrumPattern'; patternType: DrumPatternType };

export type ProjectPredicate =
  | { type: 'chordCountAtLeast'; value: number }
  | { type: 'progressionEquals'; symbols: string[] }
  | { type: 'drumLaneActive'; lane: DrumLane; minSteps: number }
  | { type: 'drumPatternHas'; lanes: Array<{ lane: DrumLane; minSteps: number }> }
  | { type: 'noteCountAtLeast'; trackName: string; value: number }
  | { type: 'hasSection'; sectionType: SectionType }
  | { type: 'bpmInRange'; min: number; max: number }
  | { type: 'trackVolumeInRange'; trackName: string; min: number; max: number }
  | { type: 'exportCompleted'; format?: 'midi' | 'wav' }
  | MusicalProjectPredicate;

// ─── Step Goals ───────────────────────────────────────────────────────────────

export type EventMatch = Partial<{
  chordSymbol: string;
  pitch: number;
  inScale: boolean;
  lane: DrumLane;
  trackName: string;
  format: 'midi' | 'wav';
}>;

export type AppEventType =
  | 'chord.added'
  | 'chord.changed'
  | 'note.added'
  | 'note.moved'
  | 'drum.stepToggled'
  | 'transport.played'
  | 'project.created'
  | 'track.volumeChanged'
  | 'export.midi'
  | 'export.wav'
  | 'scale_snap.enabled'
  | 'clip.created'
  | 'section.added'
  | 'bpm.changed';

export type StepGoal =
  | { kind: 'event'; eventType: AppEventType; count?: number; match?: EventMatch }
  | { kind: 'project'; predicate: ProjectPredicate }
  | { kind: 'exercise' };

// ─── App Events ───────────────────────────────────────────────────────────────

export interface ChordAddedPayload {
  bar: number;
  chordSymbol: string;
  degree?: string;
}

export interface ChordChangedPayload {
  bar: number;
  chordSymbol: string;
  previousSymbol?: string;
}

export interface NoteAddedPayload {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  trackId: string;
  trackName: string;
  inScale: boolean;
}

export interface NoteMovedPayload {
  pitch: number;
  startBeat: number;
  trackId: string;
  trackName: string;
}

export interface DrumStepToggledPayload {
  lane: DrumLane;
  stepIndex: number;
  active: boolean;
  trackId: string;
}

export interface TransportPlayedPayload {
  positionBeats: number;
}

export interface ProjectCreatedPayload {
  templateId?: string;
  key: string;
  bpm: number;
}

export interface TrackVolumeChangedPayload {
  trackId: string;
  trackName: string;
  volume: number;
}

export interface ExportPayload {
  format: 'midi' | 'wav';
}

export interface ScaleSnapPayload {
  key: string;
  scale: string;
}

export interface ClipCreatedPayload {
  type: string;
  bars: number;
  trackId: string;
}

export interface SectionAddedPayload {
  sectionType: SectionType;
  startBar: number;
  lengthBars: number;
}

export interface BpmChangedPayload {
  bpm: number;
}

export type AppEventPayloadMap = {
  'chord.added': ChordAddedPayload;
  'chord.changed': ChordChangedPayload;
  'note.added': NoteAddedPayload;
  'note.moved': NoteMovedPayload;
  'drum.stepToggled': DrumStepToggledPayload;
  'transport.played': TransportPlayedPayload;
  'project.created': ProjectCreatedPayload;
  'track.volumeChanged': TrackVolumeChangedPayload;
  'export.midi': ExportPayload;
  'export.wav': ExportPayload;
  'scale_snap.enabled': ScaleSnapPayload;
  'clip.created': ClipCreatedPayload;
  'section.added': SectionAddedPayload;
  'bpm.changed': BpmChangedPayload;
};

export type AppEvent = {
  [K in AppEventType]: { type: K; payload: AppEventPayloadMap[K] };
}[AppEventType];

// ─── Exercises ────────────────────────────────────────────────────────────────

export interface MultipleChoiceExercise {
  kind: 'multipleChoice';
  /** Japanese question */
  question: string;
  choices: string[];
  correctIndex: number;
  /** Japanese explanation shown after answer */
  explanation: string;
}

export interface OrderChoicesExercise {
  kind: 'orderChoices';
  /** Japanese question */
  question: string;
  choices: string[];
  /** Correct order as array of original indices */
  correctOrder: number[];
  /** Japanese explanation shown after answer */
  explanation: string;
}

export type Exercise = MultipleChoiceExercise | OrderChoicesExercise;

export interface MultipleChoiceAnswer {
  kind: 'multipleChoice';
  selectedIndex: number;
}

export interface OrderChoicesAnswer {
  kind: 'orderChoices';
  orderedIndices: number[];
}

export type ExerciseAnswer = MultipleChoiceAnswer | OrderChoicesAnswer;

export interface GradeResult {
  correct: boolean;
  /** Japanese feedback message */
  feedback: string;
}

// ─── Engine State & Results ───────────────────────────────────────────────────

export type LessonStatus = 'idle' | 'inProgress' | 'completed';

export interface EngineState {
  lessonId: string;
  stepIndex: number;
  status: LessonStatus;
  currentStep: TutorialLessonStep | null;
}

export interface FeedbackResult {
  advanced: boolean;
  completedLesson: boolean;
  /** Optional Japanese celebration/explanation message */
  message?: string;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

export interface SavedProgress {
  lessonId: string;
  status: LessonStatus;
  currentStep: number;
  /** ISO 8601 string */
  updatedAt: string;
  /** Event counts per step (keyed by stepId) */
  eventCounts?: Record<string, number>;
}

// ─── Review Queue ─────────────────────────────────────────────────────────────

export interface ReviewRecord {
  lessonId: string;
  /** ISO 8601 */
  nextReviewAt: string;
  /** 0-indexed interval level (0→+1d, 1→+3d, 2→+7d) */
  intervalLevel: number;
  lastCorrect: boolean;
}

export type ClockFn = () => Date;
