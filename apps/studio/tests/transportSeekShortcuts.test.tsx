// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

// Seeking while stopped only moves the transport, so audio never starts here.
vi.mock('../src/audio/engine', () => ({
  getAudioEngine: () => ({
    isInitialized: false,
    now: () => 0,
    ensureContext: async () => ({ context: { currentTime: 0 }, master: {} }),
  }),
}));

let useStore: typeof import('../src/state/store')['useStore'];
let TransportBar: typeof import('../src/features/transport/TransportBar')['TransportBar'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ TransportBar } = await import('../src/features/transport/TransportBar'));
});

function press(key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(window, { key, bubbles: true, cancelable: true, ...init });
}

describe('seek shortcuts through the mounted transport bar', () => {
  let bpb: number;
  let lengthBeats: number;

  beforeEach(() => {
    const { project } = useStore.getState();
    bpb = project.timeSignature[0];
    lengthBeats = project.lengthBars * bpb;
    act(() => {
      if (useStore.getState().transport.isPlaying) useStore.getState().stop();
      useStore.getState().setPosition(0);
    });
  });

  it('moves a bar at a time with Ctrl+Right / Ctrl+Left and rewinds with Home', () => {
    const { getByLabelText } = render(<TransportBar />);
    const display = getByLabelText('再生位置(小節.拍)');
    const pastBefore = useStore.getState().past.length;

    press('ArrowRight', { ctrlKey: true });
    press('ArrowRight', { ctrlKey: true });
    expect(useStore.getState().transport.positionBeat).toBe(2 * bpb);
    expect(display.textContent).toBe('3.1');

    press('ArrowLeft', { ctrlKey: true });
    expect(useStore.getState().transport.positionBeat).toBe(bpb);
    expect(display.textContent).toBe('2.1');

    press('Home');
    expect(useStore.getState().transport.positionBeat).toBe(0);
    expect(display.textContent).toBe('1.1');

    // Seeking is transport state: nothing lands in undo history.
    expect(useStore.getState().past.length).toBe(pastBefore);
  });

  it('clamps to the song boundaries and ignores plain arrow keys', () => {
    render(<TransportBar />);

    press('ArrowLeft', { ctrlKey: true });
    expect(useStore.getState().transport.positionBeat).toBe(0);

    act(() => useStore.getState().setPosition(lengthBeats - bpb));
    press('ArrowRight', { ctrlKey: true });
    expect(useStore.getState().transport.positionBeat).toBe(lengthBeats);
    press('ArrowRight', { ctrlKey: true });
    expect(useStore.getState().transport.positionBeat).toBe(lengthBeats);

    act(() => useStore.getState().setPosition(bpb));
    press('ArrowRight');
    press('ArrowLeft');
    expect(useStore.getState().transport.positionBeat).toBe(bpb);
  });

  it('leaves the keys alone while typing in a text field', () => {
    const { getByLabelText } = render(<TransportBar />);
    act(() => useStore.getState().setPosition(bpb));

    const title = getByLabelText('プロジェクト名');
    fireEvent.keyDown(title, { key: 'Home', bubbles: true, cancelable: true });
    expect(useStore.getState().transport.positionBeat).toBe(bpb);
  });
});
