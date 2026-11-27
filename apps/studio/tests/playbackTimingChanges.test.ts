import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrumClip } from '@cts/project-model';
import type { AutomationPlayback } from '../src/audio/automationSchedule';
import type { SchedulePayload } from '../src/audio/events';
import { renderScheduleEvents } from '../src/audio/wav';
import { installLocalStorage } from './localStorageStub';

// Real Scheduler on a hand-driven audio clock: changing the song length or the
// meter while playing must rebuild the schedule (end position, metronome
// accent cycle) instead of playing on with the values from the last start.
const clock = vi.hoisted(() => ({ now: 0 }));
/** Every SynthVoiceManager the bridge built, in creation order. */
const synths = vi.hoisted(
  () => [] as Array<{ noteOn: ReturnType<typeof vi.fn>; releaseAll: ReturnType<typeof vi.fn> }>,
);
const drumTrigger = vi.hoisted(() => vi.fn());
const scheduleAutomation = vi.hoisted(() => vi.fn());

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
  // One stub graph per track so the bridge builds a voice manager for each.
  buildTrackGraphs: (_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string; pan: number }>) =>
    new Map(tracks.map((t) => [t.id, {
      input: {}, dispose: () => {},
      scheduleAutomation: (playback: AutomationPlayback, pass: number) =>
        scheduleAutomation(t.id, t.pan, { ...playback }, pass),
    }])),
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
vi.mock('../src/audio/drums', () => ({
  DrumVoiceManager: class {
    trigger = drumTrigger;
  },
}));
vi.mock('../src/audio/metronome', () => ({
  metronomeBeatEvents: vi.fn(() => []),
  scheduleMetronomeClick: vi.fn(),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let initAudioBridge: typeof import('../src/audio/playback')['initAudioBridge'];
let metronomeBeatEvents: typeof import('../src/audio/metronome')['metronomeBeatEvents'];
let removeClipFromSong: typeof import('../src/state/editorActions')['removeClipFromSong'];

/** 120 bpm: half a second per beat. */
const SECONDS_PER_BEAT = 0.5;
/** One scheduler tick (TICK_MS) is enough to notice the end. */
const TICK_MS = 25;

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ initAudioBridge } = await import('../src/audio/playback'));
  ({ metronomeBeatEvents } = await import('../src/audio/metronome'));
  ({ removeClipFromSong } = await import('../src/state/editorActions'));
});

