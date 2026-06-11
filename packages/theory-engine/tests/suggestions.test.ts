import { describe, it, expect } from 'vitest';
// Import directly from the concrete module: the package barrel (src/index.ts) is
// co-owned with another implementation that exports a different suggestNextChords API.
import { suggestNextChords } from '../src/suggestions';

describe('suggestions: next chord candidates', () => {
  it('after V in C major, I is the top diatonic candidate', () => {
    const res = suggestNextChords({ key: 'C', scale: 'major', previousChord: 'G' });
    expect(res.length).toBeGreaterThan(0);
    const top = res[0]!;
    expect(top.category).toBe('diatonic');
    // V -> I is the strongest resolution
    expect(top.symbol).toBe('C');
    expect(top.reason).toContain('解決');
  });

  it('diatonic candidates rank above secondary dominants', () => {
    const res = suggestNextChords({ key: 'C', scale: 'major', previousChord: 'C' });
    const firstSecondaryIdx = res.findIndex((s) => s.category === 'secondaryDominant');
    expect(firstSecondaryIdx).toBeGreaterThan(-1);
    expect(res[0]!.category).toBe('diatonic');
  });

  it('every candidate has a Japanese reason and a degree', () => {
    const res = suggestNextChords({ key: 'C', scale: 'major', previousChord: 'F' });
    for (const s of res) {
      expect(s.reason).toMatch(/[ぁ-んァ-ン一-龯]/);
      expect(s.degree.length).toBeGreaterThan(0);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it('includes secondary dominant candidates', () => {
    const res = suggestNextChords({ key: 'C', scale: 'major', previousChord: 'C' });
    const secondaries = res.filter((s) => s.category === 'secondaryDominant');
    expect(secondaries.length).toBeGreaterThan(0);
    // e.g. V7/vi = E7 should be present
    expect(secondaries.some((s) => s.symbol === 'E7')).toBe(true);
  });

  it('results are sorted by descending score', () => {
    const res = suggestNextChords({ key: 'C', scale: 'major', previousChord: 'Dm' });
    for (let i = 1; i < res.length; i += 1) {
      expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
    }
  });
});
