import type { AutomationTarget, Track } from './types';

type AutomationTargetProject = Readonly<{ tracks: readonly Track[] }>;

const TRACK_AUTOMATION_TARGET_TYPES = Object.freeze([
  'track-volume',
  'track-pan',
] as const);
const INSTRUMENT_AUTOMATION_TARGET_TYPES = Object.freeze([
  ...TRACK_AUTOMATION_TARGET_TYPES,
  'track-filter-cutoff',
] as const);
const MASTER_AUTOMATION_TARGET_TYPES = Object.freeze([
  'track-volume',
] as const);
// Pinned literal: Math.log2(10) is not guaranteed identical across platforms; Rust uses std::f64::consts::LOG2_10.
export const MAX_FILTER_CUTOFF_OCTAVES = 3.321928094887362;

const AUTOMATION_VALUE_RANGES = {
  'track-volume': [0, 2],
  'track-pan': [-1, 1],
  'track-filter-cutoff': [-MAX_FILTER_CUTOFF_OCTAVES, MAX_FILTER_CUTOFF_OCTAVES],
} as const satisfies Record<AutomationTarget['type'], readonly [number, number]>;

export function isAutomationTargetType(value: unknown): value is AutomationTarget['type'] {
  return typeof value === 'string' && Object.hasOwn(AUTOMATION_VALUE_RANGES, value);
}

export function automationValueRange(
  type: AutomationTarget['type'],
): readonly [number, number] {
  return AUTOMATION_VALUE_RANGES[type];
}

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
  if (track.type === 'instrument') return INSTRUMENT_AUTOMATION_TARGET_TYPES;
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
    || !Object.hasOwn(target, 'trackId')
    || !Object.hasOwn(target, 'type')
    || typeof target.trackId !== 'string'
    || !isAutomationTargetType(target.type)
  ) {
    return false;
  }
  return automationTargetTypesForTrack(project, target.trackId).includes(target.type);
}
