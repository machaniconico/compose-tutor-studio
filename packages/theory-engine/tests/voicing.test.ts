import { describe, it, expect } from 'vitest';
import { compareVoicings, voiceChord, voiceLead, voicingCost } from '../src/voicing';

const pcs = (midis: number[]) => new Set(midis.map((m) => m % 12));

describe('voiceChord', () => {
  it('close C at C4 is [60,64,67]', () => {
    expect(voiceChord('C', { style: 'close', register: 60 })).toEqual([60, 64, 67]);
  });

  it('close stacks every chord tone above the register within one octave', () => {
    expect(voiceChord('G7', { style: 'close', register: 60 })).toEqual([67, 71, 74, 77]);
    expect(voiceChord('Am', { style: 'close', register: 57 })).toEqual([57, 60, 64]);
  });

  it('open keeps every chord tone, spreads wider than close, stays in MIDI 0..127', () => {
    for (const symbol of ['C', 'Am', 'G7', 'Fmaj7', 'Bdim', 'Dsus4']) {
      for (const register of [0, 60, 120, 127]) {
        const close = voiceChord(symbol, { style: 'close', register });
        const open = voiceChord(symbol, { style: 'open', register });
        expect(pcs(open)).toEqual(pcs(close));
        expect(open.length).toBe(close.length);
        for (const m of open) {
          expect(m).toBeGreaterThanOrEqual(0);
          expect(m).toBeLessThanOrEqual(127);
        }
        expect(open[open.length - 1]! - open[0]!).toBeGreaterThan(close[close.length - 1]! - close[0]!);
      }
    }
    expect(voiceChord('C', { style: 'open', register: 60 })).toEqual([60, 67, 76]);
  });

  it('slash chord puts the bass note lowest', () => {
    const ce = voiceChord('C/E', { style: 'close', register: 60 });
    expect(ce[0]! % 12).toBe(4);
    expect(Math.min(...ce)).toBe(ce[0]);
    expect(pcs(ce)).toEqual(new Set([0, 4, 7]));
    const open = voiceChord('C/E', { style: 'open', register: 60 });
    expect(Math.min(...open) % 12).toBe(4);
    // Bass not in the chord is added below the chord tones.
    const cd = voiceChord('C/D', { style: 'close', register: 60 });
    expect(cd[0]! % 12).toBe(2);
    expect(pcs(cd)).toEqual(new Set([0, 2, 4, 7]));
  });

  it('defaults to close at C4 and throws on unknown symbols', () => {
    expect(voiceChord('C')).toEqual([60, 64, 67]);
    expect(() => voiceChord('Xyz')).toThrow();
  });
});

describe('voiceLead', () => {
  it('C -> Am -> F -> G moves the fewest semitones', () => {
    const c = voiceLead([], 'C', { style: 'close', register: 60 });
    expect(c).toEqual([60, 64, 67]);
    const am = voiceLead(c, 'Am');
    expect(am).toEqual([60, 64, 69]);
    const f = voiceLead(am, 'F');
    expect(f).toEqual([60, 65, 69]);
    const g = voiceLead(f, 'G');
    expect(g).toEqual([59, 62, 67]);
  });

  it('tie on total movement: the lower top note wins', () => {
    // From F [60,65,69] both [59,62,67] and [62,67,71] move 6 semitones.
    expect(voicingCost([60, 65, 69], [59, 62, 67])).toBe(6);
    expect(voicingCost([60, 65, 69], [62, 67, 71])).toBe(6);
    expect(voiceLead([60, 65, 69], 'G')).toEqual([59, 62, 67]);
  });

  it('tie on movement and top note: the lexicographically smaller voicing wins', () => {
    // From [60,64,67] both candidates move 2 semitones and top out at 67.
    expect(voicingCost([60, 64, 67], [58, 64, 67])).toBe(2);
    expect(voicingCost([60, 64, 67], [60, 62, 67])).toBe(2);
    expect(compareVoicings([60, 64, 67], [58, 64, 67], [60, 62, 67])).toBeLessThan(0);
    expect(compareVoicings([60, 64, 67], [60, 62, 67], [58, 64, 67])).toBeGreaterThan(0);
    expect(compareVoicings([60, 64, 67], [60, 62, 67], [60, 62, 67])).toBe(0);
  });

  it('compareVoicings ranks movement before the top note', () => {
    // [62,67,71] moves 6 but tops at 71; [55,59,62] moves 18 with a lower top: movement wins.
    expect(compareVoicings([60, 65, 69], [62, 67, 71], [55, 59, 62])).toBeLessThan(0);
    expect(compareVoicings([60, 65, 69], [59, 62, 67], [62, 67, 71])).toBeLessThan(0);
  });

  it('slash chord keeps the bass lowest while leading voices', () => {
    const out = voiceLead([60, 64, 67], 'C/E');
    expect(Math.min(...out) % 12).toBe(4);
    expect(out[0]! % 12).toBe(4);
    expect(pcs(out)).toEqual(new Set([0, 4, 7]));
  });

  it('result is sorted, in range, and has every chord tone', () => {
    const out = voiceLead([120, 124, 127], 'G7');
    expect(out).toEqual([...out].sort((a, b) => a - b));
    expect(pcs(out)).toEqual(new Set([7, 11, 2, 5]));
    for (const m of out) expect(m).toBeLessThanOrEqual(127);
  });
});

describe('voicing review regressions', () => {
  it('reads every chord name the chord input accepts (parseChord), e.g. Cadd9 and C♯maj9', () => {
    expect(voiceChord('Cadd9')).toEqual([60, 62, 64, 67]);
    expect(voiceChord('C♯maj9')).toEqual([61, 63, 65, 68, 72]);
    expect(pcs(voiceLead([60, 64, 67], 'Cadd9'))).toEqual(new Set([0, 2, 4, 7]));
  });

  it('close slash chord with a non-chord bass stays within one octave: C/D is [62,64,67,72]', () => {
    expect(voiceChord('C/D', { style: 'close', register: 60 })).toEqual([62, 64, 67, 72]);
    for (const symbol of ['C/D', 'Cmaj7/Db', 'Dm7/G', 'Cadd9', 'G7/F']) {
      const out = voiceChord(symbol, { style: 'close' });
      expect(Math.max(...out) - Math.min(...out)).toBeLessThan(12);
    }
  });

  it('voiceLead searches every octave, so a wide open shape is not missed', () => {
    // From [64,67], open Cmaj7/Db rooted at Db3 (49) moves 32; the Db4 shape moves 33.
    expect(voiceLead([64, 67], 'Cmaj7/Db', { style: 'open' })).toEqual([49, 55, 60, 64, 71]);
    for (const prev of [[60, 64, 67], [64, 67], [60]]) {
      const out = voiceLead(prev, 'Cmaj7/Db', { style: 'open' });
      expect(out[0]! % 12).toBe(1);
      // Every open Cmaj7/Db shape at every register is at best as good as the chosen one.
      for (let register = 0; register <= 127; register += 1) {
        const cand = voiceChord('Cmaj7/Db', { style: 'open', register });
        if (Math.max(...cand) > 127) continue;
        expect(compareVoicings(prev, out, cand)).toBeLessThanOrEqual(0);
      }
    }
  });
});
