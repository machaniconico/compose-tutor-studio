import { describe, expect, it } from 'vitest';
import {
  createPrng,
  detectChords,
  MAX_CHORD_DETECTION_CANDIDATES,
  MAX_CHORD_DETECTION_NOTES,
  MAX_CHORD_DETECTION_SEGMENTS,
  randomInt,
} from '../src';

const notesAt = (pitches: number[], startBeat = 0, durationBeats = 1) =>
  pitches.map((pitch) => ({ pitch, startBeat, durationBeats }));

const symbols = (pitches: number[]) =>
  detectChords(notesAt(pitches), { segmentBeats: 4 })[0]?.candidates.map(({ symbol }) => symbol);

describe('detectChords', () => {
  it.each([
    [[60, 64, 67], 'C'],
    [[64, 67, 72], 'C/E'],
    [[60, 64, 67, 71], 'Cmaj7'],
    [[60, 63, 67], 'Cm'],
  ] as const)('ranks %j as %s', (pitches, symbol) => {
    expect(symbols([...pitches])?.[0]).toBe(symbol);
  });

  it('keeps Am7 and C6 as tied interpretations, independently of input order', () => {
    const notes = notesAt([57, 60, 64, 67]);
    const result = detectChords(notes, { segmentBeats: 4 });
    expect(result[0]?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'Am7', score: 4 }),
      expect.objectContaining({ symbol: 'C6', score: 4 }),
    ]));
    expect(detectChords([...notes].reverse(), { segmentBeats: 4 })).toEqual(result);
  });

  it('names a lowest MIDI note that is outside the chord with a slash', () => {
    const [result] = detectChords(notesAt([50, 60, 64, 67]), { segmentBeats: 4 });
    expect(result?.candidates).toContainEqual(expect.objectContaining({
      symbol: 'C/D',
      bassPitchClass: 2,
      pitchClasses: [0, 4, 7, 2],
    }));
  });

  it('scores distinct pitch classes once and subtracts extra notes', () => {
    const [result] = detectChords(notesAt([60, 64, 67, 72, 78]), { segmentBeats: 4 });
    expect(result?.candidates).toContainEqual(expect.objectContaining({
      symbol: 'C',
      pitchClasses: [0, 4, 7],
      matchingCount: 3,
      extraCount: 1,
      score: 2,
    }));
  });

  it('uses half-open tick spans, counts sustain, and retains empty segments', () => {
    const result = detectChords([
      ...notesAt([60, 64, 67], 0, 241 / 480),
      ...notesAt([62], 0.5, 0.5),
      ...notesAt([60, 64, 67], 1.5, 0.25),
    ], { segmentBeats: 0.5 });
    expect(result.map(({ startBeat, durationBeats }) => [startBeat, durationBeats])).toEqual([
      [0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5],
    ]);
    expect(result[0]?.candidates[0]?.symbol).toBe('C');
    expect(result[1]?.candidates.find(({ symbol }) => symbol === 'C')?.matchingCount).toBe(3);
    expect(result[2]?.candidates).toEqual([]);
    expect(result[3]?.candidates[0]?.symbol).toBe('C');
  });

  it('clips the final segment and excludes notes at the clip end', () => {
    const result = detectChords([
      ...notesAt([60, 64, 67], 4, 8),
      ...notesAt([62, 65, 68], 5, 8),
    ], { segmentBeats: 4, lengthBeats: 5 });
    expect(result[1]).toMatchObject({
      startBeat: 4, durationBeats: 1,
    });
    expect(result[1]?.candidates[0]?.symbol).toBe('C');
  });

  it('ignores invalid pitches, nonpositive lengths, and non-finite timing', () => {
    const valid = notesAt([60, 64, 67]);
    expect(detectChords([
      ...valid,
      ...notesAt([-1, 128, 61.5, NaN], 0, 2e6),
      ...notesAt([61], 2e6, 0),
      ...notesAt([61], 2e6, -1),
      ...notesAt([61], Infinity),
      ...notesAt([61], 1, Infinity),
    ], { segmentBeats: 4 })).toEqual(detectChords(valid, { segmentBeats: 4 }));
  });

  it.each([NaN, Infinity, -Infinity, 0, -1])('refuses invalid segment size %s', (segmentBeats) => {
    expect(detectChords(notesAt([60, 64, 67]), { segmentBeats })).toEqual([]);
  });

  it('refuses oversized input before traversing it or creating segments', () => {
    const oversized = new Array(MAX_CHORD_DETECTION_NOTES + 1);
    Object.defineProperty(oversized, 0, { get: () => { throw new Error('notes were read'); } });
    expect(detectChords(oversized, { segmentBeats: 4 })).toEqual([]);
    expect(detectChords(notesAt([60], 0, 2e6), { segmentBeats: 2e6 })).toEqual([]);
    expect(detectChords([...notesAt([60, 64, 67]), ...notesAt([60], 1e308, 1e307)], { segmentBeats: 4 })).toEqual([]);
    expect(detectChords([], { segmentBeats: 4, lengthBeats: 2e6 })).toEqual([]);
    expect(detectChords(notesAt([60], 0, MAX_CHORD_DETECTION_SEGMENTS + 1), { segmentBeats: 1 })).toEqual([]);
    expect(detectChords(notesAt([60], 0, 1), { segmentBeats: Number.MIN_VALUE })).toEqual([]);
    expect(detectChords(notesAt([60], 0, MAX_CHORD_DETECTION_SEGMENTS), { segmentBeats: 1 }))
      .toHaveLength(MAX_CHORD_DETECTION_SEGMENTS);
  });

  it('is deterministic, bounded and safe over 1,000 seeded random note sets', () => {
    const rng = createPrng(0x220480);
    for (let i = 0; i < 1_000; i++) {
      const center = randomInt(rng, 0, 127);
      const notes = Array.from({ length: randomInt(rng, 0, 32) }, () => ({
        pitch: randomInt(rng, center - 12, center + 12),
        startBeat: randomInt(rng, -8, 60) / 4,
        durationBeats: randomInt(rng, -8, 24) / 4,
      }));
      const options = { segmentBeats: randomInt(rng, -4, 24) / 8 };
      const result = detectChords(notes, options);
      expect(detectChords([...notes].reverse(), options)).toEqual(result);
      expect(result.length).toBeLessThanOrEqual(MAX_CHORD_DETECTION_SEGMENTS);
      for (const { candidates } of result) {
        expect(candidates.length).toBeLessThanOrEqual(MAX_CHORD_DETECTION_CANDIDATES);
        for (const { pitchClasses } of candidates) {
          expect(pitchClasses.every((pc) => Number.isInteger(pc) && pc >= 0 && pc < 12)).toBe(true);
        }
      }
    }
  });
});
