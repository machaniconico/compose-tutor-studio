import type { Project, Track } from './types';

export const LEARNING_TRACK_NAMES = ['Chords', 'Bass', 'Melody'] as const;

export type LearningTrackName = (typeof LEARNING_TRACK_NAMES)[number];

/** Resolve schema-v2's name-backed learning role after trim and case folding. */
export function normalizeLearningTrackName(name: string): LearningTrackName | null {
  switch (name.trim().toLocaleLowerCase('en-US')) {
    case 'chords':
      return 'Chords';
    case 'bass':
      return 'Bass';
    case 'melody':
      return 'Melody';
    default:
      return null;
  }
}

/** Whether a name is reserved for one of schema-v2's learning roles. */
export function isLearningTrackName(name: string): boolean {
  return normalizeLearningTrackName(name) !== null;
}

/** Whether an instrument track owns a learning role, optionally a specific one. */
export function isLearningTrack(
  track: Pick<Track, 'name' | 'type'>,
  role?: LearningTrackName,
): boolean {
  if (track.type !== 'instrument') return false;
  const normalized = normalizeLearningTrackName(track.name);
  return normalized !== null && (role === undefined || normalized === role);
}

/** Find the first instrument track that owns the requested schema-v2 role. */
export function findLearningTrack(
  project: Pick<Project, 'tracks'>,
  role: LearningTrackName,
): Track | undefined {
  return project.tracks.find((track) => isLearningTrack(track, role));
}

/** @deprecated Prefer isLearningTrackName. */
export const isReservedLearningTrackName = isLearningTrackName;
