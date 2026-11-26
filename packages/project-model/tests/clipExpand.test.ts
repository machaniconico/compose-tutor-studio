import { describe, expect, it } from 'vitest';
import { expandClip, MAX_LOOP_EVENTS } from '../src/clipExpand';
import type { Clip, NoteEvent } from '../src/types';

function note(id: string, startBeat: number, durationBeats: number, pitch = 60): NoteEvent {
  return { id, pitch, startBeat, durationBeats, velocity: 100 };
}

function midiClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-a',
    trackId: 'track-1',
    type: 'midi',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    notes: [],
    ...overrides,
  };
}

describe('expandClip: clip length', () => {
  it.each([false, true])('sounds a beat-zero note in a 1e-9 beat clip (loop: %s)', (loop) => {
    const clip = midiClip({ lengthBeats: 1e-9, loop, notes: [note('n', 0, 1)] });
    expect(expandClip(clip, [clip]).notes).toEqual([
      { pitch: 60, startBeat: 0, durationBeats: 1e-9, velocity: 100, cut: true },
    ]);
  });

  it('drops notes starting at or after the clip end and cuts notes crossing it', () => {
    const clip = midiClip({
      startBeat: 8,
      lengthBeats: 4,
      notes: [note('in', 1, 1), note('cross', 3.5, 2), note('after', 5, 1), note('atEnd', 4, 1)],
    });
    const { notes, problems } = expandClip(clip, [clip]);
    expect(problems).toEqual([]);
    expect(notes.map((n) => [n.pitch, n.startBeat, n.durationBeats])).toEqual([
      [60, 9, 1],
      [60, 11.5, 0.5],
    ]);
    // Only the note the clip end shortened is marked as cut.
    expect(notes.map((n) => n.cut)).toEqual([undefined, true]);
  });

  it('does not cut a note that ends on the clip end despite float rounding (start 1, length 0.15, clip 1 + 0.15)', () => {
    // (1 + 0.15) - 1 is 0.1499999999999999 in floating point.
    const clip = midiClip({ lengthBeats: 1 + 0.15, notes: [note('n', 1, 0.15)] });
    const [expanded] = expandClip(clip, [clip]).notes;
    expect(expanded!.durationBeats).toBe(0.15);
    expect(expanded!.cut).toBeUndefined();
  });

  it('applies the same rule to drum hits (absolute beats)', () => {
    const clip: Clip = {
      id: 'drums',
      trackId: 'track-d',
      type: 'drum',
      startBeat: 4,
      lengthBeats: 2,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [
        { id: 'k1', lane: 'kick', stepIndex: 0, velocity: 100 },
        { id: 's1', lane: 'snare', stepIndex: 7, velocity: 90 },
        { id: 'k2', lane: 'kick', stepIndex: 8, velocity: 100 },
      ],
    };
    const { drumHits } = expandClip(clip, [clip], 4);
    expect(drumHits).toEqual([
      { lane: 'kick', beat: 4, velocity: 100 },
      { lane: 'snare', beat: 5.75, velocity: 90 },
    ]);
  });
});

