// Pure, no-throw command that changes the song length in whole bars under the
// current time-signature map. Shortening is content-safe: a clip that crosses
// the new end is trimmed (and an empty clip past it removed) only when no note
// or hit would stop sounding; chords and sections at or past the end are removed
// or trimmed; anything else beyond the end is reported back as a blocker and
// the project is left untouched. The application store turns a successful result into exactly one
// Undo history entry.

import { buildClipIndex, resolveClipContent } from './clip-resolution';
import { visitMidiClipNoteOccurrences } from './midi-clip-loop';
import { encodeProjectJson } from './project-codec';
import { compileDrumStepProjector, compileMusicalTime, projectDrumStep } from './time';
import { MIN_EVENT_DURATION_BEATS } from './limits';
import type { ChordEvent, Clip, Project, Section, Track } from './types';
import { MAX_PROJECT_LENGTH_BARS } from './validation';

export type SongLengthBlockerKind =
  | 'clip'
  /** A note or drum hit that starts at or after the new end. */
  | 'note'
  /** A note that starts before the new end but keeps sounding past it. */
  | 'note-overrun'
  | 'audio-take-folder'
  | 'automation-point'
  | 'tempo-event'
  | 'time-signature-event';

export type SongLengthBlocker = Readonly<{
  kind: SongLengthBlockerKind;
  /** Track name, section name or chord symbol; empty for map events. */
  name: string;
  /** 1-based bar number (under the current meter map) where the item starts. */
  bar: number;
}>;

export type SongLengthErrorCode =
  | 'invalid-length'
  | 'content-beyond-end'
  | 'project-not-adoptable'
  | 'invalid-project'
  | 'unexpected';

export type SongLengthResult =
  | Readonly<{
      ok: true;
      project: Project;
      changed: boolean;
      lengthBars: number;
      lengthBeats: number;
      /** Clips shortened to the new end / empty clips removed (shrinking only). */
      trimmedClips: number;
      removedClips: number;
      /** Chord / section events dropped or shortened to the new end. */
      removedChords: number;
      trimmedChords: number;
      removedSections: number;
      trimmedSections: number;
    }>
  | Readonly<{
      ok: false;
      project: Project;
      changed: false;
      error: Readonly<{
        code: SongLengthErrorCode;
        message: string;
        blockers?: readonly SongLengthBlocker[];
      }>;
    }>;

/** Longest blocker list returned; enough to explain, bounded for huge projects. */
export const MAX_SONG_LENGTH_BLOCKERS = 50;

type Segment = Readonly<{ beat: number; beatsPerBar: number }>;

function segmentsOf(project: Project): Segment[] {
  return project.timeSignatureMap.map((event) => ({
    beat: event.beat,
    beatsPerBar: (event.numerator * 4) / event.denominator,
  }));
}

/** Beat at the start of bar index `bars` (0 = beat 0); extends the last meter. */
function beatAtBar(segments: readonly Segment[], bars: number): number {
  let remaining = bars;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as Segment;
    const next = segments[index + 1];
    if (next === undefined) return segment.beat + remaining * segment.beatsPerBar;
    const segmentBars = (next.beat - segment.beat) / segment.beatsPerBar;
    if (remaining <= segmentBars) return segment.beat + remaining * segment.beatsPerBar;
    remaining -= segmentBars;
  }
  return 0;
}

/** 1-based bar number containing `beat`. */
function barNumberAtBeat(segments: readonly Segment[], beat: number): number {
  let bars = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as Segment;
    const next = segments[index + 1];
    if (next === undefined || beat < next.beat) {
      return bars + Math.floor((beat - segment.beat) / segment.beatsPerBar) + 1;
    }
    bars += (next.beat - segment.beat) / segment.beatsPerBar;
  }
  return 1;
}

/** 1-based bar number containing `beat` under the project's meter map. */
export function songBarAtBeat(project: Project, beat: number): number {
  return barNumberAtBeat(segmentsOf(project), beat);
}

function failure(
  project: Project,
  code: SongLengthErrorCode,
  message: string,
  blockers?: readonly SongLengthBlocker[],
): Extract<SongLengthResult, { ok: false }> {
  return {
    ok: false,
    project,
    changed: false,
    error: { code, message, ...(blockers === undefined ? {} : { blockers }) },
  };
}

const MAX_VERIFIED_NOTE_OCCURRENCES = 200_000;

type ClipPlan = Readonly<{
  blockers: SongLengthBlocker[];
  tracks: Track[];
  trimmedClips: number;
  removedClips: number;
}>;

