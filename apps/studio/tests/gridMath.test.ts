import { describe, expect, it } from 'vitest';
import {
  snapBeat,
  floorToGrid,
  quantizeStart,
  xToBeat,
  beatToX,
  yToPitch,
  pitchToY,
  clampPitch,
  snapPitchToPitchClasses,
  rectsOverlap,
  normalizeRect,
  PIANO_HIGH_MIDI,
  PIANO_LOW_MIDI,
} from '../src/features/pianoRoll/gridMath';

describe('snapBeat / quantizeStart', () => {
  it('snaps to the nearest grid line', () => {
    expect(snapBeat(0.6, 1)).toBe(1);
    expect(snapBeat(0.4, 1)).toBe(0);
    expect(snapBeat(1.3, 0.5)).toBe(1.5);
    expect(quantizeStart(2.2, 1)).toBe(2);
  });

  it('never returns negatives', () => {
    expect(snapBeat(-1, 1)).toBe(0);
  });

  it('passes through when snap is non-positive', () => {
    expect(snapBeat(3.7, 0)).toBe(3.7);
  });
});

describe('floorToGrid', () => {
  it('floors to the grid line at or before', () => {
    expect(floorToGrid(1.9, 1)).toBe(1);
    expect(floorToGrid(1.4, 0.5)).toBe(1);
    expect(floorToGrid(0.9, 0.25)).toBe(0.75);
  });
});

describe('pixel <-> beat conversion round-trips', () => {
  it('xToBeat and beatToX are inverse', () => {
    expect(beatToX(4, 28)).toBe(112);
    expect(xToBeat(112, 28)).toBe(4);
  });

  it('xToBeat guards divide-by-zero', () => {
    expect(xToBeat(50, 0)).toBe(0);
  });
});

describe('pitch <-> y conversion', () => {
  it('top row is the highest pitch', () => {
    expect(yToPitch(0, 14)).toBe(PIANO_HIGH_MIDI);
    expect(pitchToY(PIANO_HIGH_MIDI, 14)).toBe(0);
  });

  it('descends one pitch per row', () => {
    expect(yToPitch(14, 14)).toBe(PIANO_HIGH_MIDI - 1);
    expect(pitchToY(PIANO_HIGH_MIDI - 2, 14)).toBe(28);
  });
});

describe('clampPitch', () => {
  it('clamps into the editable range', () => {
    expect(clampPitch(200)).toBe(PIANO_HIGH_MIDI);
    expect(clampPitch(0)).toBe(PIANO_LOW_MIDI);
    expect(clampPitch(60)).toBe(60);
  });
});

describe('snapPitchToPitchClasses', () => {
  const cMajor = new Set([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B

  it('keeps an in-scale pitch unchanged', () => {
    expect(snapPitchToPitchClasses(60, cMajor)).toBe(60); // C4
    expect(snapPitchToPitchClasses(64, cMajor)).toBe(64); // E4
  });

  it('snaps an out-of-scale pitch to the nearest in-scale pitch', () => {
    // 61 = C#4 -> nearest in-scale is C4 (60) or D4 (62); search prefers +1 first => 62
    const snapped = snapPitchToPitchClasses(61, cMajor);
    expect([60, 62]).toContain(snapped);
    expect(cMajor.has(((snapped % 12) + 12) % 12)).toBe(true);
  });

  it('returns the pitch when the set is empty', () => {
    expect(snapPitchToPitchClasses(61, new Set())).toBe(61);
  });
});

describe('rect helpers (marquee)', () => {
  it('detects overlap', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    ).toBe(true);
    expect(
      rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }),
    ).toBe(false);
  });

  it('normalizes a backwards drag rectangle', () => {
    expect(normalizeRect(30, 40, 10, 20)).toEqual({ x: 10, y: 20, w: 20, h: 20 });
  });
});
