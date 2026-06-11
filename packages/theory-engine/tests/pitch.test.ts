import { describe, it, expect } from 'vitest';
// Import directly from the concrete module: midiToNoteName / noteNameToMidi are
// routed through a co-owned barrel to a different implementation, so target this
// package's pitch utilities directly.
import {
  noteNameToPitchClass,
  midiToNoteName,
  noteNameToMidi,
  pitchClassOf,
  parseKeyRoot,
  keyPrefersFlats,
  spellPitchClass,
  pitchClassToSharpName,
} from '../src/pitch';

describe('pitch: note name <-> pitch class', () => {
  it('parses naturals', () => {
    expect(noteNameToPitchClass('C')).toBe(0);
    expect(noteNameToPitchClass('E')).toBe(4);
    expect(noteNameToPitchClass('G')).toBe(7);
    expect(noteNameToPitchClass('B')).toBe(11);
  });

  it('parses sharps and flats including wraparound', () => {
    expect(noteNameToPitchClass('C#')).toBe(1);
    expect(noteNameToPitchClass('Db')).toBe(1);
    expect(noteNameToPitchClass('Cb')).toBe(11);
    expect(noteNameToPitchClass('B#')).toBe(0);
    expect(noteNameToPitchClass('Fx')).toBe(7); // double sharp
    expect(noteNameToPitchClass('Bbb')).toBe(9); // double flat
  });

  it('throws on invalid note name', () => {
    expect(() => noteNameToPitchClass('H')).toThrow();
  });
});

describe('pitch: MIDI conversions', () => {
  it('midiToNoteName uses octave numbering (C4 = 60)', () => {
    expect(midiToNoteName(60)).toBe('C4');
    expect(midiToNoteName(69)).toBe('A4');
    expect(midiToNoteName(61)).toBe('C#4');
    expect(midiToNoteName(61, { flats: true })).toBe('Db4');
  });

  it('noteNameToMidi round-trips with octave', () => {
    expect(noteNameToMidi('C4')).toBe(60);
    expect(noteNameToMidi('A4')).toBe(69);
    expect(noteNameToMidi('F#5')).toBe(78);
    expect(noteNameToMidi('Bb3')).toBe(58);
  });

  it('noteNameToMidi defaults to octave 4 when missing', () => {
    expect(noteNameToMidi('C')).toBe(60);
  });

  it('pitchClassOf extracts class across octaves', () => {
    expect(pitchClassOf(60)).toBe(0);
    expect(pitchClassOf(72)).toBe(0);
    expect(pitchClassOf(48)).toBe(0);
    expect(pitchClassOf(67)).toBe(7);
  });
});

describe('pitch: enharmonic spelling by key', () => {
  it('parseKeyRoot strips quality', () => {
    expect(parseKeyRoot('Cm')).toBe('C');
    expect(parseKeyRoot('Bbmaj')).toBe('Bb');
    expect(parseKeyRoot('F#')).toBe('F#');
  });

  it('flat keys prefer flats, sharp keys prefer sharps', () => {
    expect(keyPrefersFlats('F')).toBe(true);
    expect(keyPrefersFlats('Bb')).toBe(true);
    expect(keyPrefersFlats('Eb')).toBe(true);
    expect(keyPrefersFlats('G')).toBe(false);
    expect(keyPrefersFlats('D')).toBe(false);
    expect(keyPrefersFlats('C')).toBe(false);
  });

  it('spellPitchClass respects key', () => {
    // pc 1 in flat key F -> Db; in sharp key G -> C#
    expect(spellPitchClass(1, 'F')).toBe('Db');
    expect(spellPitchClass(1, 'G')).toBe('C#');
    // pc 10 (Bb/A#)
    expect(spellPitchClass(10, 'F')).toBe('Bb');
    expect(spellPitchClass(10, 'A')).toBe('A#');
  });

  it('pitchClassToSharpName is key-agnostic sharp spelling', () => {
    expect(pitchClassToSharpName(1)).toBe('C#');
    expect(pitchClassToSharpName(6)).toBe('F#');
  });
});
