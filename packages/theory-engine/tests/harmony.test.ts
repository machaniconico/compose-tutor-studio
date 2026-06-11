import { describe, expect, it } from 'vitest';
import { borrowedChords, dominantMotionChords } from '../src/harmony';

describe('harmony: borrowedChords', () => {
  it('returns common parallel-minor borrowed chords in C major', () => {
    const chords = borrowedChords('C', 'major');
    expect(chords.map((chord) => `${chord.degree}:${chord.symbol}`)).toEqual([
      'bVII:Bb',
      'iv:Fm',
      'bVI:Ab',
      'bIII:Eb',
    ]);
    expect(chords.every((chord) => /[ぁ-んァ-ン一-龯]/.test(chord.reason))).toBe(true);
  });

  it('spells borrowed flat degrees correctly in G major', () => {
    const chords = borrowedChords('G', 'major');
    expect(chords.map((chord) => `${chord.degree}:${chord.symbol}`)).toEqual([
      'bVII:F',
      'iv:Cm',
      'bVI:Eb',
      'bIII:Bb',
    ]);
  });

  it('returns parallel-major colors in natural minor', () => {
    const chords = borrowedChords('C', 'naturalMinor');
    expect(chords.map((chord) => `${chord.degree}:${chord.symbol}`)).toEqual([
      'I:C',
      'IV:F',
      'V:G',
    ]);
  });

  it('filters out borrowed chords that are already diatonic in harmonic minor', () => {
    const chords = borrowedChords('C', 'harmonicMinor');
    expect(chords.map((chord) => chord.symbol)).toEqual(['C', 'F']);
  });
});

describe('harmony: dominantMotionChords', () => {
  it('returns V7/vi for a next Am chord in C major', () => {
    const [candidate] = dominantMotionChords({
      key: 'C',
      scale: 'major',
      targetSymbol: 'Am',
    });
    expect(candidate).toMatchObject({
      symbol: 'E7',
      degree: 'V7/vi',
      targetSymbol: 'Am',
      targetDegree: 'vi',
    });
    expect(candidate!.reason).toContain('Am');
  });

  it('returns V7/V for a next G chord in C major', () => {
    expect(
      dominantMotionChords({ key: 'C', scale: 'major', targetSymbol: 'G' })[0],
    ).toMatchObject({
      symbol: 'D7',
      degree: 'V7/V',
      targetSymbol: 'G',
    });
  });

  it('returns primary dominant motion for a next tonic when a target is explicit', () => {
    expect(
      dominantMotionChords({ key: 'C', scale: 'major', targetSymbol: 'C' })[0],
    ).toMatchObject({
      symbol: 'G7',
      degree: 'V7/I',
      targetSymbol: 'C',
    });
  });

  it('lists secondary dominants for diatonic targets when no next chord is given', () => {
    const chords = dominantMotionChords({ key: 'C', scale: 'major' });
    expect(chords.map((chord) => `${chord.degree}:${chord.symbol}`)).toEqual([
      'V7/ii:A7',
      'V7/iii:B7',
      'V7/IV:C7',
      'V7/V:D7',
      'V7/vi:E7',
    ]);
  });
});
