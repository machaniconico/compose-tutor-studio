import { describe, expect, it } from 'vitest';
import {
  snapBeat,
  floorToGrid,
  quantizeStart,
  quantizeNotes,
  xToBeat,
  beatToX,
  yToPitch,
  pitchToY,
  clampPitch,
  snapPitchToPitchClasses,
  rectsOverlap,
  normalizeRect,
  PIANO_HIGH_MIDI,
  PIANO_LOW_MIDI,
  FULL_PIANO_RANGE,
  midiToRow,
  rowToMidi,
  initialPitchWindow,
  pitchSpan,
  windowScrollTop,
  visibleRowRange,
  notesInRows,
} from '../src/features/pianoRoll/gridMath';

describe('notesInRows', () => {
  it('collects 150,000 notes in one visible row in order', () => {
    const notes = Array.from({ length: 150_000 }, (_, index) => ({
      id: `note-${index}`,
      pitch: 60,
      startBeat: 0,
      durationBeats: 1,
      velocity: 100,
    }));
    const otherNote = { ...notes[0]!, id: 'other', pitch: 59 };
    const notesByRow = new Map([[48, notes], [49, [otherNote]], [50, [otherNote]]]);
    const visible = notesInRows(notesByRow, 47, 49);

    expect(visible).toHaveLength(notes.length + 1);
    expect(visible.every((note, index) => note === (notes[index] ?? otherNote))).toBe(true);
  });
});

describe('snapBeat / quantizeStart', () => {
  it('snaps to the nearest grid line', () => {
    expect(snapBeat(0.6, 1)).toBe(1);
    expect(snapBeat(0.4, 1)).toBe(0);
    expect(snapBeat(1.3, 0.5)).toBe(1.5);
    expect(quantizeStart(2.2, 1)).toBe(2);
  });

  it('never returns negatives', () => {
    expect(snapBeat(-1, 1)).toBe(0);
  });

  it('passes through when snap is non-positive', () => {
    expect(snapBeat(3.7, 0)).toBe(3.7);
  });
});

describe('quantizeNotes', () => {
  it('quantizes note starts without changing other fields', () => {
    const notes = [
      { id: 'n1', startBeat: 0.49, pitch: 60, durationBeats: 0.5, velocity: 80 },
      { id: 'n2', startBeat: 1.26, pitch: 64, durationBeats: 1, velocity: 96 },
    ];

    expect(quantizeNotes(notes, 0.5)).toEqual([
      { id: 'n1', startBeat: 0.5, pitch: 60, durationBeats: 0.5, velocity: 80 },
      { id: 'n2', startBeat: 1.5, pitch: 64, durationBeats: 1, velocity: 96 },
    ]);
  });

  it('does not mutate the input notes', () => {
    const notes = [{ id: 'n1', startBeat: 0.74, pitch: 60 }];

    quantizeNotes(notes, 0.5);

    expect(notes).toEqual([{ id: 'n1', startBeat: 0.74, pitch: 60 }]);
  });
});

describe('floorToGrid', () => {
  it('floors to the grid line at or before', () => {
    expect(floorToGrid(1.9, 1)).toBe(1);
    expect(floorToGrid(1.4, 0.5)).toBe(1);
    expect(floorToGrid(0.9, 0.25)).toBe(0.75);
  });
});

describe('pixel <-> beat conversion round-trips', () => {
  it('xToBeat and beatToX are inverse', () => {
    expect(beatToX(4, 28)).toBe(112);
    expect(xToBeat(112, 28)).toBe(4);
  });

  it('xToBeat guards divide-by-zero', () => {
    expect(xToBeat(50, 0)).toBe(0);
  });
});

describe('pitch <-> y conversion', () => {
  it('top row is the highest pitch', () => {
    expect(yToPitch(0, 14)).toBe(PIANO_HIGH_MIDI);
    expect(pitchToY(PIANO_HIGH_MIDI, 14)).toBe(0);
  });

  it('descends one pitch per row', () => {
    expect(yToPitch(14, 14)).toBe(PIANO_HIGH_MIDI - 1);
    expect(pitchToY(PIANO_HIGH_MIDI - 2, 14)).toBe(28);
  });
});

