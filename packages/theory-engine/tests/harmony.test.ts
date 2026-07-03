import { describe, expect, it } from 'vitest';
import { analyzeChord, suggestNextChords } from '../src/index';

const japaneseText = /[ぁ-んァ-ン一-龯]/;

function bySymbol(symbol: string) {
  const suggestions = suggestNextChords({
    key: 'C',
    scale: 'major',
    currentProgression: ['C'],
  });
  const found = suggestions.find((suggestion) => suggestion.symbol === symbol);
  expect(found).toBeDefined();
  return found!;
}

describe('harmony: suggestNextChords modal interchange', () => {
  it('suggests borrowed chords from C parallel minor', () => {
    for (const symbol of ['Fm', 'Bb', 'Ab', 'Eb']) {
      const suggestion = bySymbol(symbol);
      expect(suggestion.tag).toBe('borrowed');
      expect(suggestion.origin).toContain('同主短調からの借用');
      expect(suggestion.reason).toMatch(japaneseText);
    }
  });
});

describe('harmony: suggestNextChords secondary dominants', () => {
  it('suggests secondary dominants that match analyzeChord classification', () => {
    const d7 = bySymbol('D7');
    expect(d7.tag).toBe('secondaryDominant');
    expect(d7.origin).toBe('V/V');
    expect(d7.reason).toMatch(japaneseText);

    const e7 = bySymbol('E7');
    expect(e7.tag).toBe('secondaryDominant');
    expect(e7.origin).toBe('V/vi');
    expect(e7.reason).toMatch(japaneseText);

    expect(analyzeChord({ symbol: d7.symbol, key: 'C', scale: 'major' }).secondaryDominantOf).toBe(
      'V',
    );
    expect(analyzeChord({ symbol: e7.symbol, key: 'C', scale: 'major' }).secondaryDominantOf).toBe(
      'vi',
    );
  });
});

describe('harmony: suggestNextChords compatibility metadata', () => {
  it('keeps diatonic suggestions while adding tag and origin', () => {
    const suggestions = suggestNextChords({
      key: 'C',
      scale: 'major',
      currentProgression: ['Dm'],
    });
    const dominant = suggestions.find((suggestion) => suggestion.symbol === 'G');

    expect(dominant).toBeDefined();
    expect(dominant!.reason.length).toBeGreaterThan(0);
    expect(dominant!.tag).toBe('diatonic');
    expect(dominant!.origin).toBe('ダイアトニック（V）');
  });
});
