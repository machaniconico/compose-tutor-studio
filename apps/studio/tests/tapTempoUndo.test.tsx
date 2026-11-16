// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

// Tapping and loop edits never start audio, so the engine is a stub here.
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: false,
    now: () => 0,
    ensureContext: async () => ({ context: { currentTime: 0 }, master: {} }),
  }),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let TransportBar: typeof import('../src/features/transport/TransportBar')['TransportBar'];
let TimelineRuler: typeof import('../src/features/transport/TimelineRuler')['TimelineRuler'];
let pxPerBeat: typeof import('../src/features/timeline')['pxPerBeat'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TransportBar } = await import('../src/features/transport/TransportBar'));
  ({ TimelineRuler } = await import('../src/features/transport/TimelineRuler'));
  ({ pxPerBeat } = await import('../src/features/timeline'));
});

let nowMs = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  nowMs = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  act(() => {
    useStore.getState().createNewProject('テスト');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Tap the tap-tempo button `count` times, `gapMs` apart (600ms is 100 BPM). */
function tap(count: number, gapMs = 600): void {
  const button = screen.getByRole('button', { name: 'タップテンポ' });
  for (let i = 0; i < count; i += 1) {
    nowMs += gapMs;
    fireEvent.pointerDown(button);
    fireEvent.click(button);
  }
}

function undo(): void {
  act(() => useStore.getState().undo());
}

function redo(): void {
  act(() => useStore.getState().redo());
}

describe('tap tempo followed by loop operations', () => {
  it.each(['Enter', ' '])('%j on the focused tap button only taps and keeps one undo step', (key) => {
    render(<TransportBar />);
    const button = screen.getByRole('button', { name: 'タップテンポ' });
    button.focus();
    const pastBefore = useStore.getState().past.length;
    for (let i = 0; i < 3; i += 1) {
      nowMs += 600;
      // jsdom does not synthesize a native button click from keyboard input.
      // Verify keydown remains uncancelled, then supply that native click.
      expect(fireEvent.keyDown(button, { key, code: key === ' ' ? 'Space' : 'Enter' })).toBe(true);
      fireEvent.keyUp(button, { key });
      fireEvent.click(button, { detail: 0 });
      expect(useStore.getState().transport.isPlaying).toBe(false);
    }
    expect(useStore.getState().project.bpm).toBe(100);
    act(() => vi.advanceTimersByTime(3000));
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    undo();
    expect(useStore.getState().project.bpm).toBe(120);
  });

  it('needs two taps again after a long gap', () => {
    render(<TransportBar />);
    tap(2);
    expect(useStore.getState().project.bpm).toBe(100);
    act(() => vi.advanceTimersByTime(3000));
    nowMs += 4000;
    tap(1, 500);
    expect(useStore.getState().project.bpm).toBe(100);
    tap(1, 500);
    expect(useStore.getState().project.bpm).toBe(120);
    act(() => vi.advanceTimersByTime(3000));
    undo();
    expect(useStore.getState().project.bpm).toBe(100);
  });

  it('a ruler drag right after tapping is its own undo step', () => {
    render(
      <>
        <TransportBar />
        <TimelineRuler />
      </>,
    );
    const pastBefore = useStore.getState().past.length;
    tap(3);
    expect(useStore.getState().project.bpm).toBe(100);

    // Drag from bar 2 to bar 3 within the tap pause window.
    const ruler = screen.getByTestId('timeline-ruler');
    const barPx = 4 * pxPerBeat(useStore.getState().editor.zoomX);
    fireEvent.pointerDown(ruler, { button: 0, clientX: barPx + 1, pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: 2 * barPx + 1, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: 2 * barPx + 1, pointerId: 1 });
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });

    act(() => {
      vi.advanceTimersByTime(3000); // the tap run's own close is a no-op now
    });
    expect(useStore.getState().past.length).toBe(pastBefore + 2);

    undo();
    expect(useStore.getState().project.loopRange).toBeUndefined();
    expect(useStore.getState().project.bpm).toBe(100);
    undo();
    expect(useStore.getState().project.bpm).toBe(120);
    redo();
    expect(useStore.getState().project.bpm).toBe(100);
    expect(useStore.getState().project.loopRange).toBeUndefined();
    redo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
  });

  it('clearing the range right after tapping is its own undo step', () => {
    act(() => useStore.getState().setLoopRange({ startBeat: 4, endBeat: 12 }));
    render(<TransportBar />);
    tap(3);

    const clear = screen.getByRole('button', { name: 'ループ範囲をクリア' });
    fireEvent.pointerDown(clear);
    fireEvent.click(clear);
    expect(useStore.getState().project.loopRange).toBeUndefined();

    undo();
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 4, endBeat: 12 });
    expect(useStore.getState().project.bpm).toBe(100);
    undo();
    expect(useStore.getState().project.bpm).toBe(120);
  });

  it('turning loop on right after tapping makes the default range its own undo step', () => {
    render(<TransportBar />);
    tap(3);

    const loop = screen.getByRole('button', { name: 'ループ' });
    fireEvent.pointerDown(loop);
    fireEvent.click(loop);
    expect(useStore.getState().project.loopRange).toEqual({ startBeat: 0, endBeat: 4 });

    undo();
    expect(useStore.getState().project.loopRange).toBeUndefined();
    expect(useStore.getState().project.bpm).toBe(100);
  });

  it('any other click or key after tapping closes the tap run first', () => {
    render(<TransportBar />);
    const pastBefore = useStore.getState().past.length;
    tap(3);
    fireEvent.keyDown(document.body, { key: 'a' });
    act(() => {
      useStore.getState().setLengthBars(4, true);
    });
    expect(useStore.getState().past.length).toBe(pastBefore + 2);
    undo();
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(useStore.getState().project.bpm).toBe(100);

    nowMs += 5000; // a new tap run
    tap(3, 500);
    expect(useStore.getState().project.bpm).toBe(120);
    fireEvent.pointerDown(document.body);
    act(() => {
      useStore.getState().setLengthBars(4, true);
    });
    undo();
    expect(useStore.getState().project.lengthBars).toBe(8);
    expect(useStore.getState().project.bpm).toBe(120);
  });

  it('Undo / Redo with the tap button focused undo and redo only the tap run', () => {
    render(<TransportBar />);
    act(() => useStore.getState().setTitle('prior edit'));
    tap(3);
    expect(useStore.getState().project.bpm).toBe(100);

    const button = screen.getByRole('button', { name: 'タップテンポ' });
    button.focus();
    fireEvent.keyDown(button, { key: 'z', ctrlKey: true });
    expect(useStore.getState().project.bpm).toBe(120);
    expect(useStore.getState().project.title).toBe('prior edit');

    fireEvent.keyDown(button, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(useStore.getState().project.bpm).toBe(100);
    expect(useStore.getState().project.title).toBe('prior edit');
  });

  it('a window blur during a tap run keeps the tempo as one undo step', () => {
    render(<TransportBar />);
    const pastBefore = useStore.getState().past.length;
    tap(3);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(useStore.getState().project.bpm).toBe(100);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    expect(useStore.getState().transactionBase).toBeNull();
    undo();
    expect(useStore.getState().project.bpm).toBe(120);
  });

  it('taps after an intervening operation start a fresh run', () => {
    render(<TransportBar />);
    tap(3); // 100 BPM
    fireEvent.pointerDown(document.body);
    // Within the 3 s pause: the old run's taps must not be reused.
    tap(1, 500);
    expect(useStore.getState().project.bpm).toBe(100);
    tap(1, 500);
    expect(useStore.getState().project.bpm).toBe(120);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    undo();
    expect(useStore.getState().project.bpm).toBe(100);
  });

  it('keeps one undo step for a whole run of taps', () => {
    render(<TransportBar />);
    const pastBefore = useStore.getState().past.length;
    tap(5);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    undo();
    expect(useStore.getState().project.bpm).toBe(120);
  });
});
