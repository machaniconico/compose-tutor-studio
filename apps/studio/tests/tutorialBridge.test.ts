import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { getLessonById, type AppEvent, type AppEventType } from '@cts/tutorial-engine';

// The store + bridge read localStorage at import time, so install the stub
// before importing them (mirrors store.test.ts).
let bridge: typeof import('../src/state/tutorialBridge');
let appEvents: typeof import('../src/state/appEvents');
let useStore: typeof import('../src/state/store')['useStore'];
let setRecordingStop: typeof import('../src/state/store')['setRecordingStop'];
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  bridge = await import('../src/state/tutorialBridge');
  appEvents = await import('../src/state/appEvents');
  ({ useStore, setRecordingStop } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
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

  describe('renamed tracks', () => {
    const renameTrack = (from: string, to: string): string => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((t) => (t.name === from ? { ...t, name: to } : t)),
      }));
      const track = useStore.getState().project.tracks.find((t) => t.name === to);
      return track?.clips[0]?.id ?? '';
    };
    const addNote = (clipId: string, startBeat: number) =>
      useStore.getState().addNote(clipId, { pitch: 48, startBeat, durationBeats: 1, velocity: 100 });

    it('advances compose-3 when notes go on a renamed Bass track', () => {
      const clipId = renameTrack('Bass', 'ベース');
      bridge.startLesson('compose-3');
      expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(0);

      addNote(clipId, 0); // s1: note.added matching 'Bass'
      expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(1);

      for (const beat of [1, 2, 3]) addNote(clipId, beat); // s2: noteCountAtLeast(Bass>=4)
      expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(2);
    });

    it('advances compose-4 when notes go on a renamed Melody track', () => {
      const clipId = renameTrack('Melody', 'メロディ');
      bridge.startLesson('compose-4');
      appEvents.publishAppEvent({
        type: 'scale_snap.enabled',
        payload: { key: 'C', scale: 'major' },
      });
      expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(1);

      addNote(clipId, 0); // s2: note.added matching 'Melody'
      expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(2);
    });

    it('does not advance compose-3 for a note on a different track', () => {
      renameTrack('Bass', 'ベース');
      const melodyClip = useStore.getState().project.tracks.find((t) => t.name === 'Melody');
      bridge.startLesson('compose-3');
      addNote(melodyClip?.clips[0]?.id ?? '', 0);
      expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(0);
    });
  });
});

