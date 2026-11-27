import { describe, expect, it } from 'vitest';
import { beatTick, clipTickSpan, PPQ, tickSpansOverlap } from '../src/index';

describe('tick math', () => {
  it('rounds beat positions to the nearest tick at 480 ticks per quarter note', () => {
    expect(PPQ).toBe(480);
    expect([0, 0.25, 1 / 3, 1, 2.5].map(beatTick)).toEqual([0, 120, 160, 480, 1200]);
    expect(beatTick(0.49 / PPQ)).toBe(0);
    expect(beatTick(0.5 / PPQ)).toBe(1);
  });

  it('rounds the absolute start and end of a clip independently', () => {
    expect(clipTickSpan(0.49 / PPQ, 0.02 / PPQ)).toEqual([0, 1]);
  });

  it('counts overlap only between nonempty spans that share one or more ticks', () => {
    expect(tickSpansOverlap([0, 120], [119, 240])).toBe(true);
    expect(tickSpansOverlap([119, 240], [0, 120])).toBe(true);
    expect(tickSpansOverlap([0, 120], [120, 240])).toBe(false);
    expect(tickSpansOverlap([0, 120], [60, 60])).toBe(false);
    expect(tickSpansOverlap([60, 59], [0, 120])).toBe(false);
  });
});
