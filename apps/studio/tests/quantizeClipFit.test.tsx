// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Clip } from '@cts/project-model';
import { pxPerBeat } from '../src/features/timeline';
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
let renderScheduleEvents: typeof import('../src/audio/wav')['renderScheduleEvents'];
type SchedulePayload = import('../src/audio/events').SchedulePayload;

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  ({ buildScheduleEvents } = await import('../src/audio/events'));
  ({ renderScheduleEvents } = await import('../src/audio/wav'));
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
function setUpEdgeNote(loop = false): { clipId: string; noteId: string } {
  const clipId = actions.firstMidiClipOfTrack(useStore.getState().project, 'Chords')!.id;
  act(() => {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId
          ? { ...c, lengthBeats: loop ? 8 : 4, loop, contentLengthBeats: loop ? 4 : undefined, notes: [] }
          : c)),
      })),
    }));
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 3.75, durationBeats: 0.25, velocity: 100 });
  });
  const noteId = clipById(clipId).notes![0]!.id;
  expect(notesSounded()).toBe(loop ? 2 : 1);
  return { clipId, noteId };
}

beforeEach(() => {
  installLocalStorage();
  act(() => useStore.getState().createNewProject('テスト'));
});

describe('piano roll edits preserve playback and note spacing', () => {
  it.each(['quantize', 'drag'])('%s keeps a loop note audible in both repeats', (operation) => {
    const { clipId, noteId } = setUpEdgeNote(true);
    const { trackId } = clipById(clipId);
    const soundedBeats = (schedule: typeof buildScheduleEvents | typeof renderScheduleEvents) =>
      schedule(useStore.getState().project)
        .filter((event) => {
          const payload = event.payload as SchedulePayload;
          return payload.kind === 'note' && payload.trackId === trackId;
        })
        .map((event) => event.beat);
    const expectBeats = (beats: number[]) => {
      expect(soundedBeats(buildScheduleEvents)).toEqual(beats);
      expect(soundedBeats(renderScheduleEvents)).toEqual(beats);
    };
    expectBeats([3.75, 7.75]);

    act(() => {
      useStore.getState().selectClip(clipId);
      useStore.getState().selectNotes([noteId]);
      useStore.getState().setZoomX(2);
    });
    render(<PianoRoll />);
    if (operation === 'quantize') fireEvent.keyDown(window, { key: 'q' });
    else dragNote(3.75, 1);

    expectBeats([3, 7]);
    expect(clipById(clipId)).toMatchObject({ lengthBeats: 8, contentLengthBeats: 4, loop: true });
    act(() => useStore.getState().undo());
    expectBeats([3.75, 7.75]);
  });

  it('keeps consecutive notes a beat apart when the selection hits the right edge', () => {
    const { clipId } = setUpEdgeNote();
    const notes = [1, 2].map((startBeat) => ({
      id: `drag-${startBeat}`, startBeat, pitch: 60, durationBeats: 1, velocity: 100,
    }));
    act(() => {
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, lengthBeats: 5, notes } : clip),
        })),
      }));
      useStore.getState().selectClip(clipId);
      useStore.getState().selectNotes(notes.map((note) => note.id));
    });
    render(<PianoRoll />);
    dragNote(1, 3);
    expect(clipById(clipId).notes).toEqual(notes.map((note) => ({ ...note, startBeat: note.startBeat + 2 })));
    act(() => useStore.getState().undo());
    expect(clipById(clipId).notes).toEqual(notes);
  });
});

function dragNote(fromBeat: number, deltaBeats: number) {
  const note = document.querySelector('.pr__note')!;
  const pixelsPerBeat = pxPerBeat(useStore.getState().editor.zoomX);
  const clientX = fromBeat * pixelsPerBeat + 1;
  fireEvent.pointerDown(note, { clientX, clientY: 0, button: 0 });
  fireEvent.pointerMove(note, { clientX: clientX + deltaBeats * pixelsPerBeat, clientY: 0 });
  fireEvent.pointerUp(note);
}

describe('quantize keeps notes sounding past a short clip end', () => {
  it('quantizeNotes keeps the note on the last grid point, undone in one step', () => {
    const { clipId, noteId } = setUpEdgeNote();
    act(() => actions.quantizeNotes(clipId, [noteId], 1));
    expect(clipById(clipId).notes![0]!.startBeat).toBe(3);
    expect(clipById(clipId).lengthBeats).toBe(4);
    expect(notesSounded()).toBe(1);

    act(() => useStore.getState().undo());
    expect(clipById(clipId).notes![0]!.startBeat).toBe(3.75);
    expect(clipById(clipId).lengthBeats).toBe(4);
  });

  it('the piano roll Q shortcut keeps the note inside the clip (past its end is shaded) and the clip length', () => {
    const { clipId, noteId } = setUpEdgeNote();
    act(() => {
      useStore.getState().selectClip(clipId);
      useStore.getState().selectNotes([noteId]);
    });
    render(<PianoRoll />);
    fireEvent.keyDown(window, { key: 'q' });
    expect(clipById(clipId).notes![0]!.startBeat).toBe(3);
    expect(clipById(clipId).lengthBeats).toBe(4);
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