describe('clampPitch', () => {
  it('clamps into the editable range', () => {
    expect(clampPitch(200)).toBe(PIANO_HIGH_MIDI);
    expect(clampPitch(0)).toBe(PIANO_LOW_MIDI);
    expect(clampPitch(60)).toBe(60);
  });
});

describe('snapPitchToPitchClasses', () => {
  const cMajor = new Set([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B

  it('keeps an in-scale pitch unchanged', () => {
    expect(snapPitchToPitchClasses(60, cMajor)).toBe(60); // C4
    expect(snapPitchToPitchClasses(64, cMajor)).toBe(64); // E4
  });

  it('snaps an out-of-scale pitch to the nearest in-scale pitch', () => {
    // 61 = C#4 -> nearest in-scale is C4 (60) or D4 (62); search prefers +1 first => 62
    const snapped = snapPitchToPitchClasses(61, cMajor);
    expect([60, 62]).toContain(snapped);
    expect(cMajor.has(((snapped % 12) + 12) % 12)).toBe(true);
  });

  it('returns the pitch when the set is empty', () => {
    expect(snapPitchToPitchClasses(61, new Set())).toBe(61);
  });

  it('snaps inward at the top of the keyboard (B major at MIDI 108 gives 107, not 109)', () => {
    const bMajor = new Set([11, 1, 3, 4, 6, 8, 10]);
    expect(snapPitchToPitchClasses(108, bMajor)).toBe(109);
    expect(snapPitchToPitchClasses(108, bMajor, 21, 108)).toBe(107);
  });
});

describe('rect helpers (marquee)', () => {
  it('detects overlap', () => {
    expect(
      rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    ).toBe(true);
    expect(
      rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }),
    ).toBe(false);
  });

  it('normalizes a backwards drag rectangle', () => {
    expect(normalizeRect(30, 40, 10, 20)).toEqual({ x: 10, y: 20, w: 20, h: 20 });
  });
});

describe('row <-> MIDI over the full piano range (21..108)', () => {
  it('uses the full 88-key range by default', () => {
    expect(PIANO_LOW_MIDI).toBe(21);
    expect(PIANO_HIGH_MIDI).toBe(108);
    expect(FULL_PIANO_RANGE).toEqual({ low: 21, high: 108 });
  });

  it('round-trips MIDI 21 and 108', () => {
    for (const midi of [21, 60, 108]) {
      const row = midiToRow(midi);
      expect(row).not.toBeNull();
      expect(rowToMidi(row as number)).toBe(midi);
    }
    expect(midiToRow(108)).toBe(0);
    expect(midiToRow(21)).toBe(87);
  });

  it('returns null outside the range', () => {
    expect(midiToRow(20)).toBeNull();
    expect(midiToRow(109)).toBeNull();
    expect(rowToMidi(-1)).toBeNull();
    expect(rowToMidi(88)).toBeNull();
    expect(rowToMidi(1.5)).toBeNull();
  });

  it('honours a custom range', () => {
    const range = { low: 48, high: 72 };
    expect(midiToRow(72, range)).toBe(0);
    expect(rowToMidi(24, range)).toBe(48);
    expect(midiToRow(47, range)).toBeNull();
    expect(rowToMidi(25, range)).toBeNull();
  });
});

describe('initialPitchWindow', () => {
  it('shows C3..C5 when the clip has no notes', () => {
    expect(initialPitchWindow([])).toEqual({ low: 48, high: 72 });
  });

  it('pads the note range by one octave on each side', () => {
    expect(initialPitchWindow([60, 67, 64])).toEqual({ low: 48, high: 79 });
  });

  it('clamps the padded range into the piano range', () => {
    expect(initialPitchWindow([24, 105])).toEqual({ low: 21, high: 108 });
  });

  it('handles a dense clip (200,000 notes) without overflowing the call stack', () => {
    const pitches = Array<number>(200_000).fill(60);
    pitches[123_456] = 30;
    expect(() => initialPitchWindow(pitches)).not.toThrow();
    expect(initialPitchWindow(pitches)).toEqual({ low: 21, high: 72 });
    expect(pitchSpan(pitches)).toEqual({ low: 30, high: 60 });
  });
});

