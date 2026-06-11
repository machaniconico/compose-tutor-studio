import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { createDefaultProject } from '../src/state/defaultProject';

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it. We import dynamically inside beforeAll for that reason.
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
});

beforeEach(() => {
  // Reset to a clean project + history before each test.
  installLocalStorage();
  useStore.getState().createNewProject('テスト');
});

describe('default project', () => {
  it('builds 120bpm / C major / 4/4 / 8 bars with the expected tracks', () => {
    const project = createDefaultProject();
    expect(project.bpm).toBe(120);
    expect(project.key).toBe('C');
    expect(project.scale).toBe('major');
    expect(project.timeSignature).toEqual([4, 4]);
    expect(project.lengthBars).toBe(8);

    const names = project.tracks.map((t) => t.name);
    expect(names).toEqual(['Chords', 'Bass', 'Melody', 'Drums', 'Master']);

    // Instrument tracks each have one full-length empty midi clip.
    const chords = project.tracks[0];
    expect(chords?.clips.length).toBe(1);
    expect(chords?.clips[0]?.type).toBe('midi');
    expect(chords?.clips[0]?.lengthBeats).toBe(32);
    expect(chords?.clips[0]?.notes).toEqual([]);

    // Drum track has one drum clip with stepsPerBar 16.
    const drums = project.tracks[3];
    expect(drums?.type).toBe('drum');
    expect(drums?.clips[0]?.type).toBe('drum');
    expect(drums?.clips[0]?.stepsPerBar).toBe(16);
  });

  it('has the preset C G Am F progression with correct pitch-class notes', () => {
    const project = createDefaultProject();
    const symbols = project.chordTrack.map((c) => c.symbol);
    // 8 bars / 1 chord per bar => C G Am F repeated twice.
    expect(symbols).toEqual(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F']);

    const bySymbol = (s: string) => project.chordTrack.find((c) => c.symbol === s);
    expect(bySymbol('C')?.notes).toEqual([0, 4, 7]); // C E G
    expect(bySymbol('G')?.notes).toEqual([7, 11, 2]); // G B D
    expect(bySymbol('Am')?.notes).toEqual([9, 0, 4]); // A C E
    expect(bySymbol('F')?.notes).toEqual([5, 9, 0]); // F A C
  });
});

describe('store metadata actions', () => {
  it('mutates bpm/key/scale/title and bumps updatedAt', () => {
    const before = useStore.getState().project.updatedAt;
    useStore.getState().setBpm(140);
    expect(useStore.getState().project.bpm).toBe(140);

    useStore.getState().setKey('G');
    expect(useStore.getState().project.key).toBe('G');

    useStore.getState().setScale('minorPentatonic');
    expect(useStore.getState().project.scale).toBe('minorPentatonic');

    useStore.getState().setTitle('新タイトル');
    expect(useStore.getState().project.title).toBe('新タイトル');

    expect(useStore.getState().project.updatedAt >= before).toBe(true);
  });
});

describe('chord actions', () => {
  it('adds and removes chords', () => {
    const initialCount = useStore.getState().project.chordTrack.length;
    useStore.getState().addChord('Dm', 0, 4);
    const added = useStore.getState().project.chordTrack;
    expect(added.length).toBe(initialCount + 1);
    const newChord = added[added.length - 1];
    expect(newChord?.symbol).toBe('Dm');
    expect(newChord?.quality).toBe('minor');

    const id = newChord?.id ?? '';
    useStore.getState().removeChord(id);
    expect(useStore.getState().project.chordTrack.length).toBe(initialCount);
  });

  it('updates a chord', () => {
    const id = useStore.getState().project.chordTrack[0]?.id ?? '';
    useStore.getState().updateChord(id, { symbol: 'Cmaj7' });
    expect(useStore.getState().project.chordTrack[0]?.symbol).toBe('Cmaj7');
  });
});

describe('note actions', () => {
  it('adds, updates, and removes notes on a clip', () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });

    const clip = () => useStore.getState().project.tracks[0]?.clips[0];
    expect(clip()?.notes?.length).toBe(1);

    const noteId = clip()?.notes?.[0]?.id ?? '';
    useStore.getState().updateNote(clipId, noteId, { pitch: 64 });
    expect(clip()?.notes?.[0]?.pitch).toBe(64);

    useStore.getState().removeNote(clipId, noteId);
    expect(clip()?.notes?.length).toBe(0);
  });
});

