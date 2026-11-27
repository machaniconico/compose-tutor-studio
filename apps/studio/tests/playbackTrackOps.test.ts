import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_EVENTS_PER_SECOND, buildParamSchedule, type AutomationPlayback, type ParamEvent } from '../src/audio/automationSchedule';
import { validateProject, type Track } from '@cts/project-model';
import { renderProjectToWav } from '../src/audio/wav';
import { installLocalStorage } from './localStorageStub';

// Adding or removing a track while playing takes effect from the next
// playback: the running mix keeps the tracks it was started with.
const clock = vi.hoisted(() => ({ now: 0 }));
const { scheduleAutomation } = vi.hoisted(() => ({ scheduleAutomation: vi.fn() }));

let liveContext: AutomationAudioContext | undefined;

class AutomationAudioContext {
  eventCount = 0;
  readonly events: ParamEvent[] = [];
  private gains = 0;
  readonly currentTime = 0;

  constructor(private readonly channels = 2, private readonly frames = 0) {}

  createGain() {
    // This fixture has one automated sound track. Its second gain is automation.
    const isAutomation = ++this.gains === 2;
    const record = (method: ParamEvent['method'], value: number, time: number) => {
      if (isAutomation && ++this.eventCount <= AUTOMATION_EVENTS_PER_SECOND) this.events.push({ method, value, time });
    };
    return {
      connect() {}, disconnect() {},
      gain: {
        value: 1, setTargetAtTime() {},
        setValueAtTime: (value: number, time: number) => record('setValueAtTime', value, time),
        linearRampToValueAtTime: (value: number, time: number) => record('linearRampToValueAtTime', value, time),
      },
    };
  }

  createStereoPanner() { return { connect() {}, disconnect() {}, pan: { value: 0, setTargetAtTime() {} } }; }
  createAnalyser() { return { disconnect() {} }; }

  async startRendering() {
    return { numberOfChannels: this.channels, getChannelData: () => new Float32Array(this.frames) };
  }
}

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => clock.now,
    ensureContext: async () => ({ context: liveContext ?? { currentTime: clock.now }, master: {} }),
    requireMaster: () => ({}),
  }),
}));
vi.mock('../src/audio/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/graph')>();
  return {
    ...actual,
    applyMixState: vi.fn(),
    buildTrackGraphs: vi.fn((ctx: BaseAudioContext, master: AudioNode, tracks: readonly Track[], when: number) => {
      if (ctx instanceof AutomationAudioContext) return actual.buildTrackGraphs(ctx, master, tracks, when);
      return new Map(tracks.filter((t) => t.type !== 'master').map((t) => [t.id, {
        input: {}, dispose() {},
        scheduleAutomation(timing: AutomationPlayback, pass: number) {
          if (t.automation?.volume) scheduleAutomation(t.automation.volume, { ...timing }, pass);
        },
      }]));
    }),
  };
});
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn(), createMasterChain: () => ({ input: {} }) }));
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    noteOn = vi.fn();
    releaseAll = vi.fn();
  },
}));
vi.mock('../src/audio/drums', () => ({ DrumVoiceManager: class {} }));
vi.mock('../src/audio/metronome', () => ({
  metronomeBeatEvents: vi.fn(() => []),
  scheduleMetronomeClick: vi.fn(),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let initAudioBridge: typeof import('../src/audio/playback')['initAudioBridge'];
let graph: typeof import('../src/audio/graph');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ initAudioBridge } = await import('../src/audio/playback'));
  graph = await import('../src/audio/graph');
});

