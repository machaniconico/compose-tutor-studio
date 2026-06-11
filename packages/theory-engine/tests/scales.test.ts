import { describe, it, expect } from 'vitest';
import {
  getScalePitchClasses,
  getScaleNoteNames,
  isInScale,
  getScaleIntervals,
  SCALE_NAMES,
} from '../src/scales';

describe('scales: pitch classes', () => {
  it('C major', () => {
    expect(getScalePitchClasses('C', 'major')).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it('A natural minor', () => {
    expect(getScalePitchClasses('A', 'naturalMinor')).toEqual([9, 11, 0, 2, 4, 5, 7]);
  });

  it('A harmonic minor raises the 7th', () => {
    // A harmonic minor: A B C D E F G# -> 9,11,0,2,4,5,8
    expect(getScalePitchClasses('A', 'harmonicMinor')).toEqual([9, 11, 0, 2, 4, 5, 8]);
  });

  it('C major pentatonic and minor pentatonic', () => {
    expect(getScalePitchClasses('C', 'majorPentatonic')).toEqual([0, 2, 4, 7, 9]);
    expect(getScalePitchClasses('C', 'minorPentatonic')).toEqual([0, 3, 5, 7, 10]);
  });

  it('C blues contains the blue note (b5)', () => {
    expect(getScalePitchClasses('C', 'blues')).toEqual([0, 3, 5, 6, 7, 10]);
  });

  it('all SCALE_NAMES resolve to intervals', () => {
    for (const s of SCALE_NAMES) {
      expect(getScaleIntervals(s).length).toBeGreaterThan(0);
    }
  });
});

describe('scales: note name spelling by key', () => {
  it('F major uses Bb not A#', () => {
    expect(getScaleNoteNames('F', 'major')).toEqual(['F', 'G', 'A', 'Bb', 'C', 'D', 'E']);
  });

  it('G major uses F# not Gb', () => {
    expect(getScaleNoteNames('G', 'major')).toEqual(['G', 'A', 'B', 'C', 'D', 'E', 'F#']);
  });
});

describe('scales: isInScale (octave independent)', () => {
  it('F# is out of C major but in G major', () => {
    // F# pitch class = 6. Test across octaves.
    expect(isInScale(66, 'C', 'major')).toBe(false); // F#4
    expect(isInScale(54, 'C', 'major')).toBe(false); // F#3
    expect(isInScale(78, 'C', 'major')).toBe(false); // F#5
    expect(isInScale(66, 'G', 'major')).toBe(true);
    expect(isInScale(54, 'G', 'major')).toBe(true);
  });

  it('works across octaves for in-scale notes', () => {
    // C is in C major in every octave
    expect(isInScale(60, 'C', 'major')).toBe(true);
    expect(isInScale(48, 'C', 'major')).toBe(true);
    expect(isInScale(72, 'C', 'major')).toBe(true);
    // E (pc 4) in C major
    expect(isInScale(64, 'C', 'major')).toBe(true);
    expect(isInScale(52, 'C', 'major')).toBe(true);
  });
});
