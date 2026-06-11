import { beforeEach, describe, expect, it } from 'vitest';
import { TutorialEngine } from '../src/engine.js';
import { COURSE0_LESSONS } from '../src/content/index.js';
import type { AppEvent, TutorialLesson } from '../src/types.js';
import {
  makeBassTrack,
  makeDrumEvent,
  makeDrumTrack,
  makeMelodyTrack,
  makeNote,
  makeProject,
  makeSection,
} from './helpers.js';

// Minimal 3-step lesson: event → project → exercise
const TEST_LESSON: TutorialLesson = {
  id: 'test-lesson',
  courseId: 'test',
  level: 'basic',
  schemaVersion: 1,
  title: 'テストレッスン',
  description: 'エンジンテスト用レッスン',
  steps: [
    {
      id: 'step-1',
      title: 'コードを追加しよう',
      instruction: 'コードトラックにCコードを置いてください。',
      explanation: 'コードとは...',
      goal: { kind: 'event', eventType: 'chord.added', count: 1 },
      hints: ['ヒント1', 'ヒント2'],
    },
    {
      id: 'step-2',
      title: 'BPMを確認しよう',
      instruction: 'BPMが60〜180の範囲か確認してください。',
      explanation: 'テンポとは...',
      goal: { kind: 'project', predicate: { type: 'bpmInRange', min: 60, max: 180 } },
      hints: ['BPMはトランスポートで確認'],
    },
    {
      id: 'step-3',
      title: 'クイズ',
      instruction: '下の問題に答えてください。',
      explanation: '理解の確認',
      goal: { kind: 'exercise' },
      hints: ['ヒントA'],
      exercise: {
        kind: 'multipleChoice',
        question: 'Cの半音上は？',
        choices: ['D', 'C#', 'B'],
        correctIndex: 1,
        explanation: 'C#が正解です。',
      },
    },
  ],
};

