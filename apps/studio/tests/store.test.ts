import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateProject } from '@cts/project-model';
import { installLocalStorage, MemoryStorage } from './localStorageStub';
import { createDefaultProject } from '../src/state/defaultProject';
import { createSampleProject, SAMPLE_PROJECT_TITLE } from '../src/state/sampleProject';
import { isInScale, PITCH_CLASS } from '../src/state/music';
import { projectKey } from '../src/state/persistence';

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it. We import dynamically inside beforeAll for that reason.
let useStore: typeof import('../src/state/store')['useStore'];
let installProjectSaveGuards: typeof import('../src/state/projectSaveGuard')['installProjectSaveGuards'];
let storage: MemoryStorage;

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

/** Spin until the wall clock ticks, so consecutive saves get distinct updatedAt. */
function waitNextMs(): void {
  const t = Date.now();
  while (Date.now() === t) {
    // busy-wait (sub-millisecond)
  }
}

function makeBeforeUnloadTarget() {
  const listeners = new Map<string, Set<() => void>>();
  const addListener = (type: string, listener: () => void): void => {
    const typeListeners = listeners.get(type) ?? new Set<() => void>();
    typeListeners.add(listener);
    listeners.set(type, typeListeners);
  };
  const removeListener = (type: string, listener: () => void): void => {
    listeners.get(type)?.delete(listener);
  };
  const dispatch = (type: string): void => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return {
    target: {
      addEventListener(type: string, listener: () => void): void {
        addListener(type, listener);
      },
      removeEventListener(type: string, listener: () => void): void {
        removeListener(type, listener);
      },
    } as Window,
    dispatchBeforeUnload(): void {
      dispatch('beforeunload');
    },
    dispatchPageHide(): void {
      dispatch('pagehide');
    },
  };
}

beforeAll(async () => {
  storage = installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ installProjectSaveGuards } = await import('../src/state/projectSaveGuard'));
});

beforeEach(() => {
  // Reset to a clean project + history before each test.
  storage = installLocalStorage();
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
    expect(useStore.getState().save.status).toBe('saved');
  });

  it('saveToLocalStorage writes synchronously and survives reload', () => {
    useStore.getState().setTitle('永続化');
    expect(useStore.getState().save.status).toBe('saving');
    expect(useStore.getState().saveToLocalStorage()).toBe(true);
    const id = useStore.getState().project.id;
    const list = useStore.getState().listSavedProjects();
    const found = list.find((p) => p.id === id);
    expect(found?.title).toBe('永続化');
    expect(useStore.getState().save.status).toBe('saved');
    expect(useStore.getState().save.lastSavedAt).not.toBeNull();
  });

  it('flushes a debounced save synchronously before unload', () => {
    const id = useStore.getState().project.id;
    useStore.getState().setTitle('リロード直前の編集');

    const beforeFlush = storage.getItem(projectKey(id));
    expect(beforeFlush ? JSON.parse(beforeFlush).title : null).toBe('テスト');

    expect(useStore.getState().flushPendingSave()).toBe(true);
    const afterFlush = storage.getItem(projectKey(id));
    expect(afterFlush ? JSON.parse(afterFlush).title : null).toBe('リロード直前の編集');
    expect(useStore.getState().save.status).toBe('saved');
  });

  it('registers app-level lifecycle guards that flush pending saves', () => {
    const { target, dispatchBeforeUnload, dispatchPageHide } = makeBeforeUnloadTarget();
    const id = useStore.getState().project.id;
    useStore.getState().setTitle('閉じる直前の編集');

    const dispose = installProjectSaveGuards(target);
    dispatchBeforeUnload();

    const saved = storage.getItem(projectKey(id));
    expect(saved ? JSON.parse(saved).title : null).toBe('閉じる直前の編集');

    useStore.getState().setTitle('ページ退避直前の編集');
    dispatchPageHide();

    const pageHidden = storage.getItem(projectKey(id));
    expect(pageHidden ? JSON.parse(pageHidden).title : null).toBe('ページ退避直前の編集');

    useStore.getState().setTitle('登録解除後の編集');
    dispose();
    dispatchBeforeUnload();
    dispatchPageHide();

    const afterDispose = storage.getItem(projectKey(id));
    expect(afterDispose ? JSON.parse(afterDispose).title : null).toBe('ページ退避直前の編集');
  });

  it('reports a Japanese user-facing message when saving fails', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new FailingStorage(),
      configurable: true,
      writable: true,
    });

    useStore.getState().setTitle('保存失敗テスト');

    expect(useStore.getState().saveToLocalStorage()).toBe(false);
    expect(useStore.getState().save.status).toBe('error');
    expect(useStore.getState().save.errorMessage).toContain('保存に失敗しました');
    expect(useStore.getState().save.errorMessage).toContain('保存容量');
  });
});

describe('transport toggles', () => {
  it('toggles loop and metronome state', () => {
    expect(useStore.getState().transport.loopEnabled).toBe(false);
    expect(useStore.getState().transport.metronome).toBe(false);

    useStore.getState().toggleLoop();
    useStore.getState().toggleMetronome();

    expect(useStore.getState().transport.loopEnabled).toBe(true);
    expect(useStore.getState().transport.metronome).toBe(true);
  });
});

