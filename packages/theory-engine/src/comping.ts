import type { ChordEventInput, GeneratedNote } from './types';
import { parseBoundedChord } from './chords';
import { voiceChord, voiceLead } from './voicing';

export type CompingPattern = 'whole' | 'eighths' | 'arpUp' | 'arpUpDown' | 'stab';

const PPQ = 480;
export const MAX_COMPING_NOTES = 100_000;
const TOO_MANY_NOTES = '伴奏の音の数が上限（100000 個）を超えます。クリップを短くするか、音の数を減らしてください。';
// Clip-relative subtraction can leave an exact grid edge a tiny fraction off its tick.
const TICK_EPSILON = 1e-9;

const PATTERN_TIMING = {
  whole: { step: Infinity, length: Infinity },
  eighths: { step: PPQ / 2, length: PPQ / 2 },
  arpUp: { step: PPQ, length: PPQ },
  arpUpDown: { step: PPQ, length: PPQ },
  stab: { step: PPQ, length: PPQ / 4 },
} satisfies Record<CompingPattern, { step: number; length: number }>;

export function compingTickSpan(chord: ChordEventInput) {
  if (!chord || !Number.isFinite(chord.startBeat) || !Number.isFinite(chord.durationBeats) ||
      chord.durationBeats <= 0) return;
  // Round inwards so every emitted note fits, including when a span is shorter than one tick.
  const start = Math.ceil(chord.startBeat * PPQ - TICK_EPSILON) + 0; // Normalize negative zero.
  const end = Math.floor((chord.startBeat + chord.durationBeats) * PPQ + TICK_EPSILON);
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
      Number.isSafeInteger(end - start) && end > start) return { start, end };
}

function isArpeggio(pattern: CompingPattern): boolean {
  return pattern === 'arpUp' || pattern === 'arpUpDown';
}

/** Count the notes for one chord without expanding its steps or computing a voicing. */
export function compingNoteCount(chord: ChordEventInput, pattern: CompingPattern): number {
  if (typeof pattern !== 'string' || !Object.hasOwn(PATTERN_TIMING, pattern)) return 0;
  const span = compingTickSpan(chord);
  if (!span) return 0;

  let pitchCount: number;
  try {
    // Inversions and register shifts preserve the pitch count, including a non-chord slash bass.
    const { pitchClasses, bassPc } = parseBoundedChord(chord.symbol);
    pitchCount = pitchClasses.length + Number(!pitchClasses.includes(bassPc));
  } catch {
    return 0;
  }
  const { step } = PATTERN_TIMING[pattern];
  const ticks = span.end - span.start;
  const steps = Math.ceil(ticks / Math.min(step, ticks));
  return steps * (isArpeggio(pattern) ? 1 : pitchCount);
}

/** Generate clip-ready notes in chronological chord order. Each pattern restarts at its chord's first tick. */
export function compingPattern(
  chords: readonly ChordEventInput[],
  pattern: CompingPattern,
  { register, voiceLeading }: { register: number; voiceLeading: boolean },
): Omit<GeneratedNote, 'reason'>[] {
  if (typeof pattern !== 'string' || !Object.hasOwn(PATTERN_TIMING, pattern)) return [];
  if (chords.length > MAX_COMPING_NOTES) throw new RangeError(TOO_MANY_NOTES);
  let count = 0;
  for (const chord of chords) {
    count += compingNoteCount(chord, pattern);
    if (count > MAX_COMPING_NOTES) throw new RangeError(TOO_MANY_NOTES);
  }
  if (count === 0) return [];

  const notes: Omit<GeneratedNote, 'reason'>[] = [];
  const { step, length } = PATTERN_TIMING[pattern];
  const arpeggio = isArpeggio(pattern);
  const voicing = { register: Number.isFinite(register) ? Math.max(0, Math.min(127, register)) : 60 };
  let previous: number[] = [];

  const orderedChords = chords.filter((chord) => Number.isFinite(chord?.startBeat))
    .sort((a, b) => a.startBeat - b.startBeat);
  for (const chord of orderedChords) {
    const span = compingTickSpan(chord);
    if (!span) continue;
    const { start, end } = span;

    let pitches: number[];
    try {
      pitches = voiceLeading ? voiceLead(previous, chord.symbol, voicing) : voiceChord(chord.symbol, voicing);
    } catch {
      continue; // Unreadable chord symbols are skipped, as in the chord lane.
    }
    previous = pitches;

    const sequence = pattern === 'arpUpDown'
      ? [...pitches, ...pitches.slice(1, -1).reverse()]
      : pitches;
    for (let tick = start, index = 0; tick < end; tick += Math.min(step, end - tick), index += 1) {
      const soundingPitches = arpeggio ? [sequence[index % sequence.length]!] : pitches;
      const durationBeats = Math.min(length, end - tick) / PPQ;
      for (const pitch of soundingPitches) {
        notes.push({ pitch, startBeat: tick / PPQ, durationBeats, velocity: 90 });
      }
    }
  }
  return notes;
}
