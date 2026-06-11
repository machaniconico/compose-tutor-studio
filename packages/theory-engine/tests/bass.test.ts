import { describe, it, expect } from 'vitest';
import { generateBassLine } from '../src/bass';
import { pitchClassOf } from '../src/pitch';
import type { ChordEventInput } from '../src/types';

const chords: ChordEventInput[] = [
  { symbol: 'C', startBeat: 0, durationBeats: 4 },
  { symbol: 'G', startBeat: 4, durationBeats: 4 },
  { symbol: 'Am', startBeat: 8, durationBeats: 4 },
  { symbol: 'F', startBeat: 12, durationBeats: 4 },
];

describe('bass: rootOnly', () => {
  it('puts the chord root at each chord start', () => {
    const notes = generateBassLine(chords, {
      mode: 'rootOnly',
      key: 'C',
      scale: 'major',
      beatsPerBar: 4,
    });
    expect(notes).toHaveLength(4);
    // roots: C(0), G(7), A(9), F(5)
    const expectedPc = [0, 7, 9, 5];
    notes.forEach((n, i) => {
      expect(n.startBeat).toBe(chords[i]!.startBeat);
      expect(pitchClassOf(n.pitch)).toBe(expectedPc[i]);
      expect(n.reason).toMatch(/ルート/);
    });
  });
});

describe('bass: rootFifth', () => {
  it('plays root then fifth within each chord', () => {
    const notes = generateBassLine(chords.slice(0, 1), {
      mode: 'rootFifth',
      key: 'C',
      scale: 'major',
      beatsPerBar: 4,
    });
    expect(notes).toHaveLength(2);
    expect(pitchClassOf(notes[0]!.pitch)).toBe(0); // root C
    expect(pitchClassOf(notes[1]!.pitch)).toBe(7); // fifth G
    expect(notes[1]!.startBeat).toBe(2);
  });
});

describe('bass: octavePulse', () => {
  it('alternates root and octave', () => {
    const notes = generateBassLine([{ symbol: 'C', startBeat: 0, durationBeats: 4 }], {
      mode: 'octavePulse',
      key: 'C',
      scale: 'major',
      beatsPerBar: 4,
    });
    expect(notes.length).toBe(4);
    // even-index = root, odd-index = octave up
    expect(notes[1]!.pitch - notes[0]!.pitch).toBe(12);
    expect(pitchClassOf(notes[0]!.pitch)).toBe(0);
  });
});

describe('bass: walkingSimple', () => {
  it('starts each chord on its root and approaches next chord root by step/half-step', () => {
    const notes = generateBassLine(chords, {
      mode: 'walkingSimple',
      key: 'C',
      scale: 'major',
      beatsPerBar: 4,
    });
    expect(notes.length).toBeGreaterThan(chords.length);

    // first note of first chord is C root
    expect(pitchClassOf(notes[0]!.pitch)).toBe(0);

    // The last note before G (beat 4) should approach G root by step/half-step.
    const beforeG = notes
      .filter((n) => n.startBeat < 4)
      .sort((a, b) => b.startBeat - a.startBeat)[0]!;
    const gRootNote = notes.find((n) => n.startBeat === 4)!;
    const dist = Math.abs(beforeG.pitch - gRootNote.pitch);
    expect(dist).toBeLessThanOrEqual(2);
    expect(dist).toBeGreaterThan(0);
    expect(beforeG.reason).toMatch(/経過音/);
  });

  it('approach note reason mentions a half-step when approaching by a semitone', () => {
    const two: ChordEventInput[] = [
      { symbol: 'C', startBeat: 0, durationBeats: 4 },
      { symbol: 'F', startBeat: 4, durationBeats: 4 },
    ];
    const notes = generateBassLine(two, {
      mode: 'walkingSimple',
      key: 'C',
      scale: 'major',
      beatsPerBar: 4,
    });
    const beforeF = notes
      .filter((n) => n.startBeat < 4)
      .sort((a, b) => b.startBeat - a.startBeat)[0]!;
    const fRootNote = notes.find((n) => n.startBeat === 4)!;
    // approach is a half-step below the F root
    expect(Math.abs(beforeF.pitch - fRootNote.pitch)).toBe(1);
    expect(beforeF.reason).toContain('半音');
  });
});
