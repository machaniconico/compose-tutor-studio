// Project (de)serialization with a forward-migration scaffold.
//
// Projects carry a `schemaVersion`. On load, any project with an older version
// is run through the registered migration functions in sequence until it
// reaches CURRENT_SCHEMA_VERSION.

import { CURRENT_SCHEMA_VERSION } from './factories';
import type { Project } from './types';

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

/**
 * Registry of migrations keyed by source version. Currently empty because the
 * schema is at version 1. New migrations should be appended here as
 * `{ from: N, to: N + 1, migrate }` when the schema changes.
 */
export const MIGRATIONS: Migration[] = [];

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
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid project JSON: expected an object');
  }
  const migrated = migrateProject(parsed as Record<string, unknown>);
  return migrated as unknown as Project;
}
