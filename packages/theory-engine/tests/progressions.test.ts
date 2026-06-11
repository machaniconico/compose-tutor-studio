import { describe, it, expect } from 'vitest';
import {
  PROGRESSION_TEMPLATES,
  realizeProgression,
  realizeDegrees,
  getProgressionTemplate,
} from '../src/progressions';

describe('progressions: templates', () => {
  it('exposes core templates with Japanese name/description', () => {
    const ids = PROGRESSION_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('I-V-vi-IV');
    expect(ids).toContain('vi-IV-I-V');
    expect(ids).toContain('ii-V-I');
    expect(ids).toContain('I-vi-IV-V');
    expect(ids).toContain('12-bar-blues');
    for (const t of PROGRESSION_TEMPLATES) {
      expect(t.name).toMatch(/[ぁ-んァ-ン一-龯]/);
      expect(t.description).toMatch(/[ぁ-んァ-ン一-龯]/);
      expect(t.degrees.length).toBeGreaterThan(0);
    }
  });

  it('realizes I-V-vi-IV in C major to C G Am F', () => {
    expect(realizeProgression('I-V-vi-IV', 'C', 'major')).toEqual(['C', 'G', 'Am', 'F']);
  });

  it('realizes vi-IV-I-V in C major to Am F C G', () => {
    expect(realizeProgression('vi-IV-I-V', 'C', 'major')).toEqual(['Am', 'F', 'C', 'G']);
  });

  it('realizes ii-V-I in C major to Dm G C', () => {
    expect(realizeProgression('ii-V-I', 'C', 'major')).toEqual(['Dm', 'G', 'C']);
  });

  it('realizes 12-bar-blues in C with dominant 7ths', () => {
    const blues = realizeProgression('12-bar-blues', 'C', 'major');
    expect(blues).toHaveLength(12);
    expect(blues[0]).toBe('C7');
    expect(blues[4]).toBe('F7');
    expect(blues[8]).toBe('G7');
  });

  it('realizes I-V-vi-IV in G major using sharp spelling', () => {
    // G major: I=G V=D vi=Em IV=C
    expect(realizeProgression('I-V-vi-IV', 'G', 'major')).toEqual(['G', 'D', 'Em', 'C']);
  });

  it('realizes I-V-vi-IV in F major using flat spelling for IV (Bb)', () => {
    // F major: I=F V=C vi=Dm IV=Bb
    expect(realizeProgression('I-V-vi-IV', 'F', 'major')).toEqual(['F', 'C', 'Dm', 'Bb']);
  });

  it('realizeDegrees handles ad-hoc degree lists', () => {
    expect(realizeDegrees(['I', 'IV', 'V'], 'C', 'major')).toEqual(['C', 'F', 'G']);
  });

  it('getProgressionTemplate returns by id', () => {
    expect(getProgressionTemplate('ii-V-I')?.degrees).toEqual(['ii', 'V', 'I']);
    expect(getProgressionTemplate('nope')).toBeUndefined();
  });

  it('throws for unknown template id on realize', () => {
    expect(() => realizeProgression('unknown', 'C', 'major')).toThrow();
  });
});
