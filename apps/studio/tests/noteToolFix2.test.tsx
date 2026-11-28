// @vitest-environment jsdom
// P34 review item 2: grid-derived positions and lengths are computed in integer ticks and converted once.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PPQ, type Clip, type NoteEvent } from '@cts/project-model';
import { addGridBeats, beatDifference, floorToGrid, snapBeat } from '../src/features/pianoRoll/gridMath';
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

const note = (id: string, pitch: number, startBeat: number, durationBeats: number): NoteEvent => ({ id, pitch, startBeat, durationBeats, velocity: 90 });
type Drag = Parameters<typeof mod.buildNoteGesturePreview>[0];
const drag = (kind: 'move' | 'resize', source: NoteEvent, gridSnap: number): Drag =>
  ({ kind, noteId: source.id, snapshot: [source], startX: 0, startY: 0, ppb: 100, rowHeight: 12, clipLengthBeats: 8, gridSnap, scaleSnap: false, scalePcs: new Set(), duplicate: false }) as unknown as Drag;

describe('grid arithmetic helpers', () => {
  it('addGridBeats / beatDifference are exact on triplet grids and leave other values alone', () => {
    let beat = 0;
    for (let i = 1; i <= 200; i += 1) {
      beat = addGridBeats(beat, 1 / 6);
      expect(beat).toBe((i * 80) / PPQ);
    }
    expect(beatDifference(1, 1 / 3)).toBe(320 / PPQ);
    expect(addGridBeats(0.999999999, 0)).toBe(0.999999999);
    expect(addGridBeats(0.3001, 0.25)).toBe(0.3001 + 0.25);
    expect(beatDifference(0.3001, 0.1)).toBe(0.3001 - 0.1);
  });
  it('gives the same doubles as main for the four existing grids', () => {
    for (const grid of [0.25, 0.5, 1, 2]) {
      for (let k = 0; k < 400; k += 1) {
        const start = (k % 37) * 0.125;
        const raw = k * 0.0937;
        expect(snapBeat(raw, grid)).toBe(Math.max(0, Math.round(raw / grid) * grid));
        expect(floorToGrid(raw, grid)).toBe(Math.max(0, Math.floor(raw / grid) * grid));
        const snapped = snapBeat(start + raw, grid);
        expect(beatDifference(snapped, start)).toBe(snapped - start);
        expect(addGridBeats(start, grid)).toBe(start + grid);
        expect(addGridBeats(start, -grid)).toBe(start - grid);
        expect(addGridBeats(start, beatDifference(snapped, start))).toBe(start + (snapped - start));
        // the drag previews (move and resize) match main's formulas on these grids
        const source = note('a', 60, start, 1);
        const move = mod.buildNoteGesturePreview(drag('move', source, grid), { clientX: raw * 100, clientY: 0, shiftKey: false });
        const wantedStart = start + Math.max(-start, Math.min(8 - 1 - start, snapBeat(start + raw, grid) - start));
        expect(move.notes[0]!.startBeat).toBe(wantedStart);
        const resize = mod.buildNoteGesturePreview(drag('resize', source, grid), { clientX: raw * 100, clientY: 0, shiftKey: false });
        const wantedDuration = Math.min(Math.max(1 / PPQ, 8 - start), Math.max(1 / PPQ, snapBeat(start + (1 + (raw * 100) / 100), grid) - start));
        expect(resize.notes[0]!.durationBeats).toBe(wantedDuration);
      }
    }
  });
});

describe('triplet drags and steps land on whole ticks', () => {
  it('drag-resize from a 1/3 onset on the 1/3 grid gives 320 ticks', () => {
    const preview = mod.buildNoteGesturePreview(drag('resize', note('a', 60, 1 / 3, 1), 1 / 3), { clientX: -40, clientY: 0, shiftKey: false });
    expect(preview.notes[0]!.durationBeats).toBe(320 / PPQ);
  });
  it('drag-move onto the 1/6 grid gives whole-tick onsets', () => {
    const preview = mod.buildNoteGesturePreview(drag('move', note('a', 60, 0, 1), 1 / 6), { clientX: 83, clientY: 0, shiftKey: false });
    expect(preview.notes[0]!.startBeat).toBe(400 / PPQ);
  });
  it('keyboard translate / resize by grid steps stay on whole ticks', () => {
    let notes = [note('a', 60, 0, 1 / 3)];
    for (let i = 0; i < 7; i += 1) {
      notes = mod.translateNoteGroup({ snapshot: notes, anchorId: 'a', requestedBeatDelta: 1 / 6, requestedPitchDelta: 0, clipLengthBeats: 8, scaleSnap: false, scalePcs: new Set() });
    }
    expect(notes[0]!.startBeat).toBe(560 / PPQ);
    expect(mod.resizeNoteGroup(notes, 1 / 6, 8)[0]!.durationBeats).toBe(240 / PPQ);
  });
});

function melody(): Clip {
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'midi')!;
}
function currentNotes() {
  const id = melody().id;
  return useStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.notes ?? [];
}

describe('the grid cursor', () => {
  beforeEach(async () => {
    installLocalStorage();
    await act(async () => { await useStore.getState().createNewProject('カーソル'); });
    const clip = melody();
    act(() => {
      useStore.setState((s) => ({
        project: { ...s.project, tracks: s.project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, notes: [] } : c)) })) },
        past: [], future: [], midiRecordingActive: false,
      }));
      useStore.getState().addNote(clip.id, { pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 90 });
      useStore.getState().selectClip(clip.id);
    });
  });
  it('on 1/16T stores whole-tick positions (5 steps = 400 ticks) and a 80-tick length', () => {
    const { container } = render(<mod.PianoRoll />);
    fireEvent.change(screen.getByLabelText('グリッド分解能'), { target: { value: String(80 / PPQ) } });
    const grid = container.querySelector<HTMLElement>('.pr__grid')!;
    grid.focus();
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    const added = currentNotes().find((n) => n.startBeat > 0.5)!;
    expect(added.startBeat).toBe(400 / PPQ);
    expect(added.durationBeats).toBe(80 / PPQ);
  });
});
