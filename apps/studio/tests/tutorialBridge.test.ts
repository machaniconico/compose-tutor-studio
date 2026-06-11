import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { getLessonById, type AppEvent } from '@cts/tutorial-engine';

// The store + bridge read localStorage at import time, so install the stub
// before importing them (mirrors store.test.ts).
let bridge: typeof import('../src/state/tutorialBridge');
let appEvents: typeof import('../src/state/appEvents');
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  bridge = await import('../src/state/tutorialBridge');
  appEvents = await import('../src/state/appEvents');
  ({ useStore } = await import('../src/state/store'));
});

beforeEach(() => {
  installLocalStorage();
  bridge.__resetBridgeForTest();
  useStore.getState().createNewProject('テスト');
});

const noteAdded: AppEvent = {
  type: 'note.added',
  payload: {
    pitch: 60,
    startBeat: 0,
    durationBeats: 1,
    trackId: 't',
    trackName: 'Melody',
    inScale: true,
  },
};

describe('tutorialBridge event flow', () => {
  it('advances the engine when a matching app event is published', () => {
    // basic-1 step 1 goal: { event, note.added, count 1 }
    bridge.startLesson('basic-1');
    const before = bridge.getBridgeSnapshot().engineState;
    expect(before?.stepIndex).toBe(0);

    const result = bridge.handleAppEvent(noteAdded, useStore.getState().project);
    expect(result.advanced).toBe(true);

    const after = bridge.getBridgeSnapshot().engineState;
    expect(after?.stepIndex).toBe(1);
  });

  it('forwards published app events through the pub/sub subscription', () => {
    bridge.startLesson('basic-1');
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(0);

    // Publish via the decoupled bus — the bridge's subscription should forward
    // it to the engine and advance the step.
    appEvents.publishAppEvent(noteAdded);
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(1);
  });

  it('ignores non-matching events (no advance)', () => {
    bridge.startLesson('basic-1');
    const played: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
    appEvents.publishAppEvent(played);
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(0);
  });

  it('persists progress to localStorage and restores it on restart', () => {
    bridge.startLesson('basic-1');
    appEvents.publishAppEvent(noteAdded); // advance to step 1
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(1);

    const saved = bridge.loadProgress('basic-1');
    expect(saved?.currentStep).toBe(1);
    expect(saved?.status).toBe('inProgress');

    // Restart the lesson (fresh engine) — progress should be restored.
    bridge.__resetBridgeForTest();
    bridge.startLesson('basic-1');
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(1);
    expect(bridge.lessonStatus('basic-1')).toBe('inProgress');
  });

  it('reports idle status for a never-started lesson', () => {
    const lesson = getLessonById('basic-2');
    expect(lesson).toBeDefined();
    expect(bridge.lessonStatus('basic-2')).toBe('idle');
  });

  it('grades a multipleChoice exercise and advances on the correct answer', () => {
    // basic-1: step0 note.added -> step1 noteCountAtLeast(Melody>=2) -> step2 MC.
    bridge.startLesson('basic-1');

    const project = useStore.getState().project;
    const melody = project.tracks.find((t) => t.name === 'Melody');
    const clipId = melody?.clips[0]?.id ?? '';
    // Each addNote publishes note.added; the engine re-evaluates the goal against
    // the live project, satisfying step0 then the step1 predicate.
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });
    useStore.getState().addNote(clipId, { pitch: 62, startBeat: 1, durationBeats: 1, velocity: 100 });
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(2);

    // Now answer the exercise correctly (correctIndex 1).
    const grade = bridge.answerExercise({ kind: 'multipleChoice', selectedIndex: 1 });
    expect(grade.correct).toBe(true);
    expect(grade.advanced).toBe(true);
  });
});