/** First thing in `clip` that would stop sounding if the song ended at `newEndBeat`. */
function firstLostContent(
  clip: Clip,
  content: Clip,
  musicalTime: ReturnType<typeof compileMusicalTime>,
  newEndBeat: number,
): { kind: SongLengthBlockerKind; beat: number } | null {
  if (content.type === 'midi') {
    let lost: { kind: SongLengthBlockerKind; beat: number } | null = null;
    try {
      visitMidiClipNoteOccurrences(content, MAX_VERIFIED_NOTE_OCCURRENCES, (occurrence) => {
        if (lost !== null) return;
        const onset = clip.startBeat + occurrence.localStartBeat;
        if (onset >= newEndBeat) lost = { kind: 'note', beat: onset };
        else if (onset + occurrence.durationBeats > newEndBeat) {
          lost = { kind: 'note-overrun', beat: onset };
        }
      });
    } catch {
      return { kind: 'clip', beat: clip.startBeat };
    }
    return lost;
  }
  if (content.type === 'drum') {
    const events = content.drumEvents ?? [];
    if (events.length === 0) return null;
    const stepsPerBar = Number.isSafeInteger(content.stepsPerBar) && (content.stepsPerBar ?? 0) > 0
      ? (content.stepsPerBar as number)
      : 16;
    const projector = compileDrumStepProjector(stepsPerBar, clip.startBeat, musicalTime);
    const clipEnd = clip.startBeat + clip.lengthBeats;
    for (const drum of events) {
      const beat = projectDrumStep(projector, drum.stepIndex).beat;
      if (beat < clipEnd && beat >= newEndBeat) return { kind: 'note', beat };
    }
    return null;
  }
  // Audio (and any other) clips: the audible region is the clip window, so a
  // clip crossing or lying past the new end would lose sound.
  return { kind: 'clip', beat: clip.startBeat };
}

function planClips(
  project: Project,
  segments: readonly Segment[],
  newEndBeat: number,
): ClipPlan {
  const blockers: SongLengthBlocker[] = [];
  const musicalTime = compileMusicalTime(project);
  const index = buildClipIndex(project);
  let trimmedClips = 0;
  let removedClips = 0;
  const removedIds = new Set<string>();
  const tracks = project.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      if (clip.startBeat + clip.lengthBeats <= newEndBeat) {
        clips.push(clip);
        continue;
      }
      const content = resolveClipContent(project, clip, index);
      const lost = content === null
        ? { kind: 'clip' as const, beat: clip.startBeat }
        : firstLostContent(clip, content, musicalTime, newEndBeat);
      if (lost !== null) {
        blockers.push({
          kind: lost.kind,
          name: track.name,
          bar: barNumberAtBeat(segments, lost.beat),
        });
        clips.push(clip);
      } else if (clip.startBeat >= newEndBeat) {
        removedClips += 1;
        removedIds.add(clip.id);
      } else {
        trimmedClips += 1;
        clips.push({ ...clip, lengthBeats: newEndBeat - clip.startBeat });
      }
    }
    return { ...track, clips };
  });
  // A removed clip that a kept alias still points at would orphan that alias.
  if (removedIds.size > 0) {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.aliasOf !== undefined && removedIds.has(clip.aliasOf)) {
          blockers.push({
            kind: 'clip',
            name: track.name,
            bar: barNumberAtBeat(segments, clip.startBeat),
          });
        }
      }
    }
  }
  return { blockers, tracks, trimmedClips, removedClips };
}

function findOtherBlockers(
  project: Project,
  segments: readonly Segment[],
  newEndBeat: number,
): SongLengthBlocker[] {
  const found: SongLengthBlocker[] = [];
  const add = (kind: SongLengthBlockerKind, name: string, beat: number): void => {
    found.push({ kind, name, bar: barNumberAtBeat(segments, beat) });
  };
  for (const folder of project.audioTakeFolders) {
    if (folder.startBeat + folder.lengthBeats > newEndBeat) {
      const track = project.tracks.find((candidate) => candidate.id === folder.trackId);
      add('audio-take-folder', track?.name ?? '', folder.startBeat);
    }
  }
  for (const lane of project.automationLanes) {
    const track = project.tracks.find((candidate) => candidate.id === lane.target.trackId);
    for (const point of lane.points) {
      if (point.beat > newEndBeat) add('automation-point', track?.name ?? '', point.beat);
    }
  }
  for (const event of project.tempoMap) {
    if (event.beat >= newEndBeat) add('tempo-event', '', event.beat);
  }
  for (const event of project.timeSignatureMap) {
    if (event.beat >= newEndBeat) add('time-signature-event', '', event.beat);
  }
  return found;
}

