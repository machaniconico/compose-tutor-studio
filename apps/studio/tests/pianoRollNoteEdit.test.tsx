// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let clipboard: typeof import('../src/state/noteClipboard');

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
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  clipboard = await import('../src/state/noteClipboard');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('ノート編集')).toBe(true);
  clipboard.setNoteClipboard(null);
});

afterEach(async () => {
  cleanup();
  await useStore.getState().flushPendingSave();
});

function setup() {
  const state = useStore.getState();
  const clip = state.project.tracks.find((track) => track.name === 'Melody')?.clips[0];
  if (!clip) throw new Error('MIDI clip fixture missing');
  state.selectClip(clip.id);
  state.setActiveView('pianoRoll');
  state.addNote(clip.id, { pitch: 61, startBeat: 0, durationBeats: 1, velocity: 90 });
  state.addNote(clip.id, { pitch: 64, startBeat: 1, durationBeats: 1, velocity: 90 });
  const ids = (useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)?.notes ?? [])
    .map((n) => n.id);
  useStore.getState().selectNotes(ids);
  const view = render(<PianoRoll />);
  const notes = () => useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)?.notes ?? [];
  return { clip, view, notes };
}

describe('piano roll selection edits', () => {
  it('copies with Ctrl+C, pastes at the moved playhead with Ctrl+V, and Ctrl+Shift+V keeps the original position', () => {
    const { view, notes } = setup();
    const note = view.container.querySelector<HTMLButtonElement>('.pr__note')!;
    note.focus();
    fireEvent.keyDown(note, { key: 'c', ctrlKey: true });
    expect(clipboard.getNoteClipboard()?.notes).toHaveLength(2);
    const message = () => view.container.querySelector('.pr__edit-message')?.textContent ?? '';
    expect(message()).toBe('2個の音をコピーしました。');

    // Playhead at the clip start: Ctrl+V lands on the same-pitch originals, refused.
    act(() => useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 0 } })));
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    expect(notes()).toHaveLength(2);
    expect(message()).toContain('同じ高さの音');

    // Move the playhead: Ctrl+V pastes there, one undo step.
    act(() => useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 4 } })));
    const pastBefore = useStore.getState().past.length;
    fireEvent.keyDown(note, { key: 'v', ctrlKey: true });
    expect(notes().map((n) => [n.pitch, n.startBeat])).toEqual([[61, 0], [64, 1], [61, 4], [64, 5]]);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);

    // Ctrl+Shift+V always uses the original position, so it overlaps and is refused.
    fireEvent.keyDown(window, { key: 'V', ctrlKey: true, shiftKey: true });
    expect(notes()).toHaveLength(4);
    expect(message()).toContain('同じ高さの音');
  });

  it('does not take Ctrl+C / Ctrl+V from a text input', () => {
    const { view, notes } = setup();
    const input = document.createElement('input');
    view.container.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
    expect(clipboard.getNoteClipboard()).toBeNull();
    clipboard.setNoteClipboard({ originTicks: 0, notes: [{ pitch: 70, offsetTicks: 0, durationTicks: 480, velocity: 80 }] });
    fireEvent.keyDown(input, { key: 'v', ctrlKey: true });
    expect(notes()).toHaveLength(2);
  });

  it('transposes and fits to the scale with the toolbar buttons, explaining the option', () => {
    const { notes } = setup();
    expect(screen.getAllByText(/スケール外の音は間違いではありません/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '選んだ音を半音上げる' }));
    expect(notes().map((n) => n.pitch)).toEqual([62, 65]);
    fireEvent.click(screen.getByRole('button', { name: '選んだ音を半音下げる' }));
    fireEvent.click(screen.getByRole('button', { name: 'スケールに合わせる(選んだ音だけ)' }));
    // The project's key decides the scale; C# leaves it only when it is outside.
    const after = notes().map((n) => n.pitch);
    expect(after[1]).toBe(64);
    fireEvent.click(screen.getByRole('button', { name: '選んだ音をスケールに沿って上げる' }));
    expect(notes().map((n) => n.pitch)).not.toEqual(after);
  });

  it('moves an octave and several scale steps in one click and one undo step each', () => {
    const { notes } = setup();
    const start = notes().map((n) => n.pitch);
    const past = useStore.getState().past.length;
    fireEvent.click(screen.getByRole('button', { name: '選んだ音を1オクターブ上げる' }));
    expect(notes().map((n) => n.pitch)).toEqual(start.map((p) => p + 12));
    expect(useStore.getState().past.length).toBe(past + 1);
    fireEvent.click(screen.getByRole('button', { name: '選んだ音を1オクターブ下げる' }));
    expect(notes().map((n) => n.pitch)).toEqual(start);
    // Seven scale steps up, then down: one undo step per click.
    fireEvent.change(screen.getByRole('combobox', { name: 'スケールに沿って動かす段数' }), { target: { value: '7' } });
    const beforeSteps = useStore.getState().past.length;
    fireEvent.click(screen.getByRole('button', { name: '選んだ音をスケールに沿って上げる' }));
    expect(useStore.getState().past.length).toBe(beforeSteps + 1);
    fireEvent.click(screen.getByRole('button', { name: '選んだ音をスケールに沿って下げる' }));
    expect(useStore.getState().past.length).toBe(beforeSteps + 2);
  });

  it('cuts with the button and undoes it in one step', () => {
    const { notes } = setup();
    const pastBefore = useStore.getState().past.length;
    fireEvent.click(screen.getByRole('button', { name: '切り取り' }));
    expect(notes()).toHaveLength(0);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    act(() => useStore.getState().undo());
    expect(notes()).toHaveLength(2);
  });
});