describe('drum actions', () => {
  it('toggles a drum step on and off', () => {
    const drumTrack = useStore.getState().project.tracks.find((t) => t.type === 'drum');
    const clipId = drumTrack?.clips[0]?.id ?? '';

    useStore.getState().toggleDrumStep(clipId, 'kick', 0);
    const drumClip = () =>
      useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0];
    expect(drumClip()?.drumEvents?.length).toBe(1);
    expect(drumClip()?.drumEvents?.[0]?.lane).toBe('kick');

    useStore.getState().toggleDrumStep(clipId, 'kick', 0);
    expect(drumClip()?.drumEvents?.length).toBe(0);
  });
});

describe('mixer actions', () => {
  it('sets volume/pan and toggles mute/solo', () => {
    const trackId = useStore.getState().project.tracks[0]?.id ?? '';
    useStore.getState().setTrackVolume(trackId, 0.5);
    useStore.getState().setTrackPan(trackId, -0.3);
    useStore.getState().toggleMute(trackId);
    useStore.getState().toggleSolo(trackId);

    const track = useStore.getState().project.tracks[0];
    expect(track?.volume).toBe(0.5);
    expect(track?.pan).toBe(-0.3);
    expect(track?.mute).toBe(true);
    expect(track?.solo).toBe(true);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes a project mutation', () => {
    expect(useStore.getState().canUndo()).toBe(false);

    useStore.getState().setBpm(150);
    expect(useStore.getState().project.bpm).toBe(150);
    expect(useStore.getState().canUndo()).toBe(true);

    useStore.getState().undo();
    expect(useStore.getState().project.bpm).toBe(120);
    expect(useStore.getState().canRedo()).toBe(true);

    useStore.getState().redo();
    expect(useStore.getState().project.bpm).toBe(150);
  });

  it('clears redo history on a new mutation', () => {
    useStore.getState().setBpm(150);
    useStore.getState().undo();
    expect(useStore.getState().canRedo()).toBe(true);

    useStore.getState().setBpm(99);
    expect(useStore.getState().canRedo()).toBe(false);
    expect(useStore.getState().project.bpm).toBe(99);
  });

  it('caps history at 100 snapshots', () => {
    for (let i = 0; i < 120; i += 1) {
      useStore.getState().setBpm(100 + i);
    }
    expect(useStore.getState().past.length).toBeLessThanOrEqual(100);
  });
});

describe('selection (no history)', () => {
  it('selecting does not push history', () => {
    const trackId = useStore.getState().project.tracks[1]?.id ?? '';
    useStore.getState().selectTrack(trackId);
    expect(useStore.getState().editor.selectedTrackId).toBe(trackId);
    expect(useStore.getState().canUndo()).toBe(false);
  });
});

describe('persistence integration', () => {
  it('createNewProject persists and is listable', () => {
    useStore.getState().createNewProject('保存テスト');
    const id = useStore.getState().project.id;
    const list = useStore.getState().listSavedProjects();
    expect(list.some((p) => p.id === id)).toBe(true);
  });

  it('saveToLocalStorage writes synchronously and survives reload', () => {
    useStore.getState().setTitle('永続化');
    useStore.getState().saveToLocalStorage();
    const id = useStore.getState().project.id;
    const list = useStore.getState().listSavedProjects();
    const found = list.find((p) => p.id === id);
    expect(found?.title).toBe('永続化');
  });
});