function planChords(
  chords: readonly ChordEvent[],
  newEndBeat: number,
): { chords: ChordEvent[]; removed: number; trimmed: number } {
  const kept: ChordEvent[] = [];
  let removed = 0;
  let trimmed = 0;
  for (const chord of chords) {
    if (chord.startBeat + chord.durationBeats <= newEndBeat) {
      kept.push(chord);
      continue;
    }
    const duration = newEndBeat - chord.startBeat;
    if (duration < MIN_EVENT_DURATION_BEATS) {
      removed += 1;
    } else {
      trimmed += 1;
      kept.push({ ...chord, durationBeats: duration });
    }
  }
  return { chords: kept, removed, trimmed };
}

function planSections(
  sections: readonly Section[],
  newBars: number,
): { sections: Section[]; removed: number; trimmed: number } {
  const kept: Section[] = [];
  let removed = 0;
  let trimmed = 0;
  for (const section of sections) {
    if (section.startBar + section.lengthBars <= newBars) {
      kept.push(section);
    } else if (section.startBar >= newBars) {
      removed += 1;
    } else {
      trimmed += 1;
      kept.push({ ...section, lengthBars: newBars - section.startBar });
    }
  }
  return { sections: kept, removed, trimmed };
}

/**
 * Set the song length to `bars` whole bars. Growing appends bars of the last
 * meter. Shrinking trims or removes clips, chords and sections that cross the
 * new end when nothing audible is lost, and is refused (with the blocking
 * items) when a note, audio clip, take folder, automation point, or tempo /
 * meter change would be cut off or fall outside the new end.
 */
export function setProjectLengthBars(project: Project, bars: unknown): SongLengthResult {
  try {
    if (
      typeof bars !== 'number'
      || !Number.isSafeInteger(bars)
      || bars < 1
      || bars > MAX_PROJECT_LENGTH_BARS
    ) {
      return failure(
        project,
        'invalid-length',
        `Song length must be a whole number of bars from 1 to ${MAX_PROJECT_LENGTH_BARS}.`,
      );
    }
    if (!encodeProjectJson(project).ok) {
      return failure(project, 'project-not-adoptable', 'Project codec rejected the project.');
    }
    if (bars === project.lengthBars) {
      return {
        ok: true,
        project,
        changed: false,
        lengthBars: project.lengthBars,
        lengthBeats: project.lengthBeats,
        trimmedClips: 0,
        removedClips: 0,
        removedChords: 0,
        trimmedChords: 0,
        removedSections: 0,
        trimmedSections: 0,
      };
    }
    const segments = segmentsOf(project);
    const newEndBeat = beatAtBar(segments, bars);
    let tracks = project.tracks;
    let trimmedClips = 0;
    let removedClips = 0;
    let chordPlan = { chords: project.chordTrack, removed: 0, trimmed: 0 };
    let sectionPlan = { sections: project.sections, removed: 0, trimmed: 0 };
    if (bars < project.lengthBars) {
      const plan = planClips(project, segments, newEndBeat);
      const blockers = [
        ...plan.blockers,
        ...findOtherBlockers(project, segments, newEndBeat),
      ];
      if (blockers.length > 0) {
        return failure(
          project,
          'content-beyond-end',
          'Content lies beyond the new song end.',
          blockers.slice(0, MAX_SONG_LENGTH_BLOCKERS),
        );
      }
      tracks = plan.tracks;
      trimmedClips = plan.trimmedClips;
      removedClips = plan.removedClips;
      chordPlan = planChords(project.chordTrack, newEndBeat);
      sectionPlan = planSections(project.sections, bars);
    }
    const next: Project = {
      ...project,
      tracks,
      chordTrack: chordPlan.chords,
      sections: sectionPlan.sections,
      lengthBars: bars,
      lengthBeats: newEndBeat,
    };
    if (!encodeProjectJson(next).ok) {
      return failure(project, 'invalid-project', 'The new length was rejected by the project codec.');
    }
    return {
      ok: true,
      project: next,
      changed: true,
      lengthBars: bars,
      lengthBeats: newEndBeat,
      trimmedClips,
      removedClips,
      removedChords: chordPlan.removed,
      trimmedChords: chordPlan.trimmed,
      removedSections: sectionPlan.removed,
      trimmedSections: sectionPlan.trimmed,
    };
  } catch {
    return failure(project, 'unexpected', 'The song length could not be changed safely.');
  }
}
