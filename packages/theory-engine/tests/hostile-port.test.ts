import { describe, expect, it } from 'vitest';
import { classifyNoteRole, voiceLead, voicingCost, voiceChord, detectChords, generateAccompaniment } from '../src/index';

describe('移植モジュールの不正入力(P10 レビュー)', () => {
  it('classifyNoteRole は配列でない chordNotes でも落ちない', () => {
    for (const bad of [{ toString: null }, 42, '__proto__', null]) {
      expect(() => classifyNoteRole(60, bad as never, 'C', 'major')).not.toThrow();
    }
    expect(classifyNoteRole(60, { toString: null } as never, 'C', 'major')).toBe(classifyNoteRole(60, undefined, 'C', 'major'));
  });
  it('voiceLead と voicingCost は数値でない音を RangeError で拒否する', () => {
    expect(() => voiceLead([{ toString: null } as never], 'C')).toThrow(RangeError);
    expect(() => voicingCost([60], [Number.NaN])).toThrow(RangeError);
  });
  it('options が null でも落ちない', () => {
    expect(() => voiceChord('C', null)).not.toThrow();
    expect(detectChords([], null)).toEqual([]);
    expect(generateAccompaniment([], null).ok).toBe(false);
  });
});
