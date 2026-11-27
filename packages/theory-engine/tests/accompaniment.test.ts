import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ACCOMPANIMENT_MOODS, generateAccompaniment, createPrng, randomInt,
  type AccompanimentMood, type AccompanimentOptions, type ChordEventInput,
} from '../src';

const config = { seed: 10, complexity: 0.5, intensity: 0.5, mood: 'straight' } as const;
const progression = [
  { symbol: 'C', startBeat: 0, durationBeats: 3.5 },
  { symbol: 'G/B', startBeat: 3.5, durationBeats: 2.5 },
] as const;
const parts = ['chords', 'bass', 'drums'] as const;

function generate(chords: readonly ChordEventInput[], options: AccompanimentOptions) {
  const result = generateAccompaniment(chords, options);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('generateAccompaniment', () => {
  it('uses own mood and window keys without coercing input values', () => {
    for (const mood of ['constructor', '__proto__', { toString: null }]) {
      expect(generateAccompaniment(progression, { ...config, mood: mood as AccompanimentMood }))
        .toEqual({ ok: false, reason: expect.any(String) });
    }
    const windows = Object.create({ bass: { startBeat: 4, endBeat: 4.5 } });
    expect(generate(progression, { ...config, windows })).toEqual(generate(progression, config));
  });

  it('offers exactly four fixed moods', () => {
    expectTypeOf<AccompanimentMood>().toEqualTypeOf<'soft' | 'bouncy' | 'straight' | 'driving'>();
    expect(Object.values(ACCOMPANIMENT_MOODS)).toEqual(['やわらかい', 'はずむ', 'まっすぐ', 'かけぬける']);
    expect(new Set(Object.keys(ACCOMPANIMENT_MOODS).map((mood) => {
      const hits = generate(progression, { ...config, mood: mood as AccompanimentMood }).drums;
      return JSON.stringify(hits.map(({ lane, stepIndex }) => [lane, stepIndex]));
    })).size).toBe(4);
  });

  it('repeats the exact arrangement with the same seed and varies it with a new seed', () => {
    const result = generate(progression, config);
    expect(generate(progression, config)).toEqual(result);
    expect(generate(progression, { ...config, seed: 11 })).not.toEqual(result);
    for (const part of parts) expect(result[part].length).toBeGreaterThan(0);
  });

  it('clamps the controls and treats NaN as the midpoint', () => {
    expect(generate(progression, { ...config, complexity: NaN, intensity: NaN })).toEqual(generate(progression, config));
    expect(generate(progression, { ...config, complexity: -4, intensity: -Infinity }))
      .toEqual(generate(progression, { ...config, complexity: 0, intensity: 0 }));
    expect(generate(progression, { ...config, complexity: Infinity, intensity: 3 }))
      .toEqual(generate(progression, { ...config, complexity: 1, intensity: 1 }));
  });

  it('uses each clip origin and cuts each part to its own window', () => {
    const result = generate(progression, { ...config, windows: {
      chords: { startBeat: 1.5, endBeat: 3 },
      bass: { startBeat: 4, endBeat: 4.5 },
      drums: { startBeat: 0.5, endBeat: 2 },
    } });
    expect(result.chords.every((note) => note.pitch % 12 === 0 || note.pitch % 12 === 4 || note.pitch % 12 === 7)).toBe(true);
    expect(result.bass.map((note) => note.pitch % 12)).toEqual([7, 2]);
    expect(result.chords).not.toHaveLength(0);
    expect(result.drums).not.toHaveLength(0);
    for (const part of parts) {
      const duration = part === 'bass' ? 0.5 : 1.5;
      expect(result[part].every((note) => note.startBeat >= 0 && note.startBeat + note.durationBeats <= duration)).toBe(true);
    }
  });

  it('refuses oversized arrangements before expanding notes', () => {
    expect(generateAccompaniment([{ symbol: 'C', startBeat: 0, durationBeats: 2e6 }], config))
      .toEqual({ ok: false, reason: expect.stringContaining('上限') });
    expect(generateAccompaniment([
      { symbol: 'C', startBeat: 0, durationBeats: 9_000 },
      { symbol: 'Am7', startBeat: 9_000, durationBeats: 9_000 },
    ], { ...config, complexity: 1 })).toEqual({ ok: false, reason: expect.stringContaining('上限') });
  });

  it('keeps note count, mean velocity, and tick bounds over 500 seeded progressions', () => {
    const rng = createPrng(31);
    const moods = Object.keys(ACCOMPANIMENT_MOODS) as AccompanimentMood[];
    const symbols = ['C', 'Am7', 'F#dim', 'G/B', 'Bbmaj7', 'D7/F#'];
    for (let sample = 0; sample < 500; sample += 1) {
      const seed = randomInt(rng, 0, 0xffffffff);
      const mood = moods[sample % moods.length]!;
      const beatsPerBar = [1, 2.5, 3, 3.75, 4, 5][sample % 6]!;
      let tick = randomInt(rng, 0, 120) + 0.2;
      const chords = Array.from({ length: randomInt(rng, 1, 8) }, () => {
        const duration = rng() < 0.2 ? randomInt(rng, 1, 4) : randomInt(rng, 5, 2_880);
        const chord = { symbol: symbols[randomInt(rng, 0, symbols.length - 1)]!, startBeat: tick / 480, durationBeats: duration / 480 };
        tick += duration + randomInt(rng, 0, 120);
        return chord;
      });
      const complexities = [0, rng(), 0.5, rng(), 1].sort((a, b) => a - b);
      const intensities = [0, rng(), 0.5, rng(), 1].sort((a, b) => a - b);
      const byComplexity = complexities.map((complexity) =>
        generate(chords, { seed, mood, complexity, intensity: intensities[3]!, beatsPerBar }));
      const byIntensity = intensities.map((intensity) =>
        generate(chords, { seed, mood, complexity: complexities[3]!, intensity, beatsPerBar }));
      for (const part of parts) {
        const counts = byComplexity.map((result) => result[part].length);
        const means = byIntensity.map((result) => {
          const notes = result[part];
          return notes.reduce((total, note) => total + note.velocity, 0) / (notes.length || 1);
        });
        expect(counts, `seed ${seed}: ${part} density`).toEqual([...counts].sort((a, b) => a - b));
        expect(means, `seed ${seed}: ${part} strength`).toEqual([...means].sort((a, b) => a - b));
        const notes = byComplexity.at(-1)![part];
        const valid = notes.every(({ pitch, startBeat, durationBeats, velocity }) =>
          Math.abs(startBeat * 480 - Math.round(startBeat * 480)) < 1e-8 &&
          Math.abs(durationBeats * 480 - Math.round(durationBeats * 480)) < 1e-8 &&
          durationBeats >= 1 / 480 && Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 &&
          Number.isInteger(velocity) && velocity >= 1 && velocity <= 127 &&
          chords.some((chord) => startBeat + 1e-9 >= chord.startBeat &&
            startBeat + durationBeats <= chord.startBeat + chord.durationBeats + 1e-9));
        expect(valid, `seed ${seed}: ${part} bounds`).toBe(true);
      }
    }
  });
});
