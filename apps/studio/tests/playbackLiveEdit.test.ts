import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrumClip, createMidiClip, type Clip, type DrumEvent, type Project } from '@cts/project-model';
import type { TrackGraph } from '../src/audio/graph';

// US-012b (wave5 playbackLiveEdit) invariants checked against main's playback.
// A clip-layout or tempo edit stops playback (hasPlaybackTopologyChanged);
// note-content edits are applied to the running session (G1-G4). Real
// Scheduler on a hand-driven audio clock; the synth mock records what is
// actually triggered and what is released/disposed.
const rec = vi.hoisted(() => ({
  now: 10,
  notes: [] as Array<{ pitch: number; start: number; duration: number }>,
  disposed: 0,
  released: 0,
  releasedVoices: [] as Array<{ pitch: number; start: number; when: number }>,
  drums: [] as Array<{ lane: string; time: number; velocity: number }>,
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
      return { pitch, start };
    });
    releaseVoice = vi.fn((handle: { pitch: number; start: number }, when: number) => {
      rec.releasedVoices.push({ ...handle, when });
    });
    releaseAll = vi.fn(() => { rec.released += 1; });
    dispose = vi.fn(() => { rec.disposed += 1; });
  },
}));

vi.mock('../src/audio/drums', () => ({
  createNoiseBuffer: () => ({}),
  DrumVoiceManager: class {
    trigger = vi.fn((lane: string, time: number, velocity: number) => {
      rec.drums.push({ lane, time, velocity });
    });
    dispose = vi.fn();
  },
}));

vi.mock('../src/audio/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/events')>();
  return { ...actual, buildScheduleEvents: vi.fn(actual.buildScheduleEvents) };
});

import { buildScheduleEvents } from '../src/audio/events';
import { applyRuntimeScheduleContentEdit, initAudioBridge } from '../src/audio/playback';
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
  rec.releasedVoices.length = 0;
  rec.drums.length = 0;
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

