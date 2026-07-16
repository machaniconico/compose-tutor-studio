import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '@cts/tutorial-engine';
import { MAX_TRACK_EFFECTS } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';
import { subscribeAppEvents } from '../src/state/appEvents';

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it (and editorActions, which imports the store).
let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('テスト')).toBe(true);
});

function bassClipId(): string {
  const project = useStore.getState().project;
  const clip = actions.firstMidiClipOfTrack(project, 'Bass');
  return clip?.id ?? '';
}

function melodyClipId(): string {
  const project = useStore.getState().project;
  const clip = actions.firstMidiClipOfTrack(project, 'Melody');
  return clip?.id ?? '';
}

function chordsClipId(): string {
  const project = useStore.getState().project;
  const clip = actions.firstMidiClipOfTrack(project, 'Chords');
  return clip?.id ?? '';
}

describe('learning track role lookup', () => {
  it('finds Chords, Bass, and Melody after shared trim and case normalization', () => {
    const project = structuredClone(useStore.getState().project);
    const roles = [
      ['Chords', '  cHoRdS\n', '\tCHORDS '],
      ['Bass', '\tBaSs ', ' bass\n'],
      ['Melody', '  mElOdY  ', ' MELODY '],
    ] as const;

    for (const [canonical, storedVariant] of roles) {
      const track = project.tracks.find((candidate) => candidate.name === canonical);
      if (!track) throw new Error(`${canonical} track fixture is missing`);
      track.name = storedVariant;
    }
    const drums = project.tracks.find((track) => track.type === 'drum');
    if (!drums) throw new Error('Drum track fixture is missing');
    drums.name = 'Melody';
    project.tracks = [drums, ...project.tracks.filter((track) => track.id !== drums.id)];

    for (const [canonical, , queryVariant] of roles) {
      const expected = project.tracks.find(
        (track) => track.type === 'instrument' && track.name.trim().toLowerCase() === canonical.toLowerCase(),
      );
      expect(actions.findTrackByName(project, queryVariant)?.id).toBe(expected?.id);
      expect(actions.firstMidiClipOfTrack(project, queryVariant)?.trackId).toBe(expected?.id);
    }
  });
});

describe('addTrackEffect commit boundary', () => {
  it('publishes only after the generated effect is adopted', () => {
    const track = useStore.getState().project.tracks.find(
      (candidate) => candidate.name === 'Melody',
    );
    if (!track) throw new Error('Melody track fixture is missing');
    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => observed.push(event));

    let effectId: string | null;
    try {
      effectId = actions.addTrackEffect(track.id, 'reverb');
    } finally {
      unsubscribe();
    }

    expect(effectId).not.toBeNull();
    expect(useStore.getState().project.tracks.find(
      (candidate) => candidate.id === track.id,
    )?.effects.some((effect) => effect.id === effectId)).toBe(true);
    expect(observed).toEqual([
      expect.objectContaining({
        type: 'effect.added',
        payload: expect.objectContaining({ trackId: track.id, trackName: 'Melody' }),
      }),
    ]);
  });

  it('returns null and emits nothing when the codec rejects effect 65', () => {
    const trackId = useStore.getState().project.tracks.find(
      (candidate) => candidate.name === 'Melody',
    )?.id;
    if (!trackId) throw new Error('Melody track fixture is missing');
    for (let index = 0; index < MAX_TRACK_EFFECTS; index += 1) {
      expect(actions.addTrackEffect(trackId, 'filter')).not.toBeNull();
    }
    const before = useStore.getState().project;
    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => observed.push(event));
    let result: string | null;
    try {
      result = actions.addTrackEffect(trackId, 'delay');
    } finally {
      unsubscribe();
    }

    expect(result).toBeNull();
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().project.tracks.find(
      (candidate) => candidate.id === trackId,
    )?.effects).toHaveLength(MAX_TRACK_EFFECTS);
    expect(observed).toEqual([]);
  });
});

