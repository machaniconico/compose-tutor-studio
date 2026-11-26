// Immutable mutation helpers. Each returns a new Project (no in-place mutation)
// and bumps updatedAt via the injectable clock.

import type { Clock } from './clock';
import { systemClock, nowIso } from './clock';
import { clipFirstPassEnd, drumHitRepeatCount, expandClip, resolveLinkSource } from './clipExpand';
import { makeId } from './ids';
import { beatsPerBar, drumStepsPerBar } from './time';
import type {
  ChordEvent,
  Clip,
  DrumEvent,
  DrumLane,
  NoteEvent,
  Project,
  Section,
  Track,
} from './types';

/** Stamp updatedAt on a (shallow-copied) project. */
function touch(project: Project, clock: Clock): Project {
  return { ...project, updatedAt: nowIso(clock) };
}

/** Map over tracks, replacing the one whose id matches. */
function mapTrack(project: Project, trackId: string, fn: (track: Track) => Track): Track[] {
  return project.tracks.map((track) => (track.id === trackId ? fn(track) : track));
}

/** Map over a clip wherever it lives, returning new track list. */
function mapClip(project: Project, clipId: string, fn: (clip: Clip) => Clip): Track[] {
  return project.tracks.map((track) => {
    if (!track.clips.some((c) => c.id === clipId)) return track;
    return { ...track, clips: track.clips.map((c) => (c.id === clipId ? fn(c) : c)) };
  });
}

// --- Chord track ---

export function addChordEvent(
  project: Project,
  chord: Omit<ChordEvent, 'id'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  const event: ChordEvent = { ...chord, id: chord.id ?? makeId('chord') };
  return touch({ ...project, chordTrack: [...project.chordTrack, event] }, clock);
}

export function updateChordEvent(
  project: Project,
  chordId: string,
  patch: Partial<Omit<ChordEvent, 'id'>>,
  clock: Clock = systemClock,
): Project {
  const chordTrack = project.chordTrack.map((c) => (c.id === chordId ? { ...c, ...patch } : c));
  return touch({ ...project, chordTrack }, clock);
}

export function removeChordEvent(
  project: Project,
  chordId: string,
  clock: Clock = systemClock,
): Project {
  const chordTrack = project.chordTrack.filter((c) => c.id !== chordId);
  return touch({ ...project, chordTrack }, clock);
}

// --- Notes within a clip ---

export function addNoteToClip(
  project: Project,
  clipId: string,
  note: Omit<NoteEvent, 'id'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  const event: NoteEvent = { ...note, id: note.id ?? makeId('note') };
  const tracks = mapClip(project, clipId, (clip) => ({
    ...clip,
    notes: [...(clip.notes ?? []), event],
  }));
  return touch({ ...project, tracks }, clock);
}

export function updateNote(
  project: Project,
  clipId: string,
  noteId: string,
  patch: Partial<Omit<NoteEvent, 'id'>>,
  clock: Clock = systemClock,
): Project {
  const tracks = mapClip(project, clipId, (clip) => ({
    ...clip,
    notes: (clip.notes ?? []).map((n) => (n.id === noteId ? { ...n, ...patch } : n)),
  }));
  return touch({ ...project, tracks }, clock);
}

export function removeNote(
  project: Project,
  clipId: string,
  noteId: string,
  clock: Clock = systemClock,
): Project {
  const tracks = mapClip(project, clipId, (clip) => ({
    ...clip,
    notes: (clip.notes ?? []).filter((n) => n.id !== noteId),
  }));
  return touch({ ...project, tracks }, clock);
}

// --- Drum steps ---

/**
 * Toggle a drum step at (lane, stepIndex) for a drum clip.
 * If a matching event exists it is removed; otherwise one is added with the
 * provided velocity (default 100).
 */
