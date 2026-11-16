// Immutable mutation helpers. Each returns a new Project (no in-place mutation)
// and bumps updatedAt via the injectable clock.

import type { Clock } from './clock';
import { systemClock, nowIso } from './clock';
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

// --- Time signature / song length ---

/** Default steps per bar for a drum clip when not specified. */
const DEFAULT_STEPS_PER_BAR = 16;
const BEAT_EPSILON = 1e-9;

export type TimeSignatureChange = {
  project: Project;
  /** Beginner-facing notes (Japanese) about content that could not be kept exactly. */
  warnings: string[];
  /**
   * Drum hits removed because two hits of the same lane landed on one step of the
   * new grid, or because rounding moved a hit onto (or past) the end of its clip
   * or the song, where playback and export never sound it. This is the only
   * lossy part of the change, so callers should ask before applying when it is
   * above zero.
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
  let droppedHits = 0;
  let pastEndHits = 0;
  const tracks = project.tracks.map((track) => {
    if (track.type !== 'drum') return { ...track, clips: track.clips.map(followSongEnd) };
    const clips = track.clips.map((oldClip) => {
      const clip = followSongEnd(oldClip);
      const oldStepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const oldEnd = Math.min(oldClip.lengthBeats, totalBeats - oldClip.startBeat);
      const newEnd = Math.min(clip.lengthBeats, newEndBeat - clip.startBeat);
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
        // past) the end of its clip or song, where playback never reaches it.
        const newBeat = drumStepBeat(candidate.stepIndex, newStepsPerBar, newBpb);
        if (beat < oldEnd - BEAT_EPSILON && newBeat >= newEnd - BEAT_EPSILON) {
          droppedHits += 1;
          pastEndHits += 1;
          continue;
        }
        const key = `${event.lane}:${candidate.stepIndex}`;
        const current = survivors.get(key);
        if (current === undefined) {
          survivors.set(key, candidate);
          continue;
        }
        droppedHits += 1;
        if (outranks(candidate, current)) survivors.set(key, candidate);
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
  const collidedHits = droppedHits - pastEndHits;
  if (collidedHits > 0) {
    warnings.push(
      `ドラムの ${collidedHits} 個の音が新しいグリッドで別の音と同じステップに重なるため、拍に合っていた音(同じなら強い音)を残して削除しました。`,
    );
  }
  if (pastEndHits > 0) {
    warnings.push(
      `ドラムの ${pastEndHits} 個の音が新しいグリッドでは曲の終わり(またはクリップの終わり)に重なって鳴らなくなるため、削除しました。`,
    );
  }

  return {
    project: touch({ ...project, timeSignature, lengthBars, sections, tracks }, clock),
    warnings,
    droppedHits,
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
};

/**
 * Count the content affected by shortening the song to `lengthBars`: notes,
 * chords, drum hits and sections that start at or after the new end, plus the
 * notes and chords that start before it and run past it.
 */
export function contentBeyondBars(project: Project, lengthBars: number): ContentBeyondBars {
  const bpb = beatsPerBar(project.timeSignature);
  const endBeat = lengthBars * bpb;
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const crosses = (start: number, duration: number): boolean =>
    !beyond(start) && start + duration > endBeat + BEAT_EPSILON;

  let notes = 0;
  let truncatedNotes = 0;
  let drumHits = 0;
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
    }
  }
  const chords = project.chordTrack.filter((c) => beyond(c.startBeat)).length;
  const truncatedChords = project.chordTrack.filter((c) => crosses(c.startBeat, c.durationBeats)).length;
  const sections = project.sections.filter((s) => s.startBar >= lengthBars).length;
  return { notes, chords, drumHits, sections, truncatedNotes, truncatedChords };
}

/**
 * Set the song length in bars. Content that starts at or after the new end is
 * removed, and notes and chords that run past it are cut at the new end (see
 * `contentBeyondBars` to warn first). Clips are cut at the new end, and clips
 * that ended exactly with the song grow with it; sections are trimmed.
 */
export function setLengthBars(
  project: Project,
  lengthBars: number,
  clock: Clock = systemClock,
): Project {
  const bpb = beatsPerBar(project.timeSignature);
  const oldEndBeat = project.lengthBars * bpb;
  const endBeat = lengthBars * bpb;
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  /** Cut `durationBeats` so that `start + duration` does not pass the new end. */
  const cutAtEnd = <T extends { durationBeats: number }>(item: T, start: number): T =>
    start + item.durationBeats > endBeat + BEAT_EPSILON
      ? { ...item, durationBeats: endBeat - start }
      : item;

  const tracks = project.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      if (beyond(clip.startBeat)) continue;
      const clipEnd = clip.startBeat + clip.lengthBeats;
      const endsWithSong = Math.abs(clipEnd - oldEndBeat) < BEAT_EPSILON;
      const lengthBeats = clipEnd > endBeat || endsWithSong ? endBeat - clip.startBeat : clip.lengthBeats;
      const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const next: Clip = { ...clip, lengthBeats };
      if (clip.notes) {
        next.notes = clip.notes
          .filter((n) => !beyond(clip.startBeat + n.startBeat))
          .map((n) => cutAtEnd(n, clip.startBeat + n.startBeat));
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

  const chordTrack = project.chordTrack
    .filter((c) => !beyond(c.startBeat))
    .map((c) => cutAtEnd(c, c.startBeat));
  const sections = project.sections
    .filter((s) => s.startBar < lengthBars)
    .map((s) => ({ ...s, lengthBars: Math.min(s.lengthBars, lengthBars - s.startBar) }));

  return touch({ ...project, lengthBars, tracks, chordTrack, sections }, clock);
}
