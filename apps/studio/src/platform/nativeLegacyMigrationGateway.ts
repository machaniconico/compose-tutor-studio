import { invoke as invokeTauriCommand } from '@tauri-apps/api/core';
import type {
  LegacyStorageSnapshot,
  PersistenceErrorCode,
  RepositoryResult,
  RetryPolicy,
} from '@cts/project-persistence';
import {
  type LegacyMigrationCompletion,
  type LegacyMigrationStatus,
  type LegacyProjectImportReceipt,
  type LegacyProjectImportRequest,
  type NativeLegacyMigrationGateway,
} from './nativeLegacyMigration';

export const NATIVE_LEGACY_MIGRATION_COMMANDS = {
  status: 'persistence_get_legacy_migration_status',
  backup: 'persistence_backup_legacy_snapshot',
  importProject: 'persistence_import_legacy_project',
  complete: 'persistence_complete_legacy_migration',
} as const;

export type NativeLegacyMigrationCommand =
  (typeof NATIVE_LEGACY_MIGRATION_COMMANDS)[keyof typeof NATIVE_LEGACY_MIGRATION_COMMANDS];

export type NativeLegacyMigrationInvoke = (
  command: NativeLegacyMigrationCommand,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

const CHECKSUM = /^crc32:[0-9a-f]{8}$/;
const MAX_RECORDS = 4_096;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const MAX_ID_LENGTH = 4_096;
const encoder = new TextEncoder();

const ERROR_CODES = new Set<PersistenceErrorCode>([
  'storage-unavailable',
  'quota-exceeded',
  'access-denied',
  'invalid-project',
  'serialization-failed',
  'too-large',
  'corrupt-data',
  'unsupported-version',
  'conflict',
  'read-failed',
  'write-failed',
  'delete-failed',
  'migration-failed',
  'lock-unavailable',
  'sync-unsupported',
]);
const RETRIES = new Set<RetryPolicy>(['automatic', 'manual', 'never']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function checksum(value: unknown): value is string {
  return typeof value === 'string' && CHECKSUM.test(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validSnapshot(value: LegacyStorageSnapshot): boolean {
  const candidate = record(value);
  if (
    !candidate ||
    !exactKeys(candidate, [
      'storageVersion',
      'createdAt',
      'entries',
      'totalBytes',
      'contentChecksum',
      'checksum',
    ]) ||
    candidate.storageVersion !== 1 ||
    !canonicalTimestamp(candidate.createdAt) ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length > MAX_RECORDS ||
    !Number.isSafeInteger(candidate.totalBytes) ||
    (candidate.totalBytes as number) < 0 ||
    (candidate.totalBytes as number) > MAX_TOTAL_BYTES ||
    !checksum(candidate.contentChecksum) ||
    !checksum(candidate.checksum)
  ) {
    return false;
  }

  let totalBytes = 0;
  let previousKey: string | null = null;
  for (const valueEntry of candidate.entries) {
    const entry = record(valueEntry);
    if (
      !entry ||
      !exactKeys(entry, ['key', 'value', 'valueBytes', 'checksum']) ||
      typeof entry.key !== 'string' ||
      (!entry.key.startsWith('cts.persistence.v1.') && !entry.key.startsWith('cts.project.')) ||
      typeof entry.value !== 'string' ||
      !Number.isSafeInteger(entry.valueBytes) ||
      (entry.valueBytes as number) < 0 ||
      !checksum(entry.checksum) ||
      (previousKey !== null && previousKey >= entry.key)
    ) {
      return false;
    }
    const keyBytes = encoder.encode(entry.key).byteLength;
    const valueBytes = encoder.encode(entry.value).byteLength;
    if (valueBytes !== entry.valueBytes) return false;
    totalBytes += keyBytes + valueBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) return false;
    previousKey = entry.key;
  }
  return totalBytes === candidate.totalBytes;
}

function failure<T>(
  retry: RetryPolicy,
  code: PersistenceErrorCode = 'migration-failed',
  projectId?: string,
): RepositoryResult<T> {
  return {
    ok: false,
    error: {
      operation: 'initialize',
      code,
      retry,
      ...(projectId !== undefined ? { projectId } : {}),
    },
  };
}

function structuredFailure<T>(error: unknown, expectedProjectId?: string): RepositoryResult<T> {
  try {
    const candidate = record(error);
    if (
      candidate &&
      Object.keys(candidate).every((key) => ['code', 'retry', 'projectId'].includes(key)) &&
      ERROR_CODES.has(candidate.code as PersistenceErrorCode) &&
      RETRIES.has(candidate.retry as RetryPolicy) &&
      (candidate.projectId === undefined ||
        (boundedString(candidate.projectId) &&
          (expectedProjectId === undefined || candidate.projectId === expectedProjectId)))
    ) {
      return failure(
        candidate.retry as RetryPolicy,
        candidate.code as PersistenceErrorCode,
        typeof candidate.projectId === 'string' ? candidate.projectId : undefined,
      );
    }
  } catch {
    // Rejected proxies/getters are not trusted wire errors.
  }
  return failure('automatic');
}

function defaultInvoke(
  command: NativeLegacyMigrationCommand,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return invokeTauriCommand<unknown>(command, args);
}

export class TauriLegacyMigrationGateway implements NativeLegacyMigrationGateway {
  constructor(private readonly invoke: NativeLegacyMigrationInvoke = defaultInvoke) {}

  async getStatus(
    contentChecksum: string,
    migrationVersion: number,
  ): Promise<RepositoryResult<LegacyMigrationStatus>> {
    if (!checksum(contentChecksum) || !Number.isSafeInteger(migrationVersion) || migrationVersion < 1) {
      return failure('never');
    }
    try {
      const raw = record(
        await this.invoke(NATIVE_LEGACY_MIGRATION_COMMANDS.status, {
          contentChecksum,
          migrationVersion,
        }),
      );
      return raw && exactKeys(raw, ['complete']) && typeof raw.complete === 'boolean'
        ? { ok: true, value: { complete: raw.complete } }
        : failure('never');
    } catch (error) {
      return structuredFailure(error);
    }
  }

  async backupSnapshot(snapshot: LegacyStorageSnapshot): Promise<RepositoryResult<void>> {
    if (!validSnapshot(snapshot)) return failure('never');
    try {
      const raw = await this.invoke(NATIVE_LEGACY_MIGRATION_COMMANDS.backup, { snapshot });
      return raw === null ? { ok: true, value: undefined } : failure('never');
    } catch (error) {
      return structuredFailure(error);
    }
  }

  async importProject(
    request: LegacyProjectImportRequest,
  ): Promise<RepositoryResult<LegacyProjectImportReceipt>> {
    if (
      !checksum(request.contentChecksum) ||
      !boundedString(request.projectId) ||
      !Number.isSafeInteger(request.migrationVersion) ||
      request.migrationVersion < 1 ||
      !Array.isArray(request.sourceKeys) ||
      request.sourceKeys.length === 0 ||
      request.sourceKeys.length > MAX_RECORDS ||
      request.sourceKeys.some(
        (key, index) =>
          typeof key !== 'string' ||
          key.length === 0 ||
          key.length > MAX_ID_LENGTH ||
          (!key.startsWith('cts.persistence.v1.') && !key.startsWith('cts.project.')) ||
          (index > 0 && request.sourceKeys[index - 1]! >= key),
      ) ||
      ('projectJson' in request
        ? typeof request.projectJson !== 'string' ||
          encoder.encode(request.projectJson).byteLength > MAX_PROJECT_BYTES ||
          (request.branch !== undefined &&
            ((request.branch.source !== 'recovery-journal' &&
              request.branch.source !== 'interrupted-save') ||
              !boundedString(request.branch.activationId) ||
              !Number.isSafeInteger(request.branch.revision) ||
              request.branch.revision < 0 ||
              !boundedString(request.branch.writeId) ||
              !canonicalTimestamp(request.branch.savedAt)))
        : request.diagnostic.errorCode !== 'corrupt-data' &&
          request.diagnostic.errorCode !== 'unsupported-version' &&
          request.diagnostic.errorCode !== 'migration-failed' &&
          request.diagnostic.errorCode !== 'conflict')
    ) {
      return failure('never', 'migration-failed', request.projectId);
    }
    try {
      const raw = record(
        await this.invoke(NATIVE_LEGACY_MIGRATION_COMMANDS.importProject, { request }),
      );
      if (
        !raw ||
        raw.projectId !== request.projectId ||
        (raw.status !== 'imported' &&
          raw.status !== 'unchanged' &&
          raw.status !== 'branched')
      ) {
        return failure('never', 'migration-failed', request.projectId);
      }
      if (raw.status === 'branched') {
        return exactKeys(raw, ['projectId', 'status', 'branchId']) && boundedString(raw.branchId)
          ? {
              ok: true,
              value: {
                projectId: request.projectId,
                status: 'branched',
                branchId: raw.branchId,
              },
            }
          : failure('never', 'migration-failed', request.projectId);
      }
      return exactKeys(raw, ['projectId', 'status'])
        ? {
            ok: true,
            value: { projectId: request.projectId, status: raw.status },
          }
        : failure('never', 'migration-failed', request.projectId);
    } catch (error) {
      return structuredFailure(error, request.projectId);
    }
  }

  async complete(completion: LegacyMigrationCompletion): Promise<RepositoryResult<void>> {
    if (
      !checksum(completion.contentChecksum) ||
      !Number.isSafeInteger(completion.migrationVersion) ||
      completion.migrationVersion < 1 ||
      !Number.isSafeInteger(completion.recordCount) ||
      completion.recordCount < 0 ||
      completion.recordCount > MAX_RECORDS ||
      !Number.isSafeInteger(completion.totalBytes) ||
      completion.totalBytes < 0 ||
      completion.totalBytes > MAX_TOTAL_BYTES ||
      !Number.isSafeInteger(completion.readyProjectCount) ||
      completion.readyProjectCount < 0 ||
      completion.readyProjectCount > MAX_RECORDS ||
      !Number.isSafeInteger(completion.unreadableProjectCount) ||
      completion.unreadableProjectCount < 0 ||
      completion.unreadableProjectCount > MAX_RECORDS ||
      !Number.isSafeInteger(completion.branchCount) ||
      completion.branchCount < 0 ||
      completion.branchCount > MAX_RECORDS
    ) {
      return failure('never');
    }
    try {
      const raw = await this.invoke(NATIVE_LEGACY_MIGRATION_COMMANDS.complete, {
        request: completion,
      });
      return raw === null ? { ok: true, value: undefined } : failure('never');
    } catch (error) {
      return structuredFailure(error);
    }
  }
}

export const nativeLegacyMigrationGateway = new TauriLegacyMigrationGateway();