export function toggleDrumStep(
  project: Project,
  clipId: string,
  lane: DrumLane,
  stepIndex: number,
  velocity = 100,
  clock: Clock = systemClock,
): Project {
  const tracks = mapClip(project, clipId, (clip) => {
    const events = clip.drumEvents ?? [];
    const existing = events.find((e) => e.lane === lane && e.stepIndex === stepIndex);
    if (existing) {
      return { ...clip, drumEvents: events.filter((e) => e !== existing) };
    }
    const event: DrumEvent = { id: makeId('drum'), lane, stepIndex, velocity };
    return { ...clip, drumEvents: [...events, event] };
  });
  return touch({ ...project, tracks }, clock);
}

// --- Mixer ---

export function setTrackVolume(
  project: Project,
  trackId: string,
  volume: number,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, volume })) }, clock);
}

export function setTrackPan(
  project: Project,
  trackId: string,
  pan: number,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, pan })) }, clock);
}

export function setTrackMute(
  project: Project,
  trackId: string,
  mute: boolean,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, mute })) }, clock);
}

export function setTrackSolo(
  project: Project,
  trackId: string,
  solo: boolean,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, solo })) }, clock);
}

// --- Sections ---

export function addSection(
  project: Project,
  section: Omit<Section, 'id'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  const event: Section = { ...section, id: section.id ?? makeId('section') };
  return touch({ ...project, sections: [...project.sections, event] }, clock);
}

export function updateSection(
  project: Project,
  sectionId: string,
  patch: Partial<Omit<Section, 'id'>>,
  clock: Clock = systemClock,
): Project {
  const sections = project.sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s));
  return touch({ ...project, sections }, clock);
}

// --- Loop range ---

/**
 * Set the beat range repeated while looping, or clear it with null. Throws
 * unless 0 <= startBeat < endBeat.
 */
export function setLoopRange(
  project: Project,
  range: { startBeat: number; endBeat: number } | null,
  clock: Clock = systemClock,
): Project {
  if (range === null) {
    const { loopRange: _cleared, ...rest } = project;
    return touch(rest, clock);
  }
  const { startBeat, endBeat } = range;
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || startBeat < 0 || endBeat <= startBeat) {
    throw new Error(`loop range must satisfy 0 <= start < end (got ${startBeat} to ${endBeat})`);
  }
  return touch({ ...project, loopRange: { startBeat, endBeat } }, clock);
}

// --- Time signature / song length ---

/** Default steps per bar for a drum clip when not specified. */
const DEFAULT_STEPS_PER_BAR = 16;
const BEAT_EPSILON = 1e-9;

export type TimeSignatureChange = {
  project: Project;
  /** Beginner-facing notes (Japanese) about content that could not be kept exactly. */
  warnings: string[];
  /**
   * Source drum hits removed by a collision or losing one or more audible
   * occurrences at a clip, loop or song boundary. Callers should confirm
   * before applying a change with a nonzero count.
   */
  droppedHits: number;
};

type RegriddedHit = {
  event: DrumEvent;
  stepIndex: number;
  /** The old beat position lies exactly on the new grid. */
  exact: boolean;
  beat: number;
};

/**
 * Which of two hits that collide on one step survives: the one that was on the
 * grid already, then the louder one, then the earlier one. Independent of the
 * order the events are stored in.
 */
function outranks(candidate: RegriddedHit, current: RegriddedHit): boolean {
  if (candidate.exact !== current.exact) return candidate.exact;
  if (candidate.event.velocity !== current.event.velocity) {
    return candidate.event.velocity > current.event.velocity;
  }
  return candidate.beat < current.beat;
}

/** Nearest integer, treating values within BEAT_EPSILON of an integer as exact. */
function isWholeNumber(value: number): boolean {
  return Math.abs(value - Math.round(value)) < BEAT_EPSILON;
}

/** Beat position of a drum step, relative to its clip start. */
function drumStepBeat(stepIndex: number, stepsPerBar: number, bpb: number): number {
  return stepIndex * (bpb / stepsPerBar);
}

/**
 * Change the time signature. Note and chord positions are kept in beats, so no
 * content is lost: `lengthBars` is rounded up to cover the old total beats.
 * Sections are converted by beat and snapped to the nearest bar; drum clips are
 * regridded to `beatsPerBar * 4` steps with every hit at its old beat position.
 * Clips that ended with the song grow to the new (rounded-up) song end.
 * Anything that did not land exactly is reported in `warnings`.
 */
