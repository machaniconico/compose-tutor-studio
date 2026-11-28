// Acceptance tests for "note edits during playback take effect in the current
// playback" (docs/05 section 6.1.6.1). Written from the user-facing contract and
// the public store API only. The engine, synth, drums and track graphs are
// replaced by recorders; time is driven by hand (fake timers + a manual clock).
//
// Fixture: 120 bpm, so one beat is 0.5 s. Every project carries a short
// "sentinel" note at beat 0 (pitch 40) whose first onset reveals the playback
// anchor in context time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject, type Project } from '@cts/project-model';
import type { AudioAssetBufferLease } from '../../src/audio/audioAssetResolver';
import type { TrackGraph } from '../../src/audio/graph';

type Handle = {
  readonly pitch: number;
  readonly time: number;
  readonly duration: number;
  readonly velocity: unknown;
  readonly seq: number;
};

const rec = vi.hoisted(() => ({
  currentTime: 10,
  contextState: 'running',
  generation: 7,
  listeners: new Set<(state: string) => void>(),
  noteOns: [] as Array<{
    pitch: number;
    time: number;
    duration: number;
    velocity: unknown;
    handle: object;
    calledAt: number;
  }>,
  releases: [] as Array<{ handle: object; args: unknown[]; calledAt: number }>,
  otherCalls: [] as string[],
  context: null as unknown as AudioContext,
  master: null as unknown as GainNode,
}));

vi.hoisted(() => {
  const makeParam = () => ({
    value: 1,
    cancelScheduledValues: () => undefined,
    cancelAndHoldAtTime: () => undefined,
    setValueAtTime: () => undefined,
    setTargetAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
  });
  const makeGain = () => ({ gain: makeParam(), connect: () => undefined, disconnect: () => undefined });
  rec.context = {
    sampleRate: 48_000,
    get currentTime() {
      return rec.currentTime;
    },
    get state() {
      return rec.contextState;
    },
    createGain: () => makeGain(),
  } as unknown as AudioContext;
  rec.master = makeGain() as unknown as GainNode;
});

const assetHarness = vi.hoisted(() => ({
  acquire: vi.fn(),
  preflight: vi.fn(),
  clearUnused: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../src/audio/engine', () => ({
  getAudioEngine: () => ({
    get audioContext() {
      return rec.context;
    },
    get contextGeneration() {
      return rec.generation;
    },
    ensureContext: vi.fn(async () => ({
      context: rec.context,
      master: rec.master,
      contextGeneration: rec.generation,
    })),
    now: () => rec.currentTime,
    subscribeStateChange: (listener: (state: string) => void) => {
      rec.listeners.add(listener);
      return () => rec.listeners.delete(listener);
    },
  }),
}));

vi.mock('../../src/audio/audioAssetResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/audioAssetResolver')>();
  return {
    ...actual,
    getAudioAssetPlaybackCache: () => ({
      clearUnused: assetHarness.clearUnused,
      preflight: assetHarness.preflight,
      retainedDecodedBytes: 0,
    }),
    projectHasReferencedReadyAudioAssets: () => false,
    acquireProjectAudioBuffers: assetHarness.acquire,
  };
});

vi.mock('../../src/audio/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/graph')>();
  return {
    ...actual,
    assertRoutingGraphNodeBudget: vi.fn(),
    buildTrackGraphs: (_ctx: unknown, _dest: unknown, project: Project) =>
      new Map(
        project.tracks.map((track) => [
          track.id,
          {
            input: {} as GainNode,
            scheduleAutomation: vi.fn(),
            schedulePunchAudibility: vi.fn(),
            dispose: vi.fn(),
          },
        ]),
      ) as unknown as Map<string, TrackGraph>,
  };
});

vi.mock('../../src/audio/drums', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/drums')>();
  return {
    ...actual,
    createNoiseBuffer: () => ({}),
    DrumVoiceManager: class {
      trigger(): void {}
      dispose(): void {}
    },
  };
});

