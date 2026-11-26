import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

// Real Scheduler on a hand-driven audio clock: a note that starts before the
// song end and lasts past it must ring out in live playback (graphs kept until
// it ends plus the same tail the WAV render keeps), not be cut at the end.
const clock = vi.hoisted(() => ({ now: 0 }));
const synths = vi.hoisted(
  () => [] as Array<{ noteOn: ReturnType<typeof vi.fn>; releaseAll: ReturnType<typeof vi.fn> }>,
);
const disposed = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => clock.now,
    ensureContext: async () => ({ context: { currentTime: clock.now }, master: {} }),
    requireMaster: () => ({}),
  }),
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  buildTrackGraphs: (_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string }>) =>
    new Map(
      tracks.map((t) => [
        t.id,
        {
          input: {},
          dispose: () => {
            disposed.count += 1;
          },
        },
      ]),
    ),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    noteOn = vi.fn();
    releaseAll = vi.fn();
    constructor() {
      synths.push(this);
    }
  },
}));
vi.mock('../src/audio/drums', () => ({ DrumVoiceManager: class {} }));
vi.mock('../src/audio/metronome', () => ({
  metronomeBeatEvents: vi.fn(() => []),
  scheduleMetronomeClick: vi.fn(),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let initAudioBridge: typeof import('../src/audio/playback')['initAudioBridge'];
let renderLengthSeconds: typeof import('../src/audio/wav')['renderLengthSeconds'];
let RENDER_TAIL_SECONDS: number;

/** 120 bpm: half a second per beat. */
const SECONDS_PER_BEAT = 0.5;
const TICK_MS = 25;

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ initAudioBridge } = await import('../src/audio/playback'));
  ({ renderLengthSeconds, RENDER_TAIL_SECONDS } = await import('../src/audio/wav'));
});

/** 120 bpm, 1 bar of 4/4 (song end at beat 4), one instrument track with a 4-beat note at beat 3. */
function crossingProject(project: Project): Project {
  const track = project.tracks.find((t) => t.type === 'instrument')!;
  return {
    ...project,
    bpm: 120,
    timeSignature: [4, 4],
    lengthBars: 1,
    tracks: [
      {
        ...track,
        mute: false,
        solo: false,
        effects: [],
        clips: [
          {
            id: 'crossing',
            trackId: track.id,
            type: 'midi',
            startBeat: 0,
            lengthBeats: 8,
            loop: false,
            notes: [{ id: 'n', pitch: 60, startBeat: 3, durationBeats: 4, velocity: 100 }],
          },
        ],
      },
    ],
  };
}

describe('a note crossing the song end', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    synths.length = 0;
    disposed.count = 0;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    useStore.getState().createNewProject('テスト');
    useStore.getState().applyProjectChange(crossingProject);
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.useRealTimers();
  });

  async function playFromStart(): Promise<void> {
    useStore.getState().setPosition(0);
    useStore.getState().play();
    // startPlayback awaits ensureContext; flush microtasks until it has started.
    for (let i = 0; i < 20 && synths.length === 0; i += 1) await Promise.resolve();
    expect(synths).toHaveLength(1);
  }

  function advanceToSeconds(seconds: number): void {
    clock.now = seconds;
    vi.advanceTimersByTime(TICK_MS);
  }

  it('live: no new note after the end, but the note rings until its end plus the tail', async () => {
    await playFromStart();
    advanceToSeconds(3 * SECONDS_PER_BEAT);
    advanceToSeconds(4 * SECONDS_PER_BEAT + 0.05);

    expect(useStore.getState().transport.isPlaying).toBe(false);
    const synth = synths[0]!;
    expect(synth.noteOn).toHaveBeenCalledTimes(1);
    // Full 4-beat length: the note ends at beat 7 (3.5 s), past the song end at 2 s.
    expect(synth.noteOn.mock.calls[0]![2]).toBe(4 * SECONDS_PER_BEAT);
    expect(synth.releaseAll).not.toHaveBeenCalled();
    expect(disposed.count).toBe(0);

    // Graphs stay until beat 7 + the tail (no delay: RENDER_TAIL_SECONDS).
    const ringEnd = 7 * SECONDS_PER_BEAT + RENDER_TAIL_SECONDS;
    vi.advanceTimersByTime((ringEnd - clock.now) * 1000 - 50);
    expect(disposed.count).toBe(0);
    vi.advanceTimersByTime(100);
    expect(disposed.count).toBe(1);
  });

  it('WAV: the render lasts until the same end (beat 7 plus the tail), not the song end plus the tail', () => {
    const project = useStore.getState().project;
    expect(renderLengthSeconds(project)).toBe(7 * SECONDS_PER_BEAT + RENDER_TAIL_SECONDS);
  });

  it('keeps the warm pad release when a clipped note ends exactly at the song end', async () => {
    useStore.getState().applyProjectChange((project) => {
      const track = project.tracks[0]!;
      const clip = track.clips[0]!;
      return {
        ...project,
        tracks: [{
          ...track,
          instrument: { type: 'synth', preset: 'warmPad' },
          clips: [{
            ...clip,
            lengthBeats: 4,
            notes: [{ id: 'n', pitch: 60, startBeat: 3.5, durationBeats: 2, velocity: 100 }],
          }],
        }],
      };
    });
    const wavEnd = renderLengthSeconds(useStore.getState().project);
    expect(wavEnd).toBe(2 + RENDER_TAIL_SECONDS);
    await playFromStart();
    advanceToSeconds(1.75);
    advanceToSeconds(2);

    expect(useStore.getState().transport).toMatchObject({ isPlaying: false, positionBeat: 0 });
    expect(synths[0]!.noteOn).toHaveBeenCalledWith(60, 1.75, 0.25, 100, { cutAtEnd: true });
    expect(synths[0]!.releaseAll).not.toHaveBeenCalled();
    expect(disposed.count).toBe(0);
    vi.advanceTimersByTime((wavEnd - clock.now) * 1000 - 1);
    expect(disposed.count).toBe(0);
    vi.advanceTimersByTime(1);
    expect(disposed.count).toBe(1);
  });

  it('a stop pressed before the end still cuts the sound at once', async () => {
    await playFromStart();
    advanceToSeconds(3 * SECONDS_PER_BEAT + 0.05);
    useStore.getState().stop();

    expect(synths[0]!.releaseAll).toHaveBeenCalledTimes(1);
    expect(disposed.count).toBe(1);
  });

  it('playing again while the end still rings disconnects the old graphs first', async () => {
    await playFromStart();
    advanceToSeconds(4 * SECONDS_PER_BEAT + 0.05);
    expect(disposed.count).toBe(0);

    synths.length = 0;
    await playFromStart();
    expect(disposed.count).toBe(1);
  });
});
