// DAW 操作コース(移植 P60)が頼る AppEvent の発行規則。
// 操作が成功した時だけ、ちょうど 1 回出る。断られた時は出ない。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addTrack, setProjectLengthBars, type ChordEvent, type Project } from '@cts/project-model';
import { projectToMidi } from '@cts/midi-io';
import type { AppEvent, AppEventType } from '@cts/tutorial-engine';
import { installLocalStorage } from './localStorageStub';
import { subscribeAppEvents } from '../src/state/appEvents';

let useStore: typeof import('../src/state/store')['useStore'];
let trackActions: typeof import('../src/state/trackActions');
let songLengthActions: typeof import('../src/state/songLengthActions');
let editorActions: typeof import('../src/state/editorActions');
let grooveActions: typeof import('../src/state/grooveActions');
let compingGeneration: typeof import('../src/state/compingGeneration');
let routingActions: typeof import('../src/state/routingActions');
let importMidi: typeof import('../src/state/importMidi');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  trackActions = await import('../src/state/trackActions');
  songLengthActions = await import('../src/state/songLengthActions');
  editorActions = await import('../src/state/editorActions');
  grooveActions = await import('../src/state/grooveActions');
  compingGeneration = await import('../src/state/compingGeneration');
  routingActions = await import('../src/state/routingActions');
  importMidi = await import('../src/state/importMidi');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('コース検証')).toBe(true);
});

/** Run `action` and return the events of `type` it published. */
function observe<T extends AppEventType>(type: T, action: () => unknown): Extract<AppEvent, { type: T }>[] {
  const seen: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((event) => seen.push(event));
  try {
    action();
  } finally {
    unsubscribe();
  }
  return seen.filter((event): event is Extract<AppEvent, { type: T }> => event.type === type);
}

const melodyClip = () => useStore.getState().project.tracks.find((track) => track.name === 'Melody')!.clips[0]!;

function lockByRecording(): void {
  expect(useStore.getState().tryBeginAudioRecordingOperation()).not.toBeNull();
}

describe('track.added', () => {
  it('fires once with the track kind after a track is added', () => {
    const events = observe('track.added', () => {
      expect(trackActions.addStudioTrack({ kind: 'instrument', name: 'Hook' }).ok).toBe(true);
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ trackName: 'Hook', trackType: 'instrument' });
    expect(useStore.getState().project.tracks.some((t) => t.id === events[0]!.payload.trackId)).toBe(true);
  });

  it('does not fire when adding is refused', () => {
    useStore.setState({ projectOperationBusy: true });
    const before = useStore.getState().project;
    const events = observe('track.added', () => {
      expect(trackActions.addStudioTrack({ kind: 'instrument', name: 'Hook' }).ok).toBe(false);
    });
    expect(events).toHaveLength(0);
    expect(useStore.getState().project).toBe(before);
  });
});

