import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProject } from '@cts/project-model';
import { installLocalStorage, MemoryStorage } from './localStorageStub';
import { createDefaultProject } from '../src/state/defaultProject';
import { createSampleProject, SAMPLE_PROJECT_TITLE } from '../src/state/sampleProject';
import { isInScale, PITCH_CLASS } from '../src/state/music';
import { projectKey } from '../src/state/persistence';

// Audio is mocked so the bridge's start beat can be observed without Web Audio.
const schedulerStarts = vi.hoisted(() => [] as number[]);
const schedulerLoops = vi.hoisted(
  () => [] as Array<{ startBeat: number; endBeat: number } | null>,
);
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    now: () => 0,
    ensureContext: async () => ({ context: {}, master: {} }),
  }),
}));
vi.mock('../src/audio/graph', () => ({
  buildTrackGraphs: () => new Map(),
  applyMixState: () => undefined,
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: () => undefined }));
vi.mock('../src/audio/synth', () => ({ SynthVoiceManager: class {} }));
vi.mock('../src/audio/drums', () => ({ DrumVoiceManager: class {} }));
vi.mock('../src/audio/scheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/scheduler')>();
  class FakeScheduler {
    isRunning = false;
    start(
      _events: unknown,
      _bpm: number,
      startBeat: number,
      loop: { startBeat: number; endBeat: number } | null,
    ): void {
      schedulerStarts.push(startBeat);
      schedulerLoops.push(loop);
      this.isRunning = true;
    }
    stop(): void {
      this.isRunning = false;
    }
    currentBeat(): number {
      return 0;
    }
  }
  return { ...actual, Scheduler: FakeScheduler };
});

// The store reads localStorage at module-import time, so install the stub
// BEFORE importing it. We import dynamically inside beforeAll for that reason.
let useStore: typeof import('../src/state/store')['useStore'];
let activeLoopRange: typeof import('../src/state/store')['activeLoopRange'];
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
  ({ useStore, activeLoopRange } = await import('../src/state/store'));
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

describe('song length (setLengthBars)', () => {
  const noteStarts = () =>
    useStore.getState().project.tracks[0]?.clips[0]?.notes?.map((n) => n.startBeat) ?? [];

  it('shortens freely when nothing lies past the new end', () => {
    expect(useStore.getState().setLengthBars(16)).toBeNull();
    expect(useStore.getState().setLengthBars(8)).toBeNull();
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(useStore.getState().canUndo()).toBe(true);
  });

  it('warns about the preset chords in bars 5-8 before cutting to 4 bars', () => {
    const warning = useStore.getState().setLengthBars(4);
    expect(warning).toMatch(/コード 4 個/);
    expect(useStore.getState().project.lengthBars).toBe(8);
  });

  it('warns in Japanese about notes past the new end, deletes after confirming, and undoes in one step', () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 });
    useStore.getState().addNote(clipId, { pitch: 64, startBeat: 20, durationBeats: 1, velocity: 100 });
    const pastBefore = useStore.getState().past.length;

    const warning = useStore.getState().setLengthBars(4);
    expect(warning).toMatch(/ノート 1 個/);
    expect(warning).toMatch(/削除/);
    // Not applied until confirmed.
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(noteStarts()).toEqual([0, 20]);
    expect(useStore.getState().past.length).toBe(pastBefore);

    expect(useStore.getState().setLengthBars(4, true)).toBeNull();
    expect(useStore.getState().project.lengthBars).toBe(4);
    expect(noteStarts()).toEqual([0]);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    useStore.getState().undo();
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(noteStarts()).toEqual([0, 20]);
  });

  it('warns about a note that rings past the new end, cuts it after confirming, and undoes the cut', () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 15, durationBeats: 8, velocity: 100 });
    // Only the preset chords in bars 5-8 and this note are affected (nothing starts past bar 4 on the note side).
    const noteDuration = () =>
      useStore.getState().project.tracks[0]?.clips[0]?.notes?.find((n) => n.startBeat === 15)?.durationBeats;
    const pastBefore = useStore.getState().past.length;

    const warning = useStore.getState().setLengthBars(4);
    expect(warning).toMatch(/終わりをまたぐ ノート 1 個/);
    expect(warning).toMatch(/切られます/);
    // Cancel: nothing changes and no undo step is added.
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(noteDuration()).toBe(8);
    expect(useStore.getState().past.length).toBe(pastBefore);

    expect(useStore.getState().setLengthBars(4, true)).toBeNull();
    expect(useStore.getState().project.lengthBars).toBe(4);
    expect(noteDuration()).toBe(1);
    expect(useStore.getState().project.tracks[0]?.clips[0]?.lengthBeats).toBe(16);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    useStore.getState().undo();
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(noteDuration()).toBe(8);
  });

  it('lengthens without a warning and keeps the chords', () => {
    const chords = useStore.getState().project.chordTrack.length;
    expect(useStore.getState().setLengthBars(16)).toBeNull();
    expect(useStore.getState().project.lengthBars).toBe(16);
    expect(useStore.getState().project.chordTrack.length).toBe(chords);
  });
});

