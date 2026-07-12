import { describe, expect, it, vi } from 'vitest';
import {
  countMidiClipNoteOccurrences,
  midiClipNaturalPatternLength,
  visitMidiClipNoteOccurrences,
  type MidiClipNoteOccurrence,
  type NoteEvent,
} from '../src/index';

function note(
  id: string,
  startBeat: number,
  durationBeats: number,
): NoteEvent {
  return { id, pitch: 60, startBeat, durationBeats, velocity: 100 };
}

function occurrences(
  lengthBeats: number,
  loop: boolean,
  notes: readonly NoteEvent[],
): MidiClipNoteOccurrence[] {
  const result: MidiClipNoteOccurrence[] = [];
  visitMidiClipNoteOccurrences(
    { lengthBeats, loop, notes },
    100,
    (occurrence) => result.push(occurrence),
  );
  return result;
}

describe('MIDI clip note occurrence projection', () => {
  it('keeps an empty loop silent', () => {
    expect(countMidiClipNoteOccurrences({ lengthBeats: 4, loop: true, notes: [] }))
      .toBe(0);
    expect(occurrences(4, true, [])).toEqual([]);
  });

  it('uses the latest authored note end as the natural loop period', () => {
    expect(midiClipNaturalPatternLength([
      note('early', 0, 0.5),
      note('late', 1.25, 0.75),
    ])).toBe(2);
  });

  it('preserves authored notes once when loop is off', () => {
    const source = [note('a', 0.25, 0.5), note('b', 1, 1)];
    expect(countMidiClipNoteOccurrences({ lengthBeats: 4, loop: false, notes: source }))
      .toBe(2);
    expect(occurrences(4, false, source).map((event) => ({
      id: event.note.id,
      start: event.localStartBeat,
      duration: event.durationBeats,
      repeat: event.repeatIndex,
    }))).toEqual([
      { id: 'a', start: 0.25, duration: 0.5, repeat: 0 },
      { id: 'b', start: 1, duration: 1, repeat: 0 },
    ]);
  });

  it('repeats exact multiples and excludes an onset at the clip end', () => {
    const source = [note('pulse', 0, 1)];
    expect(countMidiClipNoteOccurrences({ lengthBeats: 4, loop: true, notes: source }))
      .toBe(4);
    expect(occurrences(4, true, source).map((event) => event.localStartBeat))
      .toEqual([0, 1, 2, 3]);
  });

  it('shortens the final partial occurrence at the clip boundary', () => {
    const projected = occurrences(3.5, true, [note('pulse', 0, 1)]);
    expect(projected.map((event) => event.localStartBeat)).toEqual([0, 1, 2, 3]);
    expect(projected.map((event) => event.durationBeats)).toEqual([1, 1, 1, 0.5]);
  });

  it('normalizes decimal exact boundaries as a half-open interval', () => {
    const projected = occurrences(0.9, true, [note('decimal', 0, 0.3)]);
    expect(projected).toHaveLength(3);
    expect(projected.map((event) => event.localStartBeat)).toEqual([0, 0.3, 0.6]);
    expect(projected.at(-1)?.durationBeats).toBeCloseTo(0.3, 12);

    const offset = occurrences(0.4, true, [
      note('period', 0, 0.3),
      note('offset', 0.1, 0.1),
    ]).filter((event) => event.note.id === 'offset');
    expect(offset.map((event) => event.localStartBeat)).toEqual([0.1]);
  });

  it('keeps counted and visited occurrences identical across randomized clips', () => {
    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let fixture = 0; fixture < 500; fixture += 1) {
      const source = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => {
        const startBeat = Math.round(random() * 20) / 20;
        const durationBeats = (1 + Math.floor(random() * 20)) / 20;
        return note(`random-${fixture}-${index}`, startBeat, durationBeats);
      });
      const lengthBeats = (1 + Math.floor(random() * 200)) / 20;
      const pattern = { lengthBeats, loop: true, notes: source } as const;
      const count = countMidiClipNoteOccurrences(pattern);
      const visited: MidiClipNoteOccurrence[] = [];
      visitMidiClipNoteOccurrences(pattern, count, (event) => visited.push(event));

      expect(visited).toHaveLength(count);
      expect(visited.every((event) => event.durationBeats > 0)).toBe(true);
      expect(visited.every((event) => event.localStartBeat < lengthBeats)).toBe(true);
    }
  });

  it('fails closed for an unrepresentably large loop expansion', () => {
    const tiny = [note('tiny', 0, Number.MIN_VALUE)];
    expect(countMidiClipNoteOccurrences({ lengthBeats: 1, loop: true, notes: tiny }))
      .toBe(Number.MAX_SAFE_INTEGER);

    const visitor = vi.fn();
    expect(() => visitMidiClipNoteOccurrences(
      { lengthBeats: 1, loop: true, notes: tiny },
      10,
      visitor,
    )).toThrowError(RangeError);
    expect(visitor).not.toHaveBeenCalled();
  });
});