describe('note-content edit while playing (US-012b)', () => {
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

  it('削除した未再生ノートは鳴らない - docs/05 G1', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62));
    await runFor(6);

    expect(count(62)).toBe(0);
    expect(count(64)).toBe(1);
  });

  it('再生ヘッドより先に追加したノートが同じパスで鳴る - docs/05 G2', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(1);

    editNotes((ns) => ns.concat([newNote(71, 5)]));
    await runFor(6);

    expect(count(71)).toBe(1);
    // Beat 5 at 120 bpm is 2.5 s after the 10 s start.
    expect(rec.notes.find((n) => n.pitch === 71)?.start).toBeCloseTo(12.5, 6);
    expect(count(62)).toBe(1);
  });

  it('鳴っている最中のノートを削除すると短いリリースで止まる - docs/05 G3', async () => {
    setClips([melody([[60, 0, 1], [62, 2, 6]])]);
    await play();
    await runFor(2);
    expect(count(62)).toBe(1);
    const editAt = rec.now;

    editNotes((ns) => ns.filter((n) => n.pitch !== 62));
    await runFor(0.1);

    const released = rec.releasedVoices.filter((v) => v.pitch === 62);
    expect(released).toHaveLength(1);
    // Released at the next tick with the synth's soft release, not a hard dispose.
    expect(released[0]!.when).toBeGreaterThanOrEqual(editAt);
    expect(released[0]!.when).toBeLessThan(editAt + 0.1);
    expect(rec.disposed).toBe(0);
    expect(rec.released).toBe(0);
    expect(rec.releasedVoices.filter((v) => v.pitch !== 62)).toHaveLength(0);
    expect(store().transport.phase).toBe('playing');
  });

  it('先読み済みのノートも差分で取り消し・追加し、未変更のノートは鳴らし直さない - docs/05 G1/G2', async () => {
    setClips([melody([[60, 0, 1], [62, 4, 1], [64, 4, 1]])]);
    await play();
    await runFor(1);
    // 11.9 s: the 120 ms lookahead has already handed beat 4 (12.0 s) to the synth.
    rec.now = 11.9;
    await vi.advanceTimersByTimeAsync(50);
    expect(rec.notes.filter((n) => n.start === 12)).toHaveLength(2);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62).concat([newNote(71, 3.95)]));
    await vi.advanceTimersByTimeAsync(0);

    expect(rec.releasedVoices).toEqual([{ pitch: 62, start: 12, when: 11.9 }]);
    expect(count(71)).toBe(1);
    expect(count(64)).toBe(1);
    await runFor(1);
    expect(count(64)).toBe(1);
    expect(count(71)).toBe(1);
  });

  it('再生の準備中に消したノートも、再生が始まったら鳴らない - live-edit fix A', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    store().play();
    expect(store().transport.phase).toBe('starting');
    editNotes((ns) => ns.filter((n) => n.pitch !== 62));
    await vi.advanceTimersByTimeAsync(50);
    expect(store().transport.phase).toBe('playing');

    await runFor(6);

    expect(count(62)).toBe(0);
    expect(count(60)).toBe(1);
    expect(count(64)).toBe(1);
  });

  it('同じ音のノートが2つ鳴っている時に1つ消すと、1つだけ止まる - live-edit fix C', async () => {
    setClips([melody([[62, 0, 4], [62, 0, 4]])]);
    await play();
    await runFor(1);
    expect(count(62)).toBe(2);

    editNotes((ns) => ns.filter((n) => n.id !== 'n1'));
    await runFor(0.1);

    expect(rec.releasedVoices).toHaveLength(1);
    expect(rec.releasedVoices[0]!.pitch).toBe(62);
  });

  it('隣の編集でスイングの切り詰めが変わっても、鳴っているノートは止めない - live-edit fix C', async () => {
    store().applyProjectChange((p) => ({ ...p, swing: 50 }));
    setClips([melody([[60, 0.25, 4.25]])]);
    await play();
    await runFor(1.5);
    expect(count(60)).toBe(1);

    editNotes((ns) => ns.concat([newNote(60, 4.5)]));
    await runFor(3);

    expect(rec.releasedVoices).toHaveLength(0);
    expect(count(60)).toBe(2);
  });

  it('鳴っているノートの強さや長さだけを変えても止めず、鳴らし直さない - live-edit fix C', async () => {
    setClips([melody([[62, 0, 4]])]);
    await play();
    await runFor(1);

    editNotes((ns) => ns.map((n) => ({ ...n, velocity: 40, durationBeats: 3 })));
    await runFor(0.5);

    expect(rec.releasedVoices).toHaveLength(0);
    expect(count(62)).toBe(1);
  });

  it('鳴っているノートの高さを変えると止めて、新しい高さは次の音から - live-edit fix C', async () => {
    setClips([melody([[62, 0, 4]])]);
    await play();
    await runFor(1);

    editNotes((ns) => ns.map((n) => ({ ...n, pitch: 65 })));
    await runFor(0.1);

    expect(rec.releasedVoices.map((v) => v.pitch)).toEqual([62]);
    expect(count(65)).toBe(0);
  });

  it('先読み済みのドラムは差分を取らず、先読みより後のドラム編集だけが反映される - live-edit fix D', async () => {
    const drumTrack = store().project.tracks.find((t) => t.type === 'drum');
    if (!drumTrack) throw new Error('no drum track');
    const hits = (events: Array<[number, number]>): DrumEvent[] =>
      events.map(([stepIndex, velocity]) => ({ id: `d${stepIndex}`, lane: 'kick', stepIndex, velocity }));
    store().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.id === drumTrack.id
          ? [{ ...createDrumClip(t.id, 0, 8), id: 'drum-live', drumEvents: hits([[8, 100], [16, 100]]) }]
          : [],
      })),
    }));
    useStore.setState({ past: [], future: [] });
    await play();
    await runFor(0.5);
    // 10.9 s: the look-ahead has already handed the step-8 kick (beat 2, 11.0 s) over.
    rec.now = 10.9;
    await vi.advanceTimersByTimeAsync(50);
    expect(rec.drums.map((d) => d.time)).toEqual([11]);

    store().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (
          c.id === 'drum-live' ? { ...c, drumEvents: hits([[8, 40], [20, 100]]) } : c
        )),
      })),
    }));
    await runFor(3);

    // No second hit for the re-voiced step 8; step 16 removed; step 20 (12.5 s) added.
    expect(rec.drums.map((d) => d.time)).toEqual([11, 12.5]);
    expect(rec.drums[0]!.velocity).toBe(100);
  });

  it('曲末の直前に最後のノートを消しても、もう鳴っているディレイの残響を切らない - live-edit fix E', async () => {
    const end = store().project.lengthBeats;
    const id = melodyId();
    store().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        effects: t.id === id
          ? [{ id: 'fx', type: 'delay' as const, enabled: true, params: { delayTime: 1, feedback: 0.8, mix: 1 } }]
          : t.effects,
        clips: t.id === id ? [{ ...melody([[60, end - 1, 1]], 0, end), trackId: id }] : [],
      })),
    }));
    useStore.setState((s) => ({ past: [], future: [], transport: { ...s.transport, positionBeat: end - 2 } }));
    await play();
    await runFor(0.9);
    expect(count(60)).toBe(1);

    editNotes(() => []);
    await runFor(1.5);

    // The song ended at 1.0 s; the delay tail keeps the graph alive past 2.4 s.
    expect(store().transport.phase).toBe('stopped');
    expect(rec.disposed).toBe(0);
  });

  it('トラック名の変更(updatedAtだけが変わる編集)ではスケジュールを作り直さない - live-edit fix F', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    await play();
    await runFor(0.5);
    const builds = vi.mocked(buildScheduleEvents).mock.calls.length;
    const id = melodyId();

    store().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === id ? { ...t, name: 'メロディ2' } : t)),
    }));
    await runFor(0.5);

    expect(store().transport.phase).toBe('playing');
    expect(vi.mocked(buildScheduleEvents).mock.calls.length).toBe(builds);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62));
    await runFor(0.1);
    expect(vi.mocked(buildScheduleEvents).mock.calls.length).toBe(builds + 1);
  });

  it('ループの2周が重なって鳴る長いノートは、別の高さのノートを消しても止めない - live-edit fix H', async () => {
    setClips([melody([[60, 0, 8], [64, 1, 1]], 0, 8)]);
    store().setLoopRange(0, 4);
    await play();
    await runFor(2.5);
    // Passes start at 10 s and 12 s; both 8-beat voices of pitch 60 are sounding.
    expect(rec.notes.filter((n) => n.pitch === 60).map((n) => n.start)).toEqual([10, 12]);

    editNotes((ns) => ns.filter((n) => n.pitch !== 64));
    await runFor(0.1);

    // Only the deleted pitch may be released; both pitch-60 voices keep sounding.
    expect(rec.releasedVoices.filter((v) => v.pitch === 60)).toEqual([]);
  });

  it('ループの2周が重なって鳴る長いノートそのものを消すと、両方の周の音を止める - live-edit fix H2', async () => {
    setClips([melody([[60, 0, 8], [64, 1, 1]], 0, 8)]);
    store().setLoopRange(0, 4);
    await play();
    await runFor(2.5);
    expect(rec.notes.filter((n) => n.pitch === 60).map((n) => n.start)).toEqual([10, 12]);

    editNotes((ns) => ns.filter((n) => n.pitch !== 60));
    await runFor(0.1);

    expect(rec.releasedVoices.filter((v) => v.pitch === 60)).toHaveLength(2);
  });

  it('再生の準備中にトラック名だけを変えても、開始時に作り直さない - live-edit fix A (critic minor 1)', async () => {
    setClips([melody(TWO_NOTES_THEN_TAIL)]);
    const before = vi.mocked(buildScheduleEvents).mock.calls.length;
    store().play();
    const id = melodyId();
    store().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === id ? { ...t, name: 'メロディ2' } : t)),
    }));
    await vi.advanceTimersByTimeAsync(50);
    expect(store().transport.phase).toBe('playing');

    // Exactly one build: the startup schedule.
    expect(vi.mocked(buildScheduleEvents).mock.calls.length).toBe(before + 1);
  });

  it('ループ再生中のノート編集が次のパスで聞こえる - docs/05 G4', async () => {
    setClips([melody([[60, 0, 1], [62, 2, 1]], 0, 4)]);
    store().setLoopRange(0, 4);
    await play();
    await runFor(1.5);

    editNotes((ns) => ns.filter((n) => n.pitch !== 62).concat([newNote(71, 3)]));
    await runFor(3);

    // One pass is 2 s: passes start at 10 s, 12 s and 14 s. The second pass
    // (12-14 s) is the first one scheduled entirely after the edit.
    const afterEdit = rec.notes.filter((n) => n.start > 11.6);
    expect(afterEdit.filter((n) => n.pitch === 62)).toHaveLength(0);
    expect(afterEdit.filter((n) => n.pitch === 71).map((n) => n.start))
      .toEqual([expect.closeTo(13.5, 6)]);
    expect(count(60)).toBe(3);
  });
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

  it.todo('クリップの移動・削除・テンポ変更後も再生が止まらず即時に反映される(main は停止する設計) - docs/05 §6.1.6.1 G5');
});

