import { describe, expect, it } from 'vitest';
import { MemoryProjectRepository } from '@cts/project-persistence';
import type { AppEvent } from '@cts/tutorial-engine';
import { subscribeAppEvents } from '../src/state/appEvents';
import { createStudioStore } from '../src/state/store';

describe('note event commit boundary', () => {
  it('publishes only committed additions and position changes', () => {
    const store = createStudioStore(new MemoryProjectRepository());
    const clip = store
      .getState()
      .project.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.type === 'midi');
    expect(clip).toBeDefined();

    const observed: Array<{ event: AppEvent; pitches: number[] }> = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type !== 'note.added' && event.type !== 'note.moved') return;
      observed.push({
        event,
        pitches: store
          .getState()
          .project.tracks.flatMap((track) => track.clips)
          .flatMap((candidate) => candidate.notes ?? [])
          .map((note) => note.pitch),
      });
    });

    try {
      const initial = store.getState();
      const noteInput = { startBeat: 0, durationBeats: 1, velocity: 90 };
      store.getState().addNote('missing-clip', { ...noteInput, pitch: 61 });
      store.getState().addNote(clip?.id ?? '', { ...noteInput, pitch: 999 });
      expect(observed).toEqual([]);
      expect(store.getState().project).toBe(initial.project);
      expect(store.getState().saveState.revision).toBe(initial.saveState.revision);

      store.getState().addNote(clip?.id ?? '', { ...noteInput, pitch: 61 });
      expect(observed).toHaveLength(1);
      expect(observed[0]?.event).toMatchObject({
        type: 'note.added',
        payload: { pitch: 61, startBeat: 0 },
      });
      expect(observed[0]?.pitches).toContain(61);

      const note = store
        .getState()
        .project.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === clip?.id)
        ?.notes?.find((candidate) => candidate.pitch === 61);
      expect(note).toBeDefined();
      observed.length = 0;

      const revision = store.getState().saveState.revision;
      store.getState().updateNote(clip?.id ?? '', note?.id ?? '', { pitch: 61 });
      store.getState().updateNote(clip?.id ?? '', note?.id ?? '', { pitch: 999 });
      expect(observed).toEqual([]);
      expect(store.getState().saveState.revision).toBe(revision);

      store.getState().updateNote(clip?.id ?? '', note?.id ?? '', { velocity: 80 });
      expect(observed).toEqual([]);
      expect(store.getState().saveState.revision).toBe(revision + 1);

      store.getState().updateNote(clip?.id ?? '', note?.id ?? '', { pitch: 62 });
      expect(observed).toHaveLength(1);
      expect(observed[0]?.event).toMatchObject({
        type: 'note.moved',
        payload: { pitch: 62, startBeat: 0 },
      });
      expect(observed[0]?.pitches).toContain(62);
    } finally {
      unsubscribe();
    }
  });
});