describe('time signature (setTimeSignature)', () => {
  it('switches 4/4 -> 3/4 keeping beats, rounding the length up, and undoes in one step', () => {
    const chordStarts = useStore.getState().project.chordTrack.map((c) => c.startBeat);
    const { confirm, warnings } = useStore.getState().setTimeSignature([3, 4]);
    expect(confirm).toBeNull();
    expect(Array.isArray(warnings)).toBe(true);
    const project = useStore.getState().project;
    expect(project.timeSignature).toEqual([3, 4]);
    expect(project.lengthBars).toBe(11);
    expect(project.chordTrack.map((c) => c.startBeat)).toEqual(chordStarts);
    for (const track of project.tracks) {
      if (track.type !== 'drum') continue;
      for (const clip of track.clips) expect(clip.stepsPerBar).toBe(12);
    }
    useStore.getState().undo();
    expect(useStore.getState().project.timeSignature).toEqual([4, 4]);
    expect(useStore.getState().project.lengthBars).toBe(8);
  });

  it('asks before merging drum hits that collide on the coarser grid, applies after confirming, and undoes', () => {
    // A 32-step kick grid: step 1 (off the 16th grid, soft) and step 2 (on the beat, loud) both become step 1 in 3/4.
    const seeded = useStore.getState().project;
    useStore.setState({
      project: {
        ...seeded,
        tracks: seeded.tracks.map((t) =>
          t.type === 'drum'
            ? {
                ...t,
                clips: t.clips.map((c) => ({
                  ...c,
                  stepsPerBar: 32,
                  drumEvents: [
                    { id: 'kick-soft', lane: 'kick' as const, stepIndex: 1, velocity: 20 },
                    { id: 'kick-loud', lane: 'kick' as const, stepIndex: 2, velocity: 127 },
                  ],
                })),
              }
            : t,
        ),
      },
    });
    const kicks = () =>
      useStore
        .getState()
        .project.tracks.find((t) => t.type === 'drum')
        ?.clips[0]?.drumEvents?.map((e) => [e.id, e.stepIndex, e.velocity]);
    const pastBefore = useStore.getState().past.length;

    const first = useStore.getState().setTimeSignature([3, 4]);
    expect(first.confirm).toMatch(/ドラムの 1 個/);
    expect(first.confirm).toMatch(/削除/);
    expect(first.warnings).toEqual([]);
    // Cancel: nothing changes and no undo step is added.
    expect(useStore.getState().project.timeSignature).toEqual([4, 4]);
    expect(kicks()).toEqual([
      ['kick-soft', 1, 20],
      ['kick-loud', 2, 127],
    ]);
    expect(useStore.getState().past.length).toBe(pastBefore);

    const second = useStore.getState().setTimeSignature([3, 4], true);
    expect(second.confirm).toBeNull();
    expect(second.warnings.some((w) => w.includes('重なる'))).toBe(true);
    expect(useStore.getState().project.timeSignature).toEqual([3, 4]);
    expect(kicks()).toEqual([['kick-loud', 1, 127]]);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    useStore.getState().undo();
    expect(useStore.getState().project.timeSignature).toEqual([4, 4]);
    expect(kicks()).toEqual([
      ['kick-soft', 1, 20],
      ['kick-loud', 2, 127],
    ]);
  });

  it('asks before removing a drum hit that the new grid rounds onto the song end', () => {
    // 8 bars of 3/4 (24 beats) with a 32-step grid: step 255 (beat 23.9) rounds to beat 24 in 4/4.
    const seeded = useStore.getState().project;
    useStore.setState({
      project: {
        ...seeded,
        timeSignature: [3, 4],
        lengthBars: 8,
        tracks: seeded.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => ({
            ...c,
            startBeat: 0,
            lengthBeats: 24,
            ...(t.type === 'drum'
              ? {
                  stepsPerBar: 32,
                  drumEvents: [{ id: 'kick-last', lane: 'kick' as const, stepIndex: 255, velocity: 100 }],
                }
              : {}),
          })),
        })),
      },
    });

    const first = useStore.getState().setTimeSignature([4, 4]);
    expect(first.confirm).toMatch(/ドラムの 1 個/);
    expect(useStore.getState().project.timeSignature).toEqual([3, 4]);

    const second = useStore.getState().setTimeSignature([4, 4], true);
    expect(second.confirm).toBeNull();
    expect(second.warnings.some((w) => w.includes('曲の終わり'))).toBe(true);
    expect(useStore.getState().project.tracks.find((t) => t.type === 'drum')?.clips[0]?.drumEvents).toEqual([]);
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

