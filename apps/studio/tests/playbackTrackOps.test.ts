import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

// Adding or removing a track while playing takes effect from the next
// playback: the running mix keeps the tracks it was started with.
const clock = vi.hoisted(() => ({ now: 0 }));

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => clock.now,
    ensureContext: async () => ({ context: { currentTime: clock.now }, master: {} }),
    requireMaster: () => ({}),
  }),
}));
vi.mock('../src/audio/graph', async (importOriginal) => ({
  computeAudibleTracks: (await importOriginal<typeof import('../src/audio/graph')>()).computeAudibleTracks,
  applyMixState: vi.fn(),
  buildTrackGraphs: vi.fn((_ctx: unknown, _master: unknown, tracks: ReadonlyArray<Track>) =>
    new Map(tracks.filter((t) => t.type !== 'master').map((t) => [t.id, { input: {}, dispose: () => {} }]))),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
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
    vi.mocked(graph.applyMixState).mockClear();
    vi.mocked(graph.buildTrackGraphs).mockClear();
  });

  async function play(): Promise<void> {
    useStore.getState().play();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
  }

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