describe('clip.split', () => {
  it('fires once with both clip ids after a split', () => {
    const clip = melodyClip();
    const events = observe('clip.split', () => {
      expect(useStore.getState().splitClipAtBeat(clip.id, clip.startBeat + 4).ok).toBe(true);
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.clipId).toBe(clip.id);
    expect(events[0]!.payload.rightClipId).not.toBe(clip.id);
  });

  it('does not fire for a split at the clip edge, a non-number, or while recording', () => {
    const clip = melodyClip();
    const events = observe('clip.split', () => {
      expect(useStore.getState().splitClipAtBeat(clip.id, clip.startBeat).ok).toBe(false);
      expect(useStore.getState().splitClipAtBeat(clip.id, { toString: null }).ok).toBe(false);
      lockByRecording();
      expect(useStore.getState().splitClipAtBeat(clip.id, clip.startBeat + 4).ok).toBe(false);
    });
    expect(events).toHaveLength(0);
  });
});

describe('song.lengthChanged', () => {
  it('fires once with the new length when the length changes', () => {
    const next = useStore.getState().project.lengthBars + 2;
    const events = observe('song.lengthChanged', () => {
      expect(songLengthActions.setStudioSongLengthBars(next)).toMatchObject({ ok: true, changed: true });
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.lengthBars).toBe(next);
  });

  it('does not fire when nothing changes, the value is invalid, or while recording', () => {
    const current = useStore.getState().project.lengthBars;
    const events = observe('song.lengthChanged', () => {
      expect(songLengthActions.setStudioSongLengthBars(current)).toMatchObject({ ok: true, changed: false });
      expect(songLengthActions.setStudioSongLengthBars(0).ok).toBe(false);
      expect(songLengthActions.setStudioSongLengthBars({ toString: null }).ok).toBe(false);
      lockByRecording();
      expect(songLengthActions.setStudioSongLengthBars(current + 1).ok).toBe(false);
    });
    expect(events).toHaveLength(0);
  });
});

describe('notes.quantized', () => {
  function addOffGridNote(): { clipId: string; noteIds: string[] } {
    const clipId = melodyClip().id;
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 1.1, durationBeats: 0.5, velocity: 100 });
    const noteIds = melodyClip().notes?.map((note) => note.id) ?? [];
    expect(noteIds.length).toBeGreaterThan(0);
    return { clipId, noteIds };
  }

  it('fires once from the toolbar quantize, and not when the notes are already on the grid', () => {
    const { clipId, noteIds } = addOffGridNote();
    const first = observe('notes.quantized', () => {
      expect(editorActions.quantizeNotesWithReport(clipId, noteIds, 0.5).committed.length).toBeGreaterThan(0);
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.payload.clipId).toBe(clipId);
    const second = observe('notes.quantized', () => {
      expect(editorActions.quantizeNotesWithReport(clipId, noteIds, 0.5).committed).toHaveLength(0);
    });
    expect(second).toHaveLength(0);
  });

  it('does not fire from the toolbar quantize for a bad grid, a missing clip, or no selection', () => {
    const { clipId, noteIds } = addOffGridNote();
    const events = observe('notes.quantized', () => {
      editorActions.quantizeNotesWithReport(clipId, noteIds, Number.NaN);
      editorActions.quantizeNotesWithReport('missing-clip', noteIds, 0.5);
      editorActions.quantizeNotesWithReport(clipId, [], 0.5);
    });
    expect(events).toHaveLength(0);
  });

  it('fires once from the strength quantize and not when it is refused or changes nothing', () => {
    const { clipId, noteIds } = addOffGridNote();
    const refused = observe('notes.quantized', () => {
      expect(grooveActions.quantizeNotesWithStrength(clipId, noteIds, 0.5, 150).ok).toBe(false);
      expect(grooveActions.quantizeNotesWithStrength(clipId, noteIds, 0.5, 0)).toMatchObject({ ok: true, changed: 0 });
    });
    expect(refused).toHaveLength(0);
    const done = observe('notes.quantized', () => {
      expect(grooveActions.quantizeNotesWithStrength(clipId, noteIds, 0.5, 100)).toMatchObject({ ok: true });
    });
    expect(done).toHaveLength(1);
    expect(done[0]!.payload.noteCount).toBeGreaterThan(0);
  });

  it('does not fire while recording', () => {
    const { clipId, noteIds } = addOffGridNote();
    lockByRecording();
    const events = observe('notes.quantized', () => {
      expect(grooveActions.quantizeNotesWithStrength(clipId, noteIds, 0.5, 100).ok).toBe(false);
    });
    expect(events).toHaveLength(0);
  });
});

describe('accompaniment.created', () => {
  function putChords(): void {
    const chord: ChordEvent = {
      id: 'c0', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7],
    };
    useStore.getState().applyProjectChange((project) => ({ ...project, chordTrack: [chord] }));
  }
  const request = { startBar: 1, endBar: 1, pattern: 'whole', register: 55, voiceLeading: true } as const;

  it('fires once with the new track after an accompaniment is made', () => {
    putChords();
    const events = observe('accompaniment.created', () => {
      expect(compingGeneration.generateCompingClip(request).ok).toBe(true);
    });
    expect(events).toHaveLength(1);
    expect(useStore.getState().project.tracks.some((t) => t.id === events[0]!.payload.trackId)).toBe(true);
  });

  it('does not fire without chords or while recording', () => {
    useStore.getState().applyProjectChange((project) => ({ ...project, chordTrack: [] }));
    const none = observe('accompaniment.created', () => {
      expect(compingGeneration.generateCompingClip(request).ok).toBe(false);
    });
    expect(none).toHaveLength(0);
    putChords();
    lockByRecording();
    const locked = observe('accompaniment.created', () => {
      expect(compingGeneration.generateCompingClip(request).ok).toBe(false);
    });
    expect(locked).toHaveLength(0);
  });
});