describe('addChordWithAnalysis', () => {
  it('fills full analysis fields (root/quality/notes/degree/function)', () => {
    const before = useStore.getState().project.chordTrack.length;
    actions.addChordWithAnalysis('G', 0, 4); // V in C major
    const track = useStore.getState().project.chordTrack;
    expect(track.length).toBe(before + 1);
    const chord = track[track.length - 1];
    expect(chord?.symbol).toBe('G');
    expect(chord?.root).toBe('G');
    expect(chord?.quality).toBe('major');
    expect(chord?.notes).toEqual([7, 11, 2]); // G B D pitch classes
    expect(chord?.degree).toBe('V');
    expect(chord?.function).toBe('D');
  });

  it('tags a secondary dominant', () => {
    // E7 in C major resolves to Am (vi) -> secondary dominant
    actions.addChordWithAnalysis('E7', 0, 4);
    const track = useStore.getState().project.chordTrack;
    const chord = track[track.length - 1];
    expect(chord?.function).toBe('D');
    expect(chord?.tags ?? []).toContain('secondaryDominant');
  });
});

describe('updateChordSymbol', () => {
  it('re-derives analysis when the symbol changes', () => {
    actions.addChordWithAnalysis('C', 0, 4);
    const id = useStore.getState().project.chordTrack[0]?.id ?? '';
    actions.updateChordSymbol(id, 'Dm'); // ii in C major
    const chord = useStore.getState().project.chordTrack.find((c) => c.id === id);
    expect(chord?.symbol).toBe('Dm');
    expect(chord?.quality).toBe('minor');
    expect(chord?.degree).toBe('ii');
    expect(chord?.function).toBe('SD');
  });
});

describe('appendChordAfterLast', () => {
  it('places the chord right after the final chord', () => {
    const track = useStore.getState().project.chordTrack;
    const last = [...track].sort((a, b) => a.startBeat - b.startBeat).pop();
    const expectedStart = (last?.startBeat ?? 0) + (last?.durationBeats ?? 0);
    actions.appendChordAfterLast('F');
    const updated = useStore.getState().project.chordTrack;
    const appended = updated[updated.length - 1];
    expect(appended?.symbol).toBe('F');
    expect(appended?.startBeat).toBe(expectedStart);
    expect(useStore.getState().project.lengthBars).toBeGreaterThanOrEqual(
      Math.ceil(((appended?.startBeat ?? 0) + (appended?.durationBeats ?? 0)) / 4),
    );
  });
});

describe('applyProgressionTemplate', () => {
  it('replaces the whole chord track with one chord per bar', () => {
    actions.applyProgressionTemplate('I-V-vi-IV');
    const project = useStore.getState().project;
    expect(project.chordTrack.length).toBe(project.lengthBars);
    // I-V-vi-IV in C => C G Am F repeated
    const symbols = project.chordTrack.map((c) => c.symbol);
    expect(symbols.slice(0, 4)).toEqual(['C', 'G', 'Am', 'F']);
    // every chord has full analysis fields
    for (const c of project.chordTrack) {
      expect(c.notes.length).toBeGreaterThan(0);
      expect(c.degree).toBeDefined();
      expect(c.function).toBeDefined();
    }
  });
});

describe('replaceChordTrack', () => {
  it('replaces with the supplied chords', () => {
    const project = useStore.getState().project;
    const replacement = [actions.buildChordEvent(project, 'Am', 0, 4)];
    actions.replaceChordTrack(replacement);
    const track = useStore.getState().project.chordTrack;
    expect(track.length).toBe(1);
    expect(track[0]?.symbol).toBe('Am');
  });
});

