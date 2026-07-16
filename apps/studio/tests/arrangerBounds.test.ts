import { describe, expect, it } from 'vitest';
import { compileMusicalTime } from '@cts/project-model';
import {
  clipBarRangeToBeats,
  clampSectionLength,
  clampSectionStart,
  sectionLengthMax,
  sectionStartMax,
} from '../src/features/arranger/Arranger';

describe('arranger section timing bounds', () => {
  it('converts partial bar drafts without passing fractions to the integer bar API', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 8,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [{ id: 'signature', beat: 0, numerator: 4, denominator: 4 }],
    });

    expect(clipBarRangeToBeats(musicalTime, 0.5, 0.5)).toEqual({
      startBeat: 2,
      lengthBeats: 2,
    });
    expect(clipBarRangeToBeats(musicalTime, -0.5, 1)).toBeNull();
    expect(clipBarRangeToBeats(musicalTime, 0, 0)).toBeNull();
  });

  it('clamps a start edit without shortening the section', () => {
    expect(sectionStartMax(4, 8)).toBe(4);
    expect(clampSectionStart(7, 4, 8)).toBe(4);
    expect(clampSectionStart(-3, 4, 8)).toBe(0);
    expect(clampSectionStart(1, 8, 8)).toBe(0);
  });

  it('clamps a length edit to the bars remaining after its start', () => {
    expect(sectionLengthMax(6, 8)).toBe(2);
    expect(clampSectionLength(4, 6, 8)).toBe(2);
    expect(clampSectionLength(0, 6, 8)).toBe(1);
  });

  it('uses safe minimums for empty and non-finite input', () => {
    expect(clampSectionStart('', 4, 8)).toBe(0);
    expect(clampSectionStart(Number.POSITIVE_INFINITY, 4, 8)).toBe(0);
    expect(clampSectionLength('', 2, 8)).toBe(1);
    expect(clampSectionLength(Number.NaN, 2, 8)).toBe(1);
  });

  it('normalizes fractional input to whole bars', () => {
    expect(clampSectionStart(3.9, 2, 8)).toBe(3);
    expect(clampSectionLength(3.9, 2, 8)).toBe(3);
  });

  it('keeps every bound valid when maxBars is below one or non-finite', () => {
    expect(sectionStartMax(4, 0)).toBe(0);
    expect(sectionLengthMax(4, 0)).toBe(1);
    expect(clampSectionStart(12, 4, Number.NaN)).toBe(0);
    expect(clampSectionLength(12, 4, Number.NaN)).toBe(1);
  });
});
