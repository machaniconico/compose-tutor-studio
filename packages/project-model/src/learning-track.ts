import type { Project, Track, TrackRole } from './types';

export const LEARNING_TRACK_NAMES = ['Chords', 'Bass', 'Melody'] as const;
export const LEARNING_TRACK_ROLES = [
  'learning.chords',
  'learning.bass',
  'learning.melody',
] as const satisfies readonly TrackRole[];

export type LearningTrackName = (typeof LEARNING_TRACK_NAMES)[number];
export type LearningTrackRole = (typeof LEARNING_TRACK_ROLES)[number];

const ROLE_BY_NAME: Readonly<Record<LearningTrackName, LearningTrackRole>> = {
  Chords: 'learning.chords',
  Bass: 'learning.bass',
  Melody: 'learning.melody',
};

function toLearningTrackRole(role: LearningTrackName | LearningTrackRole): LearningTrackRole {
  return role.startsWith('learning.')
    ? role as LearningTrackRole
    : ROLE_BY_NAME[role as LearningTrackName];
}

/** Legacy migration/UI helper. Runtime track ownership must use `Track.role`. */
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

/** Whether a raw legacy name maps to one of schema-v2's learning roles. */
export function isLearningTrackName(name: string): boolean {
  return normalizeLearningTrackName(name) !== null;
}

/** Whether a track owns a learning role, optionally a specific one. */
export function isLearningTrack(
  track: Pick<Track, 'role'>,
  role?: LearningTrackName | LearningTrackRole,
): boolean {
  if (!LEARNING_TRACK_ROLES.includes(track.role as LearningTrackRole)) return false;
  return role === undefined || track.role === toLearningTrackRole(role);
}

/** Find the track that owns the requested schema-v3 role. Names are irrelevant. */
export function findLearningTrack(
  project: Pick<Project, 'tracks'>,
  role: LearningTrackName | LearningTrackRole,
): Track | undefined {
  return project.tracks.find((track) => isLearningTrack(track, role));
}

/** @deprecated Prefer isLearningTrackName. */
export const isReservedLearningTrackName = isLearningTrackName;