describe('project changes during playback', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    synths.length = 0;
    drumTrigger.mockClear();
    scheduleAutomation.mockClear();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    useStore.getState().createNewProject('テスト');
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.useRealTimers();
    vi.mocked(metronomeBeatEvents).mockClear();
  });

  /** Start playing at `beat` and wait for the scheduler + position loop timers. */
  async function playFrom(beat: number): Promise<void> {
    useStore.getState().setPosition(beat);
    useStore.getState().play();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
  }

  /** Move the audio clock to `beat` (relative to a start at `startBeat`) and tick once. */
  function advanceTo(beat: number, startBeat: number): void {
    clock.now = (beat - startBeat) * SECONDS_PER_BEAT;
    vi.advanceTimersByTime(TICK_MS);
  }

  it('schedules pan and cutoff without volume and rebuilds from the playhead after a mixer pan change', async () => {
    const trackId = useStore.getState().project.tracks.find((track) => track.type === 'instrument')!.id;
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.id !== trackId ? track : {
        ...track, pan: 0, automation: {
          pan: { points: [{ beat: 0, value: -0.25 }] },
          cutoff: { points: [{ beat: 0, value: 1 }] },
        },
      }),
    }));
    await playFrom(0);
    expect(scheduleAutomation).toHaveBeenCalledWith(trackId, 0, expect.objectContaining({ startBeat: 0 }), 0);

    clock.now = 1;
    useStore.getState().setTrackPan(trackId, 0.5);
    await vi.waitFor(() => expect(scheduleAutomation).toHaveBeenCalledWith(
      trackId, 0.5, expect.objectContaining({ startBeat: 2, startTime: 1 }), 0,
    ));
    expect(useStore.getState().transport.positionBeat).toBe(2);
  });

  it('matches the WAV drum hits after deleting a clip without changing the song length', async () => {
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => track.type !== 'drum' ? track : {
        ...track,
        clips: [
          {
            ...createDrumClip(track.id, 8, 4),
            id: 'removed-clip',
            drumEvents: [{ id: 'removed-kick', lane: 'kick', stepIndex: 0, velocity: 100 }],
          },
          {
            ...createDrumClip(track.id, 12, 4),
            id: 'kept-clip',
            drumEvents: [{ id: 'kept-snare', lane: 'snare', stepIndex: 0, velocity: 90 }],
          },
        ],
      }),
    }));
    await playFrom(0);
    // Edit at beat 3, while the position in the store still reads 0.
    clock.now = 3 * SECONDS_PER_BEAT;
    removeClipFromSong('removed-clip');
    expect(useStore.getState().project.lengthBars).toBe(8);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    const wavHits = renderScheduleEvents(useStore.getState().project)
      .flatMap(({ payload, time }) => {
        const event = payload as SchedulePayload;
        return event.kind === 'drum' ? [[event.lane, time, event.velocity]] : [];
      });
    expect(wavHits).toEqual([['snare', 6, 90]]);
    advanceTo(8, 0);
    advanceTo(12, 0);
    expect(drumTrigger.mock.calls).toEqual(wavHits);
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(12);
  });

  it('stops at the new end after the song is cut from 8 to 4 bars', async () => {
    await playFrom(8);
    expect(useStore.getState().setLengthBars(4, true)).toBeNull();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    advanceTo(17, 8);

    expect(useStore.getState().transport.isPlaying).toBe(false);
    expect(useStore.getState().transport.positionBeat).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops and rewinds at once when the playhead is already past the new end', async () => {
    await playFrom(20);
    useStore.getState().setLengthBars(4, true);
    await vi.waitFor(() => expect(useStore.getState().transport.isPlaying).toBe(false));

    expect(useStore.getState().transport.positionBeat).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('follows the length restored by undo', async () => {
    await playFrom(8);
    useStore.getState().setLengthBars(4, true);
    useStore.getState().undo();
    expect(useStore.getState().project.lengthBars).toBe(8);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    advanceTo(17, 8);
    expect(useStore.getState().transport.isPlaying).toBe(true);

    advanceTo(33, 8);
    expect(useStore.getState().transport.isPlaying).toBe(false);
  });

  it('switches the metronome accent to 3 beats and the end to 33 beats on 4/4 -> 3/4', async () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 8, durationBeats: 1, velocity: 100 });
    useStore.getState().toggleMetronome();
    await playFrom(7);

    useStore.getState().setTimeSignature([3, 4]);
    expect(useStore.getState().project.lengthBars).toBe(11);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    // The note at beat 8 enters the lookahead window: the metronome is asked
    // for clicks with the new bar length.
    advanceTo(8, 7);
    const lastCall = vi.mocked(metronomeBeatEvents).mock.lastCall;
    expect(lastCall?.[2]).toBe(3);

    // 11 bars of 3/4 = 33 beats: beat 32.5 is still inside the song.
    advanceTo(32.5, 7);
    expect(useStore.getState().transport.isPlaying).toBe(true);
    advanceTo(33, 7);
    expect(useStore.getState().transport.isPlaying).toBe(false);
  });

  it('keeps a note that is sounding across the playhead when the meter changes mid-note', async () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    // Beats 8..12 at 120 bpm: starts at 0.5 s, lasts 2 s.
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 8, durationBeats: 4, velocity: 100 });
    await playFrom(7);
    const firstSynths = [...synths];

    // Reach beat 8.5: the note has been scheduled, and the position loop has
    // moved the store playhead past its start.
    clock.now = 1.5 * SECONDS_PER_BEAT;
    vi.advanceTimersByTime(66);
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(8.5);
    const original = firstSynths.find((s) => s.noteOn.mock.calls.length > 0);
    expect(original?.noteOn).toHaveBeenCalledTimes(1);
    expect(original?.noteOn).toHaveBeenCalledWith(60, 0.5, 2, 100, { cutAtEnd: undefined });

    useStore.getState().setTimeSignature([3, 4]);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    // The old voices were released at the restart ...
    for (const synth of firstSynths) expect(synth.releaseAll).toHaveBeenCalledWith(0.75);
    // ... and the note was started again on the new voices from the playhead
    // for its remaining 3.5 beats (1.75 s), not re-attacked from beat 8.
    const rebuilt = synths.filter((s) => !firstSynths.includes(s));
    expect(rebuilt.length).toBeGreaterThan(0);
    const resumed = rebuilt.find((s) => s.noteOn.mock.calls.length > 0);
    expect(resumed?.noteOn).toHaveBeenCalledTimes(1);
    expect(resumed?.noteOn).toHaveBeenCalledWith(60, 0.75, 1.75, 100, { cutAtEnd: undefined });

    // Playing on past the note's end does not start it a third time.
    advanceTo(12.5, 8.5);
    expect(resumed?.noteOn).toHaveBeenCalledTimes(1);
    expect(useStore.getState().transport.isPlaying).toBe(true);
  });

  it('does not restore sounding notes on a plain play from the middle of a note', async () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 60, startBeat: 8, durationBeats: 4, velocity: 100 });
    await playFrom(9);
    advanceTo(9.5, 9);
    expect(synths.every((s) => s.noteOn.mock.calls.length === 0)).toBe(true);
  });
});
