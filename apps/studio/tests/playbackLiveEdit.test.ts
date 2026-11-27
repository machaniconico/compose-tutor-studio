import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMidiClip, type Clip, type Project } from '@cts/project-model';
import type { TrackGraph } from '../src/audio/graph';

// US-012b (wave5 playbackLiveEdit) invariants checked against main's playback.
// Main's design differs: a clip-layout or tempo edit stops playback
// (hasPlaybackTopologyChanged) and note-content edits are not applied to the
// running session. Real Scheduler on a hand-driven audio clock; the synth mock
// records what is actually triggered and what is released/disposed.
const rec = vi.hoisted(() => ({
  now: 10,
  notes: [] as Array<{ pitch: number; start: number; duration: number }>,
  disposed: 0,
  released: 0,
}));

vi.mock('../src/audio/engine', () => {
  const makeParam = () => ({
    value: 1,
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });
  const makeGain = () => ({ gain: makeParam(), connect: vi.fn(), disconnect: vi.fn() });
  const context = {
    sampleRate: 48_000,
    get currentTime() { return rec.now; },
    state: 'running',
    createGain: vi.fn(() => makeGain()),
  } as unknown as AudioContext;
  const master = makeGain() as unknown as GainNode;
  const engine = {
    get audioContext() { return context; },
    contextGeneration: 1,
    ensureContext: async () => ({ context, master, contextGeneration: 1 }),
    now: () => rec.now,
    subscribeStateChange: () => () => undefined,
  };
  return { getAudioEngine: () => engine };
});
vi.mock('../src/audio/audioAssetResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/audioAssetResolver')>();
  return {
    ...actual,
    getAudioAssetPlaybackCache: () => ({
      clearUnused: vi.fn(),
      preflight: vi.fn(async () => ({ assets: [], estimatedDecodedBytes: 0 })),
      retainedDecodedBytes: 0,
    }),
    projectHasReferencedReadyAudioAssets: () => false,
    acquireProjectAudioBuffers: vi.fn(async () => ({
      buffersByAssetId: new Map(),
      release: vi.fn(),
    })),
  };
});
vi.mock('../src/audio/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/graph')>();
  return {
    ...actual,
    assertRoutingGraphNodeBudget: vi.fn(),
    buildTrackGraphs: vi.fn((_c: unknown, _o: unknown, project: Project) =>
      new Map(project.tracks.map((t) => [t.id, {
        input: {} as GainNode,
        scheduleAutomation: vi.fn(),
        schedulePunchAudibility: vi.fn(),
        dispose: vi.fn(),
      }])) as unknown as Map<string, TrackGraph>),
  };
});
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    noteOn = vi.fn((pitch: number, start: number, duration: number) => {
      rec.notes.push({ pitch, start, duration });
    });
    releaseAll = vi.fn(() => { rec.released += 1; });
    dispose = vi.fn(() => { rec.disposed += 1; });
  },
}));

vi.mock('../src/audio/drums', () => ({
  createNoiseBuffer: () => ({}),
  DrumVoiceManager: class {
    trigger = vi.fn();
    dispose = vi.fn();
  },
}));

import { initAudioBridge } from '../src/audio/playback';
import { useStore } from '../src/state/store';

const store = () => useStore.getState();
let teardown = (): void => undefined;
const initialProject = useStore.getState().project;

function melodyId(): string {
  const t = store().project.tracks.find((x) => x.type === 'instrument');
  if (!t) throw new Error('no instrument track');
  return t.id;
}

function setClips(clips: Clip[]): void {
  const id = melodyId();
  store().applyProjectChange((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.id === id ? clips.map((c) => ({ ...c, trackId: id })) : [],
    })),
  }));
  useStore.setState({ past: [], future: [] });
}

function melody(notes: Array<[number, number, number]>, start = 0, length = 8): Clip {
  return {
    ...createMidiClip('x', start, length),
    id: 'clip-live',
    notes: notes.map(([pitch, startBeat, durationBeats], i) => ({
      id: `n${i}`, pitch, startBeat, durationBeats, velocity: 100,
    })),
  };
}

async function play(): Promise<number> {
  store().play();
  const id = store().transport.playbackRequestId;
  await vi.advanceTimersByTimeAsync(50);
  return id;
}

async function runFor(seconds: number): Promise<void> {
  for (let t = 0; t < seconds; t += 0.05) {
    rec.now += 0.05;
    await vi.advanceTimersByTimeAsync(50);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  rec.now = 10;
  rec.notes.length = 0;
  rec.disposed = 0;
  rec.released = 0;
  useStore.setState((s) => ({
    project: initialProject,
    past: [],
    future: [],
    transport: { ...s.transport, phase: 'stopped', isPlaying: false, positionBeat: 0,
      loopEnabled: false, metronome: false, audioIssue: null },
    projectOperationBusy: false,
    audioRecordingOperationId: null,
  }));
  teardown = initAudioBridge();
});
afterEach(() => {
  store().stop(true);
  teardown();
  vi.useRealTimers();
});


