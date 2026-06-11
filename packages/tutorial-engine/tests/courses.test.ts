/**
 * courses.test.ts — Course 0 structural verification
 *
 * Verifies that course0 conforms to docs/03_tutorial_learning_spec.md:
 *   - 8 lessons in correct spec order
 *   - Each lesson has the expected id, title, and meaningful steps
 *   - The export lesson (0-8) completes on exported events
 *   - The drum lesson (0-3) has steps that reference drum.step.toggled
 */

import { describe, expect, it } from 'vitest';
import { applyEvent, checkCondition, evaluateLesson } from '../src/checker.js';
import { course0 } from '../src/courses.js';
import type { EditEvent, Lesson } from '../src/dsl.js';

function emptyState() {
  return { events: [] as EditEvent[] };
}

function stateFrom(...events: EditEvent[]) {
  return events.reduce((s, e) => applyEvent(s, e), emptyState());
}

// ─── Course 0 shape ───────────────────────────────────────────────────────────

describe('course0 — 8-lesson structure', () => {
  it('contains exactly 8 lessons', () => {
    expect(course0).toHaveLength(8);
  });

  it('all lessons belong to courseId course0', () => {
    for (const lesson of course0) {
      expect(lesson.courseId).toBe('course0');
    }
  });

  it('all lessons have unique ids', () => {
    const ids = course0.map((l) => l.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all lessons have level "beginner"', () => {
    for (const lesson of course0) {
      expect(lesson.level).toBe('beginner');
    }
  });

  it('all lessons have at least one step', () => {
    for (const lesson of course0) {
      expect(lesson.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all step ids are unique across the course', () => {
    const allStepIds = course0.flatMap((l) => l.steps.map((s) => s.id));
    const unique = new Set(allStepIds);
    expect(unique.size).toBe(allStepIds.length);
  });

  it('all steps have non-empty instruction, hint, and successMessage', () => {
    for (const lesson of course0) {
      for (const step of lesson.steps) {
        expect(step.instruction.length, `${step.id} instruction empty`).toBeGreaterThan(0);
        expect(step.hint, `${step.id} missing hint`).toBeDefined();
        expect((step.hint ?? '').length, `${step.id} hint empty`).toBeGreaterThan(0);
        expect(step.successMessage.length, `${step.id} successMessage empty`).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Spec-aligned lesson IDs and titles ──────────────────────────────────────

describe('course0 — spec-aligned lesson order', () => {
  it('lesson [0] is spec 0-1: テンプレートから音を鳴らす', () => {
    const l = course0[0] as Lesson;
    expect(l.id).toBe('course0_lesson01');
    expect(l.title).toContain('テンプレート');
  });

  it('lesson [1] is spec 0-2: コード進行を選ぶ', () => {
    const l = course0[1] as Lesson;
    expect(l.id).toBe('course0_lesson02');
    expect(l.title).toContain('コード進行');
  });

  it('lesson [2] is spec 0-3: ドラムを足す', () => {
    const l = course0[2] as Lesson;
    expect(l.id).toBe('course0_lesson03');
    expect(l.title).toContain('ドラム');
  });

  it('lesson [3] is spec 0-4: ベースを足す', () => {
    const l = course0[3] as Lesson;
    expect(l.id).toBe('course0_lesson04');
    expect(l.title).toContain('ベース');
  });

  it('lesson [4] is spec 0-5: メロディを足す', () => {
    const l = course0[4] as Lesson;
    expect(l.id).toBe('course0_lesson05');
    expect(l.title).toContain('メロディ');
  });

  it('lesson [5] is spec 0-6: 8小節に展開する', () => {
    const l = course0[5] as Lesson;
    expect(l.id).toBe('course0_lesson06');
    expect(l.title).toContain('8小節');
  });

  it('lesson [6] is spec 0-7: 音量を整える', () => {
    const l = course0[6] as Lesson;
    expect(l.id).toBe('course0_lesson07');
    expect(l.title).toContain('音量');
  });

  it('lesson [7] is spec 0-8: 書き出す', () => {
    const l = course0[7] as Lesson;
    expect(l.id).toBe('course0_lesson08');
    expect(l.title).toContain('書き出す');
  });
});

// ─── Lesson completion scenarios ──────────────────────────────────────────────

describe('course0 lesson completions', () => {
  it('0-1 completes after project.created and tempo.changed', () => {
    const lesson = course0[0] as Lesson;
    const state = stateFrom(
      { type: 'project.created' },
      { type: 'tempo.changed', bpm: 120 },
    );
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-1 does NOT complete without tempo.changed', () => {
    const lesson = course0[0] as Lesson;
    const state = stateFrom({ type: 'project.created' });
    expect(evaluateLesson(lesson, state).isComplete).toBe(false);
  });

  it('0-2 completes after chordCountAtLeast(1) + progressionEquals', () => {
    const lesson = course0[1] as Lesson;
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'G', 'Am', 'F'] },
    );
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-2 does NOT complete with wrong progression', () => {
    const lesson = course0[1] as Lesson;
    const state = stateFrom(
      { type: 'chord.added', symbol: 'C', startBeat: 0 },
      { type: 'progression.set', symbols: ['C', 'Am', 'F', 'G'] },
    );
    expect(evaluateLesson(lesson, state).isComplete).toBe(false);
  });

  it('0-3 completes after 6 drum.step.toggled events (kick x4 + snare x2)', () => {
    const lesson = course0[2] as Lesson;
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'snare', stepIndex: 12 },
    );
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-3 does NOT complete with only 4 drum events (only kicks, no snare step)', () => {
    const lesson = course0[2] as Lesson;
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
    );
    // Only 4 events — step2 requires min:6
    expect(evaluateLesson(lesson, state).isComplete).toBe(false);
  });

  it('0-4 completes after 4 note.added events (bass notes)', () => {
    const lesson = course0[3] as Lesson;
    const state = stateFrom(
      { type: 'note.added', pitch: 36, startBeat: 0 },
      { type: 'note.added', pitch: 43, startBeat: 4 },
      { type: 'note.added', pitch: 33, startBeat: 8 },
      { type: 'note.added', pitch: 41, startBeat: 12 },
    );
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-5 completes after 4 note.added events (melody)', () => {
    const lesson = course0[4] as Lesson;
    const state = stateFrom(
      { type: 'note.added', pitch: 60, startBeat: 0 },
      { type: 'note.added', pitch: 64, startBeat: 1 },
      { type: 'note.added', pitch: 67, startBeat: 2 },
      { type: 'note.added', pitch: 69, startBeat: 3 },
    );
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-6 completes after section.added event', () => {
    const lesson = course0[5] as Lesson;
    const state = stateFrom({ type: 'section.added', sectionType: 'verse' });
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-7 completes after track.volumeChanged event', () => {
    const lesson = course0[6] as Lesson;
    const state = stateFrom({ type: 'track.volumeChanged', trackName: 'Melody', volume: 0.8 });
    expect(evaluateLesson(lesson, state).isComplete).toBe(true);
  });

  it('0-8 completes after exported (any format)', () => {
    const lesson = course0[7] as Lesson;
    const stateMidi = stateFrom({ type: 'exported', format: 'midi' });
    expect(evaluateLesson(lesson, stateMidi).isComplete).toBe(true);
    const stateWav = stateFrom({ type: 'exported', format: 'wav' });
    expect(evaluateLesson(lesson, stateWav).isComplete).toBe(true);
  });

  it('0-8 does NOT complete before any export', () => {
    const lesson = course0[7] as Lesson;
    expect(evaluateLesson(lesson, emptyState()).isComplete).toBe(false);
  });
});

// ─── Drum lesson step conditions ──────────────────────────────────────────────

describe('course0 lesson 0-3 drum step conditions', () => {
  const drumLesson = course0[2] as Lesson;

  it('step 0 uses eventCount for drum.step.toggled with min:4', () => {
    const step0 = drumLesson.steps[0]!;
    expect(step0.check.kind).toBe('eventCount');
    if (step0.check.kind === 'eventCount') {
      expect(step0.check.eventType).toBe('drum.step.toggled');
      expect(step0.check.min).toBe(4);
    }
  });

  it('step 1 uses eventCount for drum.step.toggled with min:6', () => {
    const step1 = drumLesson.steps[1]!;
    expect(step1.check.kind).toBe('eventCount');
    if (step1.check.kind === 'eventCount') {
      expect(step1.check.eventType).toBe('drum.step.toggled');
      expect(step1.check.min).toBe(6);
    }
  });

  it('step 0 check satisfied by 4 kick events', () => {
    const step0 = drumLesson.steps[0]!;
    const state = stateFrom(
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 0 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 4 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 8 },
      { type: 'drum.step.toggled', lane: 'kick', stepIndex: 12 },
    );
    expect(checkCondition(step0.check, state)).toBe(true);
  });
});
