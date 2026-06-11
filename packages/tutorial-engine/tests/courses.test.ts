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
import { COURSE0_COURSE, COURSE0_LESSONS, course0 } from '../src/courses.js';
import type { EditEvent, Lesson } from '../src/dsl.js';
import type { AppEventType, TutorialCourse, TutorialLesson } from '../src/types.js';

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

// ─── COURSE0_COURSE — TutorialCourse 型の構造検証 ────────────────────────────

describe('COURSE0_COURSE — TutorialCourse structure', () => {
  it('is a valid TutorialCourse with id course0', () => {
    const course: TutorialCourse = COURSE0_COURSE;
    expect(course.id).toBe('course0');
    expect(course.title.length).toBeGreaterThan(0);
    expect(course.description.length).toBeGreaterThan(0);
  });

  it('COURSE0_LESSONS has exactly 8 lessons', () => {
    expect(COURSE0_LESSONS).toHaveLength(8);
  });

  it('COURSE0_COURSE.lessonIds matches COURSE0_LESSONS ids', () => {
    expect(COURSE0_COURSE.lessonIds).toEqual(COURSE0_LESSONS.map((l) => l.id));
  });

  it('all lessons have courseId course0', () => {
    for (const lesson of COURSE0_LESSONS) {
      expect(lesson.courseId).toBe('course0');
    }
  });

  it('all lessons have level basic', () => {
    for (const lesson of COURSE0_LESSONS) {
      expect(lesson.level).toBe('basic');
    }
  });

  it('all lesson ids are unique', () => {
    const ids = COURSE0_LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all step ids are unique across all lessons', () => {
    const stepIds = COURSE0_LESSONS.flatMap((l) => l.steps.map((s) => s.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  it('all lessons have at least 3 steps', () => {
    for (const lesson of COURSE0_LESSONS) {
      expect(lesson.steps.length, `${lesson.id} has fewer than 3 steps`).toBeGreaterThanOrEqual(3);
    }
  });

  it('lesson [0] is 0-1: テンプレートから音を鳴らす', () => {
    const l = COURSE0_LESSONS[0]!;
    expect(l.id).toBe('c0-lesson01');
    expect(l.title).toContain('テンプレート');
  });

  it('lesson [1] is 0-2: コード進行を選ぶ', () => {
    const l = COURSE0_LESSONS[1]!;
    expect(l.id).toBe('c0-lesson02');
    expect(l.title).toContain('コード進行');
  });

  it('lesson [2] is 0-3: ドラムを足す', () => {
    const l = COURSE0_LESSONS[2]!;
    expect(l.id).toBe('c0-lesson03');
    expect(l.title).toContain('ドラム');
  });

  it('lesson [3] is 0-4: ベースを足す', () => {
    const l = COURSE0_LESSONS[3]!;
    expect(l.id).toBe('c0-lesson04');
    expect(l.title).toContain('ベース');
  });

  it('lesson [4] is 0-5: メロディを足す', () => {
    const l = COURSE0_LESSONS[4]!;
    expect(l.id).toBe('c0-lesson05');
    expect(l.title).toContain('メロディ');
  });

  it('lesson [5] is 0-6: 8小節に展開する', () => {
    const l = COURSE0_LESSONS[5]!;
    expect(l.id).toBe('c0-lesson06');
    expect(l.title).toContain('8小節');
  });

  it('lesson [6] is 0-7: 音量を整える', () => {
    const l = COURSE0_LESSONS[6]!;
    expect(l.id).toBe('c0-lesson07');
    expect(l.title).toContain('音量');
  });

  it('lesson [7] is 0-8: 書き出す', () => {
    const l = COURSE0_LESSONS[7]!;
    expect(l.id).toBe('c0-lesson08');
    expect(l.title).toContain('書き出す');
  });

  it('0-1 step 1 goal is project.created event', () => {
    const step = COURSE0_LESSONS[0]!.steps[0]!;
    expect(step.goal.kind).toBe('event');
    if (step.goal.kind === 'event') {
      expect(step.goal.eventType).toBe('project.created');
    }
  });

  it('0-1 step 2 goal is transport.played event', () => {
    const step = COURSE0_LESSONS[0]!.steps[1]!;
    expect(step.goal.kind).toBe('event');
    if (step.goal.kind === 'event') {
      expect(step.goal.eventType).toBe('transport.played');
    }
  });

  it('0-3 has a drumPatternHas step with kick≥4 and snare≥2', () => {
    const lesson = COURSE0_LESSONS[2]!;
    const drumStep = lesson.steps.find(
      (s) => s.goal.kind === 'project' && s.goal.predicate.type === 'drumPatternHas',
    );
    expect(drumStep).toBeDefined();
    if (drumStep?.goal.kind === 'project' && drumStep.goal.predicate.type === 'drumPatternHas') {
      const lanes = drumStep.goal.predicate.lanes;
      const kickReq = lanes.find((r) => r.lane === 'kick');
      const snareReq = lanes.find((r) => r.lane === 'snare');
      expect(kickReq).toBeDefined();
      expect(kickReq!.minSteps).toBeGreaterThanOrEqual(4);
      expect(snareReq).toBeDefined();
      expect(snareReq!.minSteps).toBeGreaterThanOrEqual(2);
    }
  });

  it('0-8 final content step has exportCompleted predicate', () => {
    const lesson = COURSE0_LESSONS[7]!;
    const exportStep = lesson.steps.find(
      (s) => s.goal.kind === 'project' && s.goal.predicate.type === 'exportCompleted',
    );
    expect(exportStep).toBeDefined();
  });
});

// ─── Parity: COURSE0 event goals must use canonical AppEventType values ────────

/** Canonical set of AppEventType values — must stay in sync with types.ts. */
const CANONICAL_APP_EVENT_TYPES = new Set<AppEventType>([
  'chord.added',
  'chord.changed',
  'note.added',
  'note.moved',
  'drum.stepToggled',
  'transport.played',
  'project.created',
  'track.volumeChanged',
  'export.midi',
  'export.wav',
  'scale_snap.enabled',
  'clip.created',
  'section.added',
  'bpm.changed',
]);

describe('COURSE0_COURSE — event goal parity with AppEventType', () => {
  it('every event-kind goal in COURSE0_LESSONS uses a canonical AppEventType', () => {
    const violations: string[] = [];
    for (const lesson of COURSE0_LESSONS) {
      for (const step of lesson.steps) {
        if (step.goal.kind === 'event') {
          const et = step.goal.eventType;
          if (!CANONICAL_APP_EVENT_TYPES.has(et)) {
            violations.push(`${lesson.id}/${step.id}: unknown eventType "${et}"`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toHaveLength(0);
  });
});
