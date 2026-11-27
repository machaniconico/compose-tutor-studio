import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetIdCounter,
  beatTick,
  duplicateTrack,
  expandClip,
  groovePrng,
  PPQ,
  removeTrack,
  soundingEvents,
  songEndBeat,
  swingBeat,
  validateProject,
  type Clip,
} from '@cts/project-model';
import { installLocalStorage, MemoryStorage } from './localStorageStub';
import type { SchedulePayload } from '../src/audio/events';
import { createDefaultProject } from '../src/state/defaultProject';
import { createSampleProject, SAMPLE_PROJECT_TITLE } from '../src/state/sampleProject';
import { isInScale, PITCH_CLASS } from '../src/state/music';
import { loadProject, projectKey, saveProject } from '../src/state/persistence';

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
    // Live clip edits (US-012b) update the running schedule in place.
    readonly scheduledUntil = 0;
    eventsBetween(): [] {
      return [];
    }
    playheadBeat(): number {
      return 0;
    }
    timeAt(): number {
      return 0;
    }
    update(): void {}
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

  it('keeps the sound of a surviving link when shortening removes its relay', () => {
    const seeded = useStore.getState().project;
    const track = seeded.tracks[0]!;
    const source: Clip = {
      ...track.clips[0]!, id: 'source', startBeat: 1, lengthBeats: 1,
      notes: [{ id: 'linked-note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const relay: Clip = { ...source, id: 'relay', startBeat: 8, aliasOf: source.id, notes: [] };
    const link: Clip = { ...relay, id: 'link', startBeat: 0, aliasOf: relay.id };
    const project = { ...seeded, chordTrack: [], sections: [], tracks: [{ ...track, clips: [link, relay, source] }] };
    useStore.setState({ project });
    expect(expandClip(link, [link, relay, source]).notes.map((n) => n.startBeat)).toEqual([0]);

    expect(useStore.getState().setLengthBars(1)).toMatch(/ノート 1 個/);
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().setLengthBars(1, true)).toBeNull();

    const clips = useStore.getState().project.tracks[0]!.clips;
    expect(clips.map((clip) => clip.id)).toEqual(['link', 'source']);
    expect(clips[0]!.aliasOf).toBe(source.id);
    expect(expandClip(clips[0]!, clips).notes.map((n) => n.startBeat)).toEqual([0]);
    useStore.getState().undo();
    expect(useStore.getState().project).toBe(project);
  });

  it('warns when trimming a retained source removes sound from a link inside the new end', () => {
    const seeded = useStore.getState().project;
    const track = seeded.tracks[0]!;
    const source: Clip = {
      ...track.clips[0]!, id: 'source', startBeat: 3, lengthBeats: 2,
      notes: [{ id: 'linked-note', pitch: 60, startBeat: 1, durationBeats: 1, velocity: 100 }],
    };
    const link: Clip = { ...source, id: 'link', startBeat: 0, aliasOf: source.id, notes: [] };
    const project = { ...seeded, chordTrack: [], sections: [], tracks: [{ ...track, clips: [link, source] }] };
    useStore.setState({ project });

    const warning = useStore.getState().setLengthBars(1);
    expect(warning).toMatch(/リンク.*ノート 1 個/);
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().setLengthBars(1, true)).toBeNull();
    const clips = useStore.getState().project.tracks[0]!.clips;
    expect(expandClip(clips[0]!, clips).notes).toEqual([]);
  });

  it('copies the pattern into both retained links if their source is deleted', () => {
    const seeded = useStore.getState().project;
    const track = seeded.tracks[0]!;
    const source: Clip = {
      ...track.clips[0]!, id: 'source', startBeat: 8, lengthBeats: 2,
      notes: [{ id: 'source-note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
    };
    const link: Clip = { ...source, id: 'link', startBeat: 0, aliasOf: source.id, notes: [] };
    const second: Clip = { ...link, id: 'second', startBeat: 2, aliasOf: link.id };
    const project = { ...seeded, chordTrack: [], sections: [], tracks: [{ ...track, clips: [link, second, source] }] };
    useStore.setState({ project });

    expect(useStore.getState().setLengthBars(1)).toMatch(/ノート 1 個/);
    expect(useStore.getState().setLengthBars(1, true)).toBeNull();
    const shortened = useStore.getState().project;
    const clips = shortened.tracks[0]!.clips;
    expect(clips.map((clip) => clip.id)).toEqual(['link', 'second']);
    expect(clips.flatMap((clip) => expandClip(clip, clips).notes.map((n) => n.startBeat))).toEqual([0, 2]);
    expect(validateProject(shortened).errors).toEqual([]);
  });

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
  it('asks before removing a repeating drum hit rounded onto the loop boundary', () => {
    const seeded = useStore.getState().project;
    const track = seeded.tracks.find((t) => t.type === 'drum')!;
    const clip: Clip = {
      ...track.clips[0]!, lengthBeats: 4, loop: true, contentLengthBeats: 1, stepsPerBar: 32,
      drumEvents: [{ id: 'kick', lane: 'kick', stepIndex: 7, velocity: 100 }],
    };
    const project = { ...seeded, tracks: [{ ...track, clips: [clip] }] };
    useStore.setState({ project });
    expect(expandClip(clip, [clip]).drumHits).toHaveLength(4);

    const first = useStore.getState().setTimeSignature([3, 4]);
    expect(first.confirm).toMatch(/ドラムの 1 個.*ループ/);
    expect(useStore.getState().project).toBe(project);
    const second = useStore.getState().setTimeSignature([3, 4], true);
    expect(second.warnings.some((warning) => warning.includes('ループ'))).toBe(true);
    expect(useStore.getState().project.tracks[0]!.clips[0]!.drumEvents).toEqual([]);
    useStore.getState().undo();
    expect(useStore.getState().project).toBe(project);
  });

  it('asks before rounding a shared hit out of the last repeat while keeping the earlier hits', () => {
    const seeded = useStore.getState().project;
    const track = seeded.tracks.find((t) => t.type === 'drum')!;
    const source: Clip = {
      ...track.clips[0]!, id: 'drum-source', lengthBeats: 2, stepsPerBar: 32,
      drumEvents: [{ id: 'kick', lane: 'kick', stepIndex: 7, velocity: 100 }],
    };
    const link: Clip = {
      ...source, id: 'drum-link', startBeat: 4, lengthBeats: 1.95,
      aliasOf: source.id, loop: true, contentLengthBeats: 1.05, drumEvents: [],
    };
    const project = { ...seeded, tracks: [{ ...track, clips: [source, link] }] };
    useStore.setState({ project });
    expect(expandClip(link, [source, link]).drumHits).toHaveLength(2);

    expect(useStore.getState().setTimeSignature([3, 4]).confirm).toMatch(/ドラムの 1 個/);
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().setTimeSignature([3, 4], true).confirm).toBeNull();
    const clips = useStore.getState().project.tracks[0]!.clips;
    expect(expandClip(clips[0]!, clips, 3).drumHits.map((hit) => hit.beat)).toEqual([1]);
    expect(expandClip(clips[1]!, clips, 3).drumHits.map((hit) => hit.beat)).toEqual([5]);
  });

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
  it('rejects a loop edit above the sound limit and reopens the last successful edit', () => {
    const state = useStore.getState();
    const track = state.project.tracks.find((candidate) => candidate.type === 'instrument')!;
    const clip = {
      ...track.clips[0]!,
      lengthBeats: 128,
      loop: true,
      contentLengthBeats: 1 / 64,
      notes: Array.from({ length: 12 }, (_, i) => ({
        id: i === 0 ? 'original' : `loop-${i}`, pitch: 60, startBeat: 0, durationBeats: 1 / 64, velocity: 100,
      })),
    };
    state.applyProjectChange((project) => ({
      ...project,
      lengthBars: 32,
      tracks: project.tracks.map((candidate) =>
        candidate.id === track.id ? { ...candidate, clips: [clip] } : candidate,
      ),
    }));
    expect(state.flushPendingSave()).toBe(true);

    state.updateNote(clip.id, 'original', { pitch: 64 });
    const edited = useStore.getState();
    state.addNote(clip.id, { id: 'extra', pitch: 67, startBeat: 0, durationBeats: 1 / 64, velocity: 100 });
    expect(useStore.getState().project).toBe(edited.project);
    expect(useStore.getState().past).toBe(edited.past);
    expect(state.flushPendingSave()).toBe(true);
    expect(loadProject(edited.project.id)).toEqual(edited.project);
  });

  it('refuses to save an oversized loop over the current saved project', () => {
    const storage = new MemoryStorage();
    const project = createDefaultProject('ループ');
    expect(saveProject(project, storage)).toBe(true);
    const clip = project.tracks.find((track) => track.type === 'instrument')!.clips[0]!;
    clip.lengthBeats = 128;
    clip.loop = true;
    clip.contentLengthBeats = 1 / 64;
    project.lengthBars = 32;
    clip.notes = Array.from({ length: 13 }, (_, i) => ({
      id: `loop-${i}`, pitch: 60, startBeat: 0, durationBeats: 1 / 64, velocity: 100,
    }));
    const saved = storage.getItem(projectKey(project.id));
    expect(saveProject(project, storage)).toBe(false);
    expect(storage.getItem(projectKey(project.id))).toBe(saved);
  });

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

  it('lengthens a 4-beat clip to a note placed past its end, so playback sounds it, in one undo step', async () => {
    const { buildScheduleEvents } = await import('../src/audio/events');
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t, i) =>
        i === 0 ? { ...t, clips: t.clips.map((c) => ({ ...c, startBeat: 0, lengthBeats: 4, loop: false, notes: [] })) } : t,
      ),
    }));
    const clip = () => useStore.getState().project.tracks[0]?.clips[0];

    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 5, durationBeats: 1, velocity: 100 });

    expect(clip()?.lengthBeats).toBe(6);
    const trackId = useStore.getState().project.tracks[0]?.id;
    const beats = buildScheduleEvents(useStore.getState().project)
      .filter((e) => (e.payload as { trackId: string }).trackId === trackId)
      .map((e) => e.beat);
    expect(beats).toEqual([5]);

    const noteId = clip()?.notes?.[0]?.id ?? '';
    useStore.getState().updateNote(clipId, noteId, { startBeat: 7 });
    expect(clip()?.lengthBeats).toBe(8);

    useStore.getState().undo();
    useStore.getState().undo();
    expect(clip()?.lengthBeats).toBe(4);
    expect(clip()?.notes).toEqual([]);
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

