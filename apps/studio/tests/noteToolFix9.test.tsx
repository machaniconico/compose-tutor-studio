// @vitest-environment jsdom
// P34 review item 9: on the existing power-of-two grids every grid-derived path is main's float arithmetic, bit for bit.
import { beforeAll, describe, expect, it } from 'vitest';
import { MIN_EVENT_DURATION_BEATS, type NoteEvent } from '@cts/project-model';
import { floorToGrid, snapBeat } from '../src/features/pianoRoll/gridMath';
import { installLocalStorage } from './localStorageStub';

let mod: typeof import('../src/features/pianoRoll/PianoRoll');
beforeAll(async () => {
  installLocalStorage();
  mod = await import('../src/features/pianoRoll/PianoRoll');
});

const note = (id: string, startBeat: number, durationBeats: number): NoteEvent => ({ id, pitch: 60, startBeat, durationBeats, velocity: 90 });
type Drag = Parameters<typeof mod.buildNoteGesturePreview>[0];
const dragOf = (kind: 'move' | 'resize', source: NoteEvent, gridSnap: number): Drag =>
  ({ kind, noteId: source.id, snapshot: [source], startX: 0, startY: 0, ppb: 100, rowHeight: 12, clipLengthBeats: 8, gridSnap, scaleSnap: false, scalePcs: new Set(), duplicate: false }) as unknown as Drag;

// main's original formulas, copied from origin/main
const mainSnap = (beat: number, snap: number) => Math.max(0, Math.round(beat / snap) * snap);
const mainFloor = (beat: number, snap: number) => Math.max(0, Math.floor(beat / snap) * snap);

describe('item 9: the four existing grids are byte-identical to main', () => {
  it('19/480 on the 0.25 grid, → : 19/480 + 0.25 exactly as main', () => {
    const moved = mod.translateNoteGroup({
      snapshot: [note('a', 19 / 480, 1)], anchorId: 'a', requestedBeatDelta: 0.25, requestedPitchDelta: 0, clipLengthBeats: 8, scaleSnap: false, scalePcs: new Set(), gridSnap: 0.25,
    });
    expect(moved[0]!.startBeat).toBe(19 / 480 + 0.25);
    expect(moved[0]!.startBeat).toBe(0.2895833333333333);
  });

  it('random positions: snap, move, resize, keyboard move and keyboard resize match main bitwise', () => {
    let seed = 99173;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const grid of [0.25, 0.5, 1, 2]) {
      for (let i = 0; i < 400; i += 1) {
        const start = rnd() < 0.6 ? Math.floor(rnd() * 3000) / 480 : rnd() * 6;
        const duration = rnd() < 0.6 ? (1 + Math.floor(rnd() * 900)) / 480 : 0.01 + rnd();
        const dx = (rnd() - 0.4) * 400;
        const raw = dx / 100;
        expect(snapBeat(raw * 3, grid)).toBe(mainSnap(raw * 3, grid));
        expect(floorToGrid(raw * 3, grid)).toBe(mainFloor(raw * 3, grid));
        const source = note('a', start, duration);

        const move = mod.buildNoteGesturePreview(dragOf('move', source, grid), { clientX: dx, clientY: 0, shiftKey: false });
        const requested = mainSnap(start + raw, grid) - start;
        const delta = Math.max(-start, Math.min(8 - duration - start, requested));
        expect(move.notes[0]!.startBeat).toBe(start + delta);

        const resize = mod.buildNoteGesturePreview(dragOf('resize', source, grid), { clientX: dx, clientY: 0, shiftKey: false });
        const remaining = Math.max(MIN_EVENT_DURATION_BEATS, 8 - start);
        let wanted = duration + raw;
        wanted = Math.max(MIN_EVENT_DURATION_BEATS, mainSnap(start + wanted, grid) - start);
        expect(resize.notes[0]!.durationBeats).toBe(Math.min(remaining, wanted));

        for (const step of [grid, -grid]) {
          const keyed = mod.translateNoteGroup({
            snapshot: [source], anchorId: 'a', requestedBeatDelta: step, requestedPitchDelta: 0, clipLengthBeats: 8, scaleSnap: false, scalePcs: new Set(), gridSnap: grid,
          });
          const keyDelta = Math.max(-start, Math.min(8 - duration - start, step));
          expect(keyed[0]!.startBeat).toBe(start + keyDelta);
          const grown = mod.resizeNoteGroup([source], step, 8, grid);
          const growDelta = Math.max(MIN_EVENT_DURATION_BEATS - duration, Math.min(8 - start - duration, step));
          expect(grown[0]!.durationBeats).toBe(duration + growDelta);
        }
      }
    }
  });
});
