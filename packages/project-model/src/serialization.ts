// Project (de)serialization with a forward-migration scaffold.
//
// Projects carry a `schemaVersion`. On load, any project with an older version
// is run through the registered migration functions in sequence until it
// reaches CURRENT_SCHEMA_VERSION.

import { CURRENT_SCHEMA_VERSION } from './factories';
import { beatsPerBar } from './time';
import type { Project, TrackRole } from './types';

const UTF8_BOM = '\uFEFF';
const DEFAULT_STEPS_PER_BAR = 16;
const DEFAULT_DRUM_BEATS_PER_BAR = 4;

/** Track-name words that imply a role, matched as whole words in any case. */
const ROLE_NAME_PATTERNS: Array<[RegExp, TrackRole]> = [
  [/(?<![a-z])chords?(?![a-z])/i, 'chords'],
  [/(?<![a-z])bass(?![a-z])/i, 'bass'],
  [/(?<![a-z])(?:melody|lead)(?![a-z])/i, 'melody'],
];

/**
 * A migration upgrades a raw project object from `from` to `to`.
 * Migrations operate on loosely-typed records because older shapes may differ
 * from the current Project type.
 */
export type Migration = {
  from: number;
  to: number;
  migrate: (project: Record<string, unknown>) => Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The file's time signature, or 4/4 when it is missing or malformed. */
function timeSignatureOf(raw: unknown): [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2) return [DEFAULT_DRUM_BEATS_PER_BAR, 4];
  const [num, den] = raw as unknown[];
  if (typeof num !== 'number' || typeof den !== 'number' || num <= 0 || den <= 0) {
    return [DEFAULT_DRUM_BEATS_PER_BAR, 4];
  }
  return [num, den];
}

/**
 * v1 counted a bar as `numerator` quarter-note beats (6/8 = 6 beats); v2 uses
 * `beatsPerBar` (6/8 = 3). Scaling bars by this factor keeps the old beat
 * positions, which is what the file was heard as. 1 for every `x/4` meter.
 */
function legacyBarScale(den: number): number {
  return den / 4;
}

/**
 * Regrid a v1 drum clip so every hit keeps the beat it was heard at: step `i`
 * sat at `i * numerator / stepsPerBar` beats, so a quarter-note bar needs
 * `stepsPerBar * 4 / den` steps. When that is not whole, the grid is made
 * `den` times finer instead and the step numbers scaled up, still exactly.
 */
function regridLegacyDrumClip(clip: Record<string, unknown>, den: number): Record<string, unknown> {
  if (den === 4 || !Array.isArray(clip.drumEvents)) return clip;
  const stepsPerBar =
    typeof clip.stepsPerBar === 'number' && clip.stepsPerBar > 0
      ? clip.stepsPerBar
      : DEFAULT_STEPS_PER_BAR;
  const exactSteps = (stepsPerBar * 4) / den;
  if (Number.isInteger(exactSteps)) return { ...clip, stepsPerBar: exactSteps };
  const drumEvents = clip.drumEvents.map((event: unknown) =>
    isRecord(event) && typeof event.stepIndex === 'number'
      ? { ...event, stepIndex: event.stepIndex * den }
      : event,
  );
  return { ...clip, stepsPerBar: stepsPerBar * 4, drumEvents };
}

/** Bars counted the v1 way, re-expressed in v2 bars (rounded up, at least 1). */
function legacyBarsToV2(bars: unknown, scale: number): unknown {
  return typeof bars === 'number' ? Math.max(1, Math.ceil(bars * scale - 1e-9)) : bars;
}

/** Sections keep their beat span: bar numbers are scaled, snapped to whole bars. */
function regridLegacySection(section: Record<string, unknown>, scale: number): Record<string, unknown> {
  if (typeof section.startBar !== 'number' || typeof section.lengthBars !== 'number') return section;
  const startBar = Math.round(section.startBar * scale);
  const endBar = Math.round((section.startBar + section.lengthBars) * scale);
  return { ...section, startBar, lengthBars: Math.max(1, endBar - startBar) };
}