describe('track management (US-010)', () => {
  const names = () => useStore.getState().project.tracks.map((t) => t.name);
  const idOf = (name: string) => useStore.getState().project.tracks.find((t) => t.name === name)?.id ?? '';

  /** Run one action and check it is exactly one undo step back to the starting tracks. */
  function expectOneUndoStep(action: () => void): void {
    const before = useStore.getState().project.tracks;
    action();
    expect(useStore.getState().project.tracks).not.toBe(before);
    expect(useStore.getState().past).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks).toBe(before);
  }

  it('moves the selection to the next track when the selected track is removed', () => {
    const bass = idOf('Bass');
    useStore.getState().selectTrack(bass);
    useStore.getState().selectClip(useStore.getState().project.tracks[1]?.clips[0]?.id ?? null);
    useStore.getState().removeTrack(bass);

    const melody = useStore.getState().project.tracks.find((t) => t.name === 'Melody');
    expect(names()).toEqual(['Chords', 'Melody', 'Drums', 'Master']);
    expect(useStore.getState().editor.selectedTrackId).toBe(melody?.id);
    expect(useStore.getState().editor.selectedClipId).toBe(melody?.clips[0]?.id);
  });

  it('moves the selection to the previous track when the last movable track is removed', () => {
    const drums = idOf('Drums');
    useStore.getState().selectTrack(drums);
    useStore.getState().removeTrack(drums);
    expect(useStore.getState().editor.selectedTrackId).toBe(idOf('Melody'));
  });

  it('keeps the selection when another track is removed', () => {
    const chords = idOf('Chords');
    useStore.getState().selectTrack(chords);
    useStore.getState().removeTrack(idOf('Melody'));
    expect(useStore.getState().editor.selectedTrackId).toBe(chords);
  });

  it('adds a track and selects it', () => {
    const id = useStore.getState().addTrack('instrument');
    expect(names()).toEqual(['Chords', 'Bass', 'Melody', 'Drums', '楽器 4', 'Master']);
    expect(useStore.getState().editor.selectedTrackId).toBe(id);
    const added = useStore.getState().project.tracks.find((t) => t.id === id);
    expect(useStore.getState().editor.selectedClipId).toBe(added?.clips[0]?.id);
  });

  it('makes each track operation one undo step', () => {
    expectOneUndoStep(() => useStore.getState().addTrack('drum'));
    useStore.getState().createNewProject('テスト');
    expectOneUndoStep(() => useStore.getState().removeTrack(idOf('Bass')));
    useStore.getState().createNewProject('テスト');
    expectOneUndoStep(() => useStore.getState().duplicateTrack(idOf('Bass')));
    useStore.getState().createNewProject('テスト');
    expectOneUndoStep(() => useStore.getState().renameTrack(idOf('Bass'), 'ベース'));
    useStore.getState().createNewProject('テスト');
    expectOneUndoStep(() => useStore.getState().moveTrack(idOf('Bass'), 0));
    useStore.getState().createNewProject('テスト');
    expectOneUndoStep(() => useStore.getState().setTrackColor(idOf('Bass'), '#123456'));
    useStore.getState().createNewProject('テスト');
    expectOneUndoStep(() => useStore.getState().setTrackRole(idOf('Bass'), 'melody'));
  });

  it('adds no undo step when an operation changes nothing', () => {
    const masterId = idOf('Master');
    useStore.getState().removeTrack(masterId);
    useStore.getState().moveTrack(masterId, 0);
    useStore.getState().duplicateTrack(masterId);
    useStore.getState().renameTrack(idOf('Bass'), '  ');
    expect(useStore.getState().past).toHaveLength(0);
    expect(names()).toEqual(['Chords', 'Bass', 'Melody', 'Drums', 'Master']);
  });

  it('leaves the project and undo history alone when the color and role already match', () => {
    const { project } = useStore.getState();
    const bass = project.tracks.find((t) => t.name === 'Bass')!;
    useStore.getState().setTrackColor(bass.id, bass.color!);
    useStore.getState().setTrackRole(bass.id, 'bass');
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().project).toBe(project);
  });

  it('persists a duplicate when an existing project id matches a clip allocation candidate', () => {
    const project = { ...createDefaultProject(), id: 'clip-2' };
    const bass = project.tracks.find((t) => t.name === 'Bass')!;
    const saved = new MemoryStorage();
    expect(saveProject(project, saved)).toBe(true);
    const reopened = loadProject(project.id, saved)!;
    _resetIdCounter();
    const next = duplicateTrack(reopened, bass.id);
    expect(saveProject(next, saved)).toBe(true);
    expect(loadProject(project.id, saved)).toEqual(next);
  });

  it('detaches deleted clip links on reopen and keeps them silent after duplicating a track', () => {
    const project = createDefaultProject();
    const bass = project.tracks.find((t) => t.name === 'Bass')!;
    const melody = project.tracks.find((t) => t.name === 'Melody')!;
    bass.clips[0]!.id = 'clip-4';
    const source = melody.clips[0]!;
    melody.clips = [
      { ...source, id: 'melody-link', aliasOf: 'clip-4' },
      source,
      {
        ...source,
        id: 'melody-notes',
        notes: [{ id: 'melody-note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
      },
    ];
    const saved = new MemoryStorage();
    expect(saveProject(removeTrack(project, bass.id), saved)).toBe(true);
    const reopened = loadProject(project.id, saved)!;
    _resetIdCounter();
    const next = duplicateTrack(reopened, melody.id);
    const clips = next.tracks.flatMap((t) => t.clips);
    const link = clips.find((clip) => clip.id === 'melody-link')!;
    expect(link.aliasOf).toBeUndefined();
    expect(expandClip(link, clips).notes).toEqual([]);
  });

  it('selects the master when the last instrument or drum track is removed', () => {
    for (const name of ['Chords', 'Bass', 'Melody']) useStore.getState().removeTrack(idOf(name));
    const drums = idOf('Drums');
    useStore.getState().selectTrack(drums);
    useStore.getState().removeTrack(drums);
    expect(names()).toEqual(['Master']);
    expect(useStore.getState().editor.selectedTrackId).toBe(idOf('Master'));
  });

  it('moves the selection off a track that Undo or Redo removes', () => {
    const id = useStore.getState().addTrack('instrument');
    expect(useStore.getState().editor.selectedTrackId).toBe(id);
    useStore.getState().undo();
    expect(useStore.getState().editor.selectedTrackId).toBe(idOf('Chords'));
    expect(useStore.getState().editor.selectedClipId).toBe(
      useStore.getState().project.tracks[0]?.clips[0]?.id,
    );

    useStore.getState().redo();
    const melody = idOf('Melody');
    useStore.getState().selectTrack(melody);
    useStore.getState().removeTrack(melody);
    useStore.getState().selectTrack(id);
    useStore.getState().undo(); // brings Melody back; the selected added track stays
    expect(useStore.getState().editor.selectedTrackId).toBe(id);
    useStore.getState().redo(); // removes Melody again, the selection is untouched
    expect(useStore.getState().editor.selectedTrackId).toBe(id);
  });

  it('refuses a role that does not suit the track type', () => {
    const drums = idOf('Drums');
    const bass = idOf('Bass');
    useStore.getState().setTrackRole(drums, 'bass');
    useStore.getState().setTrackRole(bass, 'drums');
    const tracks = useStore.getState().project.tracks;
    expect(tracks.find((t) => t.id === drums)?.role).toBe('drums');
    expect(tracks.find((t) => t.id === bass)?.role).toBe('bass');
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('clears the role with null', () => {
    const bass = idOf('Bass');
    useStore.getState().setTrackRole(bass, null);
    expect(useStore.getState().project.tracks.find((t) => t.id === bass)?.role).toBeUndefined();
  });

  it('adds and removes tracks while playing without throwing', async () => {
    const { initAudioBridge } = await import('../src/audio/playback');
    const teardown = initAudioBridge();
    schedulerStarts.length = 0;
    try {
      useStore.getState().play();
      await vi.waitFor(() => expect(schedulerStarts).toHaveLength(1));

      expect(() => {
        const id = useStore.getState().addTrack('drum');
        useStore.getState().duplicateTrack(idOf('Bass'));
        useStore.getState().removeTrack(idOf('Melody'));
        useStore.getState().removeTrack(id);
        useStore.getState().undo();
      }).not.toThrow();
      expect(useStore.getState().transport.isPlaying).toBe(true);
    } finally {
      useStore.getState().stop();
      teardown();
    }
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

  it('loopRangeOn sets the range in one undo step and turns loop on; the same range adds no step', () => {
    useStore.setState((s) => ({ transport: { ...s.transport, loopEnabled: false } }));
    useStore.getState().loopRangeOn({ startBeat: 16, endBeat: 32 });
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 16, endBeat: 32 });
    expect(useStore.getState().transport.loopEnabled).toBe(true);
    expect(useStore.getState().past).toHaveLength(1);

    useStore.getState().loopRangeOn({ startBeat: 16, endBeat: 32 });
    expect(useStore.getState().past).toHaveLength(1);
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

describe('ゴーストノートと色分けの UI 状態(US-017)', () => {
  it('トラックごとの表示を切り替えられ、保存データ(project)は変わらない', async () => {
    const { useStore } = await import('../src/state/store');
    const s = useStore.getState();
    s.createNewProject('ゴースト');
    const project = useStore.getState().project;
    expect(useStore.getState().editor.ghostHiddenTrackIds).toEqual([]);
    useStore.getState().toggleGhostTrack('t1');
    expect(useStore.getState().editor.ghostHiddenTrackIds).toEqual(['t1']);
    useStore.getState().toggleGhostTrack('t1');
    expect(useStore.getState().editor.ghostHiddenTrackIds).toEqual([]);
    expect(useStore.getState().project).toBe(project);
  });
  it('色分けモードを選べる(既定は plain)', async () => {
    const { useStore } = await import('../src/state/store');
    expect(useStore.getState().editor.noteColorMode).toBe('plain');
    useStore.getState().setNoteColorMode('velocity');
    expect(useStore.getState().editor.noteColorMode).toBe('velocity');
    useStore.getState().setNoteColorMode('plain');
  });
});

describe('writing MIDI recordings', () => {
  async function prepareTake(clipStartBeat = 4, lengthBeats = 4) {
    const actions = await import('../src/state/editorActions');
    const store = useStore.getState();
    const trackId = store.project.tracks.find((track) => track.type === 'instrument')!.id;
    const clip: Clip = {
      id: 'destination', trackId, type: 'midi', startBeat: clipStartBeat, lengthBeats, loop: false,
      notes: [{ id: 'existing', pitch: 55, startBeat: 3, durationBeats: 0.25, velocity: 90 }],
    };
    store.applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id === trackId ? { ...track, clips: [clip] } : track),
    }));
    store.selectTrack(trackId);
    store.selectClip(clip.id);
    return {
      ...actions, trackId, clip,
      target: actions.selectedRecordingTarget(0)!,
      savedClip: () => useStore.getState().project.tracks.find((track) => track.id === trackId)!.clips[0]!,
    };
  }

  const note = (midi: number, start: number, end: number) => [
    { timeBeat: start, midi, velocity: 100, on: true },
    { timeBeat: end, midi, velocity: 0, on: false },
  ];
  const toastMessages = async () => (await import('../src/state/tutorialBridge')).getBridgeSnapshot()
    .toasts.map((toast) => toast.message);

  it('wraps a press just before the loop end to the loop start and saves both notes in one undo step', async () => {
    const { target, savedClip, writeRecordingTake } = await prepareTake(0, 16);
    const before = useStore.getState();
    expect(writeRecordingTake(target, [...note(60, 0.5, 0.9), ...note(62, 3.95, 4.3)], {
      mode: 'replace', grid: 0.5, loopRange: { startBeat: 0, endBeat: 4 }, stopBeat: 4.4,
    })).toBe(true);
    expect(savedClip().notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pitch: 60, startBeat: 0.5, durationBeats: 0.4 }),
      expect.objectContaining({ pitch: 62, startBeat: 0, durationBeats: 0.35 }),
    ]));
    expect(savedClip().notes).toHaveLength(2);
    expect(useStore.getState().past).toHaveLength(before.past.length + 1);
  });

  it('cuts notes at the clip end and reports starts outside either edge', async () => {
    const { target, savedClip, writeRecordingTake } = await prepareTake();
    expect(writeRecordingTake(target, [
      ...note(58, 3.75, 4.25), ...note(60, 4.5, 4.9), ...note(62, 8 - 1 / PPQ, 8.2), ...note(64, 8, 8.5),
    ], { mode: 'replace', grid: 0, stopBeat: 9 })).toBe(true);
    expect(savedClip().notes).toEqual([
      expect.objectContaining({ pitch: 60, startBeat: 0.5, durationBeats: 0.4 }),
      expect.objectContaining({ pitch: 62, startBeat: 4 - 1 / PPQ, durationBeats: 1 / PPQ }),
    ]);
    expect(await toastMessages()).toContain('2 音はクリップの外だったので入れませんでした。');
  });

  it('keeps notes that swing delays on a muted track at their written place', async () => {
    const { clip, trackId, savedClip, selectedRecordingTarget, writeRecordingTake } = await prepareTake();
    useStore.getState().applyProjectChange((project) => ({
      ...project, swing: 50, tracks: project.tracks.map((track) =>
        track.id === trackId ? { ...track, mute: true } : track),
    }));
    // 7.75 is an off-beat 16th: swing 50 moves it to 7.875, still inside the clip (ends at 8).
    expect(writeRecordingTake(selectedRecordingTarget(4)!, [
      ...note(60, 4.25, 4.5), ...note(62, 4.5, 4.75), ...note(64, 7.75, 7.9),
    ], { mode: 'replace', grid: 0, stopBeat: 8 })).toBe(true);
    expect(savedClip().notes).toEqual([
      expect.objectContaining({ pitch: 60, startBeat: 0.25 }),
      expect.objectContaining({ pitch: 62, startBeat: 0.5 }),
      expect.objectContaining({ pitch: 64, startBeat: 3.75 }),
    ]);
    const sounds = soundingEvents(useStore.getState().project, { clipId: clip.id, includeMuted: true }).events;
    expect(sounds.map((sound) => sound.startBeat)).toEqual([4.375, 4.5, 7.875]);
  });

  it('keeps all 8 evenly played 16ths at swing 60 with 1/16 quantize', async () => {
    const { clip, savedClip, target, writeRecordingTake } = await prepareTake();
    useStore.getState().applyProjectChange((project) => ({ ...project, swing: 60 }));
    const events = Array.from({ length: 8 }, (_, i) => note(60 + i, 4 + i * 0.25 + 0.02, 4 + i * 0.25 + 0.2)).flat();
    expect(writeRecordingTake(target, events, { mode: 'replace', grid: 0.25, stopBeat: 6.5 })).toBe(true);
    expect(savedClip().notes!.map((n) => n.startBeat)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
    const sounds = soundingEvents(useStore.getState().project, { clipId: clip.id, includeMuted: true }).events;
    expect(sounds.map((sound) => sound.startBeat)).toEqual([4, 4.4, 4.5, 4.9, 5, 5.4, 5.5, 5.9]);
  });

  it('puts a new clip on the bar line and quantizes on the song grid after pausing off the grid', async () => {
    const { clip, selectedRecordingTarget, trackId, writeRecordingTake } = await prepareTake();
    useStore.getState().selectClip(null);
    const target = selectedRecordingTarget(1.1)!;
    expect(target.clipStartBeat).toBe(0);
    expect(writeRecordingTake(target, note(60, 2.02, 2.4), { mode: 'replace', grid: 0.25, stopBeat: 2.6 })).toBe(true);
    const created = useStore.getState().project.tracks.find((track) => track.id === trackId)!.clips
      .find((c) => c.id !== clip.id)!;
    expect(created).toMatchObject({ startBeat: 0, notes: [{ pitch: 60, startBeat: 2 }] });
    const sounds = soundingEvents(useStore.getState().project, { clipId: created.id, includeMuted: true }).events;
    expect(sounds.map((sound) => sound.startBeat)).toEqual([2]);
  });

  it('snaps down to the last grid line inside a 1-beat clip instead of out of it while the loop is longer', async () => {
    const { savedClip, target, writeRecordingTake } = await prepareTake(0, 1);
    expect(writeRecordingTake(target, note(60, 0.9, 0.97), {
      mode: 'replace', grid: 0.5, loopRange: { startBeat: 0, endBeat: 4 }, stopBeat: 1.5,
    })).toBe(true);
    expect(savedClip().notes).toEqual([expect.objectContaining({ pitch: 60, startBeat: 0.5 })]);
  });

  it('clamps a snap to the last grid line before the song end when both the clip and loop extend beyond it', async () => {
    const { target, savedClip, writeRecordingTake } = await prepareTake(0, 8);
    useStore.getState().applyProjectChange((project) => ({ ...project, lengthBars: 1 }));
    expect(writeRecordingTake(target, note(60, 3.92, 4.4), {
      mode: 'replace', grid: 0.25, loopRange: { startBeat: 0, endBeat: 8 }, stopBeat: 4.5,
    })).toBe(true);
    expect(savedClip().notes).toEqual([expect.objectContaining({ pitch: 60, startBeat: 3.75, durationBeats: 0.25 })]);
  });

  it.each([true, false])('shortens the saved note to fit after swing (loop: %s)', async (loop) => {
    const { clip, target, savedClip, writeRecordingTake } = await prepareTake(0, loop ? 4 : 1.5);
    useStore.getState().applyProjectChange((project) => ({ ...project, swing: 60 }));
    expect(writeRecordingTake(target, note(60, 1.25, 1.5), {
      mode: 'replace', grid: 0, loopRange: loop ? { startBeat: 0.5, endBeat: 1.5 } : undefined, stopBeat: 1.5,
    })).toBe(true);
    const written = savedClip().notes![0]!;
    expect(written.startBeat).toBe(1.25);
    expect(written.durationBeats).toBeCloseTo(0.1, 12);
    const [sound] = soundingEvents(useStore.getState().project, { clipId: clip.id }).events;
    if (sound?.kind !== 'note') throw new Error('Expected a sounding note');
    expect(sound.startBeat).toBe(1.4);
    expect(sound.startBeat + sound.durationBeats).toBe(1.5);
  });

  it('drops and counts a swung note with less than one tick left, keeping the rest of the take', async () => {
    const { target, savedClip, writeRecordingTake } = await prepareTake(0, 1.4 + 0.75 / PPQ);
    useStore.getState().applyProjectChange((project) => ({ ...project, swing: 60 }));
    expect(writeRecordingTake(target, [...note(60, 1, 1.1), ...note(62, 1.25, 1.4)], {
      mode: 'replace', grid: 0, stopBeat: 1.45,
    })).toBe(true);
    expect(savedClip().notes!.map((n) => n.pitch)).toEqual([60]);
    expect(await toastMessages()).toContain('1 音はスウィングでクリップやループ、曲の終わりより後ろにずれて鳴らないので入れませんでした。');
  });

  it('cuts a held note at the exact clip end inside a loop even when that end falls between ticks', async () => {
    const end = 1.5 + 0.25 / PPQ;
    const { target, savedClip, writeRecordingTake } = await prepareTake(0, end);
    expect(writeRecordingTake(target, note(60, 1, 1.75), {
      mode: 'replace', grid: 0, loopRange: { startBeat: 0, endBeat: 2 }, stopBeat: 2,
    })).toBe(true);
    expect(1 + savedClip().notes![0]!.durationBeats).toBe(end);
  });

  it('drops and counts a note that swing pushes past the end of a 1-beat loop instead of storing it silent', async () => {
    const { savedClip, target, writeRecordingTake } = await prepareTake(0, 4);
    useStore.getState().applyProjectChange((project) => ({ ...project, swing: 60 }));
    const loopRange = { startBeat: 0.3, endBeat: 1.3 };
    // 1.27 snaps to 1.25, an off-beat 16th: swing 60 plays it at 1.40, past the loop end.
    // 1.02 snaps to 1.00 and sounds in every pass.
    expect(writeRecordingTake(target, [...note(60, 1.02, 1.1), ...note(62, 1.27, 1.29)], {
      mode: 'replace', grid: 0.25, loopRange, stopBeat: 1.3,
    })).toBe(true);
    expect(savedClip().notes).toEqual([expect.objectContaining({ pitch: 60, startBeat: 1 })]);
    expect(await toastMessages()).toContain('1 音はスウィングでクリップやループ、曲の終わりより後ろにずれて鳴らないので入れませんでした。');
  });

  it.each([{ startBeat: 0, endBeat: 1.001 }, { startBeat: 0, endBeat: 0.375 }])(
    'refuses a take over a loop outside the recording domain: %j', async (loopRange) => {
      const { target, writeRecordingTake } = await prepareTake(0, 4);
      const before = useStore.getState();
      expect(writeRecordingTake(target, note(60, 0.25, 0.3), { mode: 'replace', grid: 0.25, loopRange, stopBeat: 0.5 })).toBe(false);
      expect(useStore.getState().project).toBe(before.project);
      expect(await toastMessages()).toContain('ループしながら録音するには、ループを 1 拍以上の長さにして、始まりと終わりを目盛りにそろえてください。');
    },
  );

  it('starts a new clip at the record position when a clip ends between the bar line and it', async () => {
    const { selectedRecordingTarget } = await prepareTake(0, 1);
    useStore.getState().selectClip(null);
    expect(selectedRecordingTarget(2.5)!.clipStartBeat).toBe(2.5);
  });

  it('quantizes into an off-grid clip on the song grid, not on the clip start', async () => {
    const { savedClip, target, writeRecordingTake } = await prepareTake(1.1, 4);
    expect(writeRecordingTake(target, [...note(60, 2.02, 2.4), ...note(62, 1.12, 1.3)], {
      mode: 'replace', grid: 0.25, stopBeat: 2.6,
    })).toBe(true);
    // 2.02 → song 2.00 (local 0.9). 1.12 rounds to 1.00, before the clip: first grid line inside is 1.25.
    expect(savedClip().notes!.map((n) => [n.pitch, beatTick(1.1 + n.startBeat)])).toEqual([
      [62, beatTick(1.25)], [60, beatTick(2)],
    ]);
  });

  it('keeps a playable note in every seeded take and writes only notes that sound (swung) as written', async () => {
    const random = groovePrng(0x250eed);
    for (let sequence = 0; sequence < 100; sequence++) {
      const { clip, savedClip, selectedRecordingTarget, writeRecordingTake } = await prepareTake(1, 4);
      const loopRange = sequence % 2 ? { startBeat: 1.125, endBeat: 4.875 } : undefined;
      const grid = ([0, 0.25, 0.5] as const)[sequence % 3]!;
      useStore.getState().applyProjectChange((project) => ({
        ...project, swing: sequence % 4 >= 2 ? 50 : 0,
        tracks: project.tracks.map((track) => track.id === clip.trackId ? { ...track, mute: sequence % 5 === 0 } : track),
      }));
      const events = [
        ...note(60, loopRange?.startBeat ?? 1.5, 1.75),
        ...Array.from({ length: 12 }, (_, i) => {
          const start = random() * 10;
          return note(61 + i, start, start + random());
        }).flat(),
      ];
      expect(writeRecordingTake(selectedRecordingTarget(1)!, events, { mode: 'replace', grid, loopRange, stopBeat: 11 }),
        `sequence ${sequence}`).toBe(true);
      const notes = savedClip().notes!;
      expect(notes.some(({ pitch }) => pitch === 60)).toBe(true);
      const sounds = soundingEvents(useStore.getState().project, { clipId: clip.id, includeMuted: true }).events;
      expect(sounds).toHaveLength(notes.length);
      const swing = useStore.getState().project.swing ?? 0;
      for (const sound of sounds) {
        expect(sound.kind).toBe('note');
        if (sound.kind !== 'note') continue;
        const written = notes[sound.sourceIndex]!;
        const swung = swingBeat(clip.startBeat + written.startBeat, swing);
        expect(beatTick(sound.startBeat)).toBe(beatTick(swung));
        expect(beatTick(sound.startBeat + sound.durationBeats))
          .toBe(Math.min(beatTick(swung + written.durationBeats), beatTick(clip.startBeat + clip.lengthBeats)));
        expect(written.durationBeats).toBeGreaterThanOrEqual(1 / PPQ);
        expect(sound.pitch).toBe(written.pitch);
        expect(sound.velocity).toBe(written.velocity);
      }
    }
  });

  it('keeps 240 seeded recording attempts tick-aligned, audible in each pass and undoable in one step', async () => {
    const { captureLiveNote, initAudioBridge, recordingTrackId, startMidiRecording, stopMidiRecording } =
      await import('../src/audio/playback');
    const { buildScheduleEvents } = await import('../src/audio/events');
    const { nextEventsInWindow } = await import('../src/audio/scheduler');
    const random = groovePrng(0x25f00d);
    const tick = (beat: number) => beatTick(beat) / PPQ;
    let now = 50_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const teardown = initAudioBridge();
    useStore.getState().setStartScreenOpen(false);
    try {
      for (let sequence = 0; sequence < 240; sequence++) {
        const newClip = sequence % 2 === 0;
        const offTick = !newClip && sequence % 5 === 0;
        const looping = Math.floor(sequence / 6) % 2 === 1;
        const shortSong = looping && Math.floor(sequence / 12) % 2 === 0;
        const recordStart = tick(shortSong ? 13 + random() : random() * 16);
        const clipLength = tick(shortSong ? 3.5 + random() * 0.5 : 1 + random() * 3);
        const { clip, trackId } = await prepareTake(
          newClip ? 40 : recordStart + (offTick ? 0.25 / PPQ : 0), newClip ? 4 : clipLength,
        );
        const grid = ([0, 0.5, 0.25] as const)[Math.floor(sequence / 2) % 3]!;
        const swing = 50 + Math.floor(random() * 11);
        const loopStart = tick(recordStart + 0.01 + random() * 0.4);
        const loopRange = looping
          ? { startBeat: loopStart, endBeat: shortSong ? 16.75 : tick(loopStart + 1 + random() * 2) }
          : undefined;
        const store = useStore.getState();
        store.applyProjectChange((project) => ({ ...project, lengthBars: shortSong ? 4 : 16, swing }));
        if (loopRange) store.loopRangeOn(loopRange);
        else if (store.transport.loopEnabled) store.toggleLoop();
        if (newClip) store.selectClip(null);
        store.setPosition(recordStart);
        useStore.setState({ past: [], future: [] }); // stay below the history cap
        const before = useStore.getState();
        const label = `sequence ${sequence}, new=${newClip}, grid=${grid}, swing=${swing}, loop=${JSON.stringify(loopRange)}`;
        now = 50_000;
        startMidiRecording({ mode: 'replace', grid });
        if (offTick) {
          expect(recordingTrackId(), label).toBeUndefined();
          expect(useStore.getState().transport.isPlaying, label).toBe(false);
          expect(useStore.getState().project, label).toBe(before.project);
          expect(await toastMessages()).toContain('録音するには、クリップの始まりを目盛りにそろえてください。');
          continue;
        }
        expect(recordingTrackId(), label).toBe(trackId);
        await Promise.resolve(); // install the count-in clock after audio initialization
        const start = loopRange?.startBeat ?? recordStart;
        const eventTime = (beat: number) => 52_000 + (beat - start) * 500;
        // An even 8th safely inside the clip and loop is immune to swing.
        const anchor = Math.ceil(start / 0.5) * 0.5;
        const events = [
          ...note(59, start - 0.04, start + 0.1),
          ...note(60, anchor, anchor + 0.2),
          ...Array.from({ length: 12 }, (_, i) => {
            const played = recordStart - 1 + random() * 9;
            return note(61 + i, played, played + random());
          }).flat(),
        ].map((e) => ({
          ...e, timeStamp: eventTime(e.timeBeat), delivered: eventTime(e.timeBeat) + 50 + random() * 150,
        })).sort((a, b) => a.delivered - b.delivered);
        for (const e of events) {
          now = e.delivered;
          captureLiveNote(e.midi, e.on, e.velocity, e.timeStamp);
        }
        now = eventTime(recordStart + 9.5);
        stopMidiRecording();

        const after = useStore.getState();
        expect(after.past, label).toHaveLength(before.past.length + 1);
        const saved = after.project.tracks.find((track) => track.id === trackId)!.clips
          .find((c) => newClip ? c.id !== clip.id : c.id === clip.id)!;
        const notes = saved.notes!;
        expect(notes.some(({ pitch }) => pitch === 60), label).toBe(true);
        expect(notes.some(({ pitch }) => pitch === 59), label).toBe(false);
        if (newClip) expect(beatTick(saved.startBeat) % beatTick(4), label).toBe(0);
        if (grid) {
          for (const written of notes) {
            expect(beatTick(saved.startBeat + written.startBeat) % beatTick(grid), `${label}, note ${written.pitch}`).toBe(0);
          }
        }
        const songEnd = songEndBeat(after.project);
        const effectiveEnd = Math.min(saved.startBeat + saved.lengthBeats, loopRange?.endBeat ?? Infinity, songEnd);
        const period = loopRange ? loopRange.endBeat - loopRange.startBeat : 0;
        const pitches = new Set(notes.map((n) => n.pitch));
        const scheduled = buildScheduleEvents(after.project, undefined, loopRange)
          .map(({ beat, payload }) => ({ beat, payload: payload as SchedulePayload }))
          .filter(({ payload }) => payload.kind === 'note' && payload.trackId === trackId && pitches.has(payload.pitch));
        expect(scheduled, label).toHaveLength(notes.length);
        for (const { beat, payload } of scheduled) {
          if (payload.kind !== 'note') throw new Error(label);
          const written = notes.find((n) => n.pitch === payload.pitch)!;
          expect(beat, label).toBe(swingBeat(saved.startBeat + written.startBeat, swing));
          expect(beat + written.durationBeats, label).toBeLessThanOrEqual(effectiveEnd + 1e-12);
          expect(payload.durationBeats, label).toBeGreaterThanOrEqual(1 / PPQ - 1e-12);
        }
        for (let pass = 0; pass < (loopRange ? 3 : 1); pass++) {
          const offset = pass * period;
          const passStart = (loopRange?.startBeat ?? 0) + offset;
          const passEnd = (loopRange?.endBeat ?? songEnd) + offset;
          // At 60 BPM scheduler time is the unwrapped beat.
          const due = nextEventsInWindow(scheduled, passStart, passEnd, 60, 0, 0, loopRange ?? null);
          expect(due, label).toHaveLength(notes.length);
          for (const event of scheduled) {
            const sound = due.find((entry) => entry.payload === event.payload);
            if (!sound || event.payload.kind !== 'note') throw new Error(label);
            expect(sound.time, label).toBeGreaterThanOrEqual(passStart);
            expect(sound.time + event.payload.durationBeats, label).toBeLessThanOrEqual(effectiveEnd + offset + 1e-12);
          }
        }
        useStore.getState().undo();
        expect(useStore.getState().project, label).toBe(before.project);
      }
    } finally {
      teardown();
      clock.mockRestore();
    }
  });

  it.each(['replace', 'overdub'] as const)('writes %s in clip-relative beats and undoes the whole take once', async (mode) => {
    const { clip, target, savedClip, writeRecordingTake } = await prepareTake();
    const before = useStore.getState();
    expect(writeRecordingTake(target, [
      { timeBeat: 4.31, midi: 67, velocity: 103, on: true },
      { timeBeat: 4.81, midi: 67, velocity: 0, on: false },
    ], { mode, grid: 0.25, stopBeat: 5 })).toBe(true);
    expect(useStore.getState().past).toHaveLength(before.past.length + 1);
    const notes = savedClip().notes!;
    expect(notes.some((note) => note.id === 'existing')).toBe(mode === 'overdub');
    expect(notes.at(-1)).toMatchObject({ pitch: 67, startBeat: 0.25, durationBeats: 0.5, velocity: 103 });
    useStore.getState().undo();
    expect(savedClip()).toEqual(clip);
  });

  it('creates a clip on the selected instrument when no clip is selected', async () => {
    const { selectedRecordingTarget, trackId, writeRecordingTake } = await prepareTake();
    const store = useStore.getState();
    store.selectClip(null);
    const target = selectedRecordingTarget(8)!;
    const before = useStore.getState();
    expect(writeRecordingTake(target, [
      { timeBeat: 8.25, midi: 60, velocity: 100, on: true },
    ], { mode: 'overdub', grid: 0, stopBeat: 9 })).toBe(true);
    const after = useStore.getState();
    const clips = after.project.tracks.find((track) => track.id === trackId)!.clips;
    expect(clips).toHaveLength(2);
    expect(clips[1]).toMatchObject({ startBeat: 8, lengthBeats: 1, notes: [{ pitch: 60, startBeat: 0.25, durationBeats: 0.75 }] });
    expect(after.editor.selectedClipId).toBe(clips[1]!.id);
    expect(after.past).toHaveLength(before.past.length + 1);
  });

  it('keeps an open-ended new clip inside the gap when recording continues past the next clip', async () => {
    const { selectedRecordingTarget, trackId, writeRecordingTake } = await prepareTake();
    useStore.getState().selectClip(null);
    expect(writeRecordingTake(selectedRecordingTarget(2)!, [
      ...note(60, 3.75, 4.25), ...note(62, 4.5, 5),
    ], { mode: 'overdub', grid: 0, stopBeat: 6 })).toBe(true);
    const clips = useStore.getState().project.tracks.find((track) => track.id === trackId)!.clips;
    expect(clips).toHaveLength(2);
    // Started at beat 2: the new clip snaps down to the bar line at 0 and fills the gap up to 4.
    expect(clips[1]).toMatchObject({
      startBeat: 0, lengthBeats: 4, notes: [{ pitch: 60, startBeat: 3.75, durationBeats: 0.25 }],
    });
    expect(await toastMessages()).toContain('1 音はクリップの外だったので入れませんでした。');
  });

  it('saves the notes that fit when the song has room for only part of the take', async () => {
    const { clip, trackId, savedClip, selectedRecordingTarget, writeRecordingTake } = await prepareTake();
    const period = 1 / 64;
    const loopClip: Clip = {
      ...clip, id: 'sound-budget-loop', startBeat: 8, lengthBeats: 11_111 * period,
      loop: true, contentLengthBeats: period,
      notes: Array.from({ length: 9 }, (_, index) => ({
        id: `sound-budget-${index}`, pitch: 70, startBeat: 0, durationBeats: period, velocity: 100,
      })),
    };
    expect(useStore.getState().applyProjectChange((project) => ({
      ...project, lengthBars: 48,
      tracks: project.tracks.map((track) => ({
        ...track, clips: track.id === trackId ? [clip, loopClip] : [],
      })),
    }))).toBe(true);
    expect(writeRecordingTake(selectedRecordingTarget(4)!, [...note(60, 4.5, 5), ...note(62, 5.5, 6)], {
      mode: 'replace', grid: 0, stopBeat: 6.5,
    })).toBe(true);
    expect(savedClip().notes).toEqual([expect.objectContaining({ pitch: 60 })]);
    expect(await toastMessages()).toContain('1 音は曲に入れられる音の上限に達したので入れませんでした。');
  });

  it.each(['linked', 'looping'] as const)(
    'leaves the project and undo history untouched when the take is %s',
    async (condition) => {
      const { clip, trackId, target, writeRecordingTake } = await prepareTake();
      const store = useStore.getState();
      store.applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track) => track.id !== trackId ? track : {
          ...track,
          clips: [
            { ...clip, loop: condition === 'looping' },
            ...(condition === 'linked' ? [{ ...clip, id: 'linked-recording', notes: [], startBeat: 8, aliasOf: clip.id }] : []),
          ],
        }),
      }));
      const before = useStore.getState();
      const timeBeat = 4.25;
      expect(writeRecordingTake(target, [{ timeBeat, midi: 60, velocity: 100, on: true }], {
        mode: 'replace', grid: 0, stopBeat: timeBeat + 0.5,
      })).toBe(false);
      expect(useStore.getState().project).toBe(before.project);
      expect(useStore.getState().past).toBe(before.past);
    },
  );
});
