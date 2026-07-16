import {
  MAX_EVENTS_PER_CLIP,
  MIN_EVENT_DURATION_BEATS,
  type NoteEvent,
} from '@cts/project-model';
import type { HummingMelodyNote } from '../../audio/hummingTranscription';

export type HummingQuantize = 'off' | 'sixteenth' | 'eighth' | 'quarter';

const QUANTIZE_BEATS: Readonly<Record<Exclude<HummingQuantize, 'off'>, number>> = {
  sixteenth: 0.25,
  eighth: 0.5,
  quarter: 1,
};

export class HummingNoteMappingError extends Error {
  constructor(readonly code: 'invalid-input' | 'event-limit-exceeded') {
    super(code);
    this.name = 'HummingNoteMappingError';
  }
}

type Candidate = Readonly<{
  pitch: number;
  startBeat: number;
  endBeat: number;
  confidence: number;
}>;

function snap(value: number, grid: number | null): number {
  return grid === null ? value : Math.round(value / grid) * grid;
}

function durationWithinEnd(startBeat: number, endBeat: number): number {
  let durationBeats = endBeat - startBeat;
  // Subtraction followed by addition can round one ULP past endBeat. Project
  // validation is intentionally strict, so move the derived duration inward.
  if (startBeat + durationBeats > endBeat) {
    durationBeats -= Number.EPSILON * Math.max(1, Math.abs(durationBeats));
  }
  return durationBeats;
}

/** Map monophonic transcription time into one clip's local quarter-note beat domain. */
export function hummingMelodyToNoteEvents(
  melody: readonly HummingMelodyNote[],
  options: Readonly<{
    bpm: number;
    clipLengthBeats: number;
    quantize: HummingQuantize;
    createId: () => string;
  }>,
): NoteEvent[] {
  if (
    !Number.isFinite(options.bpm) ||
    options.bpm <= 0 ||
    !Number.isFinite(options.clipLengthBeats) ||
    options.clipLengthBeats < MIN_EVENT_DURATION_BEATS ||
    typeof options.createId !== 'function'
  ) {
    throw new HummingNoteMappingError('invalid-input');
  }
  if (melody.length > MAX_EVENTS_PER_CLIP) {
    throw new HummingNoteMappingError('event-limit-exceeded');
  }
  const grid = options.quantize === 'off' ? null : QUANTIZE_BEATS[options.quantize];
  if (grid === undefined) throw new HummingNoteMappingError('invalid-input');
  const beatsPerSecond = options.bpm / 60;
  const candidates: Candidate[] = melody.map((note) => {
    if (
      !Number.isFinite(note.startSeconds) ||
      note.startSeconds < 0 ||
      !Number.isFinite(note.durationSeconds) ||
      note.durationSeconds <= 0 ||
      !Number.isInteger(note.midi) ||
      note.midi < 0 ||
      note.midi > 127 ||
      !Number.isFinite(note.confidence) ||
      note.confidence < 0 ||
      note.confidence > 1
    ) {
      throw new HummingNoteMappingError('invalid-input');
    }
    const rawStart = note.startSeconds * beatsPerSecond;
    const rawEnd = (note.startSeconds + note.durationSeconds) * beatsPerSecond;
    const startBeat = Math.max(0, snap(rawStart, grid));
    const minimumDuration = grid ?? MIN_EVENT_DURATION_BEATS;
    const endBeat = Math.max(startBeat + minimumDuration, snap(rawEnd, grid));
    return {
      pitch: note.midi,
      startBeat,
      endBeat,
      confidence: note.confidence,
    };
  });

  candidates.sort(
    (left, right) =>
      left.startBeat - right.startBeat ||
      right.confidence - left.confidence ||
      left.pitch - right.pitch,
  );

  // Quantization can collapse two consecutive monophonic notes onto one beat.
  // Keep the more confident candidate instead of accidentally creating a chord.
  const monophonic: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.startBeat >= options.clipLengthBeats) continue;
    const previous = monophonic.at(-1);
    if (previous && Math.abs(previous.startBeat - candidate.startBeat) < 1e-9) continue;
    monophonic.push(candidate);
  }

  const result: NoteEvent[] = [];
  for (let index = 0; index < monophonic.length; index += 1) {
    const candidate = monophonic[index];
    if (!candidate) continue;
    const nextStart = monophonic[index + 1]?.startBeat ?? options.clipLengthBeats;
    const endBeat = Math.min(candidate.endBeat, nextStart, options.clipLengthBeats);
    const durationBeats = durationWithinEnd(candidate.startBeat, endBeat);
    if (
      durationBeats < MIN_EVENT_DURATION_BEATS ||
      candidate.startBeat + durationBeats > endBeat
    ) continue;
    result.push({
      id: options.createId(),
      pitch: candidate.pitch,
      startBeat: candidate.startBeat,
      durationBeats,
      velocity: Math.round(55 + candidate.confidence * 40),
    });
  }
  if (result.length > MAX_EVENTS_PER_CLIP) {
    throw new HummingNoteMappingError('event-limit-exceeded');
  }
  return result;
}