vi.mock('../../src/audio/synth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/synth')>();
  let seq = 0;
  class FakeSynthVoiceManager {
    constructor(..._args: unknown[]) {
      // Unknown methods (dispose, releaseAll, ...) are recorded and are no-ops.
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (typeof prop !== 'string') return undefined;
          return (..._callArgs: unknown[]) => {
            rec.otherCalls.push(prop);
            return undefined;
          };
        },
      });
    }
    noteOn(
      pitch: number,
      time: number,
      duration: number,
      velocity: unknown,
      ..._rest: unknown[]
    ): Handle {
      const handle: Handle = { pitch, time, duration, velocity, seq: (seq += 1) };
      rec.noteOns.push({ pitch, time, duration, velocity, handle, calledAt: rec.currentTime });
      return handle;
    }
    releaseVoice(handle: object, ...args: unknown[]): void {
      rec.releases.push({ handle, args, calledAt: rec.currentTime });
    }
  }
  return { ...actual, SynthVoiceManager: FakeSynthVoiceManager };
});

import { initAudioBridge } from '../../src/audio/playback';
import { useStore } from '../../src/state/store';

const BEAT = 0.5; // 120 bpm
const SENTINEL_PITCH = 40;

type NoteSpec = readonly [pitch: number, startBeat: number, durationBeats: number];

async function flushMicrotasks(count = 30): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

/** Advance the manual audio clock and fake timers together, in 10 ms steps. */
async function tick(seconds: number): Promise<void> {
  const steps = Math.round(seconds / 0.01);
  for (let index = 0; index < steps; index += 1) {
    rec.currentTime += 0.01;
    await vi.advanceTimersByTimeAsync(10);
  }
}

function buildProject(notes: readonly NoteSpec[]): Project {
  const base = createDefaultProject({ bpm: 120, lengthBars: 8 });
  const tracks = base.tracks.map((track) => {
    if (track.type !== 'instrument') return track;
    return {
      ...track,
      clips: track.clips.map((clip, index) =>
        index === 0 && clip.type === 'midi'
          ? {
              ...clip,
              // Shorter than the song so the clip can be moved without leaving it.
              lengthBeats: 16,
              notes: [[SENTINEL_PITCH, 0, 0.25] as NoteSpec, ...notes].map(
                ([pitch, startBeat, durationBeats], noteIndex) => ({
                  id: `note-${noteIndex}`,
                  pitch,
                  startBeat,
                  durationBeats,
                  velocity: 100,
                }),
              ),
            }
          : clip,
      ),
    };
  });
  return { ...base, id: useStore.getState().saveState.projectId, tracks };
}

function clipOf(project: Project) {
  const track = project.tracks.find((candidate) => candidate.type === 'instrument')!;
  const clip = track.clips[0]!;
  if (clip.type !== 'midi') throw new Error('expected a midi clip');
  return { track, clip };
}

function noteIdByPitch(pitch: number, nth = 0): string {
  const { clip } = clipOf(useStore.getState().project);
  const matches = (clip.notes ?? []).filter((note) => note.pitch === pitch);
  const found = matches[nth];
  if (!found) throw new Error(`no note with pitch ${pitch}`);
  return found.id;
}

const clipId = (): string => clipOf(useStore.getState().project).clip.id;

/** Absolute context time of the playback anchor (beat 0), from the sentinel note. */
function anchor(): number {
  const first = rec.noteOns.find((entry) => entry.pitch === SENTINEL_PITCH);
  if (!first) throw new Error('sentinel note never sounded');
  return first.time;
}

const noteOnsOf = (pitch: number) => rec.noteOns.filter((entry) => entry.pitch === pitch);
const releasedHandles = () => new Set(rec.releases.map((entry) => entry.handle));
const unreleased = (pitch: number) =>
  noteOnsOf(pitch).filter((entry) => !releasedHandles().has(entry.handle));

