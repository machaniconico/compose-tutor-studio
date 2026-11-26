// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { deserializeProject } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

// Changing meter / length never starts audio, so the engine is a stub here.
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

beforeEach(() => {
  act(() => {
    useStore.getState().createNewProject('テスト');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('time signature select', () => {
  it('offers 4/4 and 3/4 only (6/8 stays hidden)', () => {
    render(<TransportBar />);
    const select = screen.getByLabelText('拍子') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['4/4', '3/4']);
    expect(values).not.toContain('6/8');
    expect(select.value).toBe('4/4');
  });

  it('switches to 3/4 keeping beat positions and undoes in one step', () => {
    render(<TransportBar />);
    const select = screen.getByLabelText('拍子') as HTMLSelectElement;
    const chordStarts = useStore.getState().project.chordTrack.map((c) => c.startBeat);
    const pastBefore = useStore.getState().past.length;

    fireEvent.change(select, { target: { value: '3/4' } });
    expect(useStore.getState().project.timeSignature).toEqual([3, 4]);
    expect(useStore.getState().project.lengthBars).toBe(11);
    expect(useStore.getState().project.chordTrack.map((c) => c.startBeat)).toEqual(chordStarts);
    expect(select.value).toBe('3/4');
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    act(() => {
      useStore.getState().undo();
    });
    expect(useStore.getState().project.timeSignature).toEqual([4, 4]);
    expect(select.value).toBe('4/4');
  });
});

describe('song length input', () => {
  it('lets a converted legacy song be edited above the usual 64-bar limit', () => {
    const project = deserializeProject(JSON.stringify({
      ...useStore.getState().project,
      schemaVersion: 1,
      timeSignature: [6, 8],
      lengthBars: 33,
    }));
    act(() => useStore.getState().loadProjectForPreview(project));
    render(<TransportBar />);
    const input = screen.getByLabelText('小節数') as HTMLInputElement;
    expect(input.value).toBe('66');
    expect(input.max).toBe('66');

    fireEvent.change(input, { target: { value: '65' } });
    fireEvent.blur(input);
    expect(useStore.getState().project.lengthBars).toBe(65);
  });

  it('commits on blur, clamps to 4..64, and asks before deleting content past the end', () => {
    render(<TransportBar />);
    const input = screen.getByLabelText('小節数') as HTMLInputElement;
    expect(input.value).toBe('8');
    expect(input.min).toBe('4');
    expect(input.max).toBe('64');

    // Growing never asks.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useStore.getState().project.lengthBars).toBe(64);
    expect(input.value).toBe('64');

    // Shrinking past the preset chords asks first; "cancel" keeps everything.
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/コード/);
    expect(useStore.getState().project.lengthBars).toBe(64);
    expect(input.value).toBe('64');

    // Confirming deletes the chords in bars 5+ in one undoable step.
    confirmSpy.mockReturnValue(true);
    const pastBefore = useStore.getState().past.length;
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(useStore.getState().project.lengthBars).toBe(4);
    expect(useStore.getState().project.chordTrack.every((c) => c.startBeat < 16)).toBe(true);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    act(() => {
      useStore.getState().undo();
    });
    expect(useStore.getState().project.lengthBars).toBe(64);
    expect(useStore.getState().project.chordTrack.length).toBe(8);
  });
});
