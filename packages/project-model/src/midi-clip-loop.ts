import type { NoteEvent } from './types';

/** The placement fields needed to project one MIDI clip's note payload. */
export type MidiClipNotePattern = Readonly<{
  lengthBeats: number;
  loop: boolean;
  notes?: readonly NoteEvent[];
}>;

/** One note occurrence relative to its timeline clip instance. */
export type MidiClipNoteOccurrence = Readonly<{
  note: NoteEvent;
  localStartBeat: number;
  durationBeats: number;
  repeatIndex: number;
}>;

const SATURATED_OCCURRENCE_COUNT = Number.MAX_SAFE_INTEGER;

/** Treat values within a few ULPs of the boundary as the same half-open end. */
function isBeforeClipEnd(value: number, end: number): boolean {
  const tolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(value), Math.abs(end));
  return value < end - tolerance;
}

function saturatingAdd(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left)
    || left < 0
    || !Number.isSafeInteger(right)
    || right < 0
    || left > Number.MAX_SAFE_INTEGER - right
  ) {
    return SATURATED_OCCURRENCE_COUNT;
  }
  return left + right;
}

/** Natural loop period: the latest authored note end, in beats. */
export function midiClipNaturalPatternLength(
  notes: readonly NoteEvent[],
): number {
  let endBeat = 0;
  for (const note of notes) {
    endBeat = Math.max(endBeat, note.startBeat + note.durationBeats);
  }
  return endBeat;
}

/**
 * Return ceil(numerator / denominator), stabilizing ratios that are only an
 * IEEE-754 rounding error away from an integer (for example 0.9 / 0.3).
 */
function halfOpenOccurrenceCount(numerator: number, denominator: number): number {
  const quotient = numerator / denominator;
  if (!Number.isFinite(quotient) || quotient <= 0) {
    return quotient === 0 ? 0 : SATURATED_OCCURRENCE_COUNT;
  }

  const nearestInteger = Math.round(quotient);
  const integerTolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(quotient));
  const stabilized = Math.abs(quotient - nearestInteger) <= integerTolerance
    ? nearestInteger
    : quotient;
  const count = Math.ceil(stabilized);
  return Number.isSafeInteger(count) && count >= 0
    ? count
    : SATURATED_OCCURRENCE_COUNT;
}

function loopedNoteOccurrenceCount(
  clipLengthBeats: number,
  patternLengthBeats: number,
  note: NoteEvent,
): number {
  if (
    !Number.isFinite(note.startBeat)
    || note.startBeat < 0
    || !Number.isFinite(note.durationBeats)
    || note.durationBeats <= 0
  ) {
    return SATURATED_OCCURRENCE_COUNT;
  }
  if (!isBeforeClipEnd(note.startBeat, clipLengthBeats)) return 0;
  let count = halfOpenOccurrenceCount(
    clipLengthBeats - note.startBeat,
    patternLengthBeats,
  );
  if (count === SATURATED_OCCURRENCE_COUNT) return count;

  // The quotient is only an estimate. Correct its boundary candidate using
  // the same scale-aware half-open comparison that defines projection.
  while (
    count > 0
    && !isBeforeClipEnd(
      note.startBeat + (count - 1) * patternLengthBeats,
      clipLengthBeats,
    )
  ) {
    count -= 1;
  }
  while (
    count < SATURATED_OCCURRENCE_COUNT
    && isBeforeClipEnd(
      note.startBeat + count * patternLengthBeats,
      clipLengthBeats,
    )
  ) {
    count += 1;
  }
  return count;
}

/**
 * Count projected note occurrences without allocating them.
 *
 * Invalid or unrepresentably large loop input saturates at MAX_SAFE_INTEGER so
 * allocation preflights fail closed. A non-looped clip preserves its authored
 * note count; project validation remains responsible for its note timing.
 */
export function countMidiClipNoteOccurrences(
  clip: MidiClipNotePattern,
): number {
  const notes = clip.notes ?? [];
  if (!clip.loop || notes.length === 0) return notes.length;
  if (!Number.isFinite(clip.lengthBeats) || clip.lengthBeats <= 0) {
    return SATURATED_OCCURRENCE_COUNT;
  }

  const patternLengthBeats = midiClipNaturalPatternLength(notes);
  if (!Number.isFinite(patternLengthBeats) || patternLengthBeats <= 0) {
    return SATURATED_OCCURRENCE_COUNT;
  }

  let total = 0;
  for (const note of notes) {
    total = saturatingAdd(
      total,
      loopedNoteOccurrenceCount(clip.lengthBeats, patternLengthBeats, note),
    );
    if (total === SATURATED_OCCURRENCE_COUNT) return total;
  }
  return total;
}

/**
 * Visit each projected note only after enforcing an explicit caller ceiling.
 * Looped notes use their natural pattern period and the final partial note is
 * shortened at the clip's half-open end boundary.
 */
export function visitMidiClipNoteOccurrences(
  clip: MidiClipNotePattern,
  maxOccurrences: number,
  visit: (occurrence: MidiClipNoteOccurrence) => void,
): number {
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences < 0) {
    throw new RangeError('maxOccurrences must be a non-negative safe integer');
  }

  const notes = clip.notes ?? [];
  const occurrenceCount = countMidiClipNoteOccurrences(clip);
  if (
    occurrenceCount === SATURATED_OCCURRENCE_COUNT
    || occurrenceCount > maxOccurrences
  ) {
    throw new RangeError(
      `MIDI clip would create ${occurrenceCount} note occurrences; limit is ${maxOccurrences}`,
    );
  }

  if (!clip.loop) {
    for (const note of notes) {
      visit({
        note,
        localStartBeat: note.startBeat,
        durationBeats: note.durationBeats,
        repeatIndex: 0,
      });
    }
    return occurrenceCount;
  }

  if (occurrenceCount === 0) return 0;
  const patternLengthBeats = midiClipNaturalPatternLength(notes);
  for (const note of notes) {
    const noteOccurrenceCount = loopedNoteOccurrenceCount(
      clip.lengthBeats,
      patternLengthBeats,
      note,
    );
    for (let repeatIndex = 0; repeatIndex < noteOccurrenceCount; repeatIndex += 1) {
      const localStartBeat = note.startBeat + repeatIndex * patternLengthBeats;
      const remainingBeats = clip.lengthBeats - localStartBeat;
      visit({
        note,
        localStartBeat,
        durationBeats: Math.min(note.durationBeats, remainingBeats),
        repeatIndex,
      });
    }
  }
  return occurrenceCount;
}
