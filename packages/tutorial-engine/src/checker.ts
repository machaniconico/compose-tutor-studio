/**
 * Tutorial Engine — DSL Checker
 *
 * Pure, deterministic functions that evaluate CheckConditions and Lessons
 * against accumulated EditEvents. No timers, no randomness, no I/O.
 */

import type { CheckCondition, EditEvent, Lesson, LessonStep } from './dsl.js';

// ─── Runtime State ────────────────────────────────────────────────────────────

/** Accumulated history of user edit actions for a single lesson session. */
export type LessonRuntimeState = {
  events: EditEvent[];
};

// ─── applyEvent ───────────────────────────────────────────────────────────────

/**
 * Returns a new state with `event` appended — original state is not mutated.
 */
export function applyEvent(
  state: LessonRuntimeState,
  event: EditEvent,
): LessonRuntimeState {
  return { events: [...state.events, event] };
}

// ─── checkCondition ───────────────────────────────────────────────────────────

/**
 * Evaluates a single CheckCondition against the accumulated event history.
 * Always deterministic — depends only on `cond` and `state`.
 */
export function checkCondition(
  cond: CheckCondition,
  state: LessonRuntimeState,
): boolean {
  switch (cond.kind) {
    case 'hasEvent': {
      return state.events.some((e) => e.type === cond.eventType);
    }

    case 'eventCount': {
      const count = state.events.filter((e) => e.type === cond.eventType).length;
      return count >= cond.min;
    }

    case 'progressionEquals': {
      // Find the last 'progression.set' event and compare its symbols.
      const last = [...state.events]
        .reverse()
        .find((e): e is Extract<EditEvent, { type: 'progression.set' }> =>
          e.type === 'progression.set',
        );
      if (!last) return false;
      if (last.symbols.length !== cond.symbols.length) return false;
      return cond.symbols.every((s, i) => last.symbols[i] === s);
    }

    case 'chordCountAtLeast': {
      const count = state.events.filter((e) => e.type === 'chord.added').length;
      return count >= cond.min;
    }

    case 'noteCountAtLeast': {
      const count = state.events.filter((e) => e.type === 'note.added').length;
      return count >= cond.min;
    }

    case 'exported': {
      return state.events.some(
        (e): e is Extract<EditEvent, { type: 'exported' }> => {
          if (e.type !== 'exported') return false;
          if (cond.format === undefined) return true;
          return e.format === cond.format;
        },
      );
    }
  }
}

// ─── evaluateLesson ───────────────────────────────────────────────────────────

/**
 * Walks all steps in order and returns lesson progress.
 *
 * - `completedStepIds` — ids of every step whose condition is satisfied.
 * - `currentStep` — 0-based index of the first unsatisfied step; equals
 *   `lesson.steps.length` when all steps are done.
 * - `isComplete` — true when every step is satisfied.
 * - `feedback` — the instruction (or hint) of the current active step, or
 *   the successMessage of the last step when all done.
 */
export function evaluateLesson(
  lesson: Lesson,
  state: LessonRuntimeState,
): {
  currentStep: number;
  completedStepIds: string[];
  isComplete: boolean;
  feedback: string;
} {
  const completedStepIds: string[] = [];
  let currentStep = 0;

  for (let i = 0; i < lesson.steps.length; i++) {
    const step = lesson.steps[i] as LessonStep;
    if (checkCondition(step.check, state)) {
      completedStepIds.push(step.id);
    } else {
      currentStep = i;
      const feedback = step.hint ?? step.instruction;
      return { currentStep, completedStepIds, isComplete: false, feedback };
    }
  }

  // All steps satisfied.
  currentStep = lesson.steps.length;
  const lastStep = lesson.steps[lesson.steps.length - 1];
  const feedback = lastStep ? lastStep.successMessage : '';
  return { currentStep, completedStepIds, isComplete: true, feedback };
}
