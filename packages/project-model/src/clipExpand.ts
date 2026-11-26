// Clip expansion: what a clip actually sounds, in absolute project beats.
//
// The single source of truth for clip length, loop and link (aliasOf) rules.
// Live playback, the WAV render and MIDI export all go through expandClip so
// they cannot disagree. Pure and deterministic; never throws on bad links.

import type { Clip, DrumEvent, DrumLane, NoteEvent, Project, TrackType } from './types';
import { beatsPerBar as projectBeatsPerBar } from './time';

/** A note to sound, at an absolute project beat. */
export type ExpandedNote = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  /** Set when the clip end (or the loop period) cut the note short. */
  cut?: true;
};

/** A drum hit to sound, at an absolute project beat. */
export type ExpandedDrumHit = {
  lane: DrumLane;
  beat: number;
  velocity: number;
};

export type ExpandedContent = {
  notes: ExpandedNote[];
  drumHits: ExpandedDrumHit[];
  /** Beginner-friendly Japanese reasons why something could not sound. */
  problems: string[];
  /**
   * Set when a loop would sound more than `MAX_LOOP_EVENTS` and was cut short.
   * validateProject rejects such a clip, so a valid project never sets it.
   */
  overLimit?: true;
};

/** Steps per bar of a drum clip that does not say. */
const DEFAULT_STEPS_PER_BAR = 16;

/**
 * Upper bound on the notes and drum hits one looping clip may sound, so a tiny
 * period cannot stall playback or fill memory. Part of the expansion rule
 * itself, so live playback, WAV and MIDI all stop at the same place; only whole
 * repeats are kept and the lost range is reported in `problems`.
 */
export const MAX_LOOP_EVENTS = 100_000;

/**
 * Tolerance for "starts at or after the end" checks. Fractional periods such
 * as 0.3 add up to 0.9999999999999999 instead of 1; content that close to the
 * end is treated as starting at the end, so it is dropped on every path.
 */
export const CLIP_EDGE_TOLERANCE_BEATS = 1e-9;

/** Keep the rounding tolerance proportional for spans shorter than one beat. */
function edgeTolerance(span: number): number {
  return CLIP_EDGE_TOLERANCE_BEATS * Math.min(1, span);
}

export function startsBeforeClipEnd(start: number, end: number): boolean {
  return end > 0 && start < end - edgeTolerance(end);
}

/** End of the first audible pass, before any repeats start. */
export function clipFirstPassEnd(clip: Clip): number {
  const period = clip.contentLengthBeats ?? clip.lengthBeats;
  return clip.loop && period > 0 ? Math.min(clip.lengthBeats, period) : clip.lengthBeats;
}

/** Count a source hit's first pass and repeats inside the clip and song. */
export function drumHitRepeatCount(clip: Clip, localBeat: number, availableBeats: number): number {
  const end = Math.min(clip.lengthBeats, availableBeats);
  const period = clip.contentLengthBeats ?? clip.lengthBeats;
  if (!clip.loop || !(period > 0)) return Number(startsBeforeClipEnd(localBeat, end));
  if (!startsBeforeClipEnd(localBeat, period)) return 0;
  const completeRepeats = Math.floor(end / period);
  const partialEnd = end - completeRepeats * period - edgeTolerance(clipFirstPassEnd(clip));
  return end > 0 ? completeRepeats + Number(localBeat < partialEnd) : 0;
}

/** What a track that sounds neither notes nor drum hits is called in messages. */
const SILENT_TRACK_LABEL: Record<Exclude<TrackType, 'instrument' | 'drum'>, string> = {
  audio: 'オーディオのトラック',
  bus: 'まとめ用のトラック(バス)',
  master: 'マスタートラック',
};

/** A beat count for a message: at most 3 decimals, no trailing zeros. */
function formatBeats(beats: number): string {
  return String(Number(beats.toFixed(3)));
}

/**
 * Follow `aliasOf` links to the clip that owns the content. Returns the
 * problem text instead when the chain is cut or loops back on itself.
 */