export function setTimeSignature(
  project: Project,
  timeSignature: [number, number],
  clock: Clock = systemClock,
): TimeSignatureChange {
  const oldBpb = beatsPerBar(project.timeSignature);
  const newBpb = beatsPerBar(timeSignature);
  const warnings: string[] = [];

  const totalBeats = project.lengthBars * oldBpb;
  const lengthBars = Math.max(1, Math.ceil(totalBeats / newBpb - BEAT_EPSILON));

  const snapped = project.sections.map((section) => {
    const startBar = (section.startBar * oldBpb) / newBpb;
    const endBar = ((section.startBar + section.lengthBars) * oldBpb) / newBpb;
    const snappedStart = Math.round(startBar);
    const snappedSection: Section = {
      ...section,
      startBar: snappedStart,
      lengthBars: Math.max(1, Math.round(endBar) - snappedStart),
    };
    return { section: snappedSection, offGrid: !isWholeNumber(startBar) || !isWholeNumber(endBar) };
  });
  // Snapping can push a section that started in the last partial bar onto the
  // new end. Such a section is merged into the latest section that still fits
  // (which then runs to the end); with none, the first one is kept on the last
  // bar and any further ones merge into it.
  const fitting = snapped.filter(({ section }) => section.startBar < lengthBars);
  let mergeTarget = fitting.reduce<Section | undefined>(
    (latest, { section }) => (latest === undefined || section.startBar >= latest.startBar ? section : latest),
    undefined,
  );
  let extendMergeTarget = false;
  const sections: Section[] = [];
  for (const { section, offGrid } of snapped) {
    if (section.startBar < lengthBars) {
      if (offGrid) {
        warnings.push(
          `セクション「${section.name}」の区切りが新しい拍子の小節に合わないため、いちばん近い小節に合わせました。`,
        );
      }
      sections.push({ ...section, lengthBars: Math.min(section.lengthBars, lengthBars - section.startBar) });
    } else if (mergeTarget !== undefined) {
      warnings.push(
        `セクション「${section.name}」は新しい拍子では曲の終わりより後ろになるため、前のセクション「${mergeTarget.name}」にまとめました。`,
      );
      extendMergeTarget = true;
    } else {
      warnings.push(
        `セクション「${section.name}」は新しい拍子では曲の終わりより後ろになるため、最後の小節に収めました。`,
      );
      mergeTarget = { ...section, startBar: lengthBars - 1, lengthBars: 1 };
      sections.push(mergeTarget);
    }
  }
  if (extendMergeTarget && mergeTarget !== undefined) {
    const index = sections.findIndex((s) => s.id === mergeTarget.id);
    const target = sections[index];
    if (target !== undefined) sections[index] = { ...target, lengthBars: lengthBars - target.startBar };
  }

  // Clips that ended with the song keep ending with it (as in `setLengthBars`),
  // so the rounded-up bars stay editable and a later lengthening still grows them.
  const newEndBeat = lengthBars * newBpb;
  const followSongEnd = (clip: Clip): Clip =>
    Math.abs(clip.startBeat + clip.lengthBeats - totalBeats) < BEAT_EPSILON
      ? { ...clip, lengthBeats: newEndBeat - clip.startBeat }
      : clip;

  const newStepsPerBar = drumStepsPerBar(timeSignature);
  let shiftedHits = 0;
  const collidedHits = new Set<string>();
  const pastEndHits = new Set<string>();
  const allClips = project.tracks.flatMap((track) => track.clips);
  const drumUses = new Map<string, Clip[]>();
  for (const track of project.tracks) {
    if (track.type !== 'drum') continue;
    for (const clip of track.clips) {
      const source = resolveLinkSource(clip, allClips);
      if (typeof source === 'string') continue;
      const uses = drumUses.get(source.id);
      if (uses) uses.push(clip);
      else drumUses.set(source.id, [clip]);
    }
  }
  const tracks = project.tracks.map((track) => {
    const clips = track.clips.map((oldClip) => {
      const clip = followSongEnd(oldClip);
      const uses = drumUses.get(clip.id);
      if (track.type !== 'drum' && uses === undefined) return clip;
      const oldStepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const clipUses = (uses ?? [oldClip]).map((use) => ({ old: use, next: followSongEnd(use) }));
      // One hit per lane and step: when the new grid is coarser, hits can collide
      // and only one can be kept (see `outranks`). Nothing is dropped silently.
      const survivors = new Map<string, RegriddedHit>();
      for (const event of clip.drumEvents ?? []) {
        const beat = drumStepBeat(event.stepIndex, oldStepsPerBar, oldBpb);
        const exactStep = beat * (newStepsPerBar / newBpb);
        const candidate: RegriddedHit = {
          event,
          stepIndex: Math.round(exactStep),
          exact: isWholeNumber(exactStep),
          beat,
        };
        // Rounding up can put a hit that sounded before the end exactly on (or
        // past) the end of a linked clip, a loop pass, or the song.
        const newBeat = drumStepBeat(candidate.stepIndex, newStepsPerBar, newBpb);
        const nextCount = (use: Clip): number => drumHitRepeatCount(use, newBeat, newEndBeat - use.startBeat);
        if (clipUses.some((use) => drumHitRepeatCount(use.old, beat, totalBeats - use.old.startBeat) > nextCount(use.next))) {
          pastEndHits.add(event.id);
          // Keep the hit if it can still sound in any pass of the pattern.
          if (!clipUses.some((use) => nextCount(use.next) > 0)) continue;
        }
        const key = `${event.lane}:${candidate.stepIndex}`;
        const current = survivors.get(key);
        if (current === undefined) {
          survivors.set(key, candidate);
          continue;
        }
        if (outranks(candidate, current)) {
          collidedHits.add(current.event.id);
          survivors.set(key, candidate);
        } else {
          collidedHits.add(event.id);
        }
      }
      const drumEvents: DrumEvent[] = [];
      for (const hit of survivors.values()) {
        if (!hit.exact) shiftedHits += 1;
        drumEvents.push({ ...hit.event, stepIndex: hit.stepIndex });
      }
      return { ...clip, stepsPerBar: newStepsPerBar, drumEvents };
    });
    return { ...track, clips };
  });
  if (shiftedHits > 0) {
    warnings.push(
      `ドラムの ${shiftedHits} 個の音が新しいグリッドに乗らないため、いちばん近いステップに動かしました。`,
    );
  }
  if (collidedHits.size > 0) {
    warnings.push(
      `ドラムの ${collidedHits.size} 個の音が新しいグリッドで別の音と同じステップに重なるため、拍に合っていた音(同じなら強い音)を残して削除しました。`,
    );
  }
  if (pastEndHits.size > 0) {
    warnings.push(
      `ドラムの ${pastEndHits.size} 個の音が新しいグリッドで曲の終わり、クリップの終わり、またはループの区切りに重なり、鳴らなくなる場所がありました。`,
    );
  }

  return {
    project: touch({ ...project, timeSignature, lengthBars, sections, tracks }, clock),
    warnings,
    droppedHits: new Set([...collidedHits, ...pastEndHits]).size,
  };
}