/** Observe every event type at once. */
function observeAll(action: () => unknown): AppEvent[] {
  const seen: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((event) => seen.push(event));
  try {
    action();
  } finally {
    unsubscribe();
  }
  return seen;
}

async function observeAllAsync(action: () => Promise<unknown>): Promise<AppEvent[]> {
  const seen: AppEvent[] = [];
  const unsubscribe = subscribeAppEvents((event) => seen.push(event));
  try {
    await action();
  } finally {
    unsubscribe();
  }
  return seen;
}

const ofType = (events: AppEvent[], type: AppEventType) => events.filter((event) => event.type === type);

/** A MIDI file of `lengthBars` bars with one note in the last bar. */
function midiBytes(lengthBars: number): Uint8Array {
  const current = useStore.getState().project;
  const source = setProjectLengthBars(current, lengthBars);
  if (!source.ok) throw new Error('fixture length');
  return projectToMidi({
    ...source.project,
    tracks: source.project.tracks.map((track) => track.name === 'Melody'
      ? {
        ...track,
        clips: track.clips.map((clip, index) => index === 0
          ? { ...clip, startBeat: 0, lengthBeats: lengthBars * 4, notes: [{ id: 'n', pitch: 60, startBeat: (lengthBars - 1) * 4, durationBeats: 1, velocity: 90 }] }
          : clip),
      }
      : track),
  });
}

describe('track.added covers every creation path exactly once', () => {
  const added = (events: AppEvent[]) => ofType(events, 'track.added');

  it('fires once per track made by the accompaniment assistant, next to accompaniment.created', () => {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      chordTrack: [{ id: 'c0', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] }],
    }));
    const events = observeAll(() => {
      expect(compingGeneration.generateCompingClip({ startBar: 1, endBar: 1, pattern: 'whole', register: 55, voiceLeading: true }).ok).toBe(true);
    });
    expect(added(events)).toHaveLength(1);
    expect(ofType(events, 'accompaniment.created')).toHaveLength(1);
  });

  it('fires once for a duplicated track and once for a reverb return', () => {
    const melody = useStore.getState().project.tracks.find((t) => t.name === 'Melody')!;
    expect(added(observeAll(() => {
      expect(trackActions.duplicateStudioTrack(melody.id).ok).toBe(true);
    }))).toHaveLength(1);
    expect(added(observeAll(() => {
      expect(routingActions.addStudioReverbReturn(melody.id).ok).toBe(true);
    }))).toHaveLength(1);
  });

  it('fires once per track imported from a MIDI file', async () => {
    const before = useStore.getState().project.tracks.length;
    const events = await observeAllAsync(async () => {
      const result = await importMidi.importMidiBytes('song.mid', midiBytes(2));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    });
    const created = useStore.getState().project.tracks.length - before;
    expect(created).toBeGreaterThan(0);
    expect(added(events)).toHaveLength(created);
  });

  it('fires for a track added by any committed project change, e.g. a drum track', () => {
    let addedId = '';
    const events = observeAll(() => {
      useStore.getState().applyProjectChange((project) => {
        const result = addTrack(project, 'drum', { name: 'Kit' });
        if (!result.ok) throw new Error('fixture');
        addedId = result.trackId;
        return result.project;
      });
    });
    expect(added(events)).toEqual([
      { type: 'track.added', payload: { trackId: addedId, trackName: 'Kit', trackType: 'drum' } },
    ]);
  });

  it('does not fire when a track command is refused, or when other edits are committed', () => {
    useStore.setState({ projectOperationBusy: true });
    expect(added(observeAll(() => {
      expect(trackActions.addStudioTrack({ kind: 'instrument', name: 'x' }).ok).toBe(false);
    }))).toHaveLength(0);
    useStore.setState({ projectOperationBusy: false });
    expect(added(observeAll(() => {
      useStore.getState().addNote(melodyClip().id, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 });
    }))).toHaveLength(0);
  });
});

