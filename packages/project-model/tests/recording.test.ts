import { describe, expect, it } from 'vitest';
import {
  beatTick, eventsToNotes, fitRecordingNote, placedNoteTicks, PPQ, swingBeat, tickAlignedRecordingLoop,
  type Clip, type RecordingEvent,
} from '../src';

function event(timeBeat: number, midi: number, on = true, velocity = 100): RecordingEvent {
  return { timeBeat, midi, velocity, on };
}

function loopHasGridLine(loop: { startBeat: number; endBeat: number }, grid: number): boolean {
  const gridTicks = beatTick(grid);
  return Math.ceil(Math.ceil(loop.startBeat * PPQ - 1e-9) / gridTicks) * gridTicks < Math.floor(loop.endBeat * PPQ + 1e-9);
}

describe('eventsToNotes', () => {
  it('pairs chronologically, ignores unmatched off and duplicate on, and closes held notes at stop', () => {
    const events = [
      event(3, 60, false), event(2, 62, false), event(2, 60, true, 91),
      event(2.25, 60, true, 30), event(3.5, 127), event(5, 127, false),
    ];
    const options = { clipStartBeat: 2, stopBeat: 4 };
    expect(eventsToNotes(events, options)).toEqual([
      { id: 'take-1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 91 },
      { id: 'take-2', pitch: 127, startBeat: 1.5, durationBeats: 0.5, velocity: 100 },
    ]);
    expect(eventsToNotes(events, options)).toEqual(eventsToNotes(events, options));
    expect(events[0]).toEqual(event(3, 60, false));
  });

  it('ignores presses during count-in even when released after it and keeps a one-tick tap', () => {
    const events = [
      event(-0.0001, 60), event(0.25, 60, false),
      event(0.5, 0), event(0.5, 0, false), event(0.75, -1), event(0.75, 128),
    ];
    expect(eventsToNotes(events, { clipStartBeat: 0, stopBeat: 1 })).toEqual([
      { id: 'take-1', pitch: 0, startBeat: 0.5, durationBeats: 1 / PPQ, velocity: 100 },
    ]);
  });

  it('folds successive passes together and cuts a held note at the loop end', () => {
    const events = [
      event(1, 60), event(1.5, 60, false), event(3.5, 62), event(4.5, 62, false), event(5, 67),
    ];
    const loopRange = { startBeat: 0, endBeat: 4 };
    const notes = eventsToNotes(events, { clipStartBeat: 0, loopRange, stopBeat: 6 });
    expect(notes.map(({ pitch, startBeat, durationBeats }) => [pitch, startBeat, durationBeats])).toEqual([
      [60, 1, 0.5], [67, 1, 1], [62, 3.5, 0.5],
    ]);
  });

  it('snaps loop takes to the song-absolute grid when the loop starts off the grid', () => {
    // Loop 0.1..4.1 at 1/16: a press at 1.02 belongs on song beat 1.00, not on 0.1 + 1.00.
    // A second-pass press at 4.21 folds to 0.11, whose nearest line 0 lies before the loop:
    // it moves to the first grid line inside the loop.
    const events = [event(1.02, 60), event(1.3, 60, false), event(4.21, 62), event(4.3, 62, false)];
    const notes = eventsToNotes(events, {
      clipStartBeat: 0, loopRange: { startBeat: 0.1, endBeat: 4.1 }, loopGrid: 0.25, stopBeat: 5,
    });
    expect(notes.map(({ pitch, startBeat }) => [pitch, startBeat])).toEqual([[62, 0.25], [60, 1]]);
    for (const note of notes) expect(beatTick(note.startBeat) % beatTick(0.25)).toBe(0);
  });

  it('wraps a press just before the loop end to the next pass downbeat at the loop start', () => {
    const notes = eventsToNotes([event(3.95, 62), event(4.3, 62, false)], {
      clipStartBeat: 0, loopRange: { startBeat: 0, endBeat: 4 }, loopGrid: 0.5, stopBeat: 4.4,
    });
    expect(notes).toEqual([{ id: 'take-1', pitch: 62, startBeat: 0, durationBeats: 0.35, velocity: 100 }]);
  });

  it('keeps loop snaps before snapEndBeat and leaves notes folded at or after it unsnapped', () => {
    const events = [event(0.9, 60), event(0.97, 60, false), event(1.2, 62), event(1.3, 62, false)];
    const notes = eventsToNotes(events, {
      clipStartBeat: 0, loopRange: { startBeat: 0, endBeat: 4 }, loopGrid: 0.5, snapEndBeat: 1, stopBeat: 1.5,
    });
    expect(notes.map(({ pitch, startBeat }) => [pitch, startBeat])).toEqual([[60, 0.5], [62, 1.2]]);
  });

  it('clamps to the last grid line when the destination ends just before the loop end', () => {
    const notes = eventsToNotes([event(3.95, 60), event(4.2, 60, false)], {
      clipStartBeat: 0, loopRange: { startBeat: 0, endBeat: 4 }, loopGrid: 0.5, snapEndBeat: 3.999, stopBeat: 4.2,
    });
    expect(notes[0]?.startBeat).toBe(3.5);
  });

  it('keeps the folded position when no grid line lies inside the loop', () => {
    const notes = eventsToNotes([event(0.7, 60), event(0.8, 60, false)], {
      clipStartBeat: 0, loopRange: { startBeat: 0.6, endBeat: 0.9 }, loopGrid: 0.5, stopBeat: 1,
    });
    expect(notes).toEqual([{ id: 'take-1', pitch: 60, startBeat: 0.7, durationBeats: 0.1, velocity: 100 }]);
  });

  it.each([
    { startBeat: 4, endBeat: 4 }, { startBeat: 4, endBeat: 1 },
    { startBeat: 0, endBeat: 0.0001 }, { startBeat: NaN, endBeat: 4 },
    { startBeat: 0, endBeat: Infinity },
  ])('refuses an invalid loop: %j', (loopRange) => {
    expect(() => eventsToNotes([], { clipStartBeat: 0, loopRange, stopBeat: 6 })).toThrow(RangeError);
  });

  it('preserves tick and pairing invariants across 1,000 seeded input sequences with and without looping', () => {
    let seed = 0x250eed;
    function random(limit: number): number {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor(seed / 0x1_0000_0000 * limit);
    }

    for (let sequence = 0; sequence < 1_000; sequence++) {
      const stopBeat = (1 + random(24_000)) / 1000;
      const loopRange = { startBeat: (100 + random(700)) / 1000, endBeat: (850 + random(4000)) / 1000 };
      const generated = [
        event(-0.04, 40), event(0.25, 40, false),
        ...Array.from({ length: 1 + random(48) }, () =>
          event((random(25_000) - 500) / 1000, random(10) === 0 ? 128 : 60 + random(5), random(2) === 1, 1 + random(127)),
        ),
      ];
      // Pair by the original event timestamps even when deliveries are out of order.
      const events = generated.map((e) => ({ e, delivered: e.timeBeat + 0.05 + random(200) / 1000 }))
        .sort((a, b) => a.delivered - b.delivered).map(({ e }) => e);
      // Count actual transitions independently to catch duplicate ons and stray offs.
      const held = new Set<number>();
      let onsets = 0;
      const onsetTicks: [number, number][] = [];
      for (const e of [...events].sort((a, b) => a.timeBeat - b.timeBeat)) {
        if (e.timeBeat < 0 || e.timeBeat > stopBeat || e.midi > 127) continue;
        if (e.on && e.timeBeat < stopBeat && !held.has(e.midi)) {
          held.add(e.midi);
          onsets += 1;
          onsetTicks.push([e.midi, Math.min(beatTick(e.timeBeat), beatTick(stopBeat) - 1)]);
        }
        if (!e.on) held.delete(e.midi);
      }
      const clipEnd = (850 + random(4000)) / 1000;
      const songEnd = sequence % 2 === 0 ? 2 : 4;
      const snapEndBeat = Math.min(clipEnd, songEnd);
      const swing = 50 + random(11);
      const offTickStart = (random(240) + 0.25) / PPQ;
      expect(() => eventsToNotes(events, { clipStartBeat: offTickStart, stopBeat })).toThrow(RangeError);
      for (const [loop, loopGrid, snapEnd] of [
        [undefined, 0, undefined], [loopRange, 0, undefined], [loopRange, 0.5, undefined],
        [loopRange, 0.25, undefined], [loopRange, 0.5, snapEndBeat], [loopRange, 0.25, snapEndBeat],
      ] as const) {
        const options = { clipStartBeat: 0, stopBeat, loopRange: loop, loopGrid, snapEndBeat: snapEnd };
        const notes = eventsToNotes(events, options);
        expect(notes.some(({ pitch }) => pitch === 40)).toBe(false);
        if (loop && loopGrid) {
          const aligned = tickAlignedRecordingLoop(loop);
          const [ls, le] = [beatTick(aligned.startBeat), beatTick(aligned.endBeat)];
          const g = beatTick(loopGrid);
          const upper = Math.min(le, snapEnd === undefined ? Infinity : beatTick(snapEnd));
          const first = Math.ceil(ls / g) * g;
          const last = Math.floor((upper - 1) / g) * g;
          const expected = onsetTicks.map(([pitch, raw]) => {
            const folded = ls + (((raw - ls) % (le - ls)) + (le - ls)) % (le - ls);
            if (folded >= upper || first > last) return [pitch, folded];
            const q = Math.round(folded / g) * g;
            const inside = Math.max(q, first);
            return [pitch, inside <= last ? inside : aligned.endBeat <= (snapEnd ?? Infinity) ? first : last];
          });
          const byKey = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]!;
          expect(notes.map((n) => [n.pitch, beatTick(n.startBeat)]).sort(byKey),
            `sequence ${sequence}, grid=${loopGrid}, snapEnd=${snapEnd}`).toEqual(expected.sort(byKey));
        }
        if (!loop || snapEnd !== undefined) {
          const end = Math.min(snapEndBeat, loop ? tickAlignedRecordingLoop(loop).endBeat : Infinity);
          const clip: Clip = { id: 'clip', trackId: 'track', type: 'midi', startBeat: 0, lengthBeats: clipEnd, loop: false };
          for (const note of notes.filter((n) => beatTick(n.startBeat) < beatTick(end))) {
            const fitted = fitRecordingNote(clip, note, swing, end);
            const swung = swingBeat(note.startBeat, swing);
            const fits = swung + 1 / PPQ <= end + 1e-12 && beatTick(swung) < beatTick(end);
            expect(Boolean(fitted), `sequence ${sequence}, swing=${swing}, end=${end}`).toBe(fits);
            if (!fitted) continue;
            const placed = placedNoteTicks(clip, fitted, { swing, songEnd });
            expect(fitted.durationBeats).toBeGreaterThanOrEqual(1 / PPQ);
            expect(placed.startBeat).toBeGreaterThanOrEqual(loop?.startBeat ?? 0);
            expect(placed.startBeat + fitted.durationBeats).toBeLessThanOrEqual(end + 1e-12);
            expect(placed.endTick).toBeGreaterThan(placed.startTick);
          }
        }
        if (snapEnd !== undefined) continue;
        const checked = notes.every((note) => {
          const start = beatTick(note.startBeat);
          const end = start + beatTick(note.durationBeats);
          return Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
            note.startBeat === start / PPQ && note.durationBeats === (end - start) / PPQ && end > start &&
            (loop ? start / PPQ >= loop.startBeat && end / PPQ <= loop.endBeat : start >= 0 && end <= beatTick(stopBeat)) &&
            // Quantized loop takes sit on the song-absolute grid whenever the loop holds a grid line.
            (!loopGrid || !loopHasGridLine(loopRange, loopGrid) || start % beatTick(loopGrid) === 0);
        });
        expect(checked, `sequence ${sequence}, loop=${Boolean(loop)}, grid=${loopGrid}`).toBe(true);
        expect(notes).toHaveLength(onsets);
        expect(new Set(notes.map((note) => note.id)).size).toBe(notes.length);
        expect(notes).toEqual(eventsToNotes(events, options));
        if (!loop) {
          const stopping = notes.filter((note) => held.has(note.pitch) && beatTick(note.startBeat + note.durationBeats) === beatTick(stopBeat));
          expect(new Set(stopping.map((note) => note.pitch)).size).toBe(held.size);
        }
      }
    }
  });
});
