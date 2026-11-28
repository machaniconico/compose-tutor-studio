import { swingBeat } from '../groove';
import { beatTick, PPQ } from '../ticks';
import type { Clip, DrumEvent, NoteEvent, Track } from '../types';
import type { LegacyClip } from './input';
import type { Wave5ReportCode } from './report';

export function drumSteps({ stepsPerBar }: LegacyClip): number {
  return stepsPerBar !== undefined && stepsPerBar > 0 ? stepsPerBar : 16;
}

export function loopPeriod(clip: LegacyClip, endTick: number): number {
  const period = clip.contentLengthBeats;
  if (period === undefined) return Infinity;
  if (!Number.isFinite(period) || period <= 0) throw new TypeError('Invalid loop period');
  return clip.loop && beatTick(clip.startBeat + period) < endTick ? period : Infinity;
}

/** Fit a tick-clipped duration by moving down the fewest representable doubles. */
export function fittingBeats(startBeat: number, durationBeats: number, endBeat: number): number {
  if (startBeat + durationBeats <= endBeat) return durationBeats;

  // Positive doubles are ordered by their bit patterns. Bisect in ULPs to
  // find the closest fit even when a short duration takes many steps.
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, durationBeats);
  let fits = 0n;
  let overshoots = bits.getBigUint64(0);
  while (overshoots - fits > 1n) {
    const candidate = (fits + overshoots) / 2n;
    bits.setBigUint64(0, candidate);
    if (startBeat + bits.getFloat64(0) <= endBeat) fits = candidate;
    else overshoots = candidate;
  }
  bits.setBigUint64(0, fits);
  return bits.getFloat64(0);
}

export type ClipReport = (code: Wave5ReportCode, detail?: Record<string, string | number | boolean>) => void;

export function convertClipContent(
  clip: Clip,
  placement: LegacyClip,
  source: LegacyClip,
  period: number,
  trackType: Track['type'],
  beatsPerBar: number,
  swing: number,
  materialized: boolean,
  useEventWork: (count: number) => void,
  eventId: (id: string, repeat: number) => string,
  report: ClipReport,
): void {
  const stepsPerBar = drumSteps(source);
  const beatsPerStep = beatsPerBar / stepsPerBar;
  const startTick = beatTick(clip.startBeat);
  const length = beatTick(clip.lengthBeats);
  const unrolling = Number.isFinite(period);
  // Use the original normalized content at this instance's original position.
  // The source clip might have been cut by its own placement in the song.
  const localTick = (beat: number) => beatTick(placement.startBeat + beat) - startTick;
  // Round each absolute pass edge. Repeating a rounded period would accumulate drift.
  const repeatOffset = (repeat: number) => repeat === 0 ? 0 : localTick(repeat * period);
  const firstPassLength = Math.min(length, repeatOffset(1));
  const noteInputs = source.notes ?? [];
  const drumInputs = source.drumEvents ?? [];
  useEventWork(noteInputs.length + drumInputs.length);
  const notes: { note: NoteEvent; onset: number; duration: number }[] = [];
  let zeroLengthNotes = 0;
  if (trackType === 'instrument' && clip.type === 'midi') {
    for (const note of noteInputs) {
      if (!Number.isFinite(note.startBeat) || note.startBeat < 0 ||
          !Number.isFinite(note.durationBeats) || note.durationBeats <= 0) throw new TypeError('Invalid note range');
      const onset = localTick(note.startBeat);
      if (onset >= firstPassLength) continue;
      const duration = localTick(note.startBeat + note.durationBeats) - onset;
      if (duration > 0) notes.push({ note, onset, duration });
      else zeroLengthNotes++;
    }
  }
  const hits: { hit: DrumEvent; onset: number }[] = [];
  if (trackType === 'drum' && clip.type === 'drum') {
    for (const hit of drumInputs) {
      if (!Number.isSafeInteger(hit.stepIndex) || hit.stepIndex < 0) throw new TypeError('Invalid drum step');
      const onset = localTick(hit.stepIndex * beatsPerStep);
      if (onset < firstPassLength) hits.push({ hit, onset });
    }
  }

  const hidden = materialized ? zeroLengthNotes : noteInputs.length + drumInputs.length - notes.length - hits.length;
  if (clip.type === 'drum' && (source.stepsPerBar !== undefined || hits.length > 0)) clip.stepsPerBar = stepsPerBar;

  let passes = 1;
  if (unrolling) {
    passes = Math.max(1, Math.ceil(((startTick + length - 0.5) / PPQ - placement.startBeat) / period));
    if (repeatOffset(passes) < length) passes++;
    if (passes > 1 && repeatOffset(passes - 1) >= length) passes--;
  }
  if (notes.length === 0 && hits.length === 0) {
    if (hidden > 0) report('hidden-events-dropped', { count: hidden });
    if (unrolling) report('loop-unrolled', { passes });
    return;
  }

  // Bound the expansion work, including occurrences later dropped or merged.
  useEventWork(passes * (notes.length + hits.length));

  const ownedNotes: NoteEvent[] = [];
  const ownedHits = new Map<string, DrumEvent>();
  let snapped = false;
  let merged = 0;
  const lastStep = Math.ceil(clip.lengthBeats / beatsPerStep) - 1;
  for (let repeat = 0; repeat < passes; repeat++) {
    const offset = repeatOffset(repeat);
    const passEnd = Math.min(length, repeatOffset(repeat + 1));
    const swungOnset = (onset: number) =>
      beatTick(swingBeat((startTick + offset + onset) / PPQ, swing)) - startTick;

    for (const { note, onset, duration } of notes) {
      const start = offset + onset;
      const effectiveStart = unrolling ? swungOnset(onset) : start;
      const available = Math.min(duration, passEnd - effectiveStart);
      if (available <= 0) continue;
      const startBeat = start / PPQ;
      let durationBeats = fittingBeats(startBeat, available / PPQ, clip.lengthBeats);
      if (unrolling) {
        durationBeats = fittingBeats(effectiveStart / PPQ, durationBeats, passEnd / PPQ);
      }
      ownedNotes.push({
        id: eventId(note.id, repeat), startBeat, durationBeats,
        pitch: note.pitch, velocity: note.velocity,
      });
    }
    for (const { hit, onset } of hits) {
      if (offset + onset >= passEnd || (unrolling && swungOnset(onset) >= passEnd)) continue;
      const exactStep = hit.stepIndex + offset / (PPQ * beatsPerStep);
      const stepIndex = Math.min(lastStep, Math.round(exactStep));
      snapped ||= unrolling && Math.abs(stepIndex - exactStep) > 1e-9;
      const key = `${hit.lane}:${stepIndex}`;
      const previous = ownedHits.get(key);
      if (previous) {
        merged++;
        if (previous.velocity >= hit.velocity) continue;
      }
      ownedHits.set(key, { id: eventId(hit.id, repeat), stepIndex, lane: hit.lane, velocity: hit.velocity });
    }
  }
  if (hidden > 0) report('hidden-events-dropped', { count: hidden });
  if (unrolling) report('loop-unrolled', { passes });
  if (ownedNotes.length) clip.notes = ownedNotes;
  if (ownedHits.size) clip.drumEvents = [...ownedHits.values()];
  if (snapped) report('drum-loop-snapped');
  if (merged > 0) report('drum-hits-merged', { count: merged });
}
