import { describe, expect, it } from 'vitest';
import { compingNoteCount, compingPattern, createPrng, pick, randomInt, voiceChord, type CompingPattern } from '../src';

const progression = ['C', 'Am', 'F', 'G'].map((symbol, i) => ({
  symbol, startBeat: i * 4, durationBeats: 4,
}));
const options = { register: 60, voiceLeading: true };
const voicings = [[60, 64, 67], [60, 64, 69], [60, 65, 69], [59, 62, 67]];
const patterns: CompingPattern[] = ['whole', 'eighths', 'arpUp', 'arpUpDown', 'stab'];
const PPQ = 480;

describe('compingNoteCount', () => {
  it.each(patterns)('matches %s generation for partial steps, slash bass, and skipped chords', (pattern) => {
    const chords = [
      { symbol: 'Cmaj9/D♭', startBeat: 0.1, durationBeats: 1.25 },
      { symbol: 'F', startBeat: 1.5, durationBeats: 1 / PPQ },
      { symbol: 'G', startBeat: 2, durationBeats: 0.5 / PPQ },
      { symbol: 'H7', startBeat: 3, durationBeats: 8 },
    ];
    const count = chords.reduce((sum, chord) => sum + compingNoteCount(chord, pattern), 0);
    expect(count).toBe(compingPattern(chords, pattern, options).length);
    expect(compingNoteCount(chords[0]!, pattern)).toBeGreaterThan(0);
  });
});

describe('compingPattern', () => {
  it('checks pattern keys and rejects large inputs before generating any notes', () => {
    for (const bad of ['__proto__', 'constructor', { toString: null }]) {
      expect(compingNoteCount(progression[0]!, bad as CompingPattern)).toBe(0);
      expect(compingPattern(progression, bad as CompingPattern, options)).toEqual([]);
    }
    const oversized = [{ symbol: 'C', startBeat: 0, durationBeats: 100_000 }];
    expect(() => compingPattern(oversized, 'eighths', options)).toThrow(RangeError);
    expect(() => compingPattern(new Array(100_001), 'whole', options)).toThrow(RangeError);
  });

  it.each([
    { pattern: 'whole', offsets: [0], length: 4 },
    { pattern: 'eighths', offsets: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], length: 0.5 },
    { pattern: 'arpUp', offsets: [0, 1, 2, 3], length: 1, pitchIndices: [0, 1, 2, 0] },
    { pattern: 'arpUpDown', offsets: [0, 1, 2, 3], length: 1, pitchIndices: [0, 1, 2, 1] },
    { pattern: 'stab', offsets: [0, 1, 2, 3], length: 0.25 },
  ] as const)('produces the expected $pattern notes for C → Am → F → G', (test) => {
    const expected = progression.flatMap((chord, i) => test.offsets.flatMap((offset, j) => {
      const voiced = voicings[i]!;
      const pitchIndex = 'pitchIndices' in test ? test.pitchIndices?.[j] : undefined;
      const pitches = pitchIndex === undefined ? voiced : [voiced[pitchIndex]!];
      return pitches.map((pitch) => ({
        pitch, startBeat: chord.startBeat + offset, durationBeats: test.length, velocity: 90,
      }));
    }));
    const notes = compingPattern(progression, test.pattern, options);
    expect(notes).toEqual(expected);
    expect(compingPattern(progression, test.pattern, options)).toEqual(notes);
  });

  it('uses the requested register without voice leading and leaves the input untouched', () => {
    const chords = Object.freeze([...progression].reverse().map((chord) => Object.freeze({ ...chord })));
    const notes = compingPattern(chords, 'whole', { register: 36, voiceLeading: false });
    for (const { symbol, startBeat } of progression) {
      expect(notes.filter((note) => note.startBeat === startBeat).map((note) => note.pitch))
        .toEqual(voiceChord(symbol, { register: 36 }));
    }
  });

  it.each(patterns)('clamps %s to a one-tick chord and skips a span with no full tick', (pattern) => {
    const notes = compingPattern([
      { symbol: 'C', startBeat: 1.25 / PPQ, durationBeats: 2 / PPQ },
      { symbol: 'F', startBeat: 4.25 / PPQ, durationBeats: 1 / PPQ },
    ], pattern, options);
    expect(notes.map((note) => note.pitch)).toEqual(pattern.startsWith('arp') ? [60] : [60, 64, 67]);
    for (const note of notes) {
      expect(note.startBeat).toBe(2 / PPQ);
      expect(note.durationBeats).toBe(1 / PPQ);
    }
  });

  it('preserves grid, span, pitch and determinism across 1,000 seeded clip windows', () => {
    const rng = createPrng(0xc021);
    const int = (min: number, max: number) => randomInt(rng, min, max);
    const symbols = ['C', 'Am', 'F', 'G', 'Cadd9', 'C♯maj9', 'Dm7', 'Eb/G'];
    for (let i = 0; i < 1_000; i += 1) {
      // Work in quarter-ticks to exercise both exact and off-grid boundaries.
      let cursor = int(0, 300_000);
      const songChords = Array.from({ length: int(2, 6) }, () => {
        const start = cursor + int(0, 96);
        const end = start + (rng() < 0.4 ? int(1, 20) : int(21, PPQ * 8));
        cursor = end;
        return { symbol: pick(rng, symbols), start, end };
      });
      const clipStart = int(songChords[0]!.start - 100, cursor - 1);
      const clipEnd = clipStart + int(1, PPQ * 12);
      const chords = songChords.flatMap(({ symbol, start, end }) => {
        const from = Math.max(start, clipStart);
        const to = Math.min(end, clipEnd);
        return to > from ? [{ symbol, startBeat: (from - clipStart) / (4 * PPQ), durationBeats: (to - from) / (4 * PPQ) }] : [];
      });
      const opts = { register: i % 128, voiceLeading: int(0, 1) === 1 };
      for (const pattern of patterns) {
        const notes = compingPattern(chords, pattern, opts);
        expect(compingPattern(chords, pattern, opts)).toEqual(notes);
        for (const note of notes) {
          const startTick = Math.round(note.startBeat * PPQ);
          const durationTicks = Math.round(note.durationBeats * PPQ);
          expect(note.startBeat).toBe(startTick / PPQ);
          expect(note.durationBeats).toBe(durationTicks / PPQ);
          expect(durationTicks).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127).toBe(true);
          expect(chords.some((chord) =>
            note.startBeat >= chord.startBeat - 1e-12 &&
            (startTick + durationTicks) / PPQ <= chord.startBeat + chord.durationBeats + 1e-12,
          )).toBe(true);
        }
      }
    }
  });
});
