import { describe, it, expect } from 'vitest';
import { parseChord, realizeChords } from '../src/chords';
import { parseChordSymbol } from '../src/parse-chord';
import { realizeProgression } from '../src/progressions';

describe('chords: parser', () => {
  it('major triad', () => {
    const c = parseChord('C');
    expect(c.root).toBe('C');
    expect(c.quality).toBe('major');
    expect(c.intervals).toEqual([0, 4, 7]);
    expect(c.pitchClasses).toEqual([0, 4, 7]);
    expect(c.notes).toEqual(['C', 'E', 'G']);
    expect(c.bass).toBe('C');
  });

  it('minor triad (Cm, Am)', () => {
    expect(parseChord('Cm').quality).toBe('minor');
    expect(parseChord('Cm').pitchClasses).toEqual([0, 3, 7]);
    const am = parseChord('Am');
    expect(am.root).toBe('A');
    expect(am.notes).toEqual(['A', 'C', 'E']);
  });

  it('maj7, dominant7, m7', () => {
    expect(parseChord('Fmaj7').quality).toBe('major7');
    expect(parseChord('Fmaj7').notes).toEqual(['F', 'A', 'C', 'E']);
    const g7 = parseChord('G7');
    expect(g7.quality).toBe('dominant7');
    expect(g7.notes).toEqual(['G', 'B', 'D', 'F']);
    expect(parseChord('Dm7').quality).toBe('minor7');
    expect(parseChord('Dm7').notes).toEqual(['D', 'F', 'A', 'C']);
  });

  it('dim, m7b5, aug', () => {
    expect(parseChord('Bdim').quality).toBe('diminished');
    expect(parseChord('Bdim').pitchClasses).toEqual([11, 2, 5]);
    expect(parseChord('Bm7b5').quality).toBe('minor7b5');
    expect(parseChord('Bm7b5').pitchClasses).toEqual([11, 2, 5, 9]);
    expect(parseChord('Caug').quality).toBe('augmented');
    expect(parseChord('Caug').pitchClasses).toEqual([0, 4, 8]);
  });

  it('sus4, sus2', () => {
    expect(parseChord('Csus4').quality).toBe('sus4');
    expect(parseChord('Csus4').pitchClasses).toEqual([0, 5, 7]);
    expect(parseChord('Csus2').quality).toBe('sus2');
    expect(parseChord('Csus2').pitchClasses).toEqual([0, 2, 7]);
  });

  it('6, m6, add9, 9', () => {
    expect(parseChord('C6').quality).toBe('6');
    expect(parseChord('C6').pitchClasses).toEqual([0, 4, 7, 9]);
    expect(parseChord('Cm6').quality).toBe('minor6');
    expect(parseChord('Cm6').pitchClasses).toEqual([0, 3, 7, 9]);
    expect(parseChord('Cadd9').quality).toBe('add9');
    expect(parseChord('Cadd9').pitchClasses).toContain(2); // 9th = D
    expect(parseChord('C9').quality).toBe('9');
    expect(parseChord('C9').pitchClasses).toContain(10); // b7
    expect(parseChord('C9').pitchClasses).toContain(2); // 9
  });

  it('slash chord Dm7/G', () => {
    const c = parseChord('Dm7/G');
    expect(c.root).toBe('D');
    expect(c.quality).toBe('minor7');
    expect(c.bass).toBe('G');
    expect(c.bassPc).toBe(7);
    expect(c.pitchClasses).toEqual([2, 5, 9, 0, 7]);
    expect(c.notes).toEqual(['D', 'F', 'A', 'C', 'G']);
  });

  it('slash chord C/E keeps chord tones and stores bass', () => {
    const c = parseChord('C/E');
    expect(c.root).toBe('C');
    expect(c.quality).toBe('major');
    expect(c.bass).toBe('E');
    expect(c.bassPc).toBe(4);
    expect(c.pitchClasses).toEqual([0, 4, 7]);
  });

  it('normalizes lowercase slash chord spelling', () => {
    const c = parseChord('dm7/g');
    expect(c.root).toBe('D');
    expect(c.quality).toBe('minor7');
    expect(c.bass).toBe('G');
    expect(c.bassPc).toBe(7);
  });

  it('rejects invalid slash chord bass', () => {
    expect(() => parseChord('Dm7/H')).toThrow();
    expect(() => parseChord('C//G')).toThrow();
  });

  it('parseChordSymbol supports slash chord bass', () => {
    const c = parseChordSymbol('Dm7/G');
    expect(c).not.toBeNull();
    expect(c!.root).toBe('D');
    expect(c!.quality).toBe('minor7');
    expect(c!.bass).toBe('G');
    expect(c!.bassPc).toBe(7);
    expect(c!.pitchClasses).toContain(7);
  });

  it('parseChordSymbol rejects invalid slash chord bass', () => {
    expect(parseChordSymbol('Dm7/H')).toBeNull();
    expect(parseChordSymbol('C//G')).toBeNull();
  });

  it('realizes slash chord bass as the lowest voiced note', () => {
    const symbols = [...realizeProgression('ii-V-I', 'C', 'major')];
    symbols[0] = 'Dm7/G';
    const realized = realizeChords(symbols, 'C');
    const firstVoicedNote = realized[0]!.voicing[0]!;
    expect(firstVoicedNote % 12).toBe(7);
    expect(Math.min(...realized[0]!.voicing)).toBe(firstVoicedNote);
  });

  it('spells with provided key (flat key)', () => {
    const bb = parseChord('Bb', 'F');
    expect(bb.root).toBe('Bb');
    expect(bb.notes).toEqual(['Bb', 'D', 'F']);
  });

  it('throws on empty symbol', () => {
    expect(() => parseChord('')).toThrow();
  });
});
