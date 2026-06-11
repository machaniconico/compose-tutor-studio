import { describe, expect, it } from 'vitest';
import {
  ALL_COURSES,
  ALL_LESSONS,
  BASIC_COURSE,
  BASIC_LESSONS,
  COMPOSE_COURSE,
  COMPOSE_LESSONS,
  COURSE0_COURSE,
  COURSE0_LESSONS,
  getLessonById,
} from '../src/content/index.js';
import type { TutorialLesson } from '../src/types.js';

describe('content registry', () => {
  it('ALL_COURSES contains 3 courses (course0, basic, compose)', () => {
    expect(ALL_COURSES).toHaveLength(3);
    const ids = ALL_COURSES.map((c) => c.id);
    expect(ids).toContain('course0');
    expect(ids).toContain('basic');
    expect(ids).toContain('compose');
  });

  it('ALL_LESSONS contains 17 lessons (8 course0 + 4 basic + 5 compose)', () => {
    expect(ALL_LESSONS).toHaveLength(17);
  });

  it('BASIC_LESSONS contains 4 lessons', () => {
    expect(BASIC_LESSONS).toHaveLength(4);
  });

  it('COMPOSE_LESSONS contains 5 lessons', () => {
    expect(COMPOSE_LESSONS).toHaveLength(5);
  });

  it('BASIC_COURSE.lessonIds matches BASIC_LESSONS ids in order', () => {
    expect(BASIC_COURSE.lessonIds).toEqual(BASIC_LESSONS.map((l) => l.id));
  });

  it('COMPOSE_COURSE.lessonIds matches COMPOSE_LESSONS ids in order', () => {
    expect(COMPOSE_COURSE.lessonIds).toEqual(COMPOSE_LESSONS.map((l) => l.id));
  });

  it('COURSE0_LESSONS contains 8 lessons', () => {
    expect(COURSE0_LESSONS).toHaveLength(8);
  });

  it('COURSE0_COURSE.lessonIds matches COURSE0_LESSONS ids in order', () => {
    expect(COURSE0_COURSE.lessonIds).toEqual(COURSE0_LESSONS.map((l) => l.id));
  });

  it('getLessonById returns correct lesson', () => {
    const lesson = getLessonById('basic-1');
    expect(lesson).toBeDefined();
    expect(lesson!.id).toBe('basic-1');
  });

  it('getLessonById returns undefined for unknown id', () => {
    expect(getLessonById('does-not-exist')).toBeUndefined();
  });
});

describe('lesson structural validity', () => {
  for (const lesson of ALL_LESSONS) {
    it(`${lesson.id}: non-empty id, title, description, courseId; schemaVersion > 0`, () => {
      expect(lesson.id.length).toBeGreaterThan(0);
      expect(lesson.title.length).toBeGreaterThan(0);
      expect(lesson.description.length).toBeGreaterThan(0);
      expect(lesson.courseId.length).toBeGreaterThan(0);
      expect(lesson.schemaVersion).toBeGreaterThan(0);
    });

    it(`${lesson.id}: has 3–6 steps`, () => {
      expect(lesson.steps.length).toBeGreaterThanOrEqual(3);
      expect(lesson.steps.length).toBeLessThanOrEqual(6);
    });

    it(`${lesson.id}: all steps have non-empty instruction and explanation`, () => {
      for (const step of lesson.steps) {
        expect(step.instruction.length, `${step.id} instruction empty`).toBeGreaterThan(0);
        expect(step.explanation.length, `${step.id} explanation empty`).toBeGreaterThan(0);
      }
    });

    it(`${lesson.id}: all steps have non-empty id and title`, () => {
      for (const step of lesson.steps) {
        expect(step.id.length, `step id empty`).toBeGreaterThan(0);
        expect(step.title.length, `step title empty`).toBeGreaterThan(0);
      }
    });

    it(`${lesson.id}: all steps have at least one non-empty hint`, () => {
      for (const step of lesson.steps) {
        expect(step.hints.length, `${step.id} has no hints`).toBeGreaterThan(0);
        for (const hint of step.hints) {
          expect(hint.length, `${step.id} has empty hint`).toBeGreaterThan(0);
        }
      }
    });

    it(`${lesson.id}: exercise steps have valid exercise with correctIndex in range`, () => {
      for (const step of lesson.steps) {
        if (step.goal.kind !== 'exercise') continue;
        expect(step.exercise, `${step.id} missing exercise`).toBeDefined();
        const ex = step.exercise!;
        expect(ex.question.length, `${step.id} question empty`).toBeGreaterThan(0);
        expect(ex.explanation.length, `${step.id} explanation empty`).toBeGreaterThan(0);
        expect(ex.choices.length, `${step.id} no choices`).toBeGreaterThan(0);
        for (const choice of ex.choices) {
          expect(choice.length, `${step.id} empty choice`).toBeGreaterThan(0);
        }
        if (ex.kind === 'multipleChoice') {
          expect(ex.correctIndex).toBeGreaterThanOrEqual(0);
          expect(ex.correctIndex).toBeLessThan(ex.choices.length);
        } else {
          expect(ex.correctOrder.length).toBe(ex.choices.length);
          const sorted = [...ex.correctOrder].sort((a, b) => a - b);
          expect(sorted).toEqual([...Array(ex.choices.length).keys()]);
        }
      }
    });
  }
});

describe('lesson level values', () => {
  it('all BASIC lessons have level "basic"', () => {
    for (const lesson of BASIC_LESSONS) {
      expect(lesson.level).toBe('basic');
    }
  });

  it('all COMPOSE lessons have level "compose"', () => {
    for (const lesson of COMPOSE_LESSONS) {
      expect(lesson.level).toBe('compose');
    }
  });
});

describe('exercise steps have exercise objects', () => {
  it('every step with goal.kind=exercise has a non-null exercise', () => {
    for (const lesson of ALL_LESSONS) {
      for (const step of lesson.steps) {
        if (step.goal.kind === 'exercise') {
          expect(step.exercise, `${lesson.id}/${step.id} missing exercise`).toBeDefined();
        }
      }
    }
  });
});

describe('goal kinds', () => {
  it('all lessons contain at least one non-exercise goal (event or project)', () => {
    for (const lesson of ALL_LESSONS) {
      const hasNonExercise = lesson.steps.some(
        (s) => s.goal.kind === 'event' || s.goal.kind === 'project',
      );
      expect(hasNonExercise, `lesson ${lesson.id} has only exercise goals`).toBe(true);
    }
  });
});
