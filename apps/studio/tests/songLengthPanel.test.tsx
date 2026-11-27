// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let SongLengthPanel: typeof import('../src/features/tempoMap/SongLengthPanel')['SongLengthPanel'];

// jsdom has no Web Locks; give the repository a serial in-process lock.
function installSerialLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(_name: string, _options: unknown, callback: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => callback());
      tail = run.catch(() => undefined);
      return run;
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

beforeAll(async () => {
  installSerialLocks();
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ SongLengthPanel } = await import('../src/features/tempoMap/SongLengthPanel'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('パネル')).toBe(true);
  expect(useStore.getState().applyProjectChange((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({ ...t, clips: [] })),
    chordTrack: [],
    sections: [],
  }))).toBe(true);
});

afterEach(() => cleanup());

describe('SongLengthPanel', () => {
  it('shows bars, adds and removes one bar, and explains a refused shortening', async () => {
    const user = userEvent.setup();
    const start = useStore.getState().project.lengthBars;
    render(<SongLengthPanel />);
    expect(screen.getByText(`${start}小節`)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '末尾に1小節追加' }));
    expect(useStore.getState().project.lengthBars).toBe(start + 1);
    expect(screen.getByText(`${start + 1}小節`)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '末尾の1小節を削除' }));
    expect(useStore.getState().project.lengthBars).toBe(start);

    // Put a chord in the last bar: shortening removes it and says so.
    const lastBar = (start - 1) * 4;
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      chordTrack: [{
        id: 'chord-x', startBeat: lastBar, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'min', notes: [57, 60, 64],
      }],
    }));
    await user.click(screen.getByRole('button', { name: '末尾の1小節を削除' }));
    expect(useStore.getState().project.lengthBars).toBe(start - 1);
    expect(useStore.getState().project.chordTrack).toEqual([]);
    expect((await screen.findByRole('status')).textContent).toContain(
      'コード 1 個を取り除きました(元に戻すで復元できます)',
    );

    // A note in the last bar still refuses, naming the bar and track.
    const track = useStore.getState().project.tracks.find((t) => t.type === 'instrument')!;
    useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, clips: [{
        id: 'held', trackId: t.id, type: 'midi' as const, startBeat: 0, lengthBeats: p.lengthBeats, loop: false,
        notes: [{ id: 'hn', pitch: 60, startBeat: p.lengthBeats - 2, durationBeats: 1, velocity: 90 }],
      }] } : t)),
    }));
    await user.click(screen.getByRole('button', { name: '末尾の1小節を削除' }));
    expect(useStore.getState().project.lengthBars).toBe(start - 1);
    expect((await screen.findByRole('alert')).textContent).toContain(track.name);
  });

  it('disables the controls while recording', () => {
    useStore.setState({ audioRecordingOperationId: 3 });
    render(<SongLengthPanel />);
    expect((screen.getByRole('button', { name: '末尾に1小節追加' }) as HTMLButtonElement).disabled).toBe(true);
    useStore.setState({ audioRecordingOperationId: null });
  });
});