describe('quantizeNotes', () => {
  it('snaps selected note starts to the grid', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 1.3, durationBeats: 1, velocity: 100 });
    const noteId = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0]?.id ?? '';
    actions.quantizeNotes(clipId, [noteId], 1);
    const note = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0];
    expect(note?.startBeat).toBe(1);
  });

  it('publishes one note.moved event from the committed quantized value', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 1.3,
      durationBeats: 1,
      velocity: 100,
    });
    const noteId = actions.findClip(useStore.getState().project, clipId)?.notes?.[0]?.id ?? '';
    const observed: Array<{ event: AppEvent; committedStartBeat: number | undefined }> = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type !== 'note.moved') return;
      observed.push({
        event,
        committedStartBeat: actions
          .findClip(useStore.getState().project, clipId)
          ?.notes?.find((note) => note.id === noteId)?.startBeat,
      });
    });

    try {
      actions.quantizeNotes(clipId, [noteId], 1);
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual([
      {
        event: expect.objectContaining({
          type: 'note.moved',
          payload: expect.objectContaining({ pitch: 60, startBeat: 1 }),
        }),
        committedStartBeat: 1,
      },
    ]);
  });

  it('does not commit when every target is missing or already quantized', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 1,
      durationBeats: 1,
      velocity: 90,
    });
    const noteId = actions.findClip(useStore.getState().project, clipId)?.notes?.[0]?.id ?? '';
    const before = useStore.getState();

    actions.quantizeNotes(clipId, [noteId, 'missing-note'], 1);
    actions.quantizeNotes(clipId, ['missing-note'], 1);

    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(useStore.getState().past).toBe(before.past);
  });

  it('uses the latest valid grid line when nearest quantization would cross the clip end', () => {
    const clipId = melodyClipId();
    const clip = actions.findClip(useStore.getState().project, clipId);
    expect(clip).toBeDefined();
    const durationBeats = 1.4;
    const startBeat = (clip?.lengthBeats ?? 32) - durationBeats;
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat,
      durationBeats,
      velocity: 90,
    });
    const noteId = actions.findClip(useStore.getState().project, clipId)?.notes?.[0]?.id ?? '';
    const before = useStore.getState();

    actions.quantizeNotes(clipId, [noteId], 1);

    const after = useStore.getState();
    const note = actions.findClip(after.project, clipId)?.notes?.[0];
    expect(note?.startBeat).toBe(Math.floor(startBeat));
    expect((note?.startBeat ?? 0) + (note?.durationBeats ?? 0)).toBeLessThanOrEqual(
      clip?.lengthBeats ?? 32,
    );
    expect(after.saveState.revision).toBe(before.saveState.revision + 1);
    expect(after.past).toHaveLength(before.past.length + 1);
  });
});

describe('commitNoteUpdates', () => {
  it('commits multiple final note values as one revision and one undo step', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    useStore.getState().addNote(clipId, {
      pitch: 65,
      startBeat: 2,
      durationBeats: 1,
      velocity: 100,
    });
    const beforeNotes = [...(actions.findClip(useStore.getState().project, clipId)?.notes ?? [])];
    const first = beforeNotes[0];
    const second = beforeNotes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'note.moved') observed.push(event);
    });
    const before = useStore.getState();
    const committed = actions.commitNoteUpdates(clipId, [
      { id: first?.id ?? '', patch: { pitch: 62, startBeat: 1 } },
      { id: second?.id ?? '', patch: { pitch: 67, startBeat: 3 } },
    ]);
    unsubscribe();

    expect(committed).toEqual([
      expect.objectContaining({ id: first?.id, pitch: 62, startBeat: 1 }),
      expect.objectContaining({ id: second?.id, pitch: 67, startBeat: 3 }),
    ]);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision + 1);
    expect(useStore.getState().past.length).toBe(before.past.length + 1);
    expect(observed).toEqual([
      expect.objectContaining({
        type: 'note.moved',
        payload: expect.objectContaining({ pitch: 62, startBeat: 1 }),
      }),
      expect.objectContaining({
        type: 'note.moved',
        payload: expect.objectContaining({ pitch: 67, startBeat: 3 }),
      }),
    ]);

    useStore.getState().undo();
    const restored = actions.findClip(useStore.getState().project, clipId)?.notes ?? [];
    expect(restored.find((note) => note.id === first?.id)).toMatchObject(first ?? {});
    expect(restored.find((note) => note.id === second?.id)).toMatchObject(second ?? {});
  });

  it('does not commit no-op, duplicate, missing, or invalid batches', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    const note = actions.findClip(useStore.getState().project, clipId)?.notes?.[0];
    expect(note).toBeDefined();

    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'note.moved') observed.push(event);
    });
    const before = useStore.getState();
    const id = note?.id ?? '';
    expect(actions.commitNoteUpdates(clipId, [{ id, patch: { pitch: 60 } }])).toEqual([]);
    expect(
      actions.commitNoteUpdates(clipId, [
        { id, patch: { pitch: 62 } },
        { id: 'missing-note', patch: { pitch: 64 } },
      ]),
    ).toEqual([]);
    expect(
      actions.commitNoteUpdates(clipId, [
        { id, patch: { pitch: 62 } },
        { id, patch: { pitch: 64 } },
      ]),
    ).toEqual([]);
    expect(actions.commitNoteUpdates(clipId, [{ id, patch: { pitch: 999 } }])).toEqual([]);
    unsubscribe();

    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(useStore.getState().past).toBe(before.past);
    expect(observed).toEqual([]);
  });

  it('emits no move event for a velocity-only final update', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    const note = actions.findClip(useStore.getState().project, clipId)?.notes?.[0];
    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'note.moved') observed.push(event);
    });

    const committed = actions.commitNoteUpdates(clipId, [
      { id: note?.id ?? '', patch: { velocity: 110 } },
    ]);
    unsubscribe();

    expect(committed).toEqual([expect.objectContaining({ velocity: 110 })]);
    expect(observed).toEqual([]);
  });
});