describe('start screen state', () => {
  it('is open on launch (before any user action)', () => {
    // No other test mutates startScreenOpen before this describe runs.
    expect(useStore.getState().startScreenOpen).toBe(true);
  });

  it('setStartScreenOpen closes and reopens without pushing history', () => {
    useStore.getState().setStartScreenOpen(false);
    expect(useStore.getState().startScreenOpen).toBe(false);

    useStore.getState().setStartScreenOpen(true);
    expect(useStore.getState().startScreenOpen).toBe(true);
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('the "前回の続き" path loads the most recent saved project', () => {
    useStore.getState().createNewProject('一曲目');
    waitNextMs(); // two creations in the same ms would tie on updatedAt
    useStore.getState().createNewProject('二曲目');

    const latest = useStore.getState().listSavedProjects()[0];
    expect(latest?.title).toBe('二曲目');

    expect(useStore.getState().loadProjectById(latest!.id)).toBe(true);
    expect(useStore.getState().project.id).toBe(latest!.id);
  });

  it('has no saved projects to continue from on a fresh install', () => {
    installLocalStorage(); // wipe storage = first launch
    expect(useStore.getState().listSavedProjects()).toEqual([]);
  });
});

describe('right panel tab (lifted from InspectorPanel)', () => {
  it('defaults to the inspector tab', () => {
    expect(useStore.getState().rightPanelTab).toBe('inspector');
  });

  it('setRightPanelTab switches to tutorial via the store, with no history', () => {
    useStore.getState().setRightPanelTab('tutorial');
    expect(useStore.getState().rightPanelTab).toBe('tutorial');
    expect(useStore.getState().canUndo()).toBe(false);

    useStore.getState().setRightPanelTab('assistant');
    expect(useStore.getState().rightPanelTab).toBe('assistant');

    useStore.getState().setRightPanelTab('inspector');
    expect(useStore.getState().rightPanelTab).toBe('inspector');
  });
});

describe('sample project (試聴用)', () => {
  it('is a valid 8-bar C-major project with the C G Am F progression', () => {
    const sample = createSampleProject();
    expect(validateProject(sample).errors).toEqual([]);
    expect(sample.title).toBe(SAMPLE_PROJECT_TITLE);
    expect(sample.lengthBars).toBe(8);
    expect(sample.bpm).toBe(120);
    expect(sample.key).toBe('C');
    expect(sample.scale).toBe('major');
    expect(sample.chordTrack.map((c) => c.symbol)).toEqual([
      'C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F',
    ]);
  });

  it('actually contains music: pad/bass/melody notes and drum hits', () => {
    const sample = createSampleProject();
    const byName = (name: string) => sample.tracks.find((t) => t.name === name);

    for (const name of ['Chords', 'Bass', 'Melody']) {
      const notes = byName(name)?.clips[0]?.notes ?? [];
      expect(notes.length, `${name} should have notes`).toBeGreaterThan(0);
      // Every note stays inside the 8 bars (32 beats).
      for (const n of notes) {
        expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(32);
      }
    }

    const drumEvents = byName('Drums')?.clips[0]?.drumEvents ?? [];
    expect(drumEvents.length).toBeGreaterThan(0);
    const lanes = new Set(drumEvents.map((e) => e.lane));
    expect(lanes.has('kick')).toBe(true);
    expect(lanes.has('snare')).toBe(true);
  });

  it('keeps every melody and bass note inside the C major scale', () => {
    const sample = createSampleProject();
    for (const name of ['Bass', 'Melody']) {
      const notes = sample.tracks.find((t) => t.name === name)?.clips[0]?.notes ?? [];
      for (const n of notes) {
        expect(
          isInScale(n.pitch, PITCH_CLASS.C, 'major'),
          `${name} pitch ${n.pitch} should be in C major`,
        ).toBe(true);
      }
    }
  });

  it('generates fresh ids each call (re-listening never collides)', () => {
    const a = createSampleProject();
    const b = createSampleProject();
    expect(a.id).not.toBe(b.id);
  });
});

describe('loadProjectForPreview', () => {
  it('loads the sample without saving it to localStorage', () => {
    const sample = createSampleProject();
    useStore.getState().loadProjectForPreview(sample);

    expect(useStore.getState().project.id).toBe(sample.id);
    expect(useStore.getState().save.status).toBe('idle');
    // Listening leaves no saved copy behind...
    const saved = useStore.getState().listSavedProjects();
    expect(saved.some((p) => p.id === sample.id)).toBe(false);
    // ...and starts with clean history and transport.
    expect(useStore.getState().canUndo()).toBe(false);
    expect(useStore.getState().transport.isPlaying).toBe(false);
    expect(useStore.getState().transport.positionBeat).toBe(0);
  });

  it('persists only once the user edits the previewed project', () => {
    const sample = createSampleProject();
    useStore.getState().loadProjectForPreview(sample);

    useStore.getState().setBpm(96);
    expect(useStore.getState().saveToLocalStorage()).toBe(true);
    const saved = useStore.getState().listSavedProjects();
    expect(saved.some((p) => p.id === sample.id)).toBe(true);
  });
});

describe('difficulty mode', () => {
  it('defaults to beginner', () => {
    expect(useStore.getState().editor.difficulty).toBe('beginner');
  });

  it('setDifficulty changes difficulty in editor state', () => {
    useStore.getState().setDifficulty('standard');
    expect(useStore.getState().editor.difficulty).toBe('standard');

    useStore.getState().setDifficulty('advanced');
    expect(useStore.getState().editor.difficulty).toBe('advanced');

    useStore.getState().setDifficulty('beginner');
    expect(useStore.getState().editor.difficulty).toBe('beginner');
  });

  it('setDifficulty persists to localStorage', () => {
    useStore.getState().setDifficulty('advanced');
    const stored = storage.getItem('cts.editor.difficulty');
    expect(stored).toBe('advanced');
  });

  it('setDifficulty does not push undo history', () => {
    useStore.getState().setDifficulty('standard');
    expect(useStore.getState().canUndo()).toBe(false);
  });
});