export type ContentBeyondBars = {
  /** Notes that start at or after the new end (removed). */
  notes: number;
  /** Chords that start at or after the new end (removed). */
  chords: number;
  drumHits: number;
  sections: number;
  /** Notes that start before the new end but ring past it (cut at the end). */
  truncatedNotes: number;
  /** Chords that start before the new end but last past it (cut at the end). */
  truncatedChords: number;
  /** Audible changes within the kept bars caused by trimming shared content. */
  linkedLosses?: { notes: number; drumHits: number; truncatedNotes: number };
};

/**
 * Count the content affected by shortening the song to `lengthBars`: notes,
 * chords, drum hits and sections that start at or after the new end, plus the
 * notes and chords that start before it and run past it.
 */
export function contentBeyondBars(project: Project, lengthBars: number): ContentBeyondBars {
  const bpb = beatsPerBar(project.timeSignature);
  const endBeat = lengthBars * bpb;
  const oldEndBeat = project.lengthBars * bpb;
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const crosses = (start: number, duration: number): boolean =>
    !beyond(start) && start + duration > endBeat + BEAT_EPSILON;

  let notes = 0;
  let truncatedNotes = 0;
  let drumHits = 0;
  const linkedLosses = { notes: 0, drumHits: 0, truncatedNotes: 0 };
  const allClips = project.tracks.flatMap((track) => track.clips);
  const shortening = lengthBars < project.lengthBars;
  const resizedClips = shortening && allClips.some((clip) => clip.aliasOf !== undefined)
    ? resizeClipTracks(project, lengthBars).flatMap((track) => track.clips)
    : [];
  const resizedById = new Map(resizedClips.map((clip) => [clip.id, clip]));
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      for (const note of clip.notes ?? []) {
        const start = clip.startBeat + note.startBeat;
        if (beyond(start)) notes += 1;
        else if (crosses(start, note.durationBeats)) truncatedNotes += 1;
      }
      const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      for (const hit of clip.drumEvents ?? []) {
        if (beyond(clip.startBeat + drumStepBeat(hit.stepIndex, stepsPerBar, bpb))) drumHits += 1;
      }
      if (!shortening || (!clip.loop && clip.aliasOf === undefined)) continue;

      // Raw content is counted above. Add linked sounds and the later passes of
      // loops, which have no separate stored event to count.
      const expanded = expandClip(clip, allClips, bpb, track.type);
      const repeatStart = clip.startBeat + clipFirstPassEnd(clip);
      const isAdditional = (beat: number): boolean =>
        beat < oldEndBeat && (clip.aliasOf !== undefined || beat >= repeatStart);
      for (const note of expanded.notes) {
        if (!isAdditional(note.startBeat)) continue;
        if (beyond(note.startBeat)) notes += 1;
        else if (crosses(note.startBeat, Math.min(note.durationBeats, oldEndBeat - note.startBeat))) truncatedNotes += 1;
      }
      drumHits += expanded.drumHits.filter((hit) => isAdditional(hit.beat) && beyond(hit.beat)).length;

      const resized = resizedById.get(clip.id);
      if (clip.aliasOf === undefined || resized === undefined) continue;
      const after = expandClip(resized, resizedClips, bpb, track.type);
      linkedLosses.drumHits += Math.max(0, expanded.drumHits.filter((hit) => !beyond(hit.beat)).length - after.drumHits.length);

      // Source trimming keeps event order and removes all notes at a removed
      // onset. Group by onset so overlapping notes at the same beat count too.
      const remainingAtBeat = new Map<number, number[]>();
      for (const note of after.notes) {
        const durations = remainingAtBeat.get(note.startBeat);
        if (durations) durations.push(note.durationBeats);
        else remainingAtBeat.set(note.startBeat, [note.durationBeats]);
      }
      for (let i = expanded.notes.length - 1; i >= 0; i--) {
        const note = expanded.notes[i]!;
        if (beyond(note.startBeat)) continue;
        const remaining = remainingAtBeat.get(note.startBeat)?.pop();
        if (remaining === undefined) linkedLosses.notes += 1;
        else if (Math.min(note.durationBeats, endBeat - note.startBeat) > remaining + BEAT_EPSILON) {
          linkedLosses.truncatedNotes += 1;
        }
      }
    }
  }
  const chords = project.chordTrack.filter((c) => beyond(c.startBeat)).length;
  const truncatedChords = project.chordTrack.filter((c) => crosses(c.startBeat, c.durationBeats)).length;
  const sections = project.sections.filter((s) => s.startBar >= lengthBars).length;
  const hasLinkedLosses = linkedLosses.notes + linkedLosses.drumHits + linkedLosses.truncatedNotes > 0;
  return {
    notes, chords, drumHits, sections, truncatedNotes, truncatedChords,
    ...(hasLinkedLosses ? { linkedLosses } : {}),
  };
}