describe('pitchSpan', () => {
  it('is null for no notes and the min..max otherwise', () => {
    expect(pitchSpan([])).toBeNull();
    expect(pitchSpan([64, 60, 67])).toEqual({ low: 60, high: 67 });
  });
});

describe('visibleRowRange (simple virtualization)', () => {
  it('returns the rows inside the viewport plus overscan', () => {
    // rows 10..14 are visible at 16px rows; overscan 2 -> 8..16
    expect(visibleRowRange(160, 80, 16, 88, 2)).toEqual({ first: 8, last: 16 });
  });

  it('clamps to the row count', () => {
    expect(visibleRowRange(0, 64, 16, 88, 4)).toEqual({ first: 0, last: 7 });
    expect(visibleRowRange(87 * 16, 160, 16, 88, 4)).toEqual({ first: 83, last: 87 });
  });

  it('is empty-safe', () => {
    expect(visibleRowRange(0, 100, 0, 88)).toEqual({ first: 0, last: 87 });
    expect(visibleRowRange(0, 100, 16, 0)).toEqual({ first: 0, last: -1 });
  });
});

describe('windowScrollTop', () => {
  // 88 rows (MIDI 108 at the top), 16px each.
  const ROWS = 88;
  const H = 16;
  const midiAt = (y: number) => 108 - Math.floor(y / H);

  it('keeps the clip notes in view when the viewport is shorter than the window', () => {
    // Notes 60..72 -> window 48..84; a 12-row viewport (1280x900 case).
    const top = windowScrollTop({ low: 48, high: 84 }, 12 * H, H, ROWS);
    const topMidi = midiAt(top);
    const bottomMidi = midiAt(top + 12 * H - 1);
    expect(topMidi).toBeLessThanOrEqual(72);
    expect(bottomMidi).toBeGreaterThanOrEqual(60);
    // Centred on the middle of the notes (66).
    expect(Math.abs((topMidi + bottomMidi) / 2 - 66)).toBeLessThanOrEqual(1);
  });

  it('shows the whole window when the viewport is taller than it', () => {
    const top = windowScrollTop({ low: 48, high: 72 }, 40 * H, H, ROWS);
    expect(midiAt(top)).toBeGreaterThanOrEqual(72);
    expect(midiAt(top + 40 * H - 1)).toBeLessThanOrEqual(48);
  });

  it('clamps to the scrollable range at both ends', () => {
    expect(windowScrollTop({ low: 96, high: 108 }, 30 * H, H, ROWS)).toBe(0);
    expect(windowScrollTop({ low: 21, high: 33 }, 30 * H, H, ROWS)).toBe((ROWS - 30) * H);
    expect(windowScrollTop({ low: 21, high: 108 }, 200 * H, H, ROWS)).toBe(0);
  });

  // 1280x800 case: 72px viewport minus the 22px sticky ruler = 50px for rows.
  const ROW_VIEW = 50;
  const rowsInView = (top: number) => {
    const midis: number[] = [];
    for (let row = Math.floor(top / H); row * H < top + ROW_VIEW; row += 1) {
      if ((row + 1) * H <= top + ROW_VIEW && row * H >= top) midis.push(108 - row);
    }
    return midis;
  };

  it.each([108, 21])('keeps a lone MIDI %i note fully in view when the padded window cannot fit', (pitch) => {
    const notes = pitchSpan([pitch])!;
    const top = windowScrollTop(initialPitchWindow([pitch]), ROW_VIEW, H, ROWS, 108, notes);
    expect(rowsInView(top)).toContain(pitch);
  });

  it('shows the top of the notes when even the notes do not fit', () => {
    const top = windowScrollTop(initialPitchWindow([60, 84]), ROW_VIEW, H, ROWS, 108, { low: 60, high: 84 });
    expect(rowsInView(top)[0]).toBe(84);
  });

  it('still centres the padded window when it fits', () => {
    const win = { low: 48, high: 72 };
    expect(windowScrollTop(win, 40 * H, H, ROWS, 108, { low: 60, high: 60 })).toBe(
      windowScrollTop(win, 40 * H, H, ROWS),
    );
  });
});
