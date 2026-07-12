import { CURRENT_SCHEMA_VERSION } from './factories';

/** A single, consecutive project-schema migration. */
export type Migration = Readonly<{
  from: number;
  to: number;
  migrate: (project: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}>;

/**
 * Append a migration here whenever CURRENT_SCHEMA_VERSION is incremented.
 * The registry is intentionally readonly: runtime code must not change the
 * persistence contract after startup.
 */
/**
 * v1 exposed `aliasOf` in the transport shape but did not assign it any runtime
 * meaning: editors, playback, and MIDI all consumed each clip's own payload.
 * Preserve that audible behaviour when v2 introduces real linked clips by
 * removing the inert marker. A v1 clip therefore remains an independent clip.
 */
function migrateV1ToV2(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const tracks = Array.isArray(project.tracks)
    ? project.tracks.map((track) => {
        if (typeof track !== 'object' || track === null || Array.isArray(track)) {
          return track;
        }
        const trackRecord = track as Readonly<Record<string, unknown>>;
        const clips = Array.isArray(trackRecord.clips)
          ? trackRecord.clips.map((clip) => {
              if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
                return clip;
              }
              const { aliasOf: _legacyAliasOf, ...independentClip } = clip as Record<
                string,
                unknown
              >;
              return independentClip;
            })
          : trackRecord.clips;
        return { ...trackRecord, clips };
      })
    : project.tracks;

  return { ...project, schemaVersion: 2, tracks };
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { from: 1, to: 2, migrate: migrateV1ToV2 },
]);

export type ProjectMigrationErrorCode =
  | 'future-schema-version'
  | 'migration-unavailable'
  | 'migration-failed';

export class ProjectMigrationError extends Error {
  readonly code: ProjectMigrationErrorCode;

  constructor(code: ProjectMigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectMigrationError';
    this.code = code;
  }
}

function cloneRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    const cloned: unknown = structuredClone(input);
    if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
      throw new Error('Migration input did not clone to an object');
    }
    return cloned as Record<string, unknown>;
  } catch (error) {
    throw new ProjectMigrationError(
      'migration-failed',
      'Project migration input could not be cloned safely',
      { cause: error },
    );
  }
}

function assertMigrationRegistry(): void {
  const seen = new Set<number>();
  for (const migration of MIGRATIONS) {
    if (
      !Number.isSafeInteger(migration.from) ||
      !Number.isSafeInteger(migration.to) ||
      migration.from < 1 ||
      migration.to !== migration.from + 1 ||
      migration.to > CURRENT_SCHEMA_VERSION ||
      seen.has(migration.from)
    ) {
      throw new ProjectMigrationError(
        'migration-failed',
        `Invalid migration registry entry ${migration.from} -> ${migration.to}`,
      );
    }
    seen.add(migration.from);
  }
}

/** Apply every consecutive migration without mutating the caller's input. */
export function migrateProject(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  assertMigrationRegistry();
  let current = cloneRecord(raw);
  const initialVersion = current.schemaVersion;
  if (!Number.isSafeInteger(initialVersion) || (initialVersion as number) < 1) {
    throw new ProjectMigrationError(
      'migration-failed',
      'Project schemaVersion must be a positive safe integer before migration',
    );
  }
  let version = initialVersion as number;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new ProjectMigrationError(
      'future-schema-version',
      `Project schemaVersion ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((candidate) => candidate.from === version);
    if (!migration) {
      throw new ProjectMigrationError(
        'migration-unavailable',
        `No migration registered from schemaVersion ${version}`,
      );
    }

    let next: Record<string, unknown>;
    try {
      next = migration.migrate(Object.freeze(cloneRecord(current)));
    } catch (error) {
      if (error instanceof ProjectMigrationError) throw error;
      throw new ProjectMigrationError(
        'migration-failed',
        `Migration ${migration.from} -> ${migration.to} failed`,
        { cause: error },
      );
    }
    if (
      typeof next !== 'object' ||
      next === null ||
      Array.isArray(next) ||
      next === current ||
      next.schemaVersion !== migration.to
    ) {
      throw new ProjectMigrationError(
        'migration-failed',
        `Migration ${migration.from} -> ${migration.to} returned an invalid result`,
      );
    }
    current = next;
    version = migration.to;
  }

  return current;
}
