/**
 * Tutorial Engine — Lesson DSL types
 *
 * Serialisable, pure data types used by the checker and course definitions.
 * No runtime dependencies; nothing from @cts/project-model is imported here.
 */

// ─── Level ────────────────────────────────────────────────────────────────────

export type LessonLevel = 'beginner' | 'intermediate' | 'advanced';

// ─── EditEvent ────────────────────────────────────────────────────────────────

/** Discriminated union of every user action the tutorial engine can observe. */
export type EditEvent =
  | { type: 'project.created' }
  | { type: 'tempo.changed'; bpm: number }
  | { type: 'key.changed'; key: string; scale: string }
  | { type: 'chord.added'; symbol: string; startBeat: number }
  | { type: 'progression.set'; symbols: string[] }
  | { type: 'note.added'; pitch: number; startBeat: number }
  | { type: 'drum.step.toggled'; lane: string; stepIndex: number }
  | { type: 'section.added'; sectionType: string }
  | { type: 'exported'; format: 'midi' | 'wav' };

// ─── CheckCondition ───────────────────────────────────────────────────────────

/**
 * Serialisable condition object evaluated against a LessonRuntimeState.
 * Each variant maps to a deterministic boolean check in checker.ts.
 */
export type CheckCondition =
  | { kind: 'eventCount'; eventType: EditEvent['type']; min: number }
  | { kind: 'progressionEquals'; symbols: string[] }
  | { kind: 'chordCountAtLeast'; min: number }
  | { kind: 'noteCountAtLeast'; min: number }
  | { kind: 'hasEvent'; eventType: EditEvent['type'] }
  | { kind: 'exported'; format?: 'midi' | 'wav' };

// ─── LessonStep ──────────────────────────────────────────────────────────────

export type LessonStep = {
  id: string;
  title: string;
  /** Japanese instruction shown while the step is active. */
  instruction: string;
  check: CheckCondition;
  hint?: string;
  /** Japanese message shown when the step is satisfied. */
  successMessage: string;
};

// ─── Lesson ───────────────────────────────────────────────────────────────────

export type Lesson = {
  id: string;
  title: string;
  level: LessonLevel;
  courseId: string;
  lessonSchemaVersion: number;
  summary: string;
  steps: LessonStep[];
};
