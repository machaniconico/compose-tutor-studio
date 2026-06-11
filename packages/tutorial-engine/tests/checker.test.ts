/**
 * Tests for checker.ts — pure DSL evaluation functions.
 */

import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  checkCondition,
  evaluateLesson,
} from '../src/checker.js';
import type { EditEvent, Lesson } from '../src/dsl.js';
import type { LessonRuntimeState } from '../src/checker.js';
import { course0 } from '../src/courses.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyState(): LessonRuntimeState {
  return { events: [] };
}

function stateFrom(...events: EditEvent[]): LessonRuntimeState {
  return events.reduce(
    (s, e) => applyEvent(s, e),
    emptyState(),
  );
}

// ─── applyEvent — immutability ────────────────────────────────────────────────

describe('applyEvent', () => {
  it('returns a new state object (immutable)', () => {
    const before = emptyState();
    const after = applyEvent(before, { type: 'project.created' });
    expect(after).not.toBe(before);
    expect(before.events).toHaveLength(0);
    expect(after.events).toHaveLength(1);
  });

  it('does not mutate the original events array', () => {
    const before = stateFrom({ type: 'project.created' });
    const original = before.events;
    applyEvent(before, { type: 'tempo.changed', bpm: 120 });
    expect(before.events).toBe(original);
    expect(before.events).toHaveLength(1);
  });

  it('accumulates events in order', () => {
    const s = stateFrom(
      { type: 'project.created' },
      { type: 'tempo.changed', bpm: 100 },
    );
    expect(s.events[0]?.type).toBe('project.created');
    expect(s.events[1]?.type).toBe('tempo.changed');
  });
});

// ─── checkCondition — hasEvent ────────────────────────────────────────────────

describe('checkCondition: hasEvent', () => {
  it('returns false when no matching event exists', () => {
    const state = emptyState();
    expect(
      checkCondition({ kind: 'hasEvent', eventType: 'project.created' }, state),
    ).toBe(false);
  });

  it('returns true when a matching event exists', () => {
    const state = stateFrom({ type: 'project.created' });
    expect(
      checkCondition({ kind: 'hasEvent', eventType: 'project.created' }, state),
    ).toBe(true);
  });

  it('does not false-positive on a different event type', () => {
    const state = stateFrom({ type: 'tempo.changed', bpm: 120 });
    expect(
      checkCondition({ kind: 'hasEvent', eventType: 'project.created' }, state),
    ).toBe(false);
  });
});

// ─── checkCondition — eventCount ─────────────────────────────────────────────

describe('checkCondition: eventCount', () => {
  it('returns false when count is below min', () => {
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
    );
    expect(
      checkCondition(
        { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
        state,
      ),
    ).toBe(false);
  });

  it('returns true when count meets min', () => {
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 12 },
    );
    expect(
      checkCondition(
        { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
        state,
      ),
    ).toBe(true);
  });

  it('returns true when count exceeds min', () => {
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
    );
    expect(
      checkCondition(
        { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
        state,
      ),
    ).toBe(true);
  });
});

// ─── checkCondition — progressionEquals ──────────────────────────────────────

describe('checkCondition: progressionEquals', () => {
  it('returns false when no progression.set event exists', () => {
    const state = stateFrom({ type: 'chord.added', symbol: 'C', startBeat: 0 });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(false);
  });

  it('returns false when progression does not match', () => {
    const state = stateFrom({
      type: 'progression.set',
      symbols: ['C', 'Am', 'F', 'G'],
    });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(false);
  });

  it('returns false when symbol count differs', () => {
    const state = stateFrom({
      type: 'progression.set',
      symbols: ['C', 'G', 'Am'],
    });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(false);
  });

  it('returns true when last progression.set matches exactly', () => {
    const state = stateFrom({
      type: 'progression.set',
      symbols: ['C', 'G', 'Am', 'F'],
    });
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(true);
  });

  it('uses the LAST progression.set event', () => {
    const state = stateFrom(
      { type: 'progression.set', symbols: ['C', 'Am', 'F', 'G'] },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    expect(
      checkCondition(
        { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
        state,
      ),
    ).toBe(true);
  });
});

// ─── checkCondition — noteCountAtLeast ───────────────────────────────────────

describe('checkCondition: noteCountAtLeast', () => {
  it('returns false when note count is below min', () => {
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 62, startBeat: 1 },
    );
    expect(
      checkCondition({ kind: 'noteCountAtLeast', min: 4 }, state),
    ).toBe(false);
  });

  it('returns true when note count meets min', () => {
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 62, startBeat: 1 },
      { type: 'note.added', pitch: 64, startBeat: 2 },
      { type: 'note.added', pitch: 65, startBeat: 3 },
    );
    expect(
      checkCondition({ kind: 'noteCountAtLeast', min: 4 }, state),
    ).toBe(true);
  });
});

// ─── checkCondition — exported ────────────────────────────────────────────────

