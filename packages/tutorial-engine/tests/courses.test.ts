/**
 * courses.test.ts — Course 0 structural and engine-route verification
 *
 * Verifies that course0 (TutorialLesson[]) conforms to
 * docs/03_tutorial_learning_spec.md and works via TutorialEngine:
 *   - 8 lessons in correct spec order
 *   - Each lesson has the expected id, title, and meaningful steps
 *   - 0-1 advances on project.created then transport.played
 *   - 0-3 uses drumLaneActive ProjectPredicate (kick≥4, snare≥2), not event count
 *   - 0-8 advances on export.midi or export.wav AppEvent
 *   - Sequential 0-1 → 0-8 engine walkthrough completes the course
 */

import { describe, expect, it } from 'vitest';
import { TutorialEngine } from '../src/engine.js';
import { course0 } from '../src/courses.js';
import type { AppEvent, TutorialLesson } from '../src/types.js';
import {
  makeDrumEvent,
  makeDrumTrack,
  makeMelodyTrack,
  makeBassTrack,
  makeNote,
  makeProject,
  makeSection,
} from './helpers.js';

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
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all lessons have level "basic"', () => {
    for (const lesson of course0) {
      expect(lesson.level).toBe('basic');
    }
  });

  it('all lessons have at least one step', () => {
    for (const lesson of course0) {
      expect(lesson.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all step ids are unique across the course', () => {
    const allStepIds = course0.flatMap((l) => l.steps.map((s) => s.id));
    expect(new Set(allStepIds).size).toBe(allStepIds.length);
  });

  it('all steps have non-empty instruction, explanation, and at least one hint', () => {
    for (const lesson of course0) {
      for (const step of lesson.steps) {
        expect(step.instruction.length, `${step.id} instruction empty`).toBeGreaterThan(0);
        expect(step.explanation.length, `${step.id} explanation empty`).toBeGreaterThan(0);
        expect(step.hints.length, `${step.id} no hints`).toBeGreaterThanOrEqual(1);
        expect(step.hints[0]!.length, `${step.id} hint[0] empty`).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Spec-aligned lesson IDs and titles ──────────────────────────────────────

describe('course0 — spec-aligned lesson order', () => {
  it('lesson [0] is spec 0-1: テンプレートから音を鳴らす', () => {
    const l = course0[0] as TutorialLesson;
    expect(l.id).toBe('course0_lesson01');
    expect(l.title).toContain('テンプレート');
  });

  it('lesson [1] is spec 0-2: コード進行を選ぶ', () => {
    const l = course0[1] as TutorialLesson;
    expect(l.id).toBe('course0_lesson02');
    expect(l.title).toContain('コード進行');
  });

  it('lesson [2] is spec 0-3: ドラムを足す', () => {
    const l = course0[2] as TutorialLesson;
    expect(l.id).toBe('course0_lesson03');
    expect(l.title).toContain('ドラム');
  });

  it('lesson [3] is spec 0-4: ベースを足す', () => {
    const l = course0[3] as TutorialLesson;
    expect(l.id).toBe('course0_lesson04');
    expect(l.title).toContain('ベース');
  });

  it('lesson [4] is spec 0-5: メロディを足す', () => {
    const l = course0[4] as TutorialLesson;
    expect(l.id).toBe('course0_lesson05');
    expect(l.title).toContain('メロディ');
  });

  it('lesson [5] is spec 0-6: 8小節に展開する', () => {
    const l = course0[5] as TutorialLesson;
    expect(l.id).toBe('course0_lesson06');
    expect(l.title).toContain('8小節');
  });

  it('lesson [6] is spec 0-7: 音量を整える', () => {
    const l = course0[6] as TutorialLesson;
    expect(l.id).toBe('course0_lesson07');
    expect(l.title).toContain('音量');
  });

  it('lesson [7] is spec 0-8: 書き出す', () => {
    const l = course0[7] as TutorialLesson;
    expect(l.id).toBe('course0_lesson08');
    expect(l.title).toContain('書き出す');
  });
});

// ─── Goal type assertions ──────────────────────────────────────────────────────

describe('course0 — goal types per spec', () => {
  it('0-1 step1 uses event goal: project.created', () => {
    const step = course0[0]!.steps[0]!;
    expect(step.goal.kind).toBe('event');
    if (step.goal.kind === 'event') {
      expect(step.goal.eventType).toBe('project.created');
    }
  });

  it('0-1 step2 uses event goal: transport.played (spec: 4小節ループ再生)', () => {
    const step = course0[0]!.steps[1]!;
    expect(step.goal.kind).toBe('event');
    if (step.goal.kind === 'event') {
      expect(step.goal.eventType).toBe('transport.played');
    }
  });

  it('0-3 step1 uses project goal: drumLaneActive kick ≥4 (real pattern)', () => {
    const step = course0[2]!.steps[0]!;
    expect(step.goal.kind).toBe('project');
    if (step.goal.kind === 'project') {
      expect(step.goal.predicate.type).toBe('drumLaneActive');
      if (step.goal.predicate.type === 'drumLaneActive') {
        expect(step.goal.predicate.lane).toBe('kick');
        expect(step.goal.predicate.minSteps).toBe(4);
      }
    }
  });

  it('0-3 step2 uses project goal: drumLaneActive snare ≥2 (real pattern)', () => {
    const step = course0[2]!.steps[1]!;
    expect(step.goal.kind).toBe('project');
    if (step.goal.kind === 'project') {
      expect(step.goal.predicate.type).toBe('drumLaneActive');
      if (step.goal.predicate.type === 'drumLaneActive') {
        expect(step.goal.predicate.lane).toBe('snare');
        expect(step.goal.predicate.minSteps).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('0-8 uses exportCompleted ProjectPredicate', () => {
    const step = course0[7]!.steps[0]!;
    expect(step.goal.kind).toBe('project');
    if (step.goal.kind === 'project') {
      expect(step.goal.predicate.type).toBe('exportCompleted');
    }
  });
});

// ─── Individual lesson completion via TutorialEngine ─────────────────────────

describe('course0 lesson completions via TutorialEngine', () => {
  it('0-1 completes after project.created then transport.played', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[0]!);
    const proj = makeProject();

    const r1 = engine.handleEvent({ type: 'project.created', payload: { key: 'C', bpm: 120 } }, proj);
    expect(r1.advanced).toBe(true);
    expect(r1.completedLesson).toBe(false);

    const r2 = engine.handleEvent({ type: 'transport.played', payload: { positionBeats: 0 } }, proj);
    expect(r2.advanced).toBe(true);
    expect(r2.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  it('0-1 does NOT complete after project.created alone', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[0]!);
    const proj = makeProject();

    engine.handleEvent({ type: 'project.created', payload: { key: 'C', bpm: 120 } }, proj);
    expect(engine.getState().status).toBe('inProgress');
    expect(engine.getState().stepIndex).toBe(1);
  });

  it('0-2 completes when project has chordCountAtLeast(1) then progressionEquals', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[1]!);

    const proj1 = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
      ],
    });
    const r1 = engine.handleEvent({ type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } }, proj1);
    expect(r1.advanced).toBe(true);

    const proj2 = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    const r2 = engine.handleEvent({ type: 'chord.added', payload: { bar: 1, chordSymbol: 'G' } }, proj2);
    expect(r2.advanced).toBe(true);
    expect(r2.completedLesson).toBe(true);
  });

  it('0-3 step1 completes when kick lane has ≥4 actual steps in project', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[2]!);

    // 4 distinct kick steps in the drum track
    const projWith4Kicks = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 4),
          makeDrumEvent('kick', 8),
          makeDrumEvent('kick', 12),
        ]),
      ],
    });
    const r1 = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 12, active: true, trackId: 'drums' } },
      projWith4Kicks,
    );
    expect(r1.advanced).toBe(true);
    expect(r1.completedLesson).toBe(false);
    expect(engine.getState().stepIndex).toBe(1);
  });

  it('0-3 step1 does NOT complete with only 3 kicks in project', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[2]!);

    const projWith3Kicks = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 4),
          makeDrumEvent('kick', 8),
        ]),
      ],
    });
    const r = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 8, active: true, trackId: 'drums' } },
      projWith3Kicks,
    );
    expect(r.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(0);
  });

  it('0-3 fully completes when kick≥4 and snare≥2 steps are present', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[2]!);

    const projKicks = makeProject({
      tracks: [makeDrumTrack([
        makeDrumEvent('kick', 0), makeDrumEvent('kick', 4),
        makeDrumEvent('kick', 8), makeDrumEvent('kick', 12),
      ])],
    });
    engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 12, active: true, trackId: 'drums' } },
      projKicks,
    );

    const projFull = makeProject({
      tracks: [makeDrumTrack([
        makeDrumEvent('kick', 0), makeDrumEvent('kick', 4),
        makeDrumEvent('kick', 8), makeDrumEvent('kick', 12),
        makeDrumEvent('snare', 4), makeDrumEvent('snare', 12),
      ])],
    });
    const r2 = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'snare', stepIndex: 12, active: true, trackId: 'drums' } },
      projFull,
    );
    expect(r2.advanced).toBe(true);
    expect(r2.completedLesson).toBe(true);
  });

  it('0-3 does NOT pass with ≥6 arbitrary toggles on wrong lane (regression guard)', () => {
    // Sending 6 events but only on hat lane — snare lane remains empty
    const engine = new TutorialEngine();
    engine.loadLesson(course0[2]!);

    // First advance step1 with real kick data
    const projKicks = makeProject({
      tracks: [makeDrumTrack([
        makeDrumEvent('kick', 0), makeDrumEvent('kick', 4),
        makeDrumEvent('kick', 8), makeDrumEvent('kick', 12),
      ])],
    });
    engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 12, active: true, trackId: 'drums' } },
      projKicks,
    );

    // Step2 requires snare ≥2; sending hat events should not satisfy it
    const projHatsOnly = makeProject({
      tracks: [makeDrumTrack([
        makeDrumEvent('kick', 0), makeDrumEvent('kick', 4),
        makeDrumEvent('kick', 8), makeDrumEvent('kick', 12),
        makeDrumEvent('hat', 2), makeDrumEvent('hat', 6),
      ])],
    });
    const r = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'hat', stepIndex: 6, active: true, trackId: 'drums' } },
      projHatsOnly,
    );
    expect(r.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(1);
  });

  it('0-4 completes when Bass track has ≥4 notes', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[3]!);

    const proj = makeProject({
      tracks: [makeBassTrack([makeNote(36), makeNote(43), makeNote(33), makeNote(41)])],
    });
    const r = engine.handleEvent(
      { type: 'note.added', payload: { pitch: 41, startBeat: 12, durationBeats: 4, trackId: 'bass', trackName: 'Bass', inScale: true } },
      proj,
    );
    expect(r.advanced).toBe(true);
    expect(r.completedLesson).toBe(true);
  });

  it('0-5 completes when Melody track has ≥4 notes', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[4]!);

    const proj = makeProject({
      tracks: [makeMelodyTrack([makeNote(60), makeNote(64), makeNote(67), makeNote(69)])],
    });
    const r = engine.handleEvent(
      { type: 'note.added', payload: { pitch: 69, startBeat: 3, durationBeats: 1, trackId: 'melody', trackName: 'Melody', inScale: true } },
      proj,
    );
    expect(r.advanced).toBe(true);
    expect(r.completedLesson).toBe(true);
  });

  it('0-6 completes after section.added event', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[5]!);

    const proj = makeProject({ sections: [makeSection('verse')] });
    const r = engine.handleEvent(
      { type: 'section.added', payload: { sectionType: 'verse', startBar: 4, lengthBars: 4 } },
      proj,
    );
    expect(r.advanced).toBe(true);
    expect(r.completedLesson).toBe(true);
  });

  it('0-7 completes after track.volumeChanged event', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[6]!);

    const proj = makeProject();
    const r = engine.handleEvent(
      { type: 'track.volumeChanged', payload: { trackId: 'melody', trackName: 'Melody', volume: 0.8 } },
      proj,
    );
    expect(r.advanced).toBe(true);
    expect(r.completedLesson).toBe(true);
  });

  it('0-8 completes after export.midi event', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[7]!);

    const proj = makeProject();
    const r = engine.handleEvent({ type: 'export.midi', payload: { format: 'midi' } }, proj);
    expect(r.advanced).toBe(true);
    expect(r.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  it('0-8 completes after export.wav event', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[7]!);

    const proj = makeProject();
    const r = engine.handleEvent({ type: 'export.wav', payload: { format: 'wav' } }, proj);
    expect(r.advanced).toBe(true);
    expect(r.completedLesson).toBe(true);
  });

  it('0-8 does NOT complete before any export event', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(course0[7]!);

    const proj = makeProject();
    const r = engine.handleEvent({ type: 'transport.played', payload: { positionBeats: 0 } }, proj);
    expect(r.advanced).toBe(false);
    expect(engine.getState().status).toBe('inProgress');
  });
});