describe('song.lengthChanged fires for every committed length change, once', () => {
  const lengths = (events: AppEvent[]) => ofType(events, 'song.lengthChanged');

  it('fires once for the direct set', () => {
    const next = useStore.getState().project.lengthBars + 3;
    expect(lengths(observeAll(() => {
      expect(songLengthActions.setStudioSongLengthBars(next).ok).toBe(true);
    }))).toEqual([{ type: 'song.lengthChanged', payload: { lengthBars: next } }]);
  });

  it('fires when a chord suggestion in the final bar grows the song', () => {
    const { lengthBars } = useStore.getState().project;
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      chordTrack: Array.from({ length: lengthBars }, (_, bar): ChordEvent => ({
        id: `c${bar}`, startBeat: bar * 4, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7],
      })),
    }));
    const events = observeAll(() => editorActions.appendChordAfterLast('G'));
    expect(useStore.getState().project.lengthBars).toBe(lengthBars + 1);
    expect(lengths(events)).toEqual([{ type: 'song.lengthChanged', payload: { lengthBars: lengthBars + 1 } }]);
  });

  it('fires when a longer MIDI file is imported', async () => {
    const { lengthBars } = useStore.getState().project;
    const events = await observeAllAsync(async () => {
      const result = await importMidi.importMidiBytes('long.mid', midiBytes(lengthBars + 8));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    });
    expect(useStore.getState().project.lengthBars).toBeGreaterThan(lengthBars);
    expect(lengths(events)).toHaveLength(1);
  });

  it('does not fire for a commit that leaves the length alone', () => {
    expect(lengths(observeAll(() => {
      useStore.getState().addNote(melodyClip().id, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 });
      songLengthActions.setStudioSongLengthBars(useStore.getState().project.lengthBars);
    }))).toHaveLength(0);
  });
});

describe('undo and redo do not replay action events', () => {
  const NEW_TYPES: AppEventType[] = ['track.added', 'clip.split', 'song.lengthChanged', 'notes.quantized', 'accompaniment.created'];

  it('emits none of the five new events', () => {
    const clip = melodyClip();
    useStore.getState().addNote(clip.id, { pitch: 60, startBeat: 1.1, durationBeats: 0.5, velocity: 90 });
    const noteIds = melodyClip().notes!.map((n) => n.id);
    const events = observeAll(() => {
      trackActions.addStudioTrack({ kind: 'instrument', name: 'Hook' });
      useStore.getState().splitClipAtBeat(clip.id, clip.startBeat + 4);
      songLengthActions.setStudioSongLengthBars(useStore.getState().project.lengthBars + 1);
      editorActions.quantizeNotesWithReport(clip.id, noteIds, 0.5);
    });
    expect(NEW_TYPES.filter((type) => ofType(events, type).length === 1)).toEqual(
      ['track.added', 'clip.split', 'song.lengthChanged', 'notes.quantized'],
    );
    const undoRedo = observeAll(() => {
      for (let i = 0; i < 4; i += 1) useStore.getState().undo();
      for (let i = 0; i < 4; i += 1) useStore.getState().redo();
    });
    expect(undoRedo.filter((event) => NEW_TYPES.includes(event.type))).toEqual([]);
  });
});

describe('chord events follow the commit', () => {
  it('does not report chord.added when the store refused the edit (recording lock)', () => {
    lockByRecording();
    const before = useStore.getState().project;
    const events = observeAll(() => {
      editorActions.addChordWithAnalysis('C', 0, 4);
      editorActions.appendChordAfterLast('G');
      editorActions.applyProgressionTemplate('I-V-vi-IV');
    });
    expect(useStore.getState().project).toBe(before);
    expect(ofType(events, 'chord.added')).toHaveLength(0);
  });

  it('reports chord.added once after a successful add', () => {
    expect(ofType(observeAll(() => editorActions.addChordWithAnalysis('C', 0, 4)), 'chord.added')).toHaveLength(1);
  });
});
