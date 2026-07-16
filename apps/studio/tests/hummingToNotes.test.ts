import { describe, expect, it } from 'vitest';
import {
  HummingNoteMappingError,
  hummingMelodyToNoteEvents,
} from '../src/features/hummingToMelody/hummingToNotes';

function ids() {
  let next = 0;
  return () => `note-${++next}`;
}

describe('humming melody note mapping', () => {
  it('maps seconds to local beats, quantizes, clamps and derives velocity', () => {
    const notes = hummingMelodyToNoteEvents(
      [
        { startSeconds: 0.12, durationSeconds: 0.42, midi: 69, confidence: 1 },
        { startSeconds: 0.62, durationSeconds: 0.5, midi: 72, confidence: 0.5 },
        { startSeconds: 4, durationSeconds: 1, midi: 74, confidence: 0.8 },
      ],
      { bpm: 120, clipLengthBeats: 4, quantize: 'sixteenth', createId: ids() },
    );
    expect(notes).toEqual([
      { id: 'note-1', pitch: 69, startBeat: 0.25, durationBeats: 0.75, velocity: 95 },
      { id: 'note-2', pitch: 72, startBeat: 1.25, durationBeats: 1, velocity: 75 },
    ]);
  });

  it('keeps the most confident note when quantization collapses an onset', () => {
    const notes = hummingMelodyToNoteEvents(
      [
        { startSeconds: 0.1, durationSeconds: 0.3, midi: 60, confidence: 0.4 },
        { startSeconds: 0.11, durationSeconds: 0.4, midi: 64, confidence: 0.9 },
      ],
      { bpm: 60, clipLengthBeats: 2, quantize: 'quarter', createId: ids() },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.pitch).toBe(64);
  });

  it('preserves unquantized timing and rejects invalid analyzer output', () => {
    const notes = hummingMelodyToNoteEvents(
      [{ startSeconds: 0.1, durationSeconds: 0.2, midi: 60, confidence: 0.75 }],
      { bpm: 120, clipLengthBeats: 4, quantize: 'off', createId: ids() },
    );
    expect(notes[0]?.startBeat).toBeCloseTo(0.2, 10);
    expect(notes[0]?.durationBeats).toBeCloseTo(0.4, 10);
    expect(() =>
      hummingMelodyToNoteEvents(
        [{ startSeconds: 0, durationSeconds: 1, midi: 200, confidence: 1 }],
        { bpm: 120, clipLengthBeats: 4, quantize: 'eighth', createId: ids() },
      ),
    ).toThrowError(HummingNoteMappingError);
  });

  it('keeps unquantized floating-point notes inside strict project boundaries', () => {
    const clipLengthBeats = 3.884317223462118;
    const bounded = hummingMelodyToNoteEvents(
      [{ startSeconds: 0.05, durationSeconds: 10, midi: 60, confidence: 1 }],
      { bpm: 60, clipLengthBeats, quantize: 'off', createId: ids() },
    );
    expect(bounded).toHaveLength(1);
    expect((bounded[0]?.startBeat ?? 0) + (bounded[0]?.durationBeats ?? 0)).toBeLessThanOrEqual(
      clipLengthBeats,
    );

    const tooShort = hummingMelodyToNoteEvents(
      [
        {
          startSeconds: 0.1,
          durationSeconds: 1,
          midi: 60,
          confidence: 1,
        },
      ],
      {
        bpm: 60,
        clipLengthBeats: 0.10104166666666661,
        quantize: 'off',
        createId: ids(),
      },
    );
    expect(tooShort).toEqual([]);
  });
});