describe('duplicateNotesAt', () => {
  it('commits final placements together and publishes only final additions', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    useStore.getState().addNote(clipId, {
      pitch: 64,
      startBeat: 2,
      durationBeats: 1,
      velocity: 100,
    });
    const source = actions.findClip(useStore.getState().project, clipId)?.notes ?? [];
    const first = source[0];
    const second = source[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'note.added' || event.type === 'note.moved') observed.push(event);
    });
    const before = useStore.getState();
    const duplicates = actions.duplicateNotesAt(clipId, [
      { sourceId: first?.id ?? '', pitch: 62, startBeat: 4 },
      { sourceId: second?.id ?? '', pitch: 67, startBeat: 6 },
    ]);
    unsubscribe();

    expect(duplicates).toEqual([
      expect.objectContaining({ pitch: 62, startBeat: 4, durationBeats: 1, velocity: 90 }),
      expect.objectContaining({ pitch: 67, startBeat: 6, durationBeats: 1, velocity: 100 }),
    ]);
    expect(duplicates.map((note) => note.id)).not.toContain(first?.id);
    expect(duplicates.map((note) => note.id)).not.toContain(second?.id);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision + 1);
    expect(useStore.getState().past.length).toBe(before.past.length + 1);
    expect(observed).toEqual([
      expect.objectContaining({
        type: 'note.added',
        payload: expect.objectContaining({ pitch: 62, startBeat: 4 }),
      }),
      expect.objectContaining({
        type: 'note.added',
        payload: expect.objectContaining({ pitch: 67, startBeat: 6 }),
      }),
    ]);

    useStore.getState().undo();
    const restored = actions.findClip(useStore.getState().project, clipId)?.notes ?? [];
    expect(restored.map((note) => note.id)).toEqual(source.map((note) => note.id));
  });

  it('atomically rejects missing, repeated, and invalid placements', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    const sourceId = actions.findClip(useStore.getState().project, clipId)?.notes?.[0]?.id ?? '';
    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'note.added') observed.push(event);
    });
    const before = useStore.getState();

    expect(
      actions.duplicateNotesAt(clipId, [
        { sourceId, pitch: 62, startBeat: 4 },
        { sourceId: 'missing-note', pitch: 64, startBeat: 6 },
      ]),
    ).toEqual([]);
    expect(
      actions.duplicateNotesAt(clipId, [
        { sourceId, pitch: 62, startBeat: 4 },
        { sourceId, pitch: 64, startBeat: 6 },
      ]),
    ).toEqual([]);
    expect(
      actions.duplicateNotesAt(clipId, [{ sourceId, pitch: 999, startBeat: 4 }]),
    ).toEqual([]);
    unsubscribe();

    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(useStore.getState().past).toBe(before.past);
    expect(observed).toEqual([]);
  });
});

