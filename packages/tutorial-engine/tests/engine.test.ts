import { beforeEach, describe, expect, it } from 'vitest';
import { TutorialEngine } from '../src/engine.js';
import type { AppEvent, TutorialLesson } from '../src/types.js';
import { makeProject } from './helpers.js';

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
