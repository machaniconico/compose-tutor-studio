import { describe, expect, it } from 'vitest';
import type { ChordEvent } from '@cts/project-model';
import { findChordAtBeat } from '../src/features/pianoRoll/useScaleInfo';

const chord = (id: string, startBeat: number, durationBeats: number): ChordEvent => ({
  id, startBeat, durationBeats, symbol: id, root: 'C', quality: 'major', notes: [0, 4, 7],
});
const chords = [chord('C', 0, 4), chord('F', 4, 4)];

describe('findChordAtBeat(再生と同じ 480 PPQ・Math.round の tick で、開始含む・終了含まず)', () => {
  it('境界の直前 3.9999995 は tick 2000 に丸まるので次のコード', () => {
    expect(findChordAtBeat(chords, 3.9999995)?.id).toBe('F');
  });
  it('3.99 は C、4 は F、8 はどれにも属さない', () => {
    expect(findChordAtBeat(chords, 3.99)?.id).toBe('C');
    expect(findChordAtBeat(chords, 4)?.id).toBe('F');
    expect(findChordAtBeat(chords, 8)).toBeUndefined();
  });
  it('NaN・負は undefined', () => {
    expect(findChordAtBeat(chords, Number.NaN)).toBeUndefined();
    expect(findChordAtBeat(chords, -1)).toBeUndefined();
  });
});
