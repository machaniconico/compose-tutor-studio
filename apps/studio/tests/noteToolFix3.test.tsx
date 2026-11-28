// @vitest-environment jsdom
// P34 review item 3: arrow bindings run only while focus is inside the piano roll.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clip } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let mod: typeof import('../src/features/pianoRoll/PianoRoll');
beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  mod = await import('../src/features/pianoRoll/PianoRoll');
});
afterEach(cleanup);

function melody(): Clip {
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'midi')!;
}
function currentNotes() {
  const id = melody().id;
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.notes ?? [];
}

describe('arrow keys stay inside the piano roll', () => {
  beforeEach(async () => {
    installLocalStorage();
    await act(async () => { await useStore.getState().createNewProject('矢印'); });
    const clip = melody();
    act(() => {
      useStore.setState((s) => ({
        project: { ...s.project, tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, notes: [] } : c)) })) },
        midiRecordingActive: false,
      }));
      useStore.getState().addNote(clip.id, { pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 90 });
      useStore.getState().selectClip(clip.id);
    });
    act(() => {
      useStore.getState().selectNotes(currentNotes().map((n) => n.id));
      useStore.setState({ past: [], future: [] });
    });
  });

  it('does nothing when focus is outside the piano roll (e.g. an Inspector panel)', () => {
    render(<mod.PianoRoll />);
    const panel = document.createElement('div');
    panel.setAttribute('role', 'tabpanel');
    panel.tabIndex = 0;
    document.body.appendChild(panel);
    panel.focus();
    expect(document.activeElement).toBe(panel);
    const before = useStore.getState().project;
    for (const init of [{ key: 'ArrowRight' }, { key: 'ArrowLeft' }, { key: 'ArrowUp' }, { key: 'ArrowDown' }, { key: 'ArrowUp', shiftKey: true }, { key: 'ArrowDown', shiftKey: true }]) {
      fireEvent.keyDown(panel, init);
    }
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past.length).toBe(0);
    panel.remove();
  });

  it("a focused note keeps main's handler: one move and one undo step per key, no double application", () => {
    render(<mod.PianoRoll />);
    const noteButton = screen.getAllByRole('button').find((b) => /開始/.test(b.getAttribute('aria-label') ?? ''))!;
    noteButton.focus();
    fireEvent.keyDown(noteButton, { key: 'ArrowRight' });
    expect(currentNotes()[0]!.startBeat).toBe(1);
    expect(useStore.getState().past.length).toBe(1);
    fireEvent.keyDown(noteButton, { key: 'ArrowUp' });
    expect(currentNotes()[0]!.pitch).toBe(61);
    expect(useStore.getState().past.length).toBe(2);
  });

  it('with focus inside the piano roll but not on a note, arrows nudge and transpose once each', () => {
    const { container } = render(<mod.PianoRoll />);
    const root = container.querySelector<HTMLElement>('.pr')!;
    root.tabIndex = -1;
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(currentNotes()[0]!.startBeat).toBe(1);
    fireEvent.keyDown(root, { key: 'ArrowUp', shiftKey: true });
    expect(currentNotes()[0]!.pitch).toBe(72);
    expect(useStore.getState().past.length).toBe(2);
  });
});
