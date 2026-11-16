import { describe, expect, it } from 'vitest';
import {
  BASE_PX_PER_BEAT,
  keyboardSeekBeat,
  pxPerBeat,
  stepGridPxPerBeat,
  xToSeekBeat,
} from '../src/features/timeline';
import { dragToLoopRange } from '../src/features/transport/TimelineRuler';

const BAR_PX = 4 * BASE_PX_PER_BEAT; // 4/4 at zoom 1

describe('xToSeekBeat', () => {
  it('seeks to the start of the clicked bar (bar 3 start is beat 8)', () => {
    expect(xToSeekBeat(2 * BAR_PX, 1, 4, 32, 'bar')).toBe(8);
  });

  it('snaps a click inside a bar down to that bar start', () => {
    expect(xToSeekBeat(2 * BAR_PX + 3 * BASE_PX_PER_BEAT + 5, 1, 4, 32, 'bar')).toBe(8);
  });

  it('snaps to beats when Shift is held', () => {
    expect(xToSeekBeat(2 * BAR_PX + 3 * BASE_PX_PER_BEAT + 5, 1, 4, 32, 'beat')).toBe(11);
  });

  it('accounts for zoom and other time signatures', () => {
    expect(xToSeekBeat(2 * 3 * BASE_PX_PER_BEAT * 2, 2, 3, 24, 'bar')).toBe(6);
  });

  it('clamps to the project range', () => {
    expect(xToSeekBeat(-40, 1, 4, 32, 'bar')).toBe(0);
    expect(xToSeekBeat(99999, 1, 4, 32, 'beat')).toBe(32);
  });
});

describe('keyboardSeekBeat', () => {
  it('goes to the start', () => {
    expect(keyboardSeekBeat('seekToStart', 13.5, 4, 32)).toBe(0);
  });

  it('steps forward one bar from the current bar start', () => {
    expect(keyboardSeekBeat('seekBarForward', 9.5, 4, 32)).toBe(12);
    expect(keyboardSeekBeat('seekBarForward', 31, 4, 32)).toBe(32);
  });

  it('goes back to the current bar start, then to the previous bar', () => {
    expect(keyboardSeekBeat('seekBarBack', 9.5, 4, 32)).toBe(8);
    expect(keyboardSeekBeat('seekBarBack', 8, 4, 32)).toBe(4);
    expect(keyboardSeekBeat('seekBarBack', 0, 4, 32)).toBe(0);
  });
});

describe('stepGridPxPerBeat', () => {
  it('widens low zooms so each 16th step keeps its minimum width', () => {
    expect(stepGridPxPerBeat(1, 16, 4, 25)).toBe(100);
  });

  it('uses the shared scale once that is wide enough', () => {
    expect(stepGridPxPerBeat(4, 16, 4, 25)).toBe(pxPerBeat(4));
  });
});

describe('dragToLoopRange', () => {
  it('covers every bar the drag touches, snapped to bar lines', () => {
    // From inside bar 2 (beats 4-8) to inside bar 3 (beats 8-12).
    expect(dragToLoopRange(BAR_PX + 10, 2 * BAR_PX + 30, 1, 4, 32)).toEqual({
      startBeat: 4,
      endBeat: 12,
    });
  });

  it('swaps a right-to-left drag so end is after start', () => {
    expect(dragToLoopRange(2 * BAR_PX + 30, BAR_PX + 10, 1, 4, 32)).toEqual({
      startBeat: 4,
      endBeat: 12,
    });
  });

  it('keeps at least one bar when start and end fall in the same bar', () => {
    const range = dragToLoopRange(BAR_PX + 10, BAR_PX + 20, 1, 4, 32);
    expect(range).toEqual({ startBeat: 4, endBeat: 8 });
    expect(range.endBeat).toBeGreaterThan(range.startBeat);
  });

  it('clamps to the song and uses the time signature and zoom', () => {
    expect(dragToLoopRange(-50, 99999, 1, 4, 32)).toEqual({ startBeat: 0, endBeat: 32 });
    // 3/4 at zoom 2: a bar is 3 beats of 2x width.
    const bar34 = 3 * BASE_PX_PER_BEAT * 2;
    expect(dragToLoopRange(bar34 + 1, 3 * bar34 + 1, 2, 3, 24)).toEqual({
      startBeat: 3,
      endBeat: 12,
    });
  });
});