describe('duplicateNotes', () => {
  it('creates offset copies and returns their ids', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, { pitch: 62, startBeat: 0, durationBeats: 1, velocity: 90 });
    const srcId = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0]?.id ?? '';
    const duplicates = actions.duplicateNotes(clipId, [srcId], 4);
    expect(duplicates.length).toBe(1);
    const notes = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes ?? [];
    expect(notes.length).toBe(2);
    const dupe = notes.find((n) => n.id === duplicates[0]?.id);
    expect(dupe?.startBeat).toBe(4);
    expect(dupe?.pitch).toBe(62);
  });

  it('commits a caller-provided pitch mapping for scale-snapped copies', () => {
    const clipId = melodyClipId();
    useStore.getState().addNote(clipId, {
      pitch: 61,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    });
    const source = actions.firstMidiClipOfTrack(useStore.getState().project, 'Melody')?.notes?.[0];

    useStore.getState().toggleScaleSnap();
    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'note.added') observed.push(event);
    });
    const duplicates = actions.duplicateNotes(clipId, source ? [source.id] : [], 1);
    unsubscribe();

    const notes = actions.firstMidiClipOfTrack(useStore.getState().project, 'Melody')?.notes ?? [];
    const duplicate = notes.find((note) => note.id === duplicates[0]?.id);
    expect(source?.pitch).toBe(61);
    expect(duplicate).toMatchObject({ pitch: 62, startBeat: 1 });
    expect(duplicates[0]).toEqual(duplicate);
    expect(observed).toEqual([
      expect.objectContaining({
        type: 'note.added',
        payload: expect.objectContaining({ pitch: 62, startBeat: 1, inScale: true }),
      }),
    ]);
  });

  it('does not commit or return anything when no source note exists', () => {
    const clipId = melodyClipId();
    const before = useStore.getState();

    expect(actions.duplicateNotes(clipId, ['missing-note'], 1)).toEqual([]);
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });
});

describe('setNoteVelocity', () => {
  it('clamps velocity into 1..127', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });
    const id = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0]?.id ?? '';
    actions.setNoteVelocity(clipId, [id], 999);
    const note = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.[0];
    expect(note?.velocity).toBe(127);
  });

  it('does not commit for missing targets or an unchanged final velocity', () => {
    const clipId = chordsClipId();
    useStore.getState().addNote(clipId, {
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    });
    const id = actions.findClip(useStore.getState().project, clipId)?.notes?.[0]?.id ?? '';
    const before = useStore.getState();

    actions.setNoteVelocity(clipId, [id, 'missing-note'], 100);
    actions.setNoteVelocity(clipId, ['missing-note'], 80);

    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
  });
});

describe('removeNotes', () => {
  it('does not commit when none of the requested notes exist', () => {
    const clipId = melodyClipId();
    const before = useStore.getState();

    actions.removeNotes(clipId, ['missing-note']);

    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().saveState.revision).toBe(before.saveState.revision);
    expect(useStore.getState().past).toBe(before.past);
  });
});

describe('generateBassIntoClip', () => {
  it('writes notes into the Bass clip with reasons', () => {
    actions.applyProgressionTemplate('I-V-vi-IV');
    const clipId = bassClipId();
    const reasons = actions.generateBassIntoClip(clipId, 'rootOnly');
    expect(reasons).not.toBeNull();
    expect(reasons?.length).toBeGreaterThan(0);
    expect(reasons?.[0]?.reason).toBeTruthy();
    const notes = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes ?? [];
    expect(notes.length).toBe(reasons?.length);
  });

  it('replaces (not appends) on a second generation', () => {
    actions.applyProgressionTemplate('I-V-vi-IV');
    const clipId = bassClipId();
    actions.generateBassIntoClip(clipId, 'rootOnly');
    const firstCount = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.length ?? 0;
    actions.generateBassIntoClip(clipId, 'rootOnly');
    const secondCount = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes?.length ?? 0;
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBe(firstCount);
  });
});