function cutAtSongEnd<T extends { durationBeats: number }>(item: T, start: number, end: number): T {
  return start + item.durationBeats > end + BEAT_EPSILON
    ? { ...item, durationBeats: end - start }
    : item;
}

/**
 * Repair links using the original clip list before trimming. If the entire
 * source is going away, give each affected link its own copy of the pattern.
 */
function resizeClipTracks(project: Project, lengthBars: number): Track[] {
  const bpb = beatsPerBar(project.timeSignature);
  const oldEndBeat = project.lengthBars * bpb;
  const endBeat = lengthBars * bpb;
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const allClips = project.tracks.flatMap((track) => track.clips);
  const keptClips = allClips.filter((clip) => !beyond(clip.startBeat));
  const keptIds = new Set(keptClips.map((clip) => clip.id));
  let ids: Set<string> | undefined;
  const copyEvent = <T extends { id: string }>(event: T, clipId: string): T => {
    ids ??= new Set([
      project.id,
      ...project.tracks.map((track) => track.id),
      ...project.chordTrack.map((chord) => chord.id),
      ...project.sections.map((section) => section.id),
      ...allClips.flatMap((clip) => [
        clip.id,
        ...(clip.notes ?? []).map((note) => note.id),
        ...(clip.drumEvents ?? []).map((hit) => hit.id),
      ]),
    ]);
    const base = `${clipId}-${event.id}`;
    let id = base;
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
    return { ...event, id };
  };

  return project.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const original of track.clips) {
      if (!keptIds.has(original.id)) continue;
      let clip = original;
      if (clip.aliasOf !== undefined && typeof resolveLinkSource(clip, keptClips) === 'string') {
        const source = resolveLinkSource(clip, allClips);
        if (typeof source !== 'string') {
          clip = keptIds.has(source.id)
            ? { ...clip, aliasOf: source.id }
            : {
                ...clip,
                aliasOf: undefined,
                notes: source.notes?.map((note) => copyEvent(note, clip.id)),
                drumEvents: source.drumEvents?.map((hit) => copyEvent(hit, clip.id)),
                stepsPerBar: source.stepsPerBar,
              };
        }
      }
      const clipEnd = clip.startBeat + clip.lengthBeats;
      const endsWithSong = Math.abs(clipEnd - oldEndBeat) < BEAT_EPSILON;
      const lengthBeats = clipEnd > endBeat || endsWithSong ? endBeat - clip.startBeat : clip.lengthBeats;
      const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const next: Clip = { ...clip, lengthBeats };
      if (clip.notes) {
        next.notes = clip.notes
          .filter((n) => !beyond(clip.startBeat + n.startBeat))
          .map((n) => cutAtSongEnd(n, clip.startBeat + n.startBeat, endBeat));
      }
      if (clip.drumEvents) {
        next.drumEvents = clip.drumEvents.filter(
          (hit) => !beyond(clip.startBeat + drumStepBeat(hit.stepIndex, stepsPerBar, bpb)),
        );
      }
      clips.push(next);
    }
    return { ...track, clips };
  });
}