/** End of the clip's last note or drum step, in beats from the clip start. */
function clipContentEnd(clip: Record<string, unknown>, beatsPerBar: number): number {
  const stepsPerBar =
    typeof clip.stepsPerBar === 'number' && clip.stepsPerBar > 0
      ? clip.stepsPerBar
      : DEFAULT_STEPS_PER_BAR;
  const noteEnds = records(clip.notes).map(
    (note) => Number(note.startBeat) + Number(note.durationBeats),
  );
  const drumEnds = records(clip.drumEvents).map(
    (drum) => (Number(drum.stepIndex) + 1) * (beatsPerBar / stepsPerBar),
  );
  // reduce, not a spread: a spread of a very large clip overflows the call stack.
  return [...noteEnds, ...drumEnds]
    .filter(Number.isFinite)
    .reduce((end, value) => Math.max(end, value), 0);
}

function inferTrackRole(track: Record<string, unknown>): TrackRole | undefined {
  if (track.type === 'drum') return 'drums';
  if (track.type === 'master' || typeof track.name !== 'string') return undefined;
  const name = track.name;
  return ROLE_NAME_PATTERNS.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * v1 -> v2. Before v2 playback ignored `lengthBeats` and sounded every note, and
 * the master gain was always 1 whatever `volume` said. Both are written into the
 * file here so that later readers of those fields keep the old sound. v1 also
 * counted a bar as `numerator` beats, so for meters other than `x/4` the song
 * length, the sections and the drum grids are re-expressed in quarter-note bars
 * (see `legacyBarScale`) so that nothing moves or is cut off.
 */
function migrateV1ToV2(project: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(project.tracks)) return { ...project };
  const [num, den] = timeSignatureOf(project.timeSignature);
  const bpb = beatsPerBar([num, den]);
  const scale = legacyBarScale(den);

  const tracks = project.tracks.map((track: unknown) => {
    if (!isRecord(track)) return track;
    const role = inferTrackRole(track);
    const clips = Array.isArray(track.clips)
      ? track.clips.map((raw: unknown) => {
          if (!isRecord(raw)) return raw;
          const clip = regridLegacyDrumClip(raw, den);
          return typeof clip.lengthBeats === 'number'
            ? { ...clip, lengthBeats: Math.max(clip.lengthBeats, clipContentEnd(clip, bpb)) }
            : clip;
        })
      : track.clips;
    return {
      ...track,
      clips,
      ...(role !== undefined ? { role } : {}),
      ...(track.type === 'master' ? { volume: 1 } : {}),
    };
  });

  if (scale === 1) return { ...project, tracks };
  const sections = Array.isArray(project.sections)
    ? project.sections.map((section: unknown) =>
        isRecord(section) ? regridLegacySection(section, scale) : section,
      )
    : project.sections;
  return { ...project, tracks, sections, lengthBars: legacyBarsToV2(project.lengthBars, scale) };
}

/**
 * Registry of migrations keyed by source version. New migrations should be
 * appended here as `{ from: N, to: N + 1, migrate }` when the schema changes.
 * Optional fields can be added without a new version.
 */
export const MIGRATIONS: Migration[] = [{ from: 1, to: 2, migrate: migrateV1ToV2 }];

/** Serialize a project to a pretty-printed JSON string. */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Apply registered migrations to a raw project object until it reaches the
 * current schema version. Exported for testing.
 */
export function migrateProject(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Project schemaVersion ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === version);
    if (!migration) {
      throw new Error(`No migration registered from schemaVersion ${version}`);
    }
    current = migration.migrate(current);
    current.schemaVersion = migration.to;
    version = migration.to;
  }

  return current;
}

/**
 * Deserialize a project from a JSON string, applying migrations as needed.
 * Throws if the JSON is invalid or the schema version is unsupported.
 */
export function deserializeProject(json: string): Project {
  const parsed: unknown = JSON.parse(stripLeadingBom(json));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid project JSON: expected an object');
  }
  const migrated = migrateProject(parsed as Record<string, unknown>);
  return migrated as unknown as Project;
}

function stripLeadingBom(json: string): string {
  return json.startsWith(UTF8_BOM) ? json.slice(UTF8_BOM.length) : json;
}
