// @vitest-environment jsdom
// P34 review item 10: on a triplet grid the cursor clamp at the clip end is computed in ticks.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PPQ, type Clip } from '@cts/project-model';
import { cursorEndStart } from '../src/features/pianoRoll/gridMath';
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

describe('cursorEndStart', () => {
  it('is main\'s float clamp on existing grids and whole ticks on triplet grids', () => {
    for (const grid of [0.25, 0.5, 1, 2]) for (const len of [1, 3.5, 8]) expect(cursorEndStart(len, grid)).toBe(Math.max(0, len - Math.min(grid, len)));
    expect(cursorEndStart(1, 1 / 3)).toBe(320 / PPQ);
    expect(cursorEndStart(1, 1 / 6)).toBe(400 / PPQ);
    expect(cursorEndStart(0.1, 1 / 3)).toBe(0);
  });
});

describe('End then Enter on a 1-beat clip, 1/8T grid', () => {
  beforeEach(async () => {
    installLocalStorage();
    await act(async () => { await useStore.getState().createNewProject('端'); });
    const clip = melody();
    act(() => {
      useStore.setState((s) => ({
        project: { ...s.project, tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, lengthBeats: 1, loop: false, notes: [] } : c)) })) },
        past: [], future: [], midiRecordingActive: false,
      }));
      useStore.getState().selectClip(clip.id);
    });
  });
  it('stores exactly 320/480 and 160/480', () => {
    const { container } = render(<mod.PianoRoll />);
    fireEvent.change(screen.getByLabelText('グリッド分解能'), { target: { value: String(160 / PPQ) } });
    const grid = container.querySelector<HTMLElement>('.pr__grid')!;
    grid.focus();
    fireEvent.keyDown(grid, { key: 'End' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    const added = melody().notes!.find(() => true)!;
    const clip = useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === melody().id)!;
    const note = clip.notes![0]!;
    expect(added).toBeTruthy();
    expect(note.startBeat).toBe(320 / PPQ);
    expect(note.durationBeats).toBe(160 / PPQ);
  });
});