describe('checkCondition: exported', () => {
  it('returns false when no export event exists', () => {
    const state = emptyState();
    expect(checkCondition({ kind: 'exported' }, state)).toBe(false);
  });

  it('returns true for any format when format is not specified', () => {
    const state = stateFrom({ type: 'exported', format: 'wav' });
    expect(checkCondition({ kind: 'exported' }, state)).toBe(true);
  });

  it('returns true when format matches', () => {
    const state = stateFrom({ type: 'exported', format: 'midi' });
    expect(checkCondition({ kind: 'exported', format: 'midi' }, state)).toBe(true);
  });

  it('returns false when format does not match', () => {
    const state = stateFrom({ type: 'exported', format: 'wav' });
    expect(checkCondition({ kind: 'exported', format: 'midi' }, state)).toBe(false);
  });
});

// ─── evaluateLesson — partial progress ───────────────────────────────────────

describe('evaluateLesson: partial progress', () => {
  // Use lesson02 (0-2 コード進行を選ぶ) which has 2 steps: chordCountAtLeast(1) then progressionEquals
  const lesson03 = course0[1] as Lesson;

  it('currentStep is 0 when no events have been applied', () => {
    const result = evaluateLesson(lesson03, emptyState());
    expect(result.currentStep).toBe(0);
    expect(result.completedStepIds).toHaveLength(0);
    expect(result.isComplete).toBe(false);
  });

  it('currentStep advances to 1 after first step is satisfied', () => {
    // Satisfy step 1: chord.added >= 1
    const state = stateFrom({ type: 'chord.added', symbol: 'C', startBeat: 0 });
    const result = evaluateLesson(lesson03, state);
    expect(result.currentStep).toBe(1);
    expect(result.completedStepIds).toContain(lesson03.steps[0]?.id);
    expect(result.isComplete).toBe(false);
  });

  it('feedback contains instruction or hint of the active step', () => {
    const state = emptyState();
    const result = evaluateLesson(lesson03, state);
    const step0 = lesson03.steps[0]!;
    const expectedFeedback = step0.hint ?? step0.instruction;
    expect(result.feedback).toBe(expectedFeedback);
  });
});

// ─── evaluateLesson — course0 lesson 3 completion ────────────────────────────

describe('evaluateLesson: course0 lesson03 completion', () => {
  const lesson03 = course0[1] as Lesson;

  it('isComplete when both steps are satisfied', () => {
    const state = stateFrom(
      // Satisfy step 1: chord.added >= 1
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      // Satisfy step 2: progressionEquals ['C','G','Am','F']
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    const result = evaluateLesson(lesson03, state);
    expect(result.isComplete).toBe(true);
    expect(result.completedStepIds).toHaveLength(lesson03.steps.length);
    expect(result.currentStep).toBe(lesson03.steps.length);
  });

  it('completedStepIds contains all step ids when complete', () => {
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    const result = evaluateLesson(lesson03, state);
    const expectedIds = lesson03.steps.map((s) => s.id);
    expect(result.completedStepIds).toEqual(expectedIds);
  });

  it('feedback equals successMessage of last step when complete', () => {
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    const result = evaluateLesson(lesson03, state);
    const lastStep = lesson03.steps[lesson03.steps.length - 1]!;
    expect(result.feedback).toBe(lastStep.successMessage);
  });

  it('is NOT complete with wrong progression', () => {
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'Am', 'F', 'G'] },
    );
    const result = evaluateLesson(lesson03, state);
    expect(result.isComplete).toBe(false);
  });
});

// ─── evaluateLesson — full course0 lesson sequence ───────────────────────────

describe('evaluateLesson: other course0 lessons', () => {
  it('lesson01 completes after project.created and tempo.changed', () => {
    const lesson01 = course0[0] as Lesson;
    const state = stateFrom(
      { type: 'project.created' },
      { type: 'tempo.changed', bpm: 120 },
    );
    const result = evaluateLesson(lesson01, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson04 (ベースを足す) completes after 4 note.added events', () => {
    const lesson04 = course0[3] as Lesson;
    const state = stateFrom(
      { type: 'note.added', pitch: 36, startBeat: 0 },
      { type: 'note.added', pitch: 43, startBeat: 4 },
      { type: 'note.added', pitch: 33, startBeat: 8 },
      { type: 'note.added', pitch: 41, startBeat: 12 },
    );
    const result = evaluateLesson(lesson04, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson05 (メロディを足す) completes after 4 note.added events', () => {
    const lesson05 = course0[4] as Lesson;
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 64, startBeat: 1 },
      { type: 'note.added', pitch: 67, startBeat: 2 },
      { type: 'note.added', pitch: 69, startBeat: 3 },
    );
    const result = evaluateLesson(lesson05, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson03 (ドラムを足す) completes after 6 drum.step.toggled events', () => {
    const lesson03drums = course0[2] as Lesson;
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 12 },
    );
    const result = evaluateLesson(lesson03drums, state);
    expect(result.isComplete).toBe(true);
  });

  it('lesson08 (書き出す) completes after exported midi', () => {
    const lesson08 = course0[7] as Lesson;
    const state = stateFrom({ type: 'exported', format: 'midi' });
    const result = evaluateLesson(lesson08, state);
    expect(result.isComplete).toBe(true);
  });
});
