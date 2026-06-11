import { describe, it, expect } from 'vitest';
import {
  parseChordSymbol,
  analyzeChord,
  getDiatonicChords,
  suggestNextChords,
} from '../src/index';

// prompt 02 関数 5,6,7,8 の必須テスト。

describe('parseChordSymbol (prompt 02)', () => {
  it('C (major triad)', () => {
    const c = parseChordSymbol('C');
    expect(c).not.toBeNull();
    expect(c!.root).toBe('C');
    expect(c!.quality).toBe('major');
    expect(c!.notes).toEqual(['C', 'E', 'G']);
  });

  it('Dm (minor triad)', () => {
    const c = parseChordSymbol('Dm');
    expect(c!.root).toBe('D');
    expect(c!.quality).toBe('minor');
    expect(c!.notes).toEqual(['D', 'F', 'A']);
  });

  it('G7 (dominant7)', () => {
    const c = parseChordSymbol('G7');
    expect(c!.root).toBe('G');
    expect(c!.quality).toBe('dominant7');
    expect(c!.notes).toEqual(['G', 'B', 'D', 'F']);
  });

  it('Am (minor triad)', () => {
    const c = parseChordSymbol('Am');
    expect(c!.root).toBe('A');
    expect(c!.quality).toBe('minor');
    expect(c!.notes).toEqual(['A', 'C', 'E']);
  });

  it('Fmaj7 (major7, flat spelling)', () => {
    const c = parseChordSymbol('Fmaj7');
    expect(c!.root).toBe('F');
    expect(c!.quality).toBe('major7');
    expect(c!.notes).toEqual(['F', 'A', 'C', 'E']);
  });

  it('正規 quality 文字列をカバー', () => {
    expect(parseChordSymbol('Bdim')!.quality).toBe('diminished');
    expect(parseChordSymbol('Caug')!.quality).toBe('augmented');
    expect(parseChordSymbol('Bm7b5')!.quality).toBe('minor7b5');
    expect(parseChordSymbol('Bdim7')!.quality).toBe('dim7');
    expect(parseChordSymbol('Csus2')!.quality).toBe('sus2');
    expect(parseChordSymbol('Csus4')!.quality).toBe('sus4');
    expect(parseChordSymbol('C6')!.quality).toBe('sixth');
    expect(parseChordSymbol('Cm6')!.quality).toBe('minorSixth');
    expect(parseChordSymbol('Dm7')!.quality).toBe('minor7');
  });

  it('ø と ° の別表記', () => {
    expect(parseChordSymbol('Bø')!.quality).toBe('minor7b5');
    expect(parseChordSymbol('B°')!.quality).toBe('diminished');
    expect(parseChordSymbol('C+')!.quality).toBe('augmented');
    expect(parseChordSymbol('D-')!.quality).toBe('minor');
  });

  it('不正シンボルは null', () => {
    expect(parseChordSymbol('')).toBeNull();
    expect(parseChordSymbol('H7')).toBeNull();
    expect(parseChordSymbol('Cxyz')).toBeNull();
  });
});

describe('analyzeChord degrees in C major (prompt 02)', () => {
  it('progression C-G-Am-F => I-V-vi-IV', () => {
    const degrees = ['C', 'G', 'Am', 'F'].map(
      (s) => analyzeChord({ symbol: s, key: 'C', scale: 'major' }).degree,
    );
    expect(degrees).toEqual(['I', 'V', 'vi', 'IV']);
  });

  it('C => I, Dm => ii, Am => vi, F => IV', () => {
    expect(analyzeChord({ symbol: 'C', key: 'C', scale: 'major' }).degree).toBe('I');
    expect(analyzeChord({ symbol: 'Dm', key: 'C', scale: 'major' }).degree).toBe('ii');
    expect(analyzeChord({ symbol: 'Am', key: 'C', scale: 'major' }).degree).toBe('vi');
    expect(analyzeChord({ symbol: 'F', key: 'C', scale: 'major' }).degree).toBe('IV');
  });

  it('G7 => degree V7, function D, 日本語説明', () => {
    const a = analyzeChord({ symbol: 'G7', key: 'C', scale: 'major' });
    expect(a.degree).toBe('V7');
    expect(a.function).toBe('D');
    expect(a.explanation).toContain('V7');
    expect(a.explanation).toContain('ドミナント');
  });

  it('機能グループ: I,iii,vi=T / ii,IV=SD / V,vii°=D', () => {
    const fn = (s: string) => analyzeChord({ symbol: s, key: 'C', scale: 'major' }).function;
    expect(fn('C')).toBe('T');
    expect(fn('Em')).toBe('T');
    expect(fn('Am')).toBe('T');
    expect(fn('Dm')).toBe('SD');
    expect(fn('F')).toBe('SD');
    expect(fn('G')).toBe('D');
    expect(fn('Bdim')).toBe('D');
  });
});

describe('secondary dominant (prompt 02)', () => {
  it('E7 in C major resolves to Am => isSecondaryDominant, secondaryDominantOf "vi"', () => {
    const a = analyzeChord({ symbol: 'E7', key: 'C', scale: 'major' });
    expect(a.isSecondaryDominant).toBe(true);
    expect(a.secondaryDominantOf).toBe('vi');
    expect(a.degree).toBe('V7/vi');
    expect(a.tags).toContain('secondaryDominant');
  });

  it('D7 in C major (V/V) => secondaryDominantOf "V"', () => {
    const a = analyzeChord({ symbol: 'D7', key: 'C', scale: 'major' });
    expect(a.isSecondaryDominant).toBe(true);
    expect(a.secondaryDominantOf).toBe('V');
  });

  it('G7 (primary dominant) is NOT a secondary dominant', () => {
    const a = analyzeChord({ symbol: 'G7', key: 'C', scale: 'major' });
    expect(a.isSecondaryDominant).toBeUndefined();
  });
});

describe('getDiatonicChords (prompt 02)', () => {
  it('C major => 7 triads I..vii°', () => {
    const chords = getDiatonicChords('C', 'major');
    expect(chords).toHaveLength(7);
    expect(chords.map((c) => c.symbol)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
    expect(chords.map((c) => c.degree)).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  });

  it('A naturalMinor => i..VII', () => {
    const chords = getDiatonicChords('A', 'naturalMinor');
    expect(chords.map((c) => c.symbol)).toEqual(['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
  });
});

describe('suggestNextChords (prompt 02)', () => {
  it('after V suggests I', () => {
    const s = suggestNextChords({ key: 'C', scale: 'major', currentProgression: ['C', 'G'] });
    expect(s[0]!.symbol).toBe('C');
    expect(s[0]!.reason.length).toBeGreaterThan(0);
  });

  it('after ii suggests V', () => {
    const s = suggestNextChords({ key: 'C', scale: 'major', currentProgression: ['Dm'] });
    expect(s.map((x) => x.symbol)).toContain('G');
  });

  it('empty progression suggests tonic', () => {
    const s = suggestNextChords({ key: 'C', scale: 'major', currentProgression: [] });
    expect(s[0]!.symbol).toBe('C');
  });
});