/**
 * Set the song length in bars. Content beyond the new end is removed and
 * crossing notes, chords and sections are cut. Clips ending with the song
 * follow its end (see `contentBeyondBars` to warn first).
 */
export function setLengthBars(
  project: Project,
  lengthBars: number,
  clock: Clock = systemClock,
): Project {
  const endBeat = lengthBars * beatsPerBar(project.timeSignature);
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const tracks = resizeClipTracks(project, lengthBars);
  const chordTrack = project.chordTrack
    .filter((c) => !beyond(c.startBeat))
    .map((c) => cutAtSongEnd(c, c.startBeat, endBeat));
  const sections = project.sections
    .filter((s) => s.startBar < lengthBars)
    .map((s) => ({ ...s, lengthBars: Math.min(s.lengthBars, lengthBars - s.startBar) }));

  // The loop range is cut at the new end, or dropped when it starts at or after
  // it, so loop playback never repeats beats past the song.
  const { loopRange, ...rest } = project;
  const keptLoop =
    loopRange === undefined || beyond(loopRange.startBeat)
      ? {}
      : { loopRange: { startBeat: loopRange.startBeat, endBeat: Math.min(loopRange.endBeat, endBeat) } };

  return touch({ ...rest, ...keptLoop, lengthBars, tracks, chordTrack, sections }, clock);
}