describe('DAW operation events', () => {
  let events: AppEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    const { project, addNote } = useStore.getState();
    const clip = project.tracks[2]!.clips[0]!;
    addNote(clip.id, { id: 'first', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });
    addNote(clip.id, { id: 'second', pitch: 64, startBeat: 1, durationBeats: 1, velocity: 100 });
    events = [];
    unsubscribe = appEvents.subscribeAppEvents((event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe();
    setRecordingStop(undefined);
    useStore.getState().flushPendingSave();
    vi.useRealTimers();
  });

  const melody = () => useStore.getState().project.tracks[2]!;
  const capturedNote = (start: number) => [
    { timeBeat: start, midi: 67, velocity: 100, on: true },
    { timeBeat: start + 0.25, midi: 67, velocity: 0, on: false },
  ];
  const setEq = (trackId: string, enabled = true) =>
    actions.updateTrackEffect(trackId, 'eq', (effect) => ({ ...effect, enabled }));

  it('emits one note.moved after a multi-note drag commits', () => {
    const store = useStore.getState();
    const { id } = melody().clips[0]!;
    const owner = Symbol('note drag');
    store.beginTransaction(owner);
    for (const pitch of [62, 65, 67]) {
      store.updateNotes(id, new Map([['first', { pitch }], ['second', { pitch: pitch + 4 }]]));
    }
    expect(events).toEqual([]);
    store.commitTransaction(owner);
    store.commitTransaction(owner);
    expect(events).toEqual([{
      type: 'note.moved',
      payload: { pitch: 67, startBeat: 0, trackId: melody().id, trackName: melody().name },
    }]);
    expect(melody().clips[0]?.notes?.map((note) => note.pitch)).toEqual([67, 71]);
  });

  it('emits after new tracks, clips, splits, section copies and loop ranges exist', () => {
    const store = useStore.getState();
    bridge.startLesson('daw-arrange-clips');
    const trackId = store.addTrack('instrument');
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(1);
    const clipId = actions.addEmptyClipAt(trackId, 32, 64)!;
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(2);
    expect(actions.splitClipAtBeat(clipId, 34)).toBe(true);
    expect(bridge.getBridgeSnapshot().engineState?.stepIndex).toBe(3);

    const source = melody().clips[0]!;
    const copyId = actions.duplicateClipInSong(source.id, 'copy', 128)!;
    expect(bridge.lessonStatus('daw-arrange-clips')).toBe('completed');

    const section = useStore.getState().project.sections[0]!;
    bridge.startLesson('daw-duplicate-section');
    expect(actions.duplicateSectionInSong(section.id)).toBe(true);
    const copy = useStore.getState().project.sections[1]!;
    actions.loopSection(copy.id);
    expect(bridge.lessonStatus('daw-duplicate-section')).toBe('completed');

    expect(events.map((event) => event.type)).toEqual([
      'track.added', 'clip.created', 'clip.split', 'clip.created', 'section.duplicated', 'loop.set',
    ]);
    expect(events[1]?.payload).toEqual({ clipId, trackId, type: 'midi', bars: 1 });
    expect(events[2]?.payload).toMatchObject({ clipId, trackId, atBeat: 34 });
    expect(events[3]?.payload).toMatchObject({ clipId: copyId, trackId: source.trackId });
    expect(events[4]?.payload).toEqual({
      sectionId: section.id, newSectionId: copy.id, startBar: 8, lengthBars: 8,
    });
    expect(events[5]?.payload).toEqual({ range: { startBeat: 32, endBeat: 64 } });
  });

  it('reports the number of written notes when part of a recording is dropped', () => {
    const track = melody();
    const { id: clipId, startBeat: clipStartBeat } = track.clips[0]!;
    bridge.startLesson('daw-record');
    expect(actions.writeRecordingTake({ clipId, clipStartBeat, trackId: track.id }, [
      ...capturedNote(0.5), ...capturedNote(33),
    ], { mode: 'overdub', grid: 0, stopBeat: 34 })).toBe(true);
    expect(events).toEqual([{
      type: 'recording.finished', payload: { trackId: track.id, clipId, notesWritten: 1 },
    }]);
    expect(bridge.lessonStatus('daw-record')).toBe('completed');
    expect(melody().clips[0]?.notes).toHaveLength(3);
  });

  it('groups mixer presets and fader drags and counts points added by one edit', () => {
    const trackId = melody().id;
    const store = useStore.getState();
    bridge.startLesson('daw-mix');
    actions.applyChannelPreset(trackId, 'soft-overall');
    store.beginTransaction();
    store.setTrackVolume(trackId, 0.6);
    store.setTrackVolume(trackId, 0.5);
    expect(events).toHaveLength(1);
    store.commitTransaction();
    expect(actions.setTrackAutomation(trackId, 'volume', undefined, {
      points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }],
    })).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['effect.added', 'track.volumeChanged', 'automation.pointAdded']);
    expect(events[0]?.payload).toEqual({ trackId, effectTypes: ['eq', 'compressor', 'filter'] });
    expect(events[1]?.payload).toMatchObject({ trackId, volume: 0.5 });
    expect(events[2]?.payload).toEqual({ trackId, parameter: 'volume', pointsAdded: 2 });
    expect(bridge.lessonStatus('daw-mix')).toBe('completed');
  });

  it('does not emit for refused operations or unchanged content', () => {
    const store = useStore.getState();
    const track = melody();
    const clip = track.clips[0]!;
    const target = { clipId: clip.id, clipStartBeat: 0, trackId: track.id };
    const options = { mode: 'overdub', grid: 0, stopBeat: 40 } as const;
    const range = { startBeat: 0, endBeat: 4 };
    store.setLoopRange(range);
    setEq(track.id);
    const lane = { points: [{ beat: 0, value: 1 }] };
    expect(actions.setTrackAutomation(track.id, 'volume', undefined, lane)).toBe(true);
    events.length = 0;
    const before = useStore.getState().project;
    expect(actions.addEmptyClipAt('missing', 0, 64)).toBeNull();
    expect(actions.duplicateClipInSong(clip.id, 'copy', 1)).toBeNull();
    expect(actions.splitClipAtBeat(clip.id, clip.startBeat)).toBe(false);
    expect(actions.duplicateSectionInSong('missing')).toBe(false);
    expect(actions.writeRecordingTake(target, [], options)).toBe(false);
    expect(actions.writeRecordingTake(target, capturedNote(33), options)).toBe(false);
    expect(actions.setTrackAutomation(track.id, 'volume', undefined, lane)).toBe(false);
    expect(actions.setTrackAutomation(track.id, 'volume', lane, { points: [{ beat: 0, value: 1 }] })).toBe(false);
    store.setLoopRange({ ...range });
    store.loopRangeOn(range);
    store.toggleLoop();
    setEq(track.id);
    store.setTrackVolume(track.id, track.volume);
    store.updateNote(clip.id, 'missing', { pitch: 80 });
    store.updateNote(clip.id, 'first', { pitch: 60 });

    setRecordingStop(() => {});
    try {
      expect(store.addTrack('instrument')).toBe('');
      expect(actions.addEmptyClipAt(track.id, 32, 64)).toBeNull();
      expect(actions.splitClipAtBeat(clip.id, 2)).toBe(false);
      expect(actions.duplicateSectionInSong(before.sections[0]!.id)).toBe(false);
      expect(actions.writeRecordingTake(target, capturedNote(0.5), options)).toBe(false);
      expect(actions.setTrackAutomation(track.id, 'volume', lane, { points: [...lane.points, { beat: 2, value: 0.5 }] })).toBe(false);
      store.setLoopRange(null);
      actions.applyChannelPreset(track.id, 'soft-overall');
    } finally {
      setRecordingStop(undefined);
    }
    expect(useStore.getState().project).toBe(before);
    expect(events).toEqual([]);
  });

  it('does not emit from Undo, Redo or a cancelled or unchanged drag', () => {
    const store = useStore.getState();
    const clipId = melody().clips[0]!.id;
    store.setLoopRange({ startBeat: 0, endBeat: 4 });
    events.length = 0;

    store.beginTransaction();
    store.updateNote(clipId, 'first', { pitch: 62 });
    store.updateNote(clipId, 'first', { pitch: 60 });
    store.commitTransaction();

    store.beginTransaction();
    store.updateNote(clipId, 'first', { pitch: 62 });
    store.cancelTransaction();

    store.beginTransaction();
    setEq(melody().id);
    store.undo();
    expect(melody().effects).toEqual([]);
    expect(useStore.getState().project.loopRange).toBeUndefined();
    store.redo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 0, endBeat: 4 });
    expect(events).toEqual([]);
  });

  it('matches committed changes across 300 fixed-seed operation sequences', () => {
    const initial = useStore.getState().project;
    let seed = 0x30da2026;
    const pick = (size: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 2 ** 32 * size);
    };
    const changedProject = () => JSON.stringify({ ...useStore.getState().project, updatedAt: '' });
    const count = (types: AppEventType[]) => types.reduce<Record<string, number>>((counts, type) => {
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});
    const successes: AppEventType[] = [];
    const emitted: AppEventType[] = [];
    for (let sequence = 0; sequence < 300; sequence++) {
      bridge.__resetBridgeForTest();
      useStore.getState().loadProjectForPreview(initial);
      for (let index = 0; index < 12; index++) {
        const store = useStore.getState();
        const track = melody();
        const clip = track.clips.find((item) => item.id === initial.tracks[2]!.clips[0]!.id)!;
        const trackId = pick(4) ? track.id : 'missing';
        const clipId = pick(4) ? clip.id : 'missing';
        const sectionId = pick(4) ? store.project.sections[0]!.id : 'missing';
        const beat = pick(4);
        const pointLane = track.automation?.volume;
        const options: Array<readonly [AppEventType | null, () => unknown]> = [
          ['track.added', () => pick(2) ? store.addTrack('instrument') : store.duplicateTrack(trackId)],
          ['clip.created', () => actions.addEmptyClipAt(trackId, 32 + beat * 4, 32)],
          ['clip.split', () => actions.splitClipAtBeat(clipId, clip.startBeat + beat)],
          ['section.duplicated', () => actions.duplicateSectionInSong(sectionId)],
          ['loop.set', () => store.setLoopRange(beat ? { startBeat: 0, endBeat: beat * 4 } : null)],
          ['effect.added', () => setEq(trackId)],
          ['automation.pointAdded', () => actions.setTrackAutomation(trackId, 'volume', pointLane,
            { points: [...(pointLane?.points ?? []), { beat, value: 1 }].sort((a, b) => a.beat - b.beat) })],
          ['recording.finished', () => actions.writeRecordingTake({ trackId, clipId, clipStartBeat: clip.startBeat },
            beat ? capturedNote(clip.startBeat + 0.25) : [], { mode: 'overdub', grid: 0, stopBeat: clip.startBeat + 1 })],
          ['note.moved', () => {
            const owner = Symbol('drag');
            store.beginTransaction(owner);
            store.updateNote(clipId, 'first', { pitch: 68 });
            store.updateNote(clipId, 'first', { pitch: 60 + beat });
            if (pick(3)) store.commitTransaction(owner);
            else store.cancelTransaction(owner);
          }],
          [null, () => pick(2) ? store.undo() : store.redo()],
        ];
        const [type, run] = options[pick(options.length)]!;
        const before = changedProject();
        events.length = 0;
        run();
        const expected = type && before !== changedProject() ? [type] : [];
        const actual = events.map((event) => event.type);
        expect(actual, `sequence ${sequence}, operation ${index}, ${type}`).toEqual(expected);
        successes.push(...expected);
        emitted.push(...actual);
      }
    }
    expect(count(emitted)).toEqual(count(successes));
    expect(Object.keys(count(successes))).toHaveLength(9);
  });
});
