import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { getLessonById, type AppEvent } from '@cts/tutorial-engine';
import { MAX_TRACK_EFFECTS } from '@cts/project-model';
import {
  __resetRendererStorageFenceForTest,
  fenceRendererStorageWrites,
} from '../src/platform/rendererStorageFence';

// The store + bridge read localStorage at import time, so install the stub
// before importing them (mirrors store.test.ts).
let bridge: typeof import('../src/state/tutorialBridge');
let appEvents: typeof import('../src/state/appEvents');
let useStore: typeof import('../src/state/store')['useStore'];
let addChordWithAnalysis: typeof import('../src/state/editorActions')['addChordWithAnalysis'];
let addTrackEffect: typeof import('../src/state/editorActions')['addTrackEffect'];

beforeAll(async () => {
  installLocalStorage();
  bridge = await import('../src/state/tutorialBridge');
  appEvents = await import('../src/state/appEvents');
  ({ useStore } = await import('../src/state/store'));
  ({ addChordWithAnalysis, addTrackEffect } = await import('../src/state/editorActions'));
});

beforeEach(async () => {
  __resetRendererStorageFenceForTest();
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  bridge.__resetBridgeForTest();
  expect(await useStore.getState().createNewProject('テスト')).toBe(true);
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

const chorusSection = {
  id: 'tutorial-chorus',
  name: 'サビ',
  type: 'chorus' as const,
  startBar: 0,
  lengthBars: 1,
};

async function flushProjectReconciliation(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe('tutorialBridge event flow', () => {
  it('does not advance for an effect candidate rejected at the codec limit', () => {
    const melody = useStore.getState().project.tracks.find(
      (track) => track.name === 'Melody',
    );
    if (!melody) throw new Error('Melody track fixture is missing');
    for (let index = 0; index < MAX_TRACK_EFFECTS; index += 1) {
      expect(addTrackEffect(melody.id, 'filter')).not.toBeNull();
    }

    bridge.startLesson('compose-plus-4', { restart: true });
    useStore.getState().setTrackVolume(melody.id, 0.7);
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id)
      .toBe('compose-plus-4-s2');

    expect(addTrackEffect(melody.id, 'reverb')).toBeNull();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id)
      .toBe('compose-plus-4-s2');
    expect(useStore.getState().project.tracks.find(
      (track) => track.id === melody.id,
    )?.effects).toHaveLength(MAX_TRACK_EFFECTS);
  });

  it('advances compose-4 only when scale snap is enabled for C major', () => {
    bridge.startLesson('compose-4', { restart: true });
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s1');

    useStore.getState().setKey('G');
    useStore.getState().setScale('naturalMinor');
    useStore.getState().toggleScaleSnap();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s1');

    useStore.getState().setKey('C');
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s1');

    useStore.getState().setScale('major');
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s2');
    expect(bridge.loadProgress('compose-4')?.currentStep).toBe(1);
  });

  it('reconciles an enabled scale snap state restored by undo', () => {
    bridge.startLesson('compose-4', { restart: true });
    useStore.getState().setKey('G');
    useStore.getState().toggleScaleSnap();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s1');

    useStore.getState().undo();

    expect(useStore.getState().project.key).toBe('C');
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s2');
  });

  it('reconciles an enabled scale snap state restored by redo', () => {
    useStore.getState().setKey('G');
    useStore.getState().setKey('C');
    useStore.getState().undo();
    bridge.startLesson('compose-4', { restart: true });
    useStore.getState().toggleScaleSnap();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s1');

    useStore.getState().redo();

    expect(useStore.getState().project.key).toBe('C');
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s2');
  });

  it('reconciles an already-correct scale snap state when a lesson starts', () => {
    useStore.getState().toggleScaleSnap();
    bridge.startLesson('compose-4', { restart: true });

    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s2');
    expect(bridge.getBridgeSnapshot().toasts.at(-1)?.message).toContain('すでにオン');
    expect(bridge.loadProgress('compose-4')?.currentStep).toBe(1);
  });

  it('reconciles an already-correct scale snap state when a lesson resumes', () => {
    useStore.getState().toggleScaleSnap();
    localStorage.setItem(
      'cts.tutorial.compose-4',
      JSON.stringify({
        lessonId: 'compose-4',
        status: 'inProgress',
        currentStep: 0,
        updatedAt: new Date(0).toISOString(),
        eventCounts: {},
      }),
    );

    bridge.startLesson('compose-4');

    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-4-s2');
    expect(bridge.loadProgress('compose-4')?.currentStep).toBe(1);
  });

  it('reconciles scale snap enabled during the preceding basic-2 step', () => {
    bridge.startLesson('basic-2', { restart: true });
    useStore.getState().toggleScaleSnap();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('basic-2-s1');

    const melody = useStore.getState().project.tracks.find((track) => track.name === 'Melody');
    const clipId = melody?.clips[0]?.id ?? '';
    for (let index = 0; index < 7; index += 1) {
      useStore.getState().addNote(clipId, {
        pitch: 60 + index,
        startBeat: index,
        durationBeats: 1,
        velocity: 100,
      });
    }

    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('basic-2-s3');
    expect(bridge.loadProgress('basic-2')?.currentStep).toBe(2);
    expect(bridge.getBridgeSnapshot().toasts).toHaveLength(1);
    expect(bridge.getBridgeSnapshot().toasts[0]?.message).toContain('すでにオン');
  });

  it('advances an eventless Arranger section type change from adopted state', async () => {
    bridge.startLesson('compose-5', { restart: true });
    bridge.requestHint();
    expect(bridge.getBridgeSnapshot().hint).toContain('＋ セクションを追加');

    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [{ ...chorusSection, type: 'verse', name: 'Aメロ' }],
    }))).toBe(true);
    await flushProjectReconciliation();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s1');

    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: project.sections.map((section) =>
        section.id === chorusSection.id ? { ...section, type: 'chorus' } : section),
    }))).toBe(true);
    await flushProjectReconciliation();
    // The default Melody volume already satisfies the consecutive state goal.
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s3');
    expect(bridge.getBridgeSnapshot().hint).toBeNull();
  });

  it('reconciles project goals already satisfied when a lesson starts or resumes', () => {
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [chorusSection],
    }))).toBe(true);
    bridge.startLesson('compose-5', { restart: true });
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s3');

    bridge.stopLesson();
    localStorage.setItem('cts.tutorial.compose-5', JSON.stringify({
      lessonId: 'compose-5',
      status: 'inProgress',
      currentStep: 0,
      updatedAt: new Date(0).toISOString(),
      eventCounts: {},
    }));
    bridge.startLesson('compose-5');
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s3');
  });

  it('reconciles chorus restored by undo and redo', async () => {
    // Undo restores a removed chorus.
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [chorusSection],
    }))).toBe(true);
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [],
    }))).toBe(true);
    bridge.startLesson('compose-5', { restart: true });
    useStore.getState().undo();
    await flushProjectReconciliation();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s3');

    // Redo restores a chorus that was undone before the lesson began.
    bridge.stopLesson();
    useStore.getState().undo();
    bridge.startLesson('compose-5', { restart: true });
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s1');
    useStore.getState().redo();
    await flushProjectReconciliation();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s3');
  });

  it('does not advance for a rejected project candidate', async () => {
    bridge.startLesson('compose-5', { restart: true });
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [{ ...chorusSection, startBar: project.lengthBars, lengthBars: 1 }],
    }))).toBe(false);
    await flushProjectReconciliation();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id).toBe('compose-5-s1');
  });

  it('invalidates queued reconciliation when another lesson starts', async () => {
    bridge.startLesson('compose-5', { restart: true });
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project,
      sections: [chorusSection],
    }))).toBe(true);
    bridge.startLesson('basic-1', { restart: true });
    await flushProjectReconciliation();

    expect(bridge.getBridgeSnapshot().engineState?.lessonId).toBe('basic-1');
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(0);
  });

  it('does not reuse a project-completing domain event for the next step', async () => {
    bridge.startLesson('compose-plus-1', { restart: true });
    addChordWithAnalysis('C', 0, 4);
    addChordWithAnalysis('G', 4, 4);

    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id)
      .toBe('compose-plus-1-s2');
    await flushProjectReconciliation();
    expect(bridge.getBridgeSnapshot().engineState?.currentStep?.id)
      .toBe('compose-plus-1-s2');
  });

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

  it('never recreates tutorial progress after renderer erasure is fenced', () => {
    fenceRendererStorageWrites();
    bridge.startLesson('basic-1');
    bridge.handleAppEvent(noteAdded, useStore.getState().project);

    expect(localStorage.getItem('cts.tutorial.basic-1')).toBeNull();
  });
});
