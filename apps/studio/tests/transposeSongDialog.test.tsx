// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createEmptyProject } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let TransposeSongDialog: typeof import('../src/features/transport/TransposeSongDialog')['TransposeSongDialog'];

// jsdom has no Web Locks; the repository fails closed without them.
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
  ({ TransposeSongDialog } = await import('../src/features/transport/TransposeSongDialog'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('移調ダイアログ')).toBe(true);
  useStore.setState({ project: { ...createEmptyProject({ key: 'C', scale: 'major' }), id: useStore.getState().project.id }, past: [], future: [] });
});

afterEach(async () => {
  cleanup();
  await useStore.getState().flushPendingSave();
});

describe('TransposeSongDialog', () => {
  it('previews the new key, shows the audio note and applies one undo step', () => {
    let closed = 0;
    render(<TransposeSongDialog project={useStore.getState().project} onClose={() => { closed += 1; }} />);
    expect(screen.getByText(/録音した音声.*高さは変わりません/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('移調する半音の数'), { target: { value: '2' } });
    expect(screen.getByLabelText('移調後のキー').textContent).toBe('D');
    act(() => { fireEvent.click(screen.getByRole('button', { name: '移調する' })); });
    expect(useStore.getState().project.key).toBe('D');
    expect(useStore.getState().past.length).toBe(1);
    expect(closed).toBe(1);
  });

  it('shows the Japanese reason and keeps the dialog open when refused', () => {
    let closed = 0;
    const project = useStore.getState().project;
    const clip = { id: 'hi', trackId: project.tracks[0]!.id, type: 'midi' as const, startBeat: 0, lengthBeats: 4, loop: false, notes: [{ id: 'n', pitch: 125, startBeat: 0, durationBeats: 1, velocity: 90 }] };
    useStore.setState({ project: { ...project, tracks: project.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) } });
    render(<TransposeSongDialog project={useStore.getState().project} onClose={() => { closed += 1; }} />);
    fireEvent.change(screen.getByLabelText('移調する半音の数'), { target: { value: '5' } });
    act(() => { fireEvent.click(screen.getByRole('button', { name: '移調する' })); });
    expect(screen.getByRole('alert').textContent).toContain('127');
    expect(closed).toBe(0);
    expect(useStore.getState().project.key).toBe('C');
  });
});