function editNotes(fn: (notes: NonNullable<Clip['notes']>) => NonNullable<Clip['notes']>): void {
  store().applyProjectChange((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c, notes: fn(c.notes ?? []) })),
    })),
  }));
}

function moveClips(startBeat: number): void {
  store().applyProjectChange((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c, startBeat })),
    })),
  }));
}

/** Pitches triggered so far, in trigger order. */
const heard = (): number[] => rec.notes.map((n) => n.pitch);
const count = (pitch: number): number => heard().filter((p) => p === pitch).length;

const newNote = (pitch: number, startBeat: number) =>
  ({ id: `new-${pitch}`, pitch, startBeat, durationBeats: 1, velocity: 100 });

// Default tempo is 120 bpm: one beat is 0.5 s.
const TWO_NOTES_THEN_TAIL = [[60, 0, 1], [62, 4, 1], [64, 7, 1]] as Array<[number, number, number]>;

describe('note-content edit while playing (US-012b, main: session keeps its frozen snapshot)', () => {
  it('keeps the same playback session running when a note is deleted', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    const requestId = await play();
    await runFor(1);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62));

    expect(store().transport.phase).toBe('playing');
    expect(store().transport.playbackRequestId).toBe(requestId);
    expect(rec.disposed).toBe(0);
  });

  it('plays each unedited note exactly once after another note is edited', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62).concat([newNote(71, 5)]));
    await runFor(6);

    expect(count(60)).toBe(1);
    expect(count(64)).toBe(1);
  });

  it('does not move the playhead when a note is edited', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);
    const before = store().transport.positionBeat;

    editNotes((ns) => ns.filter((n) => n.pitch !== 62));

    expect(store().transport.positionBeat).toBe(before);
  });

  it('keeps playing and does not retrigger notes when a note edit is undone', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    const requestId = await play();
    await runFor(1);
    editNotes((ns) => ns.filter((n) => n.pitch !== 62));

    store().undo();
    await runFor(6);

    expect(store().transport.playbackRequestId).toBe(requestId);
    expect(count(60)).toBe(1);
    expect(count(62)).toBe(1);
    expect(count(64)).toBe(1);
  });

  it('keeps unedited notes in a loop retriggering once per pass after a note edit', async () => {
    setClips([melody([[60, 0, 1], [62, 2, 1]], 0, 4)]);
    store().setLoopRange(0, 4);
    const requestId = await play();
    await runFor(1);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62).concat([newNote(71, 3)]));
    await runFor(4);

    expect(store().transport.playbackRequestId).toBe(requestId);
    // Passes start at 0 s, 2 s, 4 s and 6 s of the 5 s run.
    expect(count(60)).toBe(3);
  });

  it.todo('削除した未再生ノートは鳴らない(main は再生開始時の凍結スナップショットのまま鳴る) - docs/05 known playback live-edit gaps G1');
  it.todo('再生ヘッドより先に追加したノートが同じパスで鳴る(main は鳴らない) - docs/05 known playback live-edit gaps G2');
  it.todo('鳴っている最中のノートを削除すると解放される(main は鳴り続ける) - docs/05 known playback live-edit gaps G3');
  it.todo('ループ再生中のノート編集が次のパスで聞こえる(main は旧内容を繰り返す) - docs/05 known playback live-edit gaps G4');
});

describe('clip layout and tempo edit while playing (US-012b, main: topology change stops playback)', () => {
  it('stops playback and disposes every voice manager when a clip is moved', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);
    expect(rec.disposed).toBe(0);

    moveClips(1);

    expect(store().transport.phase).toBe('stopped');
    expect(rec.disposed).toBeGreaterThan(0);
  });

  it('stops playback when a clip is deleted', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);

    setClips([]);

    expect(store().transport.phase).toBe('stopped');
  });

  it('triggers no further notes after a clip edit stops playback', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);
    moveClips(1);
    const triggered = rec.notes.length;

    await runFor(6);

    expect(rec.notes).toHaveLength(triggered);
  });

  it('keeps the playhead where it was when a tempo edit stops playback', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);
    const before = store().transport.positionBeat;
    expect(before).toBeGreaterThan(0);

    store().setBpm(90);

    expect(store().transport.phase).toBe('stopped');
    expect(store().transport.positionBeat).toBe(before);
  });

  it('stops playback when undo reverts a clip edit made before play', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    moveClips(1);
    await play();
    await runFor(1);

    store().undo();

    expect(store().transport.phase).toBe('stopped');
  });

  it.todo('クリップの移動・削除・テンポ変更後も再生が止まらず即時に反映される(main は停止する設計) - docs/05 known playback live-edit gaps G5');
});