describe('generateMelodyIntoClip', () => {
  it('writes notes into the Melody clip', () => {
    const clipId = melodyClipId();
    const notes = actions.generateMelodyIntoClip(clipId, 1);
    expect(notes).not.toBeNull();
    expect(notes?.length).toBeGreaterThan(0);
    const written = useStore.getState().project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)?.notes ?? [];
    expect(written.length).toBe(notes?.length);
  });

  it('varies deterministically with the seed', () => {
    const clipId = melodyClipId();
    const a = (actions.generateMelodyIntoClip(clipId, 1) ?? []).map((n) => n.pitch);
    const b = (actions.generateMelodyIntoClip(clipId, 2) ?? []).map((n) => n.pitch);
    // same seed reproduces, different seed differs somewhere
    const aAgain = (actions.generateMelodyIntoClip(clipId, 1) ?? []).map((n) => n.pitch);
    expect(aAgain).toEqual(a);
    expect(b).not.toEqual(a);
  });
});

describe('applyDrumPattern', () => {
  it('writes drum events tiled across the clip bars', () => {
    const drumClip = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0];
    const clipId = drumClip?.id ?? '';
    expect(actions.applyDrumPattern(clipId, 'eightBeat')).toBe(true);
    const events = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.lane === 'kick')).toBe(true);
    expect(events.some((e) => e.lane === 'snare')).toBe(true);
  });
});

describe('setDrumStepVelocity', () => {
  it('adds, updates, and removes a step', () => {
    const clipId = useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.id ?? '';
    const observed: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === 'drum.stepToggled') observed.push(event);
    });
    const drumEvents = () => useStore.getState().project.tracks
      .find((t) => t.type === 'drum')?.clips[0]?.drumEvents ?? [];
    const committed: boolean[] = [];
    try {
      committed.push(actions.setDrumStepVelocity(clipId, 'kick', 0, 100));
      expect(drumEvents().find((e) => e.lane === 'kick' && e.stepIndex === 0)?.velocity).toBe(100);
      committed.push(actions.setDrumStepVelocity(clipId, 'kick', 0, 40));
      expect(drumEvents().find((e) => e.lane === 'kick' && e.stepIndex === 0)?.velocity).toBe(40);
      committed.push(actions.setDrumStepVelocity(clipId, 'kick', 0, 0));
    } finally {
      unsubscribe();
    }
    expect(committed).toEqual([true, true, true]);
    expect(drumEvents().find((e) => e.lane === 'kick' && e.stepIndex === 0)).toBeUndefined();
    expect(observed).toEqual([
      expect.objectContaining({
        type: 'drum.stepToggled',
        payload: expect.objectContaining({ lane: 'kick', stepIndex: 0, active: true }),
      }),
      expect.objectContaining({
        type: 'drum.stepToggled',
        payload: expect.objectContaining({ lane: 'kick', stepIndex: 0, active: true }),
      }),
      expect.objectContaining({
        type: 'drum.stepToggled',
        payload: expect.objectContaining({ lane: 'kick', stepIndex: 0, active: false }),
      }),
    ]);
  });
});

describe('rejected composite writes', () => {
  it('returns failure and emits no tutorial events while project operations are busy', () => {
    const melodyId = melodyClipId();
    const drumId = useStore.getState().project.tracks
      .find((track) => track.type === 'drum')?.clips[0]?.id ?? '';
    const before = useStore.getState().project;
    const events: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((event) => events.push(event));
    useStore.setState({ projectOperationBusy: true });

    try {
      expect(actions.replaceClipNotes(melodyId, [])).toBe(false);
      expect(actions.generateMelodyIntoClip(melodyId, 17)).toBeNull();
      expect(actions.applyDrumPattern(drumId, 'eightBeat')).toBe(false);
      expect(actions.setDrumStepVelocity(drumId, 'kick', 0, 100)).toBe(false);
    } finally {
      useStore.setState({ projectOperationBusy: false });
      unsubscribe();
    }

    expect(useStore.getState().project).toBe(before);
    expect(events).toEqual([]);
  });
});
