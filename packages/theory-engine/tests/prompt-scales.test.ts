import { describe, it, expect } from 'vitest';
import { buildScale } from '../src/index';

// prompt 02 関数 4 (buildScale) の必須テスト + フラットキー綴り。

describe('buildScale (prompt 02)', () => {
  it('C major -> C D E F G A B (pitchClasses 0,2,4,5,7,9,11)', () => {
    const s = buildScale('C', 'major');
    expect(s.pitchClasses).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(s.notes).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
    expect(s.root).toBe('C');
    expect(s.scaleName).toBe('major');
  });

  it('A naturalMinor -> A B C D E F G', () => {
    const s = buildScale('A', 'naturalMinor');
    expect(s.notes).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(s.pitchClasses).toEqual([9, 11, 0, 2, 4, 5, 7]);
  });

  it('G major は F# を含む (1レター1度数)', () => {
    expect(buildScale('G', 'major').notes).toEqual(['G', 'A', 'B', 'C', 'D', 'E', 'F#']);
  });

  it('F major は Bb を含む (フラットキー綴り)', () => {
    expect(buildScale('F', 'major').notes).toEqual(['F', 'G', 'A', 'Bb', 'C', 'D', 'E']);
  });

  it('Bb major', () => {
    expect(buildScale('Bb', 'major').notes).toEqual(['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A']);
  });

  it('majorPentatonic は5音', () => {
    const s = buildScale('C', 'majorPentatonic');
    expect(s.pitchClasses).toEqual([0, 2, 4, 7, 9]);
    expect(s.notes).toHaveLength(5);
  });
});
