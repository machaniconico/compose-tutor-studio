// @vitest-environment jsdom
// P34 review item 1: main's move / resize paths are untouched (no tick-drift rounding).
import { beforeAll, describe, expect, it } from 'vitest';
import type { NoteEvent } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let mod: typeof import('../src/features/pianoRoll/PianoRoll');
beforeAll(async () => {
  installLocalStorage();
  mod = await import('../src/features/pianoRoll/PianoRoll');
});

const note = (id: string, pitch: number, startBeat: number, durationBeats: number): NoteEvent => ({ id, pitch, startBeat, durationBeats, velocity: 90 });

describe('item 1: main move/resize paths are untouched', () => {
  it('a pitch-only move keeps onset and duration bit for bit', () => {
    const odd = [note('a', 60, 0.999999999, 1.000000001), note('b', 62, 0.3001, 0.7)];
    const moved = mod.translateNoteGroup({
      snapshot: odd, anchorId: 'a', requestedBeatDelta: 0, requestedPitchDelta: 1, clipLengthBeats: 8, scaleSnap: false, scalePcs: new Set(),
    });
    expect(moved.map((n) => [n.startBeat, n.durationBeats])).toEqual([[0.999999999, 1.000000001], [0.3001, 0.7]]);
    expect(moved.map((n) => n.pitch)).toEqual([61, 63]);
    const resized = mod.resizeNoteGroup(odd, 0, 8);
    expect(resized.map((n) => n.durationBeats)).toEqual([1.000000001, 0.7]);
  });
  it('a time move is plain float addition, as on main', () => {
    const moved = mod.translateNoteGroup({
      snapshot: [note('a', 60, 0.999999999, 1)], anchorId: 'a', requestedBeatDelta: 0.25, requestedPitchDelta: 0, clipLengthBeats: 8, scaleSnap: false, scalePcs: new Set(),
    });
    expect(moved[0]!.startBeat).toBe(0.999999999 + 0.25);
  });
});
