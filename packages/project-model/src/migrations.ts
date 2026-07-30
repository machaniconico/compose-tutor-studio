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

function collectObjectIds(
  value: unknown,
  result = new Set<string>(),
  visited = new WeakSet<object>(),
): Set<string> {
  if (Array.isArray(value)) {
    if (visited.has(value)) return result;
    visited.add(value);
    for (const item of value) collectObjectIds(item, result, visited);
    return result;
  }
  if (typeof value !== 'object' || value === null) return result;
  if (visited.has(value)) return result;
  visited.add(value);
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.id === 'string') result.add(record.id);
  for (const nested of Object.values(record)) collectObjectIds(nested, result, visited);
  return result;
}

function createMigrationIdAllocator(used: Set<string>, kind: string): () => string {
  let sequence = 1;
  return () => {
    let candidate: string;
    do {
      candidate = `migrated-${kind}-${sequence}`;
      sequence += 1;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };
}

type MigratedLearningRole =
  | 'learning.chords'
  | 'learning.bass'
  | 'learning.melody';

function legacyLearningRole(name: unknown): MigratedLearningRole | null {
  if (typeof name !== 'string') return null;
  switch (name.trim().toLowerCase()) {
    case 'chord':
    case 'chords':
    case 'コード':
      return 'learning.chords';
    case 'bass':
      return 'learning.bass';
    case 'melody':
      return 'learning.melody';
    default:
      return null;
  }
}

/** Add schema-v3 maps, roles, automation, and resolvable audio placeholders. */
function migrateV2ToV3(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const usedIds = collectObjectIds(project);
  const nextTempoId = createMigrationIdAllocator(usedIds, 'tempo');
  const nextSignatureId = createMigrationIdAllocator(usedIds, 'signature');
  const nextAudioId = createMigrationIdAllocator(usedIds, 'audio');
  const audioAssets: Record<string, unknown>[] = [];
  const assetByLegacyId = new Map<string, string>();
  const claimedLearningRoles = new Set<MigratedLearningRole>();

  const tracks = Array.isArray(project.tracks)
    ? project.tracks.map((track) => {
        if (typeof track !== 'object' || track === null || Array.isArray(track)) {
          return track;
        }
        const trackRecord = track as Readonly<Record<string, unknown>>;
        const candidateRole = trackRecord.type === 'instrument'
          ? legacyLearningRole(trackRecord.name)
          : null;
        const role = candidateRole !== null && !claimedLearningRoles.has(candidateRole)
          ? candidateRole
          : 'general';
        if (candidateRole !== null && role === candidateRole) {
          claimedLearningRoles.add(candidateRole);
        }

        const clips = Array.isArray(trackRecord.clips)
          ? trackRecord.clips.map((clip) => {
              if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
                return clip;
              }
              const clipRecord = clip as Readonly<Record<string, unknown>>;
              if (clipRecord.type !== 'audio') return { ...clipRecord };

              const legacyAssetId = typeof clipRecord.audioAssetId === 'string'
                && clipRecord.audioAssetId.length > 0
                ? clipRecord.audioAssetId
                : null;
              let audioAssetId: string;
              if (legacyAssetId !== null) {
                const existing = assetByLegacyId.get(legacyAssetId);
                if (existing !== undefined) {
                  audioAssetId = existing;
                } else {
                  audioAssetId = nextAudioId();
                  assetByLegacyId.set(legacyAssetId, audioAssetId);
                  audioAssets.push({
                    id: audioAssetId,
                    availability: 'unresolved',
                    legacyAssetId,
                    reason: 'legacy-reference',
                  });
                }
              } else {
                audioAssetId = nextAudioId();
                audioAssets.push({
                  id: audioAssetId,
                  availability: 'unresolved',
                  reason: 'missing-reference',
                });
              }

              return {
                ...clipRecord,
                audioAssetId,
                sourceStartFrame: 0,
                sourceFrameCount: 0,
                fadeInFrames: 0,
                fadeOutFrames: 0,
                gainDb: 0,
              };
            })
          : trackRecord.clips;
        return { ...trackRecord, role, clips };
      })
    : project.tracks;

  const timeSignature = project.timeSignature;
  const numerator = Array.isArray(timeSignature) ? timeSignature[0] : undefined;
  const denominator = Array.isArray(timeSignature) ? timeSignature[1] : undefined;
  const lengthBeats = typeof project.lengthBars === 'number'
    && typeof numerator === 'number'
    && typeof denominator === 'number'
    ? project.lengthBars * numerator * (4 / denominator)
    : Number.NaN;

  return {
    ...project,
    schemaVersion: 3,
    lengthBeats,
    tempoMap: [{ id: nextTempoId(), beat: 0, bpm: project.bpm }],
    timeSignatureMap: [{
      id: nextSignatureId(),
      beat: 0,
      numerator,
      denominator,
    }],
    audioAssets,
    automationLanes: [],
    tracks,
  };
}

/** Preserve schema-v3's fixed direct-to-Master signal flow explicitly. */
function migrateV3ToV4(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const outputs = Array.isArray(project.tracks)
    ? project.tracks.flatMap((track) => {
        if (typeof track !== 'object' || track === null || Array.isArray(track)) return [];
        const record = track as Readonly<Record<string, unknown>>;
        if (record.type === 'master' || typeof record.id !== 'string') return [];
        return [{ sourceTrackId: record.id, destination: { type: 'master' } }];
      })
    : [];

  return {
    ...project,
    schemaVersion: 4,
    audioRouting: { outputs, sends: [] },
  };
}

