import { describe, it, expect } from 'vitest';
import { parseNoteName, midiToNoteName, noteNameToMidi } from '../src/index';

// prompt 02 関数 1,2,3 の公開シグネチャを検証する。

describe('parseNoteName (prompt 02)', () => {
  it('音名のみ (オクターブなし)', () => {
    expect(parseNoteName('C')).toEqual({ name: 'C', pitchClass: 0 });
    expect(parseNoteName('F#')).toEqual({ name: 'F#', pitchClass: 6 });
    expect(parseNoteName('Bb')).toEqual({ name: 'Bb', pitchClass: 10 });
  });

  it('オクターブ付き', () => {
    expect(parseNoteName('C4')).toEqual({ name: 'C', pitchClass: 0, octave: 4 });
    expect(parseNoteName('Eb3')).toEqual({ name: 'Eb', pitchClass: 3, octave: 3 });
  });

  it('小文字・記号を正規化', () => {
    expect(parseNoteName('c')).toEqual({ name: 'C', pitchClass: 0 });
    expect(parseNoteName('f♯')).toEqual({ name: 'F#', pitchClass: 6 });
  });

  it('不正な入力は null', () => {
    expect(parseNoteName('H')).toBeNull();
    expect(parseNoteName('')).toBeNull();
  });
});

describe('midiToNoteName (prompt 02)', () => {
  it('60 -> C4', () => {
    expect(midiToNoteName(60)).toBe('C4');
  });

  it('シャープ既定 / フラットオプション', () => {
    expect(midiToNoteName(61)).toBe('C#4');
    expect(midiToNoteName(61, { flats: true })).toBe('Db4');
    expect(midiToNoteName(0)).toBe('C-1');
  });
});

describe('noteNameToMidi (prompt 02)', () => {
  it('音名 + オクターブ -> MIDI', () => {
    expect(noteNameToMidi('C', 4)).toBe(60);
    expect(noteNameToMidi('A', 4)).toBe(69);
    expect(noteNameToMidi('Eb', 3)).toBe(51);
  });

  it('往復変換が一致する', () => {
    for (let m = 21; m <= 108; m += 1) {
      const parsed = parseNoteName(midiToNoteName(m));
      expect(parsed).not.toBeNull();
      expect(noteNameToMidi(parsed!.name, parsed!.octave ?? 4)).toBe(m);
    }
  });

  it('不正な音名は null', () => {
    expect(noteNameToMidi('H', 4)).toBeNull();
  });
});
