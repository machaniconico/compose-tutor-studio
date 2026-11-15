import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioPlaybackFailureMessage, initAudioBridge, restartAt } from '../src/audio/playback';
import { useStore } from '../src/state/store';

const audio = vi.hoisted(() => {
  type Init = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

  class FakeScheduler {
    static instances: FakeScheduler[] = [];
    isRunning = false;
    startBeat = -1;
    constructor() {
      FakeScheduler.instances.push(this);
    }
    start(_events: unknown, _bpm: number, startBeat: number): void {
      this.isRunning = true;
      this.startBeat = startBeat;
    }
    stop(): void {
      this.isRunning = false;
    }
    currentBeat(): number {
      return this.startBeat;
    }
  }

  return { FakeScheduler, pendingInits: [] as Init[], pushToast: vi.fn() };
});

vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: true,
    now: () => 0,
    ensureContext: () =>
      new Promise((resolve, reject) => audio.pendingInits.push({ resolve, reject })),
  }),
}));
vi.mock('../src/audio/scheduler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/scheduler')>()),
  Scheduler: audio.FakeScheduler,
}));
vi.mock('../src/audio/graph', () => ({
  applyMixState: vi.fn(),
  buildTrackGraphs: () => new Map(),
}));
vi.mock('../src/audio/masterChain', () => ({ applyMasterVolume: vi.fn() }));
vi.mock('../src/state/tutorialBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/state/tutorialBridge')>()),
  pushToast: audio.pushToast,
}));

describe('audio playback failure messaging', () => {
  it('asks the user to retry when playback is blocked by permission or gesture policy', () => {
    const message = audioPlaybackFailureMessage(
      new DOMException('play() failed because the user did not interact first', 'NotAllowedError'),
    );

    expect(message).toContain('許可');
    expect(message).toContain('再生ボタン');
  });

  it('explains unsupported audio environments without exposing raw exception text', () => {
    const message = audioPlaybackFailureMessage(new ReferenceError('AudioContext is not defined'));

    expect(message).toContain('音声機能');
    expect(message).toContain('WebView2');
    expect(message).not.toContain('ReferenceError');
  });

  it('points persistent unknown failures to support diagnostics', () => {
    const message = audioPlaybackFailureMessage(new Error('device switch failed'));

    expect(message).toContain('出力先');
    expect(message).toContain('診断情報');
  });
});

describe('seeking while audio is still starting', () => {
  const context = { currentTime: 0 };
  const master = {};
  let teardown: () => void;

  const running = () => audio.FakeScheduler.instances.filter((s) => s.isRunning);

  async function finishInits(): Promise<void> {
    for (const init of audio.pendingInits.splice(0)) init.resolve({ context, master });
    await vi.waitFor(() => expect(audio.pendingInits).toHaveLength(0));
    await Promise.resolve();
  }

  beforeEach(() => {
    audio.FakeScheduler.instances.length = 0;
    audio.pendingInits.length = 0;
    audio.pushToast.mockClear();
    useStore.getState().setPosition(0);
    teardown = initAudioBridge();
  });

  afterEach(() => {
    if (useStore.getState().transport.isPlaying) useStore.getState().stop();
    teardown();
  });

  it('runs one scheduler from the last seek after consecutive seeks', async () => {
    useStore.getState().play();
    restartAt(4);
    restartAt(8);
    await finishInits();

    expect(running().map((s) => s.startBeat)).toEqual([8]);
  });

  it('leaves nothing running when Stop follows seeks during start-up', async () => {
    useStore.getState().play();
    restartAt(8);
    useStore.getState().stop();
    await finishInits();

    expect(useStore.getState().transport.isPlaying).toBe(false);
    expect(audio.FakeScheduler.instances).toHaveLength(0);
  });

  it('stops every scheduler when Stop comes after the start-up finishes', async () => {
    useStore.getState().play();
    restartAt(8);
    await finishInits();
    useStore.getState().stop();

    expect(running()).toHaveLength(0);
  });

  it('ignores a failed start that a later seek already replaced', async () => {
    useStore.getState().play();
    restartAt(8);
    const [stale, current] = audio.pendingInits.splice(0);
    stale?.reject(new Error('device switch failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(useStore.getState().transport.isPlaying).toBe(true);
    expect(audio.pushToast).not.toHaveBeenCalled();

    current?.resolve({ context, master });
    await vi.waitFor(() => expect(running().map((s) => s.startBeat)).toEqual([8]));
  });
});