describe('expandClip: loop', () => {
  it('repeats the content every contentLengthBeats across the clip length', () => {
    const clip = midiClip({ lengthBeats: 8, contentLengthBeats: 2, loop: true, notes: [note('n', 0.5, 1)] });
    const { notes } = expandClip(clip, [clip]);
    expect(notes.map((n) => n.startBeat)).toEqual([0.5, 2.5, 4.5, 6.5]);
    expect(notes.every((n) => n.durationBeats === 1)).toBe(true);
  });

  it('uses lengthBeats as the period when contentLengthBeats is unset', () => {
    const clip = midiClip({ lengthBeats: 4, loop: true, notes: [note('n', 0, 1), note('m', 6, 1)] });
    const { notes } = expandClip(clip, [clip]);
    expect(notes.map((n) => n.startBeat)).toEqual([0]);
  });

  it('loops drum hits with the same period', () => {
    const clip: Clip = {
      id: 'drums',
      trackId: 'track-d',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      contentLengthBeats: 1,
      loop: true,
      stepsPerBar: 16,
      drumEvents: [{ id: 'k', lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    expect(expandClip(clip, [clip], 4).drumHits.map((h) => h.beat)).toEqual([0, 1, 2, 3]);
  });

  it('does not repeat, throw or hang when the period is 0 or negative', () => {
    for (const period of [0, -2]) {
      const clip = midiClip({ lengthBeats: 4, contentLengthBeats: period, loop: true, notes: [note('n', 1, 1)] });
      const result = expandClip(clip, [clip]);
      expect(result.notes.map((n) => n.startBeat)).toEqual([1]);
    }
  });
});

describe('expandClip: loop limits and rounding', () => {
  it('keeps notes just inside the period in every complete repeat', () => {
    const period = 2 ** -29;
    const start = (period - 1e-9) * (1 - Number.EPSILON);
    const clip = midiClip({
      lengthBeats: period * 8,
      contentLengthBeats: period,
      loop: true,
      notes: [note('edge', start, 1e-10)],
    });

    const expanded = expandClip(clip, [clip]);
    expect(expanded.notes.map((event) => event.startBeat)).toEqual(
      Array.from({ length: 8 }, (_, repeat) => repeat * period + start),
    );
    expect(expanded.problems).toEqual([]);

    const longClip = { ...clip, lengthBeats: 128 };
    const capped = expandClip(longClip, [longClip]);
    expect(capped.notes).toHaveLength(MAX_LOOP_EVENTS);
    expect(capped.overLimit).toBe(true);
  });

  it('sounds every repeat of a valid short loop (128 beats, 1/64-beat period)', () => {
    // 128 / (1/64) = 8192 repeats, one note each: all of them sound.
    const clip = midiClip({ lengthBeats: 128, contentLengthBeats: 1 / 64, loop: true, notes: [note('n', 0, 1 / 128)] });
    const result = expandClip(clip, [clip]);
    expect(result.notes).toHaveLength(8192);
    expect(result.notes.at(-1)!.startBeat).toBeCloseTo(128 - 1 / 64, 9);
    expect(result.problems).toEqual([]);
  });

  it('stops at the sound limit on whole repeats and reports exactly the range that is lost', () => {
    // 2048 / (1/64) = 131,072 repeats of one note, over the 100,000 limit:
    // 100,000 repeats sound, covering 100,000 / 64 = 1562.5 beats.
    expect(MAX_LOOP_EVENTS).toBe(100_000);
    const clip = midiClip({ lengthBeats: 2048, contentLengthBeats: 1 / 64, loop: true, notes: [note('n', 0, 1 / 128)] });
    const result = expandClip(clip, [clip]);
    expect(result.notes).toHaveLength(100_000);
    expect(result.notes.at(-1)!.startBeat).toBeCloseTo(1562.5 - 1 / 64, 9);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('先頭から 1562.5 拍までは鳴ります');
    expect(result.problems[0]).toContain('485.5 拍は鳴りません');
    expect(result.problems[0]).not.toContain('このクリップは鳴りません');
  });

  it('skips an oversized first repeat whole and reports the full silent range', () => {
    const notes = Array.from({ length: MAX_LOOP_EVENTS + 1 }, (_, i) => note(`n${i}`, 0.5, 0.25));
    const clip = midiClip({ lengthBeats: 2, contentLengthBeats: 1, loop: true, notes });
    const result = expandClip(clip, [clip]);
    expect(result.notes).toHaveLength(0);
    expect(result.overLimit).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('このクリップの 2 拍は鳴りません');
  });

  it('counts only what a repeat cut by the clip end really sounds (length 4, period 3, 50,001 notes at beat 2)', () => {
    // The second repeat starts at 3 and its note would be at 5, past the end:
    // only 50,001 notes sound, under the limit.
    const notes = Array.from({ length: 50_001 }, (_, i) => note(`n${i}`, 2, 0.5));
    const clip = midiClip({ lengthBeats: 4, contentLengthBeats: 3, loop: true, notes });
    const result = expandClip(clip, [clip]);
    expect(result.notes).toHaveLength(50_001);
    expect(result.overLimit).toBeUndefined();
    expect(result.problems).toEqual([]);
  });

  it('does not walk the repeats of a tiny period whose content all lies outside it', () => {
    // 1e-12-beat period: 1.28e14 repeats would hang; nothing is inside the period.
    const clip = midiClip({ lengthBeats: 128, contentLengthBeats: 1e-12, loop: true, notes: [note('n', 5, 1)] });
    expect(expandClip(clip, [clip])).toEqual({ notes: [], drumHits: [], problems: [] });
  });

  it('drops a repeat that lands on the clip end only by rounding (0.3-beat period)', () => {
    // 3 * 0.3 + 0.1 = 0.9999999999999999, which is the clip end, not before it.
    const clip = midiClip({ lengthBeats: 1, contentLengthBeats: 0.3, loop: true, notes: [note('n', 0.1, 0.1)] });
    const starts = expandClip(clip, [clip]).notes.map((n) => n.startBeat);
    expect(starts).toHaveLength(3);
    expect(starts[2]).toBeCloseTo(0.7, 9);
  });
});

describe('expandClip: links (aliasOf)', () => {
  it('plays the source content at its own startBeat', () => {
    const source = midiClip({ id: 'src', startBeat: 0, notes: [note('n', 1, 1, 64)] });
    const linked = midiClip({ id: 'link', startBeat: 16, aliasOf: 'src', notes: [] });
    const { notes, problems } = expandClip(linked, [source, linked]);
    expect(problems).toEqual([]);
    expect(notes.map((n) => [n.pitch, n.startBeat])).toEqual([[64, 17]]);
  });

  it('returns empty content and a Japanese problem for a cycle A -> B -> A', () => {
    const a = midiClip({ id: 'A', aliasOf: 'B', notes: [note('n', 0, 1)] });
    const b = midiClip({ id: 'B', aliasOf: 'A', notes: [note('m', 0, 1)] });
    const result = expandClip(a, [a, b]);
    expect(result.notes).toEqual([]);
    expect(result.drumHits).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/リンク/);
    expect(result.problems[0]).toMatch(/循環/);
  });

  it('returns empty content and a Japanese problem for a missing link target', () => {
    const linked = midiClip({ id: 'link', aliasOf: 'gone', notes: [note('n', 0, 1)] });
    const result = expandClip(linked, [linked]);
    expect(result.notes).toEqual([]);
    expect(result.drumHits).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/リンク.*見つからない/);
  });
});

describe('expandClip: what the track can sound', () => {
  const notes = midiClip({ id: 'notes', notes: [note('n', 0, 1)] });
  const drums: Clip = {
    id: 'drums',
    trackId: 'track-1',
    type: 'drum',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    stepsPerBar: 16,
    drumEvents: [{ id: 'k', lane: 'kick', stepIndex: 0, velocity: 100 }],
  };

  it('drops notes linked onto a drum track and reports them', () => {
    const linked = midiClip({ id: 'link', startBeat: 4, aliasOf: 'notes', notes: [] });
    const result = expandClip(linked, [notes, linked], 4, 'drum');
    expect(result.notes).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('ドラムのトラックでは音符は鳴らない');
    expect(result.problems[0]).toContain('1 個');
  });

  it('drops drum hits on an instrument track and reports them', () => {
    const result = expandClip(drums, [drums], 4, 'instrument');
    expect(result.drumHits).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('楽器のトラックではドラムの音は鳴らない');
  });

  it('sounds nothing linked onto an audio track and reports it', () => {
    const linked = midiClip({ id: 'link', startBeat: 4, aliasOf: 'notes', notes: [] });
    const result = expandClip(linked, [notes, linked], 4, 'audio');
    expect(result.notes).toEqual([]);
    expect(result.drumHits).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('オーディオのトラックでは音符もドラムの音も鳴らない');
  });

  it('sounds nothing on a bus track and reports it', () => {
    const result = expandClip(drums, [drums], 4, 'bus');
    expect(result.drumHits).toEqual([]);
    expect(result.problems[0]).toContain('まとめ用のトラック(バス)では');
  });

  it('keeps what the track can sound without a problem', () => {
    expect(expandClip(drums, [drums], 4, 'drum')).toEqual({
      notes: [],
      drumHits: [{ lane: 'kick', beat: 0, velocity: 100 }],
      problems: [],
    });
    expect(expandClip(notes, [notes], 4, 'instrument').problems).toEqual([]);
  });
});
