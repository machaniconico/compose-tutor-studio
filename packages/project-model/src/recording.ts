import { placedNoteTicks } from './clipExpand';
import { beatTick, PPQ } from './time';
import type { Clip, NoteEvent } from './types';

export type RecordingEvent = { timeBeat: number; midi: number; velocity: number; on: boolean };
export type RecordingRange = { startBeat: number; endBeat: number };

function safeBeat(beat: number): boolean {
  return Number.isSafeInteger(beatTick(beat));
}

export function isWholeRecordingTick(beat: number): boolean {
  return safeBeat(beat) && beatTick(beat) / PPQ === beat;
}

/** Fit the stored duration to the sounding interval, using playback's swung onset. */
export function fitRecordingNote(
  clip: Clip, note: NoteEvent, swing: number | undefined, effectiveEnd: number,
): NoteEvent | undefined {
  const placement = placedNoteTicks(clip, note, { swing, songEnd: effectiveEnd });
  const { startBeat, startTick, passEndBeat, passEndTick } = placement;
  const minimum = 1 / PPQ;
  // Addition and subtraction can disagree by an ulp at a whole-tick edge.
  if (startTick >= passEndTick || startBeat + minimum > passEndBeat + Math.abs(passEndBeat) * Number.EPSILON) return;
  const durationBeats = Math.max(minimum, Math.min(note.durationBeats, passEndBeat - startBeat));
  return durationBeats === note.durationBeats ? note : { ...note, durationBeats };
}

/** Use only ticks inside the exact loop boundaries, including for off-grid ranges. */
export function tickAlignedRecordingLoop(range: RecordingRange): RecordingRange {
  const start = beatTick(range.startBeat);
  const end = beatTick(range.endBeat);
  const startTick = start / PPQ < range.startBeat ? start + 1 : start;
  const endTick = end / PPQ > range.endBeat ? end - 1 : end;
  if (!safeBeat(range.startBeat) || !safeBeat(range.endBeat) ||
      startTick < 0 || !Number.isSafeInteger(endTick - startTick) || endTick <= startTick) {
    throw new RangeError('録音するループの範囲を広げてください。');
  }
  return { startBeat: startTick / PPQ, endBeat: endTick / PPQ };
}

/**
 * Pair input on the unwrapped song timeline, then fold completed notes into
 * the loop. The optional grid snaps on the song-absolute grid (aligned to song
 * beat 0). A snap to the end wraps if the loop ends there, and clamps to the
 * last grid line if the destination ends earlier. Count-in presses are ignored.
 * Output IDs are take-local and deterministic.
 */
export function eventsToNotes(
  events: readonly RecordingEvent[],
  { clipStartBeat, loopRange, loopGrid = 0, snapEndBeat, stopBeat }: {
    clipStartBeat: number;
    loopRange?: RecordingRange;
    loopGrid?: number;
    /** The destination end; a note folded at or after it is left for the caller to count. */
    snapEndBeat?: number;
    stopBeat: number;
  },
): NoteEvent[] {
  const loop = loopRange && tickAlignedRecordingLoop(loopRange);
  if (!isWholeRecordingTick(clipStartBeat) || clipStartBeat < 0 || !safeBeat(stopBeat)) {
    throw new RangeError('録音する位置を確認してください。');
  }
  const clipStart = beatTick(clipStartBeat);
  const stop = beatTick(stopBeat);
  if (stop <= 0) return [];
  const loopStart = loop ? beatTick(loop.startBeat) : 0;
  const loopEnd = loop ? beatTick(loop.endBeat) : 0;
  const loopLength = loopEnd - loopStart;
  const gridTicks = beatTick(loopGrid);
  const effectiveEnd = Math.min(loop?.endBeat ?? Infinity, snapEndBeat ?? Infinity);
  const snapEnd = beatTick(effectiveEnd);
  const wrapsAtEnd = loop?.endBeat === effectiveEnd;

  const held = new Map<number, { tick: number; velocity: number }>();
  const notes: NoteEvent[] = [];
  function close(midi: number, end: number): void {
    const note = held.get(midi);
    if (!note) return;
    held.delete(midi);
    let start = note.tick;
    if (loop) {
      start = loopStart + ((start - loopStart) % loopLength + loopLength) % loopLength;
      // Use only grid lines inside the effective range, or keep the folded
      // position if no grid line fits there.
      const firstLine = gridTicks > 0 ? Math.ceil(loopStart / gridTicks) * gridTicks : loopEnd;
      const lastLine = gridTicks > 0 ? Math.floor((snapEnd - 1) / gridTicks) * gridTicks : loopStart;
      if (start < snapEnd && firstLine <= lastLine) {
        const quantized = Math.round(start / gridTicks) * gridTicks;
        start = quantized >= snapEnd ? (wrapsAtEnd ? firstLine : lastLine)
          : Math.max(quantized, firstLine);
      }
    }
    if (start < clipStart) return;
    const heldTicks = Math.max(1, end - note.tick);
    const loopBounded = (loop ? Math.min(heldTicks, loopEnd - start) : heldTicks) / PPQ;
    const durationBeats = loop && start < snapEnd && !wrapsAtEnd
      ? Math.min(loopBounded, effectiveEnd - start / PPQ)
      : loopBounded;
    notes.push({
      id: `take-${notes.length + 1}`,
      pitch: midi,
      startBeat: (start - clipStart) / PPQ,
      durationBeats,
      velocity: note.velocity,
    });
  }

  // Sort a copy so out-of-order input is paired by time. At equal times the
  // original input order decides which key transition comes first.
  const ordered = events.filter((event) =>
    safeBeat(event.timeBeat) && event.timeBeat >= 0 && event.timeBeat <= stopBeat &&
    Number.isInteger(event.midi) && event.midi >= 0 && event.midi <= 127,
  ).sort((a, b) => a.timeBeat - b.timeBeat);
  for (const event of ordered) {
    const tick = beatTick(event.timeBeat);
    if (!event.on) {
      close(event.midi, tick);
    } else if (event.timeBeat < stopBeat && !held.has(event.midi) && Number.isFinite(event.velocity)) {
      held.set(event.midi, {
        tick: Math.min(tick, stop - 1),
        velocity: Math.max(1, Math.min(127, Math.round(event.velocity))),
      });
    }
  }
  for (const midi of held.keys()) close(midi, stop);
  return notes.sort((a, b) => a.startBeat - b.startBeat);
}