describe('TutorialEngine', () => {
  let engine: TutorialEngine;
  const project = makeProject({ bpm: 120 });

  beforeEach(() => {
    engine = new TutorialEngine();
    engine.loadLesson(TEST_LESSON);
  });

  // ─── Initial state ──────────────────────────────────────────────────────────

  it('starts at step 0 with inProgress status', () => {
    const state = engine.getState();
    expect(state.lessonId).toBe('test-lesson');
    expect(state.stepIndex).toBe(0);
    expect(state.status).toBe('inProgress');
    expect(state.currentStep?.id).toBe('step-1');
  });

  it('returns idle state before loadLesson', () => {
    const fresh = new TutorialEngine();
    const state = fresh.getState();
    expect(state.status).toBe('idle');
    expect(state.currentStep).toBeNull();
  });

  // ─── Event-based step advancement ──────────────────────────────────────────

  it('does not advance on wrong event type', () => {
    const wrongEvent: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    const result = engine.handleEvent(wrongEvent, project);
    expect(result.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(0);
  });

  it('advances to step 1 when chord.added event fires', () => {
    const event: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    const result = engine.handleEvent(event, project);
    expect(result.advanced).toBe(true);
    expect(result.completedLesson).toBe(false);
    expect(engine.getState().stepIndex).toBe(1);
  });

  // ─── Project-based step advancement ────────────────────────────────────────

  it('advances step 2 (project predicate) when bpm is in range', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);
    expect(engine.getState().stepIndex).toBe(1);

    const anyEvent: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    const result = engine.handleEvent(anyEvent, project);
    expect(result.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(2);
  });

  // ─── Exercise step ──────────────────────────────────────────────────────────

  it('exercise goal is not satisfied by events', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);
    const anyEvent: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    engine.handleEvent(anyEvent, project);
    expect(engine.getState().stepIndex).toBe(2);

    const result = engine.handleEvent(anyEvent, project);
    expect(result.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(2);
  });

  it('answerExercise with correct answer completes lesson', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);
    const anyEvent: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    engine.handleEvent(anyEvent, project);

    const result = engine.answerExercise({ kind: 'multipleChoice', selectedIndex: 1 });
    expect(result.correct).toBe(true);
    expect(result.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
    expect(result.message).toContain('完了');
  });

  it('answerExercise with wrong answer does not advance', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);
    const anyEvent: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    engine.handleEvent(anyEvent, project);

    const result = engine.answerExercise({ kind: 'multipleChoice', selectedIndex: 0 });
    expect(result.correct).toBe(false);
    expect(result.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(2);
    expect(engine.getState().status).toBe('inProgress');
  });

  it('answerExercise returns error when not on exercise step', () => {
    const result = engine.answerExercise({ kind: 'multipleChoice', selectedIndex: 1 });
    expect(result.correct).toBe(false);
    expect(result.feedback).toContain('演習ではありません');
  });

  // ─── Hint cycling ──────────────────────────────────────────────────────────

  it('returns first hint then second hint then cycles back', () => {
    const h1 = engine.requestHint();
    expect(h1).toBe('ヒント1');
    const h2 = engine.requestHint();
    expect(h2).toBe('ヒント2');
    const h3 = engine.requestHint();
    expect(h3).toBe('ヒント1');
  });

  it('returns null when step has no hints', () => {
    const noHintLesson: TutorialLesson = {
      ...TEST_LESSON,
      steps: [{ ...TEST_LESSON.steps[0]!, hints: [] }],
    };
    const e = new TutorialEngine();
    e.loadLesson(noHintLesson);
    expect(e.requestHint()).toBeNull();
  });

  // ─── Progress save/load ─────────────────────────────────────────────────────

  it('toProgress returns null when no lesson loaded', () => {
    const e = new TutorialEngine();
    expect(e.toProgress()).toBeNull();
  });

  it('saves and restores progress at correct step', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);

    const progress = engine.toProgress();
    expect(progress).not.toBeNull();
    expect(progress!.lessonId).toBe('test-lesson');
    expect(progress!.currentStep).toBe(1);
    expect(progress!.status).toBe('inProgress');
    expect(progress!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const fresh = new TutorialEngine();
    fresh.loadLesson(TEST_LESSON, progress!);
    expect(fresh.getState().stepIndex).toBe(1);
    expect(fresh.getState().status).toBe('inProgress');
  });

  it('fromProgress restores progress equivalently to loadLesson', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);
    const progress = engine.toProgress()!;

    const fresh = new TutorialEngine();
    fresh.fromProgress(TEST_LESSON, progress);
    expect(fresh.getState().stepIndex).toBe(1);
  });

  it('ignores saved progress from a different lesson', () => {
    const progress = {
      lessonId: 'other-lesson',
      status: 'inProgress' as const,
      currentStep: 2,
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const e = new TutorialEngine();
    e.loadLesson(TEST_LESSON, progress);
    expect(e.getState().stepIndex).toBe(0);
  });

  it('restores completed status from saved progress', () => {
    const progress = {
      lessonId: 'test-lesson',
      status: 'completed' as const,
      currentStep: 2,
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const e = new TutorialEngine();
    e.loadLesson(TEST_LESSON, progress);
    expect(e.getState().status).toBe('completed');
  });

  // ─── No-op when completed ───────────────────────────────────────────────────

  it('handleEvent is no-op when lesson is completed', () => {
    const chordEvent: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
    engine.handleEvent(chordEvent, project);
    const anyEvent: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    engine.handleEvent(anyEvent, project);
    engine.answerExercise({ kind: 'multipleChoice', selectedIndex: 1 });
    expect(engine.getState().status).toBe('completed');

    const extra = engine.handleEvent(chordEvent, project);
    expect(extra.advanced).toBe(false);
    expect(extra.completedLesson).toBe(false);
  });
});

// ─── export.midi / export.wav advancement ─────────────────────────────────────

describe('TutorialEngine — exportCompleted predicate', () => {
  const project = makeProject({ bpm: 120 });

  const EXPORT_LESSON: TutorialLesson = {
    id: 'export-test-lesson',
    courseId: 'test',
    level: 'basic',
    schemaVersion: 1,
    title: '書き出しテスト',
    description: 'export.midi / export.wav 達成判定テスト',
    steps: [
      {
        id: 'export-step-midi',
        title: 'MIDIで書き出す',
        instruction: 'MIDIファイルを書き出してください。',
        explanation: 'MIDIは音符情報ファイルです。',
        goal: {
          kind: 'project',
          predicate: { type: 'exportCompleted', format: 'midi' },
        },
        hints: ['ファイルメニューから「書き出し → MIDI」を選んでください。'],
      },
    ],
  };

  const WAV_EXPORT_LESSON: TutorialLesson = {
    id: 'wav-export-test-lesson',
    courseId: 'test',
    level: 'basic',
    schemaVersion: 1,
    title: 'WAV書き出しテスト',
    description: 'export.wav 達成判定テスト',
    steps: [
      {
        id: 'export-step-wav',
        title: 'WAVで書き出す',
        instruction: 'WAVファイルを書き出してください。',
        explanation: 'WAVはどこでも再生できる音声ファイルです。',
        goal: {
          kind: 'project',
          predicate: { type: 'exportCompleted', format: 'wav' },
        },
        hints: ['ファイルメニューから「書き出し → WAV」を選んでください。'],
      },
    ],
  };

  it('advances step when export.midi event fires for midi format goal', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(EXPORT_LESSON);
    expect(engine.getState().stepIndex).toBe(0);

    const result = engine.handleEvent(
      { type: 'export.midi', payload: { format: 'midi' } },
      project,
    );
    expect(result.advanced).toBe(true);
    expect(result.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  it('does NOT advance when export.wav fires but goal requires midi', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(EXPORT_LESSON);

    const result = engine.handleEvent(
      { type: 'export.wav', payload: { format: 'wav' } },
      project,
    );
    expect(result.advanced).toBe(false);
    expect(engine.getState().status).toBe('inProgress');
  });

  it('advances step when export.wav event fires for wav format goal', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(WAV_EXPORT_LESSON);

    const result = engine.handleEvent(
      { type: 'export.wav', payload: { format: 'wav' } },
      project,
    );
    expect(result.advanced).toBe(true);
    expect(result.completedLesson).toBe(true);
  });

  it('transport.played does NOT satisfy exportCompleted goal', () => {
    const engine = new TutorialEngine();
    engine.loadLesson(EXPORT_LESSON);

    const result = engine.handleEvent(
      { type: 'transport.played', payload: { positionBeats: 0 } },
      project,
    );
    expect(result.advanced).toBe(false);
    expect(engine.getState().status).toBe('inProgress');
  });
});

