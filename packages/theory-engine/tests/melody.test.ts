import { describe, it, expect } from 'vitest';
import {
  analyzeMelody,
  chordToneTargets,
  generateScaleMelody,
  repeatMotif,
} from '../src/melody';
import { pitchClassOf } from '../src/pitch';
import { isInScale } from '../src/scales';
import type { ChordEventInput } from '../src/types';

describe('melody: chordToneTargets', () => {
  it('returns chord pitch classes', () => {
    expect(chordToneTargets('C')).toEqual([0, 4, 7]);
    expect(chordToneTargets('G7')).toEqual([7, 11, 2, 5]);
  });
});

describe('melody: analyzeMelody', () => {
  it('matches docs/06 shape and rewards a chord tone on beat 1', () => {
    // E (MIDI 64) on beat 1 over C chord = 3rd, a chord tone
    const res = analyzeMelody({
      key: 'C',
      scale: 'major',
      chords: [{ symbol: 'C', startBeat: 0, durationBeats: 4 }],
      notes: [{ pitch: 64, startBeat: 0, durationBeats: 1 }],
    });
    expect(res.score).toBeGreaterThan(0);
    expect(res.score).toBeLessThanOrEqual(1);
    const chordToneFinding = res.findings.find((f) => f.type === 'chord_tone');
    expect(chordToneFinding).toBeDefined();
    expect(chordToneFinding!.severity).toBe('info');
    expect(chordToneFinding!.message).toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it('chord tones on strong beats score higher than non-chord tones', () => {
    const chords: ChordEventInput[] = [{ symbol: 'C', startBeat: 0, durationBeats: 4 }];
    const good = analyzeMelody({
      key: 'C',
      scale: 'major',
      chords,
      notes: [
        { pitch: 60, startBeat: 0, durationBeats: 2 }, // C chord tone (strong)
        { pitch: 67, startBeat: 2, durationBeats: 2 }, // G chord tone (strong)
      ],
    });
    const weak = analyzeMelody({
      key: 'C',
      scale: 'major',
      chords,
      notes: [
        { pitch: 62, startBeat: 0, durationBeats: 2 }, // D non-chord (strong)
        { pitch: 69, startBeat: 2, durationBeats: 2 }, // A non-chord (strong)
      ],
    });
    expect(good.score).toBeGreaterThan(weak.score);
  });

  it('classifies a chromatic note as passing/approach (info), not an error', () => {
    const res = analyzeMelody({
      key: 'C',
      scale: 'major',
      chords: [{ symbol: 'C', startBeat: 0, durationBeats: 4 }],
      notes: [
        { pitch: 60, startBeat: 0, durationBeats: 1 }, // C chord tone
        { pitch: 62, startBeat: 1, durationBeats: 0.5 }, // D scale tone
        { pitch: 63, startBeat: 1.5, durationBeats: 0.5 }, // D#/Eb chromatic passing
        { pitch: 64, startBeat: 2, durationBeats: 2 }, // E chord tone
      ],
    });
    const chromaticFindings = res.findings.filter(
      (f) => f.type === 'passing_tone' || f.type === 'approach_tone',
    );
    expect(chromaticFindings.length).toBeGreaterThan(0);
    expect(chromaticFindings.every((f) => f.severity === 'info')).toBe(true);
  });

  it('flags excessive leaps for singability', () => {
    const res = analyzeMelody({
      key: 'C',
      scale: 'major',
      chords: [{ symbol: 'C', startBeat: 0, durationBeats: 8 }],
      notes: [
        { pitch: 60, startBeat: 0, durationBeats: 1 },
        { pitch: 72, startBeat: 1, durationBeats: 1 }, // +12
        { pitch: 60, startBeat: 2, durationBeats: 1 }, // -12
        { pitch: 76, startBeat: 3, durationBeats: 1 }, // +16
      ],
    });
    expect(res.findings.some((f) => f.type === 'leap' && f.severity === 'warn')).toBe(true);
  });

  it('flags an unresolved out-of-scale ending note', () => {
    const res = analyzeMelody({
      key: 'C',
      scale: 'major',
      chords: [{ symbol: 'C', startBeat: 0, durationBeats: 4 }],
      notes: [
        { pitch: 60, startBeat: 0, durationBeats: 2 },
        { pitch: 61, startBeat: 2, durationBeats: 2 }, // C# out of scale, ends here
      ],
    });
    expect(res.findings.some((f) => f.type === 'unresolved_tension')).toBe(true);
  });

  it('handles empty notes gracefully', () => {
    const res = analyzeMelody({ key: 'C', scale: 'major', chords: [], notes: [] });
    expect(res.score).toBe(0);
    expect(res.findings.length).toBeGreaterThan(0);
  });
});

describe('melody: generateScaleMelody (seedable, deterministic)', () => {
  const chords: ChordEventInput[] = [
    { symbol: 'C', startBeat: 0, durationBeats: 4 },
    { symbol: 'G', startBeat: 4, durationBeats: 4 },
  ];

  it('is deterministic for the same seed', () => {
    const a = generateScaleMelody({ key: 'C', scale: 'major', chords, seed: 42 });
    const b = generateScaleMelody({ key: 'C', scale: 'major', chords, seed: 42 });
    expect(a.map((n) => n.pitch)).toEqual(b.map((n) => n.pitch));
  });

  it('differs for different seeds', () => {
    const a = generateScaleMelody({ key: 'C', scale: 'major', chords, seed: 1 });
    const b = generateScaleMelody({ key: 'C', scale: 'major', chords, seed: 999 });
    expect(a.map((n) => n.pitch)).not.toEqual(b.map((n) => n.pitch));
  });

  it('produces only scale tones (with chord tones on strong beats)', () => {
    const notes = generateScaleMelody({ key: 'C', scale: 'major', chords, seed: 7 });
    for (const n of notes) {
      expect(isInScale(n.pitch, 'C', 'major')).toBe(true);
      expect(n.reason).toMatch(/[ぁ-んァ-ン一-龯]/);
    }
    const beat0 = notes.find((n) => n.startBeat === 0)!;
    expect(chordToneTargets('C')).toContain(pitchClassOf(beat0.pitch));
  });
});

describe('melody: repeatMotif', () => {
  it('transposes a motif to each chord root', () => {
    const chords: ChordEventInput[] = [
      { symbol: 'C', startBeat: 0, durationBeats: 2 },
      { symbol: 'G', startBeat: 2, durationBeats: 2 },
    ];
    const motif = { intervals: [0, 4, 7], durations: [0.5, 0.5, 1] };
    const notes = repeatMotif({ motif, chords, key: 'C' });
    expect(notes).toHaveLength(6);
    expect(pitchClassOf(notes[0]!.pitch)).toBe(0); // C
    expect(pitchClassOf(notes[3]!.pitch)).toBe(7); // G
    expect(notes[1]!.pitch - notes[0]!.pitch).toBe(4);
    expect(notes[4]!.pitch - notes[3]!.pitch).toBe(4);
  });

  it('does not overflow the chord duration', () => {
    const chords: ChordEventInput[] = [{ symbol: 'C', startBeat: 0, durationBeats: 1 }];
    const motif = { intervals: [0, 2, 4, 5], durations: [0.5, 0.5, 0.5, 0.5] };
    const notes = repeatMotif({ motif, chords, key: 'C' });
    expect(notes.every((n) => n.startBeat < 1)).toBe(true);
    expect(notes.length).toBe(2);
  });
});
