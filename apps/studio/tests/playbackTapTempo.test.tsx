// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';
import { renderScheduleEvents } from '../src/audio/wav';

// Only the audio devices and voices are stubs. The bridge, event builder and
// Scheduler are real and run against an independently driven audio clock.
const clock = vi.hoisted(() => ({ now: 0, tapMs: 0 }));
const synths = vi.hoisted(() => [] as Array<{
  noteOn: ReturnType<typeof vi.fn>;
  releaseAll: ReturnType<typeof vi.fn>;
}>);
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => clock.now,
    requireMaster: () => ({}),
    ensureContext: async () => ({ context: { currentTime: clock.now }, master: {} }),
  }),
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  buildTrackGraphs: (_ctx: unknown, _master: unknown, tracks: ReadonlyArray<{ id: string }>) =>
    new Map(tracks.map((t) => [t.id, { input: {}, dispose: () => {} }])),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
vi.mock('../src/audio/synth', () => ({
  SynthVoiceManager: class {
    noteOn = vi.fn();
    releaseAll = vi.fn();
    constructor() { synths.push(this); }
  },
}));
vi.mock('../src/audio/drums', () => ({ DrumVoiceManager: class {} }));
vi.mock('../src/audio/metronome', () => ({
  metronomeBeatEvents: vi.fn(() => []),
  scheduleMetronomeClick: vi.fn(),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let TransportBar: typeof import('../src/features/transport/TransportBar')['TransportBar'];
beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TransportBar } = await import('../src/features/transport/TransportBar'));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  clock.now = 0;
  clock.tapMs = 10_000;
  synths.length = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.tapMs);
  useStore.getState().createNewProject('テンポのテスト');
});
afterEach(() => {
  act(() => useStore.getState().stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start(): Promise<void> {
  render(<TransportBar />);
  await act(async () => useStore.getState().play());
}
async function tap100(): Promise<void> {
  const button = screen.getByRole('button', { name: 'タップテンポ' });
  fireEvent.click(button);
  clock.tapMs += 600;
  await act(async () => { fireEvent.click(button); });
  expect((screen.getByLabelText('BPM') as HTMLInputElement).value).toBe('100');
}
function advanceAudio(seconds: number): void {
  clock.now += seconds;
  act(() => vi.advanceTimersByTime(66));
}

describe('tapped tempo with the real playback scheduler', () => {
  it('uses 100 BPM immediately and Undo/Redo each restore the live speed', async () => {
    await start();
    await tap100();
    advanceAudio(1);
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(100 / 60);
    expect(useStore.getState().transport.isPlaying).toBe(true);

    // The global shortcut also closes the tap transaction before undoing it.
    const button = screen.getByRole('button', { name: 'タップテンポ' });
    await act(async () => { fireEvent.keyDown(button, { key: 'z', ctrlKey: true }); });
    expect(useStore.getState().project.bpm).toBe(120);
    advanceAudio(1);
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(100 / 60 + 2);

    await act(async () => {
      fireEvent.keyDown(button, { key: 'z', ctrlKey: true, shiftKey: true });
    });
    expect(useStore.getState().project.bpm).toBe(100);
    advanceAudio(1);
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(100 / 60 + 2 + 100 / 60);
  });

  it('keeps the exact audio position, resumes sustained notes and matches WAV event timing', async () => {
    const clipId = useStore.getState().project.tracks[0]?.clips[0]?.id ?? '';
    useStore.getState().addNote(clipId, { pitch: 73, startBeat: 0, durationBeats: 4, velocity: 100 });
    useStore.getState().addNote(clipId, { pitch: 74, startBeat: 2, durationBeats: 1, velocity: 100 });
    await start();
    const oldSynths = [...synths];
    // No position timer tick: the UI still says beat 0, the audio is at 0.5.
    clock.now = 0.25;
    await tap100();
    expect(useStore.getState().transport.positionBeat).toBeCloseTo(0.5);
    for (const synth of oldSynths) expect(synth.releaseAll).toHaveBeenCalledWith(0.25);
    const newSynths = synths.filter((s) => !oldSynths.includes(s));
    expect(newSynths.some((s) => s.noteOn.mock.calls.some(
      ([pitch, time, duration]) => pitch === 73 && time === 0.25 && duration === 3.5 * 0.6,
    ))).toBe(true);

    advanceAudio(0.85); // beat 2 enters the scheduler's lookahead window
    const live = newSynths.flatMap((s) => s.noteOn.mock.calls).find(([pitch]) => pitch === 74);
    expect(live).toBeDefined();
    const offline = renderScheduleEvents(useStore.getState().project).find((e) => {
      const payload = e.payload as { kind: string; pitch?: number };
      return payload.kind === 'note' && payload.pitch === 74;
    });
    // WAV starts from beat 0; live restarts at beat 0.5 / audio time 0.25.
    expect(offline?.time).toBeCloseTo(1.2);
    expect(live?.[1]).toBeCloseTo(0.25 + (offline?.time ?? 0) - 0.5 * 0.6);
    expect(live?.[2]).toBeCloseTo(0.6);
    advanceAudio(0.2);
    expect(newSynths.flatMap((s) => s.noteOn.mock.calls).filter(([pitch]) => pitch === 74)).toHaveLength(1);
  });
});