describe('loop range', () => {
  it('setLoopRange saves the range in the project and undo restores the previous one', () => {
    useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });

    useStore.getState().undo();
    expect(useStore.getState().project.loopRange).toBeUndefined();
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('setLoopRange(null) clears the range in one undo step', () => {
    useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
    useStore.getState().setLoopRange(null);
    expect(useStore.getState().project.loopRange).toBeUndefined();
    useStore.getState().undo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
  });

  it('turning loop on without a range loops the bar holding the playhead', () => {
    useStore.getState().setPosition(9.5); // bar 3 in 4/4 (beats 8-12)
    useStore.getState().toggleLoop();
    expect(useStore.getState().transport.loopEnabled).toBe(true);
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 8, endBeat: 12 });
  });

  it('turning loop on at the song end loops the last bar', () => {
    const lengthBeats = useStore.getState().project.lengthBars * 4;
    useStore.getState().setPosition(lengthBeats);
    useStore.getState().toggleLoop();
    expect(useStore.getState().project.loopRange).toEqual({
      startBeat: lengthBeats - 4,
      endBeat: lengthBeats,
    });
  });

  it('turning loop on keeps an existing range, and turning it off keeps the range', () => {
    useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
    useStore.getState().setPosition(20);
    useStore.getState().toggleLoop();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
    useStore.getState().toggleLoop();
    expect(useStore.getState().transport.loopEnabled).toBe(false);
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
  });

  it('derives the transport loop bounds from project.loopRange', () => {
    useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
    expect(activeLoopRange(useStore.getState())).toBeNull(); // loop is off
    useStore.getState().toggleLoop();
    expect(activeLoopRange(useStore.getState())).toEqual({ startBeat: 4, endBeat: 12 });
  });

  it('passes the loop range to playback, and restarts when the range changes while playing', async () => {
    const { initAudioBridge } = await import('../src/audio/playback');
    const teardown = initAudioBridge();
    schedulerStarts.length = 0;
    schedulerLoops.length = 0;
    try {
      useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
      useStore.getState().toggleLoop();
      useStore.getState().setPosition(4);
      useStore.getState().play();
      await vi.waitFor(() => expect(schedulerLoops).toEqual([{ startBeat: 4, endBeat: 12 }]));

      useStore.getState().setLoopRange({ startBeat: 0, endBeat: 8 });
      await vi.waitFor(() =>
        expect(schedulerLoops).toEqual([
          { startBeat: 4, endBeat: 12 },
          { startBeat: 0, endBeat: 8 },
        ]),
      );
      expect(schedulerLoops.at(-1)).toEqual(useStore.getState().project.loopRange);
    } finally {
      useStore.getState().stop();
      teardown();
    }
  });

  it('a loop range change after tap tempo is its own undo step', () => {
    const owner = {};
    const pastBefore = useStore.getState().past.length;
    useStore.getState().beginTransaction(owner);
    useStore.getState().setBpm(100);
    useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
    useStore.getState().commitTransaction(owner); // the tap run ends later: no-op
    expect(useStore.getState().past.length).toBe(pastBefore + 2);

    useStore.getState().undo();
    expect(useStore.getState().project.loopRange).toBeUndefined();
    expect(useStore.getState().project.bpm).toBe(100);
    useStore.getState().undo();
    expect(useStore.getState().project.bpm).toBe(120);
    useStore.getState().redo();
    useStore.getState().redo();
    expect(useStore.getState().project.bpm).toBe(100);
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
  });

  it('clearing the range or creating the default range after tap tempo is its own undo step', () => {
    useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
    const owner = {};
    useStore.getState().beginTransaction(owner);
    useStore.getState().setBpm(100);
    useStore.getState().setLoopRange(null);
    useStore.getState().undo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
    expect(useStore.getState().project.bpm).toBe(100);

    useStore.getState().setLoopRange(null);
    useStore.getState().beginTransaction(owner);
    useStore.getState().setBpm(90);
    useStore.getState().toggleLoop();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 0, endBeat: 4 });
    useStore.getState().undo();
    expect(useStore.getState().project.loopRange).toBeUndefined();
    expect(useStore.getState().project.bpm).toBe(90);
  });

  it('shortening the song cuts the loop range in the same undo step', () => {
    useStore.getState().setLoopRange({ startBeat: 12, endBeat: 24 });
    const pastBefore = useStore.getState().past.length;
    expect(useStore.getState().setLengthBars(4, true)).toBeNull();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 12, endBeat: 16 });
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    useStore.getState().undo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 12, endBeat: 24 });
    useStore.getState().redo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 12, endBeat: 16 });
  });

  it('shortening the song before the loop range removes it, and undo brings it back', () => {
    useStore.getState().setLoopRange({ startBeat: 24, endBeat: 32 });
    useStore.getState().setLengthBars(4, true);
    expect(useStore.getState().project.loopRange).toBeUndefined();
    useStore.getState().undo();
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 24, endBeat: 32 });
  });

  it('shortening the song while loop-playing restarts playback with a loop inside the song', async () => {
    const { initAudioBridge } = await import('../src/audio/playback');
    const teardown = initAudioBridge();
    schedulerLoops.length = 0;
    try {
      useStore.getState().setLoopRange({ startBeat: 24, endBeat: 32 });
      useStore.getState().toggleLoop();
      useStore.getState().setPosition(24);
      useStore.getState().play();
      await vi.waitFor(() => expect(schedulerLoops).toEqual([{ startBeat: 24, endBeat: 32 }]));

      useStore.getState().setLengthBars(4, true);
      // The range left the song, so playback runs to the song end instead of looping silence.
      await vi.waitFor(() => expect(schedulerLoops).toEqual([{ startBeat: 24, endBeat: 32 }, null]));
    } finally {
      useStore.getState().stop();
      teardown();
    }
  });

  it('passes no loop to playback while loop is off', async () => {
    const { initAudioBridge } = await import('../src/audio/playback');
    const teardown = initAudioBridge();
    schedulerLoops.length = 0;
    try {
      useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 });
      useStore.getState().play();
      await vi.waitFor(() => expect(schedulerLoops).toEqual([null]));
    } finally {
      useStore.getState().stop();
      teardown();
    }
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

describe('seek', () => {
  it('setPosition moves the playhead without adding undo history', () => {
    const pastBefore = useStore.getState().past.length;
    useStore.getState().setPosition(8);
    expect(useStore.getState().transport.positionBeat).toBe(8);
    expect(useStore.getState().past.length).toBe(pastBefore);
    expect(useStore.getState().canUndo()).toBe(false);
  });

  it('play after setPosition(8) starts playback from beat 8, and restartAt re-seeks while playing', async () => {
    const { initAudioBridge, restartAt } = await import('../src/audio/playback');
    const teardown = initAudioBridge();
    schedulerStarts.length = 0;
    try {
      useStore.getState().setPosition(8);
      useStore.getState().play();
      await vi.waitFor(() => expect(schedulerStarts).toEqual([8]));

      restartAt(16);
      await vi.waitFor(() => expect(schedulerStarts).toEqual([8, 16]));
      expect(useStore.getState().transport.isPlaying).toBe(true);
      expect(useStore.getState().canUndo()).toBe(false);
    } finally {
      useStore.getState().stop();
      teardown();
    }
  });
});
