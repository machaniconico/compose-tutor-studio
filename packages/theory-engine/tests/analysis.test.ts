import { describe, it, expect } from 'vitest';
// Import directly from the concrete module: the package barrel (src/index.ts) is
// co-owned with another implementation that exports a different analyzeChord shape.
// These tests target this package's docs/06-shaped analyzeChord.
import { analyzeChord } from '../src/analysis';

describe('analysis: diatonic roman numerals in C major', () => {
  it('C -> G -> Am -> F analyzes as I, V, vi, IV', () => {
    const c = analyzeChord({ symbol: 'C', key: 'C', scale: 'major' });
    const g = analyzeChord({ symbol: 'G', key: 'C', scale: 'major' });
    const am = analyzeChord({ symbol: 'Am', key: 'C', scale: 'major' });
    const f = analyzeChord({ symbol: 'F', key: 'C', scale: 'major' });

    expect(c.degree).toBe('I');
    expect(g.degree).toBe('V');
    expect(am.degree).toBe('vi');
    expect(f.degree).toBe('IV');

    expect(c.function).toBe('T');
    expect(g.function).toBe('D');
    expect(am.function).toBe('T');
    expect(f.function).toBe('SD');

    for (const r of [c, g, am, f]) {
      expect(r.diatonic).toBe(true);
      expect(r.tags).toHaveLength(0);
      expect(r.explanation.length).toBeGreaterThan(0);
    }
  });

  it('ii is Dm, vii is Bdim', () => {
    expect(analyzeChord({ symbol: 'Dm', key: 'C', scale: 'major' }).degree).toBe('ii');
    expect(analyzeChord({ symbol: 'Bdim', key: 'C', scale: 'major' }).degree).toBe('vii°');
  });
});

describe('analysis: analyzeChord exact shape (docs/06)', () => {
  it('G7 in C major', () => {
    const r = analyzeChord({ symbol: 'G7', key: 'C', scale: 'major' });
    expect(r.symbol).toBe('G7');
    expect(r.root).toBe('G');
    expect(r.quality).toBe('dominant7');
    expect(r.notes).toEqual(['G', 'B', 'D', 'F']);
    expect(r.degree).toBe('V7');
    expect(r.function).toBe('D');
    expect(typeof r.explanation).toBe('string');
    expect(r.explanation.length).toBeGreaterThan(0);
    // Japanese explanation
    expect(r.explanation).toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

describe('analysis: secondary dominants', () => {
  it('E7 in C major is V7/vi targeting Am', () => {
    const r = analyzeChord({ symbol: 'E7', key: 'C', scale: 'major' });
    expect(r.tags).toContain('secondaryDominant');
    expect(r.degree).toBe('V7/vi');
    expect(r.target).toBe('Am');
    expect(r.function).toBe('D');
    expect(r.diatonic).toBe(false);
    expect(r.explanation).toContain('セカンダリドミナント');
  });

  it('A7 in C major is V7/ii targeting Dm', () => {
    const r = analyzeChord({ symbol: 'A7', key: 'C', scale: 'major' });
    expect(r.tags).toContain('secondaryDominant');
    expect(r.degree).toBe('V7/ii');
    expect(r.target).toBe('Dm');
  });

  it('D7 in C major is V7/V targeting G', () => {
    const r = analyzeChord({ symbol: 'D7', key: 'C', scale: 'major' });
    expect(r.tags).toContain('secondaryDominant');
    expect(r.degree).toBe('V7/V');
    expect(r.target).toBe('G');
  });
});

describe('analysis: borrowed chords (modal interchange)', () => {
  it('Fm in C major is tagged borrowed', () => {
    const r = analyzeChord({ symbol: 'Fm', key: 'C', scale: 'major' });
    expect(r.diatonic).toBe(false);
    expect(r.tags).toContain('borrowed');
    expect(r.explanation).toContain('借用');
  });

  it('Bb major (bVII) in C major is borrowed', () => {
    const r = analyzeChord({ symbol: 'Bb', key: 'C', scale: 'major' });
    expect(r.diatonic).toBe(false);
    expect(r.tags).toContain('borrowed');
  });
});

describe('analysis: minor key', () => {
  it('Am in A minor is i (tonic)', () => {
    const r = analyzeChord({ symbol: 'Am', key: 'Am', scale: 'naturalMinor' });
    expect(r.degree).toBe('i');
    expect(r.function).toBe('T');
    expect(r.diatonic).toBe(true);
  });
});
