// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Clip } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

vi.mock('../src/audio/livePreview', () => ({
  previewNote: vi.fn(async () => undefined),
  previewChord: vi.fn(async () => undefined),
  PREVIEW_DURATION_MS: 300,
  MAX_PREVIEW_VOICES: 8,
}));

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let buildScheduleEvents: typeof import('../src/audio/events')['buildScheduleEvents'];
type SchedulePayload = import('../src/audio/events').SchedulePayload;

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  ({ buildScheduleEvents } = await import('../src/audio/events'));
});

function clipById(clipId: string): Clip {
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
}

function notesSounded(): number {
  const { project } = useStore.getState();
  const trackId = actions.firstMidiClipOfTrack(project, 'Chords')!.trackId;
  return buildScheduleEvents(project).filter((e) => {
    const payload = e.payload as SchedulePayload;
    return payload.kind === 'note' && payload.trackId === trackId;
  }).length;
}

/**
 * A 4-beat non-looping clip with one note at 3.75 beats, 0.25 long: quantizing
 * it to the 1-beat grid moves it to beat 4, the clip end.
 */
function setUpEdgeNote(): { clipId: string; noteId: string } {
  const clipId = actions.firstMidiClipOfTrack(useStore.getState().project, 'Chords')!.id;
  act(() => {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, lengthBeats: 4, loop: false, notes: [] } : c)),
      })),
    }));
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 3.75, durationBeats: 0.25, velocity: 100 });
  });
  const noteId = clipById(clipId).notes![0]!.id;
  expect(notesSounded()).toBe(1);
  return { clipId, noteId };
}

beforeEach(() => {
  installLocalStorage();
  act(() => useStore.getState().createNewProject('テスト'));
});

describe('quantize keeps notes sounding past a short clip end', () => {
  it('quantizeNotes lengthens the clip so the moved note still sounds, undone in one step', () => {
    const { clipId, noteId } = setUpEdgeNote();
    act(() => actions.quantizeNotes(clipId, [noteId], 1));
    expect(clipById(clipId).notes![0]!.startBeat).toBe(4);
    expect(clipById(clipId).lengthBeats).toBe(4.25);
    expect(notesSounded()).toBe(1);

    act(() => useStore.getState().undo());
    expect(clipById(clipId).notes![0]!.startBeat).toBe(3.75);
    expect(clipById(clipId).lengthBeats).toBe(4);
  });

  it('the piano roll Q shortcut does the same', () => {
    const { clipId, noteId } = setUpEdgeNote();
    act(() => {
      useStore.getState().selectClip(clipId);
      useStore.getState().selectNotes([noteId]);
    });
    render(<PianoRoll />);
    fireEvent.keyDown(window, { key: 'q' });
    expect(clipById(clipId).notes![0]!.startBeat).toBe(4);
    expect(clipById(clipId).lengthBeats).toBe(4.25);
    expect(notesSounded()).toBe(1);

    act(() => useStore.getState().undo());
    expect(clipById(clipId).notes![0]!.startBeat).toBe(3.75);
    expect(clipById(clipId).lengthBeats).toBe(4);
  });

  it('duplicating a note past the clip end lengthens the clip too', () => {
    const { clipId, noteId } = setUpEdgeNote();
    act(() => {
      actions.duplicateNotes(clipId, [noteId], 4);
    });
    expect(clipById(clipId).lengthBeats).toBe(8);
    expect(notesSounded()).toBe(2);
  });
});
