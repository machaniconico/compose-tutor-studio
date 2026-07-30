import type { AutomationTarget, Track } from './types';

type AutomationTargetProject = Readonly<{ tracks: readonly Track[] }>;

const TRACK_AUTOMATION_TARGET_TYPES = Object.freeze([
  'track-volume',
  'track-pan',
] as const);
const MASTER_AUTOMATION_TARGET_TYPES = Object.freeze([
  'track-volume',
] as const);
const NO_AUTOMATION_TARGET_TYPES = Object.freeze(
  [] as AutomationTarget['type'][],
);

/** The first Master in canonical project order is the effective output sink. */
export function effectiveMasterTrackId(project: AutomationTargetProject): string | null {
  return project.tracks.find((track) => track.type === 'master')?.id ?? null;
}

/**
 * Persistable automation targets for one Track.
 * Compatibility Masters after the effective Master intentionally expose none.
 */
export function automationTargetTypesForTrack(
  project: AutomationTargetProject,
  trackId: string,
): readonly AutomationTarget['type'][] {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) return NO_AUTOMATION_TARGET_TYPES;
  if (track.type !== 'master') return TRACK_AUTOMATION_TARGET_TYPES;
  return track.id === effectiveMasterTrackId(project)
    ? MASTER_AUTOMATION_TARGET_TYPES
    : NO_AUTOMATION_TARGET_TYPES;
}

/** Runtime-safe target support check used at every project-model boundary. */
export function isSupportedAutomationTarget(
  project: AutomationTargetProject,
  target: AutomationTarget,
): boolean {
  if (
    typeof target !== 'object'
    || target === null
    || typeof target.trackId !== 'string'
    || (target.type !== 'track-volume' && target.type !== 'track-pan')
  ) {
    return false;
  }
  return automationTargetTypesForTrack(project, target.trackId).includes(target.type);
}