/** Add the schema-v5 non-destructive Audio take collection. */
function migrateV4ToV5(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...project,
    schemaVersion: 5,
    audioTakeFolders: [],
  };
}

/** Keep every existing curve active when schema-v6 adds lane-scoped bypass. */
function migrateV5ToV6(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const automationLanes = Array.isArray(project.automationLanes)
    ? project.automationLanes.map((lane) => {
        if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) {
          return lane;
        }
        return {
          ...(lane as Readonly<Record<string, unknown>>),
          bypassed: false,
        };
      })
    : project.automationLanes;

  return {
    ...project,
    schemaVersion: 6,
    automationLanes,
  };
}

/** Preserve every existing curve when schema-v7 adds global/track Read gates. */
function migrateV6ToV7(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...project,
    schemaVersion: 7,
    automationReadState: {
      globalEnabled: true,
      disabledTrackIds: [],
    },
  };
}

/** Schema-v8 permits effective-Master volume automation without rewriting v7 data. */
function migrateV7ToV8(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...project,
    schemaVersion: 8,
  };
}

/** Schema-v9 adds optional Audio Clip warp metadata without changing v8 data. */
function migrateV8ToV9(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...project,
    schemaVersion: 9,
  };
}

/** Preserve v9 audio exactly by disabling the newly persisted formant processor. */
function migrateV9ToV10(
  project: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const tracks = Array.isArray(project.tracks)
    ? project.tracks.map((track) => {
        if (typeof track !== 'object' || track === null || Array.isArray(track)) return track;
        const trackRecord = track as Readonly<Record<string, unknown>>;
        const clips = Array.isArray(trackRecord.clips)
          ? trackRecord.clips.map((clip) => {
              if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) return clip;
              const clipRecord = clip as Readonly<Record<string, unknown>>;
              const warp = clipRecord.audioWarp;
              if (typeof warp !== 'object' || warp === null || Array.isArray(warp)) {
                return { ...clipRecord };
              }
              return {
                ...clipRecord,
                audioWarp: {
                  ...(warp as Readonly<Record<string, unknown>>),
                  formantMode: 'off',
                },
              };
            })
          : trackRecord.clips;
        return { ...trackRecord, clips };
      })
    : project.tracks;
  return { ...project, schemaVersion: 10, tracks };
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { from: 1, to: 2, migrate: migrateV1ToV2 },
  { from: 2, to: 3, migrate: migrateV2ToV3 },
  { from: 3, to: 4, migrate: migrateV3ToV4 },
  { from: 4, to: 5, migrate: migrateV4ToV5 },
  { from: 5, to: 6, migrate: migrateV5ToV6 },
  { from: 6, to: 7, migrate: migrateV6ToV7 },
  { from: 7, to: 8, migrate: migrateV7ToV8 },
  { from: 8, to: 9, migrate: migrateV8ToV9 },
  { from: 9, to: 10, migrate: migrateV9ToV10 },
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

/**
 * Master automation was not part of any legacy schema. Reject it before a
 * schema-only v7 -> v8 migration could make the same payload appear valid.
 */
function assertNoLegacyMasterAutomation(
  project: Readonly<Record<string, unknown>>,
  schemaVersion: number,
): void {
  if (schemaVersion < 3 || schemaVersion > 7) return;
  const masterIds = new Set<string>();
  if (Array.isArray(project.tracks)) {
    for (const track of project.tracks) {
      if (
        typeof track === 'object'
        && track !== null
        && !Array.isArray(track)
      ) {
        const record = track as Readonly<Record<string, unknown>>;
        if (record.type === 'master' && typeof record.id === 'string') {
          masterIds.add(record.id);
        }
      }
    }
  }
  if (masterIds.size === 0) return;

  if (Array.isArray(project.automationLanes)) {
    for (const lane of project.automationLanes) {
      if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) continue;
      const target = (lane as Readonly<Record<string, unknown>>).target;
      if (typeof target !== 'object' || target === null || Array.isArray(target)) continue;
      if (masterIds.has((target as Readonly<Record<string, unknown>>).trackId as string)) {
        throw new ProjectMigrationError(
          'migration-failed',
          `schemaVersion ${schemaVersion} automation cannot target a Master track`,
        );
      }
    }
  }

  if (schemaVersion === 7) {
    const readState = project.automationReadState;
    if (
      typeof readState === 'object'
      && readState !== null
      && !Array.isArray(readState)
    ) {
      const disabledTrackIds =
        (readState as Readonly<Record<string, unknown>>).disabledTrackIds;
      if (
        Array.isArray(disabledTrackIds)
        && disabledTrackIds.some(
          (trackId) => typeof trackId === 'string' && masterIds.has(trackId),
        )
      ) {
        throw new ProjectMigrationError(
          'migration-failed',
          'schemaVersion 7 automation Read state cannot reference a Master track',
        );
      }
    }
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

  assertNoLegacyMasterAutomation(current, version);

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