describe('live-edit session state stays bounded (live-edit fix I)', () => {
  /** Sizes of every collection a session holds, keyed by field name. */
  const collectionSizes = (session: Record<string, unknown>): Record<string, number> =>
    Object.fromEntries(Object.entries(session).flatMap(([key, value]) => (
      Array.isArray(value) ? [[key, value.length]]
        : value instanceof Set || value instanceof Map ? [[key, value.size]]
          : []
    )));

  it('1000回ドラッグしても、セッションが持つ状態の大きさは変わらない - live-edit fix I', () => {
    setClips([melody([[60, 0, 1]])]);
    const base = store().project;
    const id = melodyId();
    const at = (startBeat: number): Project => ({
      ...base,
      tracks: base.tracks.map((t) => (t.id !== id ? t : {
        ...t,
        clips: t.clips.map((c) => ({ ...c, notes: [{ ...c.notes![0]!, startBeat }] })),
      })),
    });
    const session: Record<string, unknown> = {
      scheduler: { scheduledThroughBeat: 0, replaceEventIndex: vi.fn() },
      loop: null,
      anchorBeat: 0,
      // The audio clock (0) is before the anchor, so nothing is in the look-ahead window.
      anchorTime: 100,
      scheduleEvents: [],
      scheduleProject: base,
      firedVoices: [],
      synths: new Map(),
      planTail: (events: readonly unknown[]) => ({ tailSeconds: events.length, postLimiterTailSeconds: 0.5 }),
      plannedTail: { tailSeconds: 0, postLimiterTailSeconds: 0 },
    };
    const apply = applyRuntimeScheduleContentEdit as unknown as
      (session: Record<string, unknown>, project: Project, now: number) => void;

    apply(session, at(0), 0);
    const first = collectionSizes(session);
    for (let drag = 1; drag <= 1000; drag += 1) apply(session, at(drag * 0.007), 0);

    expect(collectionSizes(session)).toEqual(first);
    expect(session.plannedTail).toEqual({ tailSeconds: 1, postLimiterTailSeconds: 0.5 });
  });
});