async function startPlayback(
  notes: readonly NoteSpec[],
  options: { loop?: readonly [number, number] } = {},
): Promise<void> {
  useStore.setState({ project: buildProject(notes) });
  if (options.loop) {
    expect(useStore.getState().setLoopRange(options.loop[0], options.loop[1])).toBe(true);
  }
  useStore.getState().play();
  await flushMicrotasks();
  await tick(0.2);
  expect(useStore.getState().transport.phase).toBe('playing');
  expect(noteOnsOf(SENTINEL_PITCH).length).toBeGreaterThan(0);
}

/** Run until `seconds` after the anchor on the context clock. */
async function runUntil(secondsAfterAnchor: number): Promise<void> {
  const target = anchor() + secondsAfterAnchor;
  if (rec.currentTime < target) await tick(target - rec.currentTime);
}

describe('live edit acceptance: note edits during playback', () => {
  let teardownBridge = (): void => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    rec.currentTime = 10;
    rec.contextState = 'running';
    rec.noteOns.length = 0;
    rec.releases.length = 0;
    rec.otherCalls.length = 0;
    rec.listeners.clear();
    assetHarness.acquire.mockReset();
    assetHarness.preflight.mockReset();
    assetHarness.clearUnused.mockReset();
    assetHarness.release = vi.fn();
    assetHarness.preflight.mockResolvedValue({ assets: [], estimatedDecodedBytes: 0 });
    assetHarness.acquire.mockResolvedValue({
      buffersByAssetId: new Map(),
      release: assetHarness.release,
    } satisfies AudioAssetBufferLease);

    const transport = useStore.getState().transport;
    useStore.setState({
      project: buildProject([]),
      projectOperationBusy: false,
      audioRecordingOperationId: null,
      armedAudioTrackId: null,
      past: [],
      future: [],
      transport: {
        ...transport,
        phase: 'stopped',
        isPlaying: false,
        playbackRequestId: 900,
        audioIssue: null,
        positionBeat: 0,
        loopEnabled: false,
        loopStartBeat: 0,
        loopEndBeat: 0,
        punchEnabled: false,
        metronome: false,
      },
    });
    teardownBridge = initAudioBridge();
  });

  afterEach(async () => {
    useStore.getState().stop(true);
    teardownBridge();
    await flushMicrotasks();
    vi.useRealTimers();
  });

  it('G1: a note deleted during playback before it has sounded does not sound', async () => {
    await startPlayback([[62, 4, 1]]);
    await runUntil(1.0); // beat 2, the note at beat 4 (2.0 s) has not been reached
    useStore.getState().removeNote(clipId(), noteIdByPitch(62));
    await runUntil(4);
    expect(unreleased(62)).toHaveLength(0);
  });

  it('G1: a note deleted after it was already handed to the synth is cancelled before its onset', async () => {
    await startPlayback([[62, 4, 1]]);
    // Run until the lookahead has handed the voice to the synth but it is still in the future.
    for (let guard = 0; guard < 400 && noteOnsOf(62).length === 0; guard += 1) await tick(0.01);
    const queued = noteOnsOf(62)[0];
    expect(queued).toBeDefined();
    expect(queued!.time).toBeGreaterThan(rec.currentTime);
    useStore.getState().removeNote(clipId(), noteIdByPitch(62));
    await tick(0.05);
    const release = rec.releases.find((entry) => entry.handle === queued!.handle);
    expect(release).toBeDefined();
    expect(release!.calledAt).toBeLessThan(queued!.time);
    await runUntil(4);
    expect(unreleased(62)).toHaveLength(0);
  });

  it('G2: a note added ahead of the playhead sounds in the same pass', async () => {
    await startPlayback([]);
    await runUntil(1.0); // beat 2
    useStore.getState().addNote(clipId(), {
      pitch: 71,
      startBeat: 5,
      durationBeats: 1,
      velocity: 100,
    });
    await runUntil(4);
    const sounded = noteOnsOf(71);
    expect(sounded).toHaveLength(1);
    expect(sounded[0]!.time).toBeCloseTo(anchor() + 5 * BEAT, 2);
    expect(releasedHandles().has(sounded[0]!.handle)).toBe(false);
  });

  it('G3: deleting a sounding note releases its synth voice promptly instead of letting it play out', async () => {
    await startPlayback([[60, 0.5, 6]]);
    await runUntil(2.0); // beat 4, the note sounds from beat 0.5 to 6.5
    const voices = noteOnsOf(60);
    expect(voices).toHaveLength(1);
    const before = rec.currentTime;
    useStore.getState().removeNote(clipId(), noteIdByPitch(60));
    await tick(0.1);
    const release = rec.releases.find((entry) => entry.handle === voices[0]!.handle);
    expect(release).toBeDefined();
    expect(release!.calledAt - before).toBeLessThan(0.1);
    expect(rec.otherCalls).not.toContain('dispose');
    expect(rec.otherCalls).not.toContain('releaseAll');
  });

  it('G4: an edit inside the loop range is heard on the next loop pass', async () => {
    // Loop 0-4 beats = 2 s per pass.
    await startPlayback([[62, 3, 0.5]], { loop: [0, 4] });
    await runUntil(1.0); // pass 1, beat 2
    const clip = clipId();
    useStore.getState().removeNote(clip, noteIdByPitch(62));
    useStore.getState().addNote(clip, {
      pitch: 71,
      startBeat: 1,
      durationBeats: 0.5,
      velocity: 100,
    });
    await runUntil(3.5); // through beat 1 of pass 2 (2.5 s) and beat 3 of pass 2 (3.5 s)
    await tick(0.1);
    const t0 = anchor();
    const secondPass71 = noteOnsOf(71).filter((entry) => Math.abs(entry.time - (t0 + 2.5)) < 0.05);
    expect(secondPass71).toHaveLength(1);
    const secondPass62 = unreleased(62).filter((entry) => entry.time >= t0 + 2.0 - 0.05);
    expect(secondPass62).toHaveLength(0);
  });

  it('N1: moving a clip during playback stops playback and keeps the playhead', async () => {
    await startPlayback([[62, 6, 1]]);
    await runUntil(1.5);
    const { clip } = clipOf(useStore.getState().project);
    expect(
      useStore.getState().applyProjectChange((project) => ({
        ...project,
        tracks: project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) =>
            candidate.id === clip.id ? { ...candidate, startBeat: candidate.startBeat + 1 } : candidate,
          ),
        })),
      })),
    ).toBe(true);
    await tick(0.2);
    const transport = useStore.getState().transport;
    expect(transport.phase).toBe('stopped');
    expect(transport.positionBeat).toBeGreaterThan(2);
    expect(transport.positionBeat).toBeLessThan(4.5);
    const kept = transport.positionBeat;
    await tick(1);
    expect(useStore.getState().transport.phase).toBe('stopped');
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(kept, 5);
  });

  it('N1: changing the tempo during playback stops playback and keeps the playhead', async () => {
    await startPlayback([[62, 6, 1]]);
    await runUntil(1.5);
    useStore.getState().setBpm(90);
    await tick(0.2);
    const transport = useStore.getState().transport;
    expect(transport.phase).toBe('stopped');
    expect(transport.positionBeat).toBeGreaterThan(2);
    const kept = transport.positionBeat;
    await tick(1);
    expect(useStore.getState().transport.phase).toBe('stopped');
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(kept, 5);
  });

  it('N2: undo of a deletion during playback makes the note sound again on a later pass', async () => {
    // Loop 0-4 beats = 2 s per pass; the note sits at beat 1 (0.5 s into each pass).
    await startPlayback([[62, 1, 0.5]], { loop: [0, 4] });
    await runUntil(0.8); // pass 1: the note has sounded once
    expect(noteOnsOf(62)).toHaveLength(1);
    useStore.getState().removeNote(clipId(), noteIdByPitch(62));
    await runUntil(3.0); // pass 2 beat 2: the note was deleted for its pass-2 slot (2.5 s)
    expect(noteOnsOf(62).filter((entry) => !releasedHandles().has(entry.handle))).toHaveLength(1);
    expect(noteOnsOf(62)).toHaveLength(1);
    useStore.getState().undo();
    expect(clipOf(useStore.getState().project).clip.notes?.some((note) => note.pitch === 62)).toBe(true);
    await runUntil(5.0); // pass 3 starts at 4.0 s, its note at 4.5 s
    const t0 = anchor();
    const pass3 = noteOnsOf(62).filter((entry) => Math.abs(entry.time - (t0 + 4.5)) < 0.05);
    expect(pass3).toHaveLength(1);
    expect(releasedHandles().has(pass3[0]!.handle)).toBe(false);
  });

  it('N3: a sounding note whose velocity is changed is not released', async () => {
    await startPlayback([[60, 0.5, 6]]);
    await runUntil(2.0);
    expect(noteOnsOf(60)).toHaveLength(1);
    useStore.getState().updateNote(clipId(), noteIdByPitch(60), { velocity: 40 });
    await runUntil(2.5);
    expect(rec.releases.filter((entry) => (entry.handle as Handle).pitch === 60)).toHaveLength(0);
    expect(noteOnsOf(60)).toHaveLength(1);
  });

  it('N3: a sounding note whose duration is changed is not released', async () => {
    await startPlayback([[60, 0.5, 6]]);
    await runUntil(2.0);
    expect(noteOnsOf(60)).toHaveLength(1);
    useStore.getState().updateNote(clipId(), noteIdByPitch(60), { durationBeats: 4 });
    await runUntil(2.5);
    expect(rec.releases.filter((entry) => (entry.handle as Handle).pitch === 60)).toHaveLength(0);
    expect(noteOnsOf(60)).toHaveLength(1);
  });

  it('N4: deleting one of two identical sounding notes releases exactly one voice', async () => {
    await startPlayback([
      [60, 0.5, 6],
      [60, 0.5, 6],
    ]);
    await runUntil(2.0);
    expect(noteOnsOf(60)).toHaveLength(2);
    useStore.getState().removeNote(clipId(), noteIdByPitch(60, 1));
    await tick(0.2);
    const released = rec.releases.filter((entry) => (entry.handle as Handle).pitch === 60);
    expect(released).toHaveLength(1);
    expect(unreleased(60)).toHaveLength(1);
  });

  it('N5: a long note overlapping itself across two loop passes releases both passes when deleted', async () => {
    // Loop 0-4 beats = 2 s; the note lasts 6 beats = 3 s, so pass 1 and pass 2 overlap during 2.0-3.0 s.
    await startPlayback([[60, 0, 6]], { loop: [0, 4] });
    await runUntil(2.4);
    const voices = noteOnsOf(60);
    expect(voices.length).toBeGreaterThanOrEqual(2);
    const sounding = voices.filter((entry) => entry.time <= rec.currentTime);
    expect(sounding).toHaveLength(2);
    useStore.getState().removeNote(clipId(), noteIdByPitch(60));
    await tick(0.2);
    const released = releasedHandles();
    for (const voice of sounding) expect(released.has(voice.handle)).toBe(true);
  });

  it('N6: renaming a track during playback does not change what sounds', async () => {
    await startPlayback([
      [62, 4, 1],
      [64, 7, 1],
    ]);
    await runUntil(1.0);
    const { track } = clipOf(useStore.getState().project);
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((candidate) =>
        candidate.id === track.id ? { ...candidate, name: 'Renamed lead' } : candidate,
      ),
    }));
    await runUntil(5);
    expect(useStore.getState().transport.phase).toBe('playing');
    expect(rec.releases).toHaveLength(0);
    expect(rec.otherCalls).not.toContain('dispose');
    expect(noteOnsOf(62)).toHaveLength(1);
    expect(noteOnsOf(64)).toHaveLength(1);
    expect(noteOnsOf(SENTINEL_PITCH)).toHaveLength(1);
  });
});