export function resolveLinkSource(clip: Clip, allClips: readonly Clip[]): Clip | string {
  const visited = new Set<string>([clip.id]);
  let current = clip;
  while (current.aliasOf !== undefined) {
    const targetId = current.aliasOf;
    if (visited.has(targetId)) {
      return 'リンク(別のクリップと中身を共有する設定)が循環していて、たどると元のクリップに戻ってしまうため、このクリップは鳴りません。';
    }
    const target = allClips.find((candidate) => candidate.id === targetId);
    if (target === undefined) {
      return 'リンク(別のクリップと中身を共有する設定)の相手のクリップが見つからないため、このクリップは鳴りません。リンク先が削除された可能性があります。';
    }
    visited.add(targetId);
    current = target;
  }
  return current;
}

/**
 * Expand a clip into the notes and drum hits it sounds, in absolute beats.
 *
 * Rules:
 * 1. Content starting at or after `lengthBeats` is dropped; notes crossing the
 *    clip end are cut to end there.
 * 2. With `loop`, the content repeats every `contentLengthBeats ?? lengthBeats`
 *    beats (each repeat keeps only content inside the period). A period of 0 or
 *    less does not repeat.
 * 3. With `aliasOf`, the linked clip's notes and drum hits sound at this clip's
 *    `startBeat`, within this clip's length and loop settings. A missing or
 *    circular link sounds nothing and reports a problem.
 * 4. With `trackType`, only what that track can sound is kept: a drum track
 *    sounds drum hits, an instrument track sounds notes, and audio, bus and
 *    master tracks sound neither. The rest is reported.
 *
 * Content starting within the edge tolerance of an end counts as starting at
 * it, and a note ending within it of an end is not cut. A loop keeps at most
 * `MAX_LOOP_EVENTS` sounds. The final partial repeat counts only its audible events.
 * Whole repeats only; the silent rest is reported. Drum steps become beats with
 * `beatsPerBar` (quarter-note beats per bar).
 */
export function expandClip(
  clip: Clip,
  allClips: readonly Clip[],
  beatsPerBar = 4,
  trackType?: TrackType,
): ExpandedContent {
  return expandClipContent(clip, allClips, beatsPerBar, trackType, true);
}

/** Check the playback limit without allocating every repeated note or hit. */
export function clipLoopLimitProblem(
  clip: Clip,
  allClips: readonly Clip[],
  beatsPerBar: number,
  trackType: TrackType,
): string | undefined {
  if (!clip.loop) return undefined;
  const result = expandClipContent(clip, allClips, beatsPerBar, trackType, false);
  return result.overLimit ? result.problems.at(-1) : undefined;
}

/** Find the first loop that would be cut short in this project. */
export function findProjectLoopLimitProblem(project: Project): string | undefined {
  const allClips = project.tracks.flatMap((track) => track.clips);
  const beatsPerBar = projectBeatsPerBar(project.timeSignature);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const problem = clipLoopLimitProblem(clip, allClips, beatsPerBar, track.type);
      if (problem) return problem;
    }
  }
  return undefined;
}

