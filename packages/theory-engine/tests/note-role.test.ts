import { describe, expect, it } from 'vitest';
import { classifyNoteRole } from '../src/index';

describe('classifyNoteRole', () => {
  const chord = [60, 64, 67];
  it('C major・コード C: E4 は chordTone、D4 は scaleTone、C#4 は outside', () => {
    expect(classifyNoteRole(64, chord, 'C', 'major')).toBe('chordTone');
    expect(classifyNoteRole(62, chord, 'C', 'major')).toBe('scaleTone');
    expect(classifyNoteRole(61, chord, 'C', 'major')).toBe('outside');
  });
  it('オクターブが違っても pitch class で判定する', () => {
    expect(classifyNoteRole(28, chord, 'C', 'major')).toBe('chordTone');
    expect(classifyNoteRole(110, chord, 'C', 'major')).toBe('scaleTone');
  });
  it('コードがスケール外の音を含むとき、その音は chordTone', () => {
    expect(classifyNoteRole(61, [61, 65, 68], 'C', 'major')).toBe('chordTone');
  });
  it('コード無し・不正なキー・不正な MIDI で落ちない', () => {
    expect(classifyNoteRole(62, undefined, 'C', 'major')).toBe('scaleTone');
    expect(classifyNoteRole(62, chord, '??', 'major')).toBe('outside');
    expect(classifyNoteRole(Number.NaN, chord, 'C', 'major')).toBe('outside');
  });
});

import { isScaleName, SCALE_NAMES } from '../src/index';

describe('isScaleName', () => {
  it('既知のスケール名だけ true。文字列以外・特殊名でも throw しない', () => {
    for (const name of SCALE_NAMES) expect(isScaleName(name)).toBe(true);
    for (const v of [null, undefined, 0, NaN, {}, { toString: null }, [], ['major'], '__proto__', 'constructor', 'dorian', '']) {
      expect(isScaleName(v)).toBe(false);
    }
  });
});
