import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAudioBridge } from '../src/audio/playback';
import { useStore } from '../src/state/store';

// Real Scheduler: starting at the project end must stop inside its first tick
// without leaving the scheduler interval or the position loop behind.
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => 0,
    ensureContext: async () => ({ context: { currentTime: 0 }, master: {} }),
  }),
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  buildTrackGraphs: () => new Map(),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
vi.mock('../src/audio/synth', () => ({ SynthVoiceManager: class {} }));
vi.mock('../src/audio/drums', () => ({ DrumVoiceManager: class {} }));

describe('playing from the exact project end', () => {
  let teardown: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
    vi.useRealTimers();
  });

  function lengthBeats(): number {
    const { project } = useStore.getState();
    return project.lengthBars * project.timeSignature[0];
  }

  it('stops at once, rewinds to the start, and leaks no interval over three attempts', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      useStore.getState().setPosition(lengthBeats());
      useStore.getState().play();
      await vi.waitFor(() => expect(useStore.getState().transport.isPlaying).toBe(false));

      expect(useStore.getState().transport.positionBeat).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('keeps the scheduler and position loop when started before the end', async () => {
    useStore.getState().setPosition(lengthBeats() - 4);
    useStore.getState().play();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));

    expect(useStore.getState().transport.isPlaying).toBe(true);
    useStore.getState().stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