// ─── Course 0 integration tests ───────────────────────────────────────────────

describe('COURSE0_LESSONS — 0-1 through 0-8 integration', () => {
  // ─── Helper: drive a lesson through all steps to completion ────────────────

  function driveToCompletion(
    engine: TutorialEngine,
    events: AppEvent[],
    project: ReturnType<typeof makeProject>,
  ): void {
    for (const ev of events) {
      engine.handleEvent(ev, project);
      if (engine.getState().status === 'completed') break;
      // answer exercise step if needed
      const step = engine.getState().currentStep;
      if (step?.goal.kind === 'exercise') {
        const ex = engine.getCurrentExercise();
        if (ex?.kind === 'multipleChoice') {
          engine.answerExercise({ kind: 'multipleChoice', selectedIndex: ex.correctIndex });
        }
      }
    }
  }

  // ─── 0-1: テンプレートから音を鳴らす ─────────────────────────────────────

  it('0-1: completes via project.created → transport.played (+ exercise)', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[0]!;
    engine.loadLesson(lesson);

    expect(engine.getState().stepIndex).toBe(0);

    // step 1: project.created
    const r1 = engine.handleEvent(
      { type: 'project.created', payload: { key: 'C', bpm: 120 } },
      makeProject(),
    );
    expect(r1.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(1);

    // step 2: transport.played
    const r2 = engine.handleEvent(
      { type: 'transport.played', payload: { positionBeats: 0 } },
      makeProject(),
    );
    expect(r2.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(2);

    // step 3: exercise
    const ex = engine.getCurrentExercise();
    expect(ex).not.toBeNull();
    expect(ex!.kind).toBe('multipleChoice');
    const grade = engine.answerExercise({
      kind: 'multipleChoice',
      selectedIndex: (ex as { correctIndex: number }).correctIndex,
    });
    expect(grade.correct).toBe(true);
    expect(grade.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  // ─── 0-2: コード進行を選ぶ ────────────────────────────────────────────────

  it('0-2: completes via chord count → progression equals → exercise', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[1]!;
    engine.loadLesson(lesson);

    const oneChord = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
      ],
    });
    const r1 = engine.handleEvent(
      { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } },
      oneChord,
    );
    expect(r1.advanced).toBe(true);

    const fullProgression = makeProject({
      chordTrack: [
        { id: '1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [] },
        { id: '2', startBeat: 4, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [] },
        { id: '3', startBeat: 8, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [] },
        { id: '4', startBeat: 12, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [] },
      ],
    });
    const r2 = engine.handleEvent(
      { type: 'chord.changed', payload: { bar: 3, chordSymbol: 'F' } },
      fullProgression,
    );
    expect(r2.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(2);

    // exercise step
    const ex = engine.getCurrentExercise()!;
    const grade = engine.answerExercise({
      kind: 'multipleChoice',
      selectedIndex: (ex as { correctIndex: number }).correctIndex,
    });
    expect(grade.correct).toBe(true);
    expect(grade.completedLesson).toBe(true);
  });

  // ─── 0-3: ドラムを足す — drumPatternHas kick≥4/snare≥2 ──────────────────

  it('0-3: step 2 advances when kick≥4 AND snare≥2 in project', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[2]!;
    engine.loadLesson(lesson);

    // step 1: any drum.stepToggled event
    const projectWithOneDrum = makeProject({
      tracks: [makeDrumTrack([makeDrumEvent('kick', 0)])],
    });
    engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 0, active: true, trackId: 'drums' } },
      projectWithOneDrum,
    );
    expect(engine.getState().stepIndex).toBe(1);

    // step 2 (drumPatternHas): project must have kick≥4 AND snare≥2
    const insufficientProject = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 4),
          makeDrumEvent('kick', 8),
          makeDrumEvent('kick', 12),
          // no snare → should NOT advance
        ]),
      ],
    });
    const noAdvance = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 12, active: true, trackId: 'drums' } },
      insufficientProject,
    );
    expect(noAdvance.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(1);

    // now with kick≥4 AND snare≥2
    const goodProject = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 4),
          makeDrumEvent('kick', 8),
          makeDrumEvent('kick', 12),
          makeDrumEvent('snare', 4),
          makeDrumEvent('snare', 12),
        ]),
      ],
    });
    const r = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'snare', stepIndex: 12, active: true, trackId: 'drums' } },
      goodProject,
    );
    expect(r.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(2);

    // exercise step
    const ex = engine.getCurrentExercise()!;
    const grade = engine.answerExercise({
      kind: 'multipleChoice',
      selectedIndex: (ex as { correctIndex: number }).correctIndex,
    });
    expect(grade.correct).toBe(true);
    expect(grade.completedLesson).toBe(true);
  });

  it('0-3: does NOT advance on kick≥4 only (snare missing)', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[2]!;
    engine.loadLesson(lesson);

    // advance past step 1
    engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 0, active: true, trackId: 'drums' } },
      makeProject({ tracks: [makeDrumTrack([makeDrumEvent('kick', 0)])] }),
    );

    // kick only — snare missing → step 2 should NOT advance
    const kickOnly = makeProject({
      tracks: [
        makeDrumTrack([
          makeDrumEvent('kick', 0),
          makeDrumEvent('kick', 4),
          makeDrumEvent('kick', 8),
          makeDrumEvent('kick', 12),
        ]),
      ],
    });
    const result = engine.handleEvent(
      { type: 'drum.stepToggled', payload: { lane: 'kick', stepIndex: 12, active: true, trackId: 'drums' } },
      kickOnly,
    );
    expect(result.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(1);
  });

  // ─── 0-8: 書き出す — export.midi AND export.wav ───────────────────────────

  it('0-8: completes via export.midi event', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[7]!;
    engine.loadLesson(lesson);

    // advance past step 1 (transport.played)
    engine.handleEvent(
      { type: 'transport.played', payload: { positionBeats: 0 } },
      makeProject(),
    );
    expect(engine.getState().stepIndex).toBe(1);

    // step 2: exportCompleted — trigger via export.midi
    const r = engine.handleEvent(
      { type: 'export.midi', payload: { format: 'midi' } },
      makeProject(),
    );
    expect(r.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(2);

    // exercise step
    const ex = engine.getCurrentExercise()!;
    const grade = engine.answerExercise({
      kind: 'multipleChoice',
      selectedIndex: (ex as { correctIndex: number }).correctIndex,
    });
    expect(grade.correct).toBe(true);
    expect(grade.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  it('0-8: completes via export.wav event', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[7]!;
    engine.loadLesson(lesson);

    // advance past step 1
    engine.handleEvent(
      { type: 'transport.played', payload: { positionBeats: 0 } },
      makeProject(),
    );

    // step 2: exportCompleted — trigger via export.wav
    const r = engine.handleEvent(
      { type: 'export.wav', payload: { format: 'wav' } },
      makeProject(),
    );
    expect(r.advanced).toBe(true);
    expect(engine.getState().stepIndex).toBe(2);

    const ex = engine.getCurrentExercise()!;
    const grade = engine.answerExercise({
      kind: 'multipleChoice',
      selectedIndex: (ex as { correctIndex: number }).correctIndex,
    });
    expect(grade.correct).toBe(true);
    expect(grade.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  it('0-8: non-export event does NOT advance step 2', () => {
    const engine = new TutorialEngine();
    const lesson = COURSE0_LESSONS[7]!;
    engine.loadLesson(lesson);

    // advance past step 1
    engine.handleEvent(
      { type: 'transport.played', payload: { positionBeats: 0 } },
      makeProject(),
    );
    expect(engine.getState().stepIndex).toBe(1);

    // chord.added should NOT satisfy exportCompleted
    const result = engine.handleEvent(
      { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } },
      makeProject(),
    );
    expect(result.advanced).toBe(false);
    expect(engine.getState().stepIndex).toBe(1);
  });
});