function trackNamed(name: string): Track {
  const track = useStore.getState().project.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

/** Track ids heard in the mix the bridge applied last. */
function lastAudibleNames(): string[] {
  const calls = vi.mocked(graph.applyMixState).mock.calls;
  const tracks = calls[calls.length - 1]![1];
  const audible = graph.computeAudibleTracks(tracks);
  return tracks.filter((t) => audible.has(t.id)).map((t) => t.name);
}

describe('track add and remove during playback', () => {
  let teardown: () => void;

  beforeEach(() => {
    clock.now = 0;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    useStore.getState().createNewProject('テスト');
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    liveContext = undefined;
    scheduleAutomation.mockClear();
    vi.mocked(graph.applyMixState).mockClear();
    vi.mocked(graph.buildTrackGraphs).mockClear();
  });

  async function play(): Promise<void> {
    useStore.getState().play();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
  }

  it.each([1 / 64, 0.5])('bounds live and WAV automation for 10,000 points in a %s-beat loop', async (endBeat) => {
    const store = useStore.getState();
    const keys = trackNamed('Chords');
    const valueAtStart = 0.37;
    const volume = { points: Array.from({ length: 10_000 }, (_, index) => ({
      beat: index * endBeat / 10_000,
      value: index === 0 ? valueAtStart : index % 13 / 12,
    })) };
    store.applyProjectChange((project) => ({
      ...project, bpm: 300, loopRange: { startBeat: 0, endBeat },
      tracks: project.tracks.filter((track) => track.id === keys.id || track.type === 'master').map((track) =>
        track.id === keys.id ? { ...track, clips: [], automation: { volume } } : track),
    }));
    const { project } = useStore.getState();
    expect(validateProject(project).ok).toBe(true);
    if (!useStore.getState().transport.loopEnabled) store.toggleLoop();
    const loopSeconds = endBeat * 60 / project.bpm;

    let offlineContext!: AutomationAudioContext;
    vi.stubGlobal('OfflineAudioContext', class extends AutomationAudioContext {
      constructor(channels: number, frames: number) {
        super(channels, frames);
        offlineContext = this;
      }
    });
    const offlineStart = performance.now();
    await renderProjectToWav(project, { range: 'loop' });
    expect.soft(performance.now() - offlineStart).toBeLessThan(1_000);
    expect.soft(offlineContext.eventCount).toBeLessThanOrEqual(Math.floor(AUTOMATION_EVENTS_PER_SECOND * loopSeconds));

    liveContext = new AutomationAudioContext();
    const liveStart = performance.now();
    await play();
    // The lookahead always queues at least the next 120 ms. Stop advancing
    // before the one-second boundary so the captured events fit in one second.
    for (let tick = 1; tick <= 35; tick++) {
      clock.now = tick * 0.025;
      vi.advanceTimersByTime(25);
    }
    expect.soft(performance.now() - liveStart).toBeLessThan(1_000);
    expect.soft(liveContext.eventCount).toBeLessThanOrEqual(AUTOMATION_EVENTS_PER_SECOND);
    const firstReset = liveContext.events.findIndex(({ method, time }) => method === 'setValueAtTime' && time > 0);
    expect(firstReset).toBeGreaterThan(0);
    expect(liveContext.events.slice(0, firstReset)).toEqual(offlineContext.events);
    expect(liveContext.events[firstReset]).toEqual({ method: 'setValueAtTime', time: loopSeconds, value: valueAtStart });
    if (loopSeconds < 0.005) {
      expect(offlineContext.events).toEqual([{ method: 'setValueAtTime', time: 0, value: valueAtStart }]);
      expect(liveContext.events.every(({ method }) => method === 'setValueAtTime')).toBe(true);
    } else {
      expect(offlineContext.events.at(-1)).toEqual({
        method: 'linearRampToValueAtTime', time: loopSeconds, value: volume.points.at(-1)!.value,
      });
    }
  });

  it('keeps only the soloed track audible after it is deleted, until the next playback', async () => {
    useStore.getState().toggleSolo(trackNamed('Chords').id);
    await play();

    useStore.getState().removeTrack(trackNamed('Chords').id);
    expect(lastAudibleNames()).toEqual(['Chords']);

    // A mix change on another track still applies live, without un-silencing it.
    useStore.getState().toggleMute(trackNamed('Bass').id);
    expect(lastAudibleNames()).toEqual(['Chords']);

    useStore.getState().stop();
    await play();
    useStore.getState().toggleMute(trackNamed('Bass').id);
    expect(lastAudibleNames()).toEqual(['Bass', 'Melody', 'Drums']);
  });

  it('does not let a track added during playback change who is audible until the next playback', async () => {
    await play();
    const id = useStore.getState().addTrack('instrument');
    useStore.getState().toggleSolo(id);
    expect(lastAudibleNames()).toEqual(['Chords', 'Bass', 'Melody', 'Drums']);
  });

  it('queues loop resets lazily and applies lane edits only after the next play', async () => {
    const store = useStore.getState();
    const keys = trackNamed('Chords');
    const original = { points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] };
    const edited = { points: [{ beat: 0, value: 0.75 }] };
    store.applyProjectChange((p) => ({
      ...p, bpm: 120, loopRange: { startBeat: 0, endBeat: 4 },
      tracks: p.tracks.map((t) => t.id === keys.id ? { ...t, automation: { volume: original } } : t),
    }));
    if (!useStore.getState().transport.loopEnabled) store.toggleLoop();
    await play();
    expect(scheduleAutomation.mock.calls.map(([, , pass]) => pass)).toEqual([0]);

    store.applyProjectChange((p) => ({
      ...p, tracks: p.tracks.map((t) => t.id === keys.id ? { ...t, automation: { volume: edited } } : t),
    }));
    clock.now = 1.95;
    vi.advanceTimersByTime(25);
    const [lane, timing, firstPass] = scheduleAutomation.mock.lastCall!;
    expect(lane).toBe(original);
    expect(firstPass).toBe(1);
    expect(buildParamSchedule(lane, timing.startBeat, timing.loop, timing.bpm, {
      startTime: timing.startTime, firstPass, passes: 1,
    })[0]).toEqual({ method: 'setValueAtTime', value: 0, time: 2 });

    useStore.getState().setBpm(121);
    await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));
    expect(scheduleAutomation.mock.lastCall![0]).toBe(original);
    store.stop();
    await play();
    expect(scheduleAutomation.mock.lastCall![0]).toBe(edited);
  });

  it.each([
    ['a tempo change', () => useStore.getState().setBpm(useStore.getState().project.bpm + 1)],
    ['a loop change', () => useStore.getState().toggleLoop()],
  ] as const)('keeps the original tracks when %s rebuilds playback', async (_change, rebuild) => {
    const bass = trackNamed('Bass');
    useStore.getState().toggleSolo(bass.id);
    await play();
    useStore.getState().removeTrack(bass.id);
    const addedId = useStore.getState().addTrack('instrument');

    rebuild();
    await vi.waitFor(() => expect(graph.buildTrackGraphs).toHaveBeenCalledTimes(2));
    const rebuiltTracks = vi.mocked(graph.buildTrackGraphs).mock.lastCall![2];
    expect(graph.computeAudibleTracks(rebuiltTracks)).toEqual(new Set([bass.id]));
    expect(rebuiltTracks.map((track) => track.id)).not.toContain(addedId);
    expect(useStore.getState().transport.isPlaying).toBe(true);

    useStore.getState().stop();
    await play();
    const nextTracks = vi.mocked(graph.buildTrackGraphs).mock.lastCall![2];
    expect(nextTracks.map((track) => track.id)).toContain(addedId);
    expect(nextTracks.map((track) => track.id)).not.toContain(bass.id);
  });
});