function expandClipContent(
  clip: Clip,
  allClips: readonly Clip[],
  beatsPerBar: number,
  trackType: TrackType | undefined,
  materialize: boolean,
): ExpandedContent {
  const result: ExpandedContent = { notes: [], drumHits: [], problems: [] };
  const source = resolveLinkSource(clip, allClips);
  if (typeof source === 'string') {
    result.problems.push(source);
    return result;
  }

  const clipEnd = clip.lengthBeats;
  if (!(clipEnd > 0)) return result;

  const looping = clip.loop && (clip.contentLengthBeats ?? clip.lengthBeats) > 0;
  const period = looping ? (clip.contentLengthBeats ?? clip.lengthBeats) : 0;
  // Within one repeat, content must start before this local end.
  const localEnd = looping ? period : clipEnd;

  const stepsPerBar =
    source.stepsPerBar !== undefined && source.stepsPerBar > 0 ? source.stepsPerBar : DEFAULT_STEPS_PER_BAR;
  const beatsPerStep = (beatsPerBar > 0 ? beatsPerBar : 4) / stepsPerBar;
  const inRepeat = (local: number): boolean => startsBeforeClipEnd(local, localEnd);

  let notes: NoteEvent[] = (source.notes ?? []).filter((note) => inRepeat(note.startBeat));
  let drums: DrumEvent[] = (source.drumEvents ?? []).filter((drum) => inRepeat(drum.stepIndex * beatsPerStep));
  if (trackType === 'drum' && notes.length > 0) {
    result.problems.push(
      `ドラムのトラックでは音符は鳴らないため、このクリップの音符 ${notes.length} 個は鳴りません。` +
        '音符は楽器のトラックのクリップに置きましょう。',
    );
    notes = [];
  } else if (trackType === 'instrument' && drums.length > 0) {
    result.problems.push(
      `楽器のトラックではドラムの音は鳴らないため、このクリップのドラムの音 ${drums.length} 個は鳴りません。` +
        'ドラムの音はドラムのトラックのクリップに置きましょう。',
    );
    drums = [];
  } else if (trackType !== undefined && trackType !== 'drum' && trackType !== 'instrument') {
    if (notes.length + drums.length > 0) {
      result.problems.push(
        `${SILENT_TRACK_LABEL[trackType]}では音符もドラムの音も鳴らないため、このクリップの音 ${notes.length + drums.length} 個は鳴りません。` +
          '音符は楽器のトラック、ドラムの音はドラムのトラックのクリップに置きましょう。',
      );
    }
    notes = [];
    drums = [];
  }
  const eventsPerRepeat = notes.length + drums.length;
  if (eventsPerRepeat === 0) return result;

  // Once a repeat's content is known, all complete repeats have the same
  // event count. Adding a large offset before testing boundaries can round
  // away the difference between a start and the end of a very short period.
  const completeRepeats = looping ? Math.floor(clipEnd / period) : 1;
  const keptRepeats = looping
    ? Math.min(completeRepeats, Math.floor(MAX_LOOP_EVENTS / eventsPerRepeat))
    : 1;
  const partialOffset = keptRepeats * period;
  const partialLength = looping && keptRepeats === completeRepeats ? clipEnd - partialOffset : 0;
  const partialEnd = partialLength - edgeTolerance(clipFirstPassEnd(clip));
  const partialNotes = partialEnd > 0 ? notes.filter((note) => note.startBeat < partialEnd) : [];
  const partialDrums = partialEnd > 0
    ? drums.filter((drum) => drum.stepIndex * beatsPerStep < partialEnd)
    : [];
  const partialFits =
    keptRepeats * eventsPerRepeat + partialNotes.length + partialDrums.length <= MAX_LOOP_EVENTS;

  if (materialize) {
    const appendRepeat = (offset: number, end: number, repeatNotes: NoteEvent[], repeatDrums: DrumEvent[]) => {
      for (const note of repeatNotes) {
        // A note whose end is within the rounding tolerance keeps its duration.
        const cut = note.startBeat + note.durationBeats > end + edgeTolerance(end);
        result.notes.push({
          pitch: note.pitch,
          startBeat: clip.startBeat + (offset + note.startBeat),
          durationBeats: cut ? end - note.startBeat : note.durationBeats,
          velocity: note.velocity,
          ...(cut ? { cut: true as const } : {}),
        });
      }
      for (const drum of repeatDrums) {
        result.drumHits.push({
          lane: drum.lane,
          beat: clip.startBeat + (offset + drum.stepIndex * beatsPerStep),
          velocity: drum.velocity,
        });
      }
    };

    for (let repeat = 0; repeat < keptRepeats; repeat++) {
      appendRepeat(repeat * period, localEnd, notes, drums);
    }
    if (partialFits && partialEnd > 0) {
      appendRepeat(partialOffset, partialLength, partialNotes, partialDrums);
    }
  }

  if (looping && (keptRepeats < completeRepeats || !partialFits)) {
    result.overLimit = true;
    const soundedBeats = partialOffset;
    result.problems.push(
      `ループで鳴らす音が上限の ${MAX_LOOP_EVENTS} 個を超えます。` +
        (keptRepeats === 0
          ? `最初の 1 回分も上限を超えるため、このクリップの ${formatBeats(clipEnd)} 拍は鳴りません。`
          : `クリップの先頭から ${formatBeats(soundedBeats)} 拍までは鳴りますが、` +
            `そこからクリップの終わりまでの ${formatBeats(clipEnd - soundedBeats)} 拍は鳴りません。`) +
        'クリップを短くするか、音の数を減らしましょう。',
    );
  }

  return result;
}
