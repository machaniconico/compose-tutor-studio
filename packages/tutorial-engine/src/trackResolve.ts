/**
 * Track resolution by role (docs/06 Track.role), falling back to the display name.
 * Display names are free text for the learner; role is the stable identity.
 */

import type { Project, Track, TrackRole } from '@cts/project-model';

// A Map, not an object literal: learner-typed names such as 'constructor' must not hit Object.prototype.
const ROLE_BY_TRACK_NAME = new Map<string, TrackRole>([
  ['bass', 'bass'],
  ['chords', 'chords'],
  ['melody', 'melody'],
  ['drums', 'drums'],
]);

/** The role a conventional track name ('Bass', 'Melody', ...) stands for, if any. */
export function roleForTrackName(trackName: string): TrackRole | undefined {
  return ROLE_BY_TRACK_NAME.get(trackName.trim().toLowerCase());
}

/**
 * Find a track: role match first, then exact name match, otherwise null.
 */
export function resolveTrack(
  project: Project,
  query: { role?: TrackRole; trackName?: string },
): Track | null {
  if (query.role !== undefined) {
    const byRole = project.tracks.find((t) => t.role === query.role);
    if (byRole) return byRole;
  }
  if (query.trackName !== undefined) {
    const byName = project.tracks.find((t) => t.name === query.trackName);
    if (byName) return byName;
  }
  return null;
}

/** Resolve a predicate's `trackName`, also accepting a track whose role it maps to. */
export function resolveTrackByPredicateName(project: Project, trackName: string): Track | null {
  return resolveTrack(project, { role: roleForTrackName(trackName), trackName });
}
