import { describe, expect, it } from 'vitest';
import { PPQ } from '@cts/project-model';
import { loopRangeFromDrag, rulerXToBeat, safeReasonText } from '../src/features/transport/rulerLogic';

describe('rulerXToBeat', () => {
  it('snaps to the nearest whole beat', () => {
    expect(rulerXToBeat(28 * 2 + 3, 28, 32)).toBe(2);
    expect(rulerXToBeat(28 * 2 + 20, 28, 32)).toBe(3);
  });
  it('clamps to [0, song end]', () => {
    expect(rulerXToBeat(-50, 28, 32)).toBe(0);
    expect(rulerXToBeat(99999, 28, 32)).toBe(32);
  });
  it('returns 0 for bad input', () => {
    expect(rulerXToBeat(Number.NaN, 28, 32)).toBe(0);
    expect(rulerXToBeat(10, 0, 32)).toBe(0);
    expect(rulerXToBeat(10, 28, Number.NaN)).toBe(0);
  });
});

describe('loopRangeFromDrag', () => {
  it('orders a right-to-left drag', () => {
    expect(loopRangeFromDrag(8, 4, 32)).toEqual({ ok: true, startBeat: 4, endBeat: 8 });
  });
  it('grows a drag shorter than 1 beat to 1 beat', () => {
    expect(loopRangeFromDrag(4, 4, 32)).toEqual({ ok: true, startBeat: 4, endBeat: 5 });
    expect(loopRangeFromDrag(4, 4.2, 32)).toEqual({ ok: true, startBeat: 4, endBeat: 5 });
  });
  it('shifts back from the song end', () => {
    expect(loopRangeFromDrag(32, 32, 32)).toEqual({ ok: true, startBeat: 31, endBeat: 32 });
    expect(loopRangeFromDrag(40, 50, 32)).toEqual({ ok: true, startBeat: 31, endBeat: 32 });
  });
  it('refuses a song shorter than 1 beat and non-finite input', () => {
    expect(loopRangeFromDrag(0, 1, 0.5).ok).toBe(false);
    expect(loopRangeFromDrag(Number.NaN, 1, 32).ok).toBe(false);
    expect(loopRangeFromDrag(0, Infinity, 32).ok).toBe(false);
  });
  it('seeded fuzz: always whole ticks, >= 1 beat, inside the song', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 2000; i += 1) {
      const length = 1 + Math.floor(rand() * 64) + (rand() < 0.3 ? 0.5 : 0);
      const r = loopRangeFromDrag((rand() - 0.2) * length * 1.5, (rand() - 0.2) * length * 1.5, length);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.startBeat).toBe(Math.round(r.startBeat * PPQ) / PPQ);
      expect(r.endBeat).toBe(Math.round(r.endBeat * PPQ) / PPQ);
      expect(r.startBeat).toBeGreaterThanOrEqual(0);
      expect(r.endBeat).toBeLessThanOrEqual(length);
      expect(Math.round((r.endBeat - r.startBeat) * PPQ)).toBeGreaterThanOrEqual(PPQ);
      const x = (rand() - 0.5) * 4000;
      const beat = rulerXToBeat(x, 28, length);
      expect(beat).toBeGreaterThanOrEqual(0);
      expect(beat).toBeLessThanOrEqual(length);
      expect(beat).toBe(Math.round(beat * PPQ) / PPQ);
    }
  });
});

describe('loopRangeFromDrag with non-whole song ends', () => {
  it('never produces a fractional endpoint (3 bars of 3/8 end at beat 4.5)', () => {
    expect(loopRangeFromDrag(4, 4.2, 4.5)).toEqual({ ok: true, startBeat: 3, endBeat: 4 });
    expect(loopRangeFromDrag(0, 99, 4.5)).toEqual({ ok: true, startBeat: 0, endBeat: 4 });
  });
  it('refuses when no whole-beat loop fits', () => {
    expect(loopRangeFromDrag(0, 1, 1.5).ok).toBe(true);
    expect(loopRangeFromDrag(0, 1, 0.5).ok).toBe(false);
  });
  it('seeded fuzz over 3/8, 5/8, 7/8 song ends: whole beats only', () => {
    let seed = 99;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 3000; i += 1) {
      const bars = 1 + Math.floor(rand() * 40);
      const length = bars * [1.5, 2.5, 3.5][Math.floor(rand() * 3)]!;
      const r = loopRangeFromDrag((rand() - 0.2) * length * 1.5, (rand() - 0.2) * length * 1.5, length);
      if (!r.ok) {
        expect(Math.floor(length)).toBeLessThan(1);
        continue;
      }
      expect(Number.isInteger(r.startBeat)).toBe(true);
      expect(Number.isInteger(r.endBeat)).toBe(true);
      expect(r.startBeat).toBeGreaterThanOrEqual(0);
      expect(r.endBeat).toBeLessThanOrEqual(Math.floor(length));
      expect(r.endBeat - r.startBeat).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('safeReasonText', () => {
  it('never throws on odd values', () => {
    expect(safeReasonText({ toString: null }, 'x')).toBe('x');
    expect(safeReasonText('理由', 'x')).toBe('理由');
  });
});
