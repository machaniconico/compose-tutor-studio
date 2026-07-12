// Immutable mutation helpers. Each returns a new Project (no in-place mutation)
// and bumps updatedAt via the injectable clock.

import type { Clock } from './clock';
import { systemClock, nowIso } from './clock';
import { makeId } from './ids';
import { clipContentOwnerId } from './clip-content';
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
  const ownerId = clipContentOwnerId(project, clipId);
  if (ownerId === null) return project.tracks;
  return project.tracks.map((track) => {
    if (!track.clips.some((c) => c.id === ownerId)) return track;
    return { ...track, clips: track.clips.map((c) => (c.id === ownerId ? fn(c) : c)) };
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
