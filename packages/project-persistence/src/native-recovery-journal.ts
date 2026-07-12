import {
  decodeProjectJson,
  encodeProjectJson,
  DEFAULT_MAX_PROJECT_JSON_BYTES,
  type Project,
  type ProjectDecodeErrorCode,
} from '@cts/project-model';
import { crc32 } from './checksum';
import type {
  PersistenceError,
  PersistenceErrorCode,
  RecoveryReceipt,
  RepositoryOperation,
  RepositoryResult,
  RetryPolicy,
  SaveRequest,
  SynchronousRecoveryCapability,
} from './contracts';
import type { StorageLike, StorageProvider } from './local-storage-repository';

export const NATIVE_RECOVERY_NAMESPACE = 'cts.native-recovery.v1.';
export const LEGACY_PERSISTENCE_PREFIX = 'cts.persistence.v1.';
export const LEGACY_PROJECT_PREFIX = 'cts.project.';
export const DEFAULT_NATIVE_RECOVERY_MAX_ENTRIES = 64;
export const DEFAULT_STORAGE_SNAPSHOT_MAX_ENTRIES = 4_096;
export const DEFAULT_STORAGE_SCAN_MAX_KEYS = 16_384;
export const DEFAULT_STORAGE_BOUND_BYTES = 64 * 1024 * 1024;

const STORAGE_VERSION = 1;
const MAX_METADATA_STRING_LENGTH = 4_096;

type FailedRepositoryResult = Readonly<{ ok: false; error: PersistenceError }>;

type NativeRecoveryRecord = Readonly<{
  storageVersion: 1;
  projectId: string;
  baseHeadKnown: boolean;
  baseHeadVersion: string | null;
  predecessorWriteId?: string;
  activationId: string;
  revision: number;
  writeId: string;
  savedAt: string;
  bytes: number;
  projectJson: string;
  checksum: string;
}>;

export type StorageBoundaryOptions = Readonly<{
  storage: StorageLike | StorageProvider | null;
  /** Bounds enumeration even when a hostile StorageLike reports an absurd length. */
  maxScannedKeys?: number;
  /** Bounds matching entries returned or retained by this utility. */
  maxEntries?: number;
  /** Counts UTF-8 bytes for both keys and values. */
  maxTotalBytes?: number;
}>;

export type NativeRecoveryJournalOptions = StorageBoundaryOptions &
  Readonly<{
    now?: () => Date;
    maxProjectBytes?: number;
  }>;

export type NativeRecoveryIdentity = Readonly<{
  storageKey: string;
  /** Fingerprint of the exact raw value observed by list(). */
  rawFingerprint: string;
  /** Exact compare token; CRC alone is never sufficient for destructive cleanup. */
  rawValue: string;
}>;

export type ReadyNativeRecoveryEntry = NativeRecoveryIdentity &
  Readonly<{
    status: 'ready';
    projectId: string;
    baseHeadKnown: boolean;
    baseHeadVersion: string | null;
    predecessorWriteId?: string;
    activationId: string;
    revision: number;
    writeId: string;
    savedAt: string;
    bytes: number;
    checksum: string;
    project: Project;
  }>;

export type UnreadableNativeRecoveryEntry = NativeRecoveryIdentity &
  Readonly<{
    status: 'unreadable';
    projectId?: string;
    activationId?: string;
    errorCode: Extract<
      PersistenceErrorCode,
      'corrupt-data' | 'unsupported-version' | 'migration-failed'
    >;
  }>;

export type NativeRecoveryEntry =
  | ReadyNativeRecoveryEntry
  | UnreadableNativeRecoveryEntry;

export type LegacyStorageSnapshotRecord = Readonly<{
  key: string;
  value: string;
  valueBytes: number;
  checksum: string;
}>;

export type LegacyStorageSnapshot = Readonly<{
  storageVersion: 1;
  createdAt: string;
  entries: readonly LegacyStorageSnapshotRecord[];
  totalBytes: number;
  /** Stable across runs for the same sorted exact key/value content. */
  contentChecksum: string;
  /** Checksum of the complete snapshot envelope, including createdAt. */
  checksum: string;
}>;

function retryFor(code: PersistenceErrorCode): RetryPolicy {
  if (code === 'read-failed' || code === 'write-failed' || code === 'delete-failed') {
    return 'automatic';
  }
  if (code === 'quota-exceeded' || code === 'access-denied' || code === 'conflict') {
    return 'manual';
  }
  return 'never';
}

function failure(
  operation: RepositoryOperation,
  code: PersistenceErrorCode,
  projectId?: string,
): FailedRepositoryResult {
  return {
    ok: false,
    error: {
      operation,
      code,
      retry: retryFor(code),
      ...(projectId !== undefined ? { projectId } : {}),
    },
  };
}

function errorName(error: unknown): string | null {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return null;
  try {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

function storageFailure(
  operation: RepositoryOperation,
  error: unknown,
  fallback: PersistenceErrorCode,
  projectId?: string,
): FailedRepositoryResult {
  const name = errorName(error);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return failure(operation, 'quota-exceeded', projectId);
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return failure(operation, 'access-denied', projectId);
  }
  return failure(operation, fallback, projectId);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function metadataString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_METADATA_STRING_LENGTH;
}

function encodedPart(value: string): string {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

function decodedPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function nativeRecoveryKey(projectId: string, activationId: string): string {
  return `${NATIVE_RECOVERY_NAMESPACE}${encodedPart(projectId)}.${encodedPart(activationId)}`;
}

function parseNativeRecoveryKey(
  key: string,
): { projectId: string; activationId: string } | null {
  if (!key.startsWith(NATIVE_RECOVERY_NAMESPACE)) return null;
  const suffix = key.slice(NATIVE_RECOVERY_NAMESPACE.length);
  const separator = suffix.indexOf('.');
  if (separator <= 0 || separator === suffix.length - 1 || suffix.indexOf('.', separator + 1) >= 0) {
    return null;
  }
  const projectId = decodedPart(suffix.slice(0, separator));
  const activationId = decodedPart(suffix.slice(separator + 1));
  return projectId && activationId ? { projectId, activationId } : null;
}

function rawFingerprint(raw: string): string {
  return `${utf8Bytes(raw)}:${crc32(`cts-native-recovery-raw-v1\u0000${raw}`)}`;
}

function recoveryChecksum(value: Omit<NativeRecoveryRecord, 'checksum'>): string {
  return crc32(JSON.stringify(value));
}

function decodeErrorCode(
  code: ProjectDecodeErrorCode,
): UnreadableNativeRecoveryEntry['errorCode'] {
  if (code === 'future-schema-version') return 'unsupported-version';
  if (code === 'migration-failed' || code === 'migration-unavailable') return 'migration-failed';
  return 'corrupt-data';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RECOVERY_KEYS = new Set([
  'storageVersion',
  'projectId',
  'baseHeadKnown',
  'baseHeadVersion',
  'predecessorWriteId',
  'activationId',
  'revision',
  'writeId',
  'savedAt',
  'bytes',
  'projectJson',
  'checksum',
]);

function parseRecoveryRecord(
  raw: string,
  key: string,
):
  | { status: 'ready'; record: NativeRecoveryRecord; project: Project }
  | { status: 'unreadable'; errorCode: UnreadableNativeRecoveryEntry['errorCode'] } {
  const keyParts = parseNativeRecoveryKey(key);
  if (!keyParts) return { status: 'unreadable', errorCode: 'corrupt-data' };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { status: 'unreadable', errorCode: 'corrupt-data' };
  }
  if (!isRecord(value)) return { status: 'unreadable', errorCode: 'corrupt-data' };
  if (Number.isSafeInteger(value.storageVersion) && (value.storageVersion as number) > STORAGE_VERSION) {
    return { status: 'unreadable', errorCode: 'unsupported-version' };
  }
  if (Object.keys(value).some((candidate) => !RECOVERY_KEYS.has(candidate))) {
    return { status: 'unreadable', errorCode: 'corrupt-data' };
  }
  if (
    value.storageVersion !== STORAGE_VERSION ||
    value.projectId !== keyParts.projectId ||
    value.activationId !== keyParts.activationId ||
    !metadataString(value.projectId) ||
    !metadataString(value.activationId) ||
    typeof value.baseHeadKnown !== 'boolean' ||
    (value.baseHeadVersion !== null && typeof value.baseHeadVersion !== 'string') ||
    (!value.baseHeadKnown && value.baseHeadVersion !== null) ||
    (typeof value.baseHeadVersion === 'string' && !metadataString(value.baseHeadVersion)) ||
    (value.predecessorWriteId !== undefined && !metadataString(value.predecessorWriteId)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !metadataString(value.writeId) ||
    !canonicalTimestamp(value.savedAt) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > DEFAULT_MAX_PROJECT_JSON_BYTES ||
    typeof value.projectJson !== 'string' ||
    typeof value.checksum !== 'string'
  ) {
    return { status: 'unreadable', errorCode: 'corrupt-data' };
  }
  const content: Omit<NativeRecoveryRecord, 'checksum'> = {
    storageVersion: STORAGE_VERSION,
    projectId: value.projectId,
    baseHeadKnown: value.baseHeadKnown,
    baseHeadVersion: value.baseHeadVersion as string | null,
    ...(typeof value.predecessorWriteId === 'string'
      ? { predecessorWriteId: value.predecessorWriteId }
      : {}),
    activationId: value.activationId,
    revision: value.revision as number,
    writeId: value.writeId,
    savedAt: value.savedAt,
    bytes: value.bytes as number,
    projectJson: value.projectJson,
  };
  if (
    value.checksum !== recoveryChecksum(content) ||
    utf8Bytes(content.projectJson) !== content.bytes
  ) {
    return { status: 'unreadable', errorCode: 'corrupt-data' };
  }
  const decoded = decodeProjectJson(content.projectJson, {
    maxBytes: DEFAULT_MAX_PROJECT_JSON_BYTES,
  });
  if (!decoded.ok) {
    return { status: 'unreadable', errorCode: decodeErrorCode(decoded.error.code) };
  }
  if (decoded.project.id !== content.projectId) {
    return { status: 'unreadable', errorCode: 'corrupt-data' };
  }
  return {
    status: 'ready',
    record: { ...content, checksum: value.checksum },
    project: decoded.project,
  };
}

function providerFor(storage: StorageBoundaryOptions['storage']): StorageProvider {
  return typeof storage === 'function' ? (storage as StorageProvider) : () => storage;
}

type ReadRawEntriesResult =
  | { ok: true; storage: StorageLike; entries: Array<{ key: string; raw: string }>; totalBytes: number }
  | { ok: false; result: FailedRepositoryResult };

function readRawEntries(
  provider: StorageProvider,
  operation: RepositoryOperation,
  matches: (key: string) => boolean,
  maxScannedKeys: number,
  maxEntries: number,
  maxTotalBytes: number,
  projectId?: string,
): ReadRawEntriesResult {
  const boundCode: PersistenceErrorCode = operation === 'save' ? 'quota-exceeded' : 'too-large';
  let storage: StorageLike | null;
  try {
    storage = provider();
  } catch (error) {
    return { ok: false, result: storageFailure(operation, error, 'storage-unavailable', projectId) };
  }
  if (!storage) return { ok: false, result: failure(operation, 'storage-unavailable', projectId) };

  let keys: string[];
  try {
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxScannedKeys) {
      return { ok: false, result: failure(operation, boundCode, projectId) };
    }
    const seen = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key !== null && matches(key)) seen.add(key);
      if (seen.size > maxEntries) {
        return { ok: false, result: failure(operation, boundCode, projectId) };
      }
    }
    keys = [...seen].sort();
  } catch (error) {
    return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
  }

  const entries: Array<{ key: string; raw: string }> = [];
  let totalBytes = 0;
  try {
    for (const key of keys) {
      const raw = storage.getItem(key);
      if (raw === null) return { ok: false, result: failure(operation, 'read-failed', projectId) };
      totalBytes += utf8Bytes(key) + utf8Bytes(raw);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
        return { ok: false, result: failure(operation, boundCode, projectId) };
      }
      entries.push({ key, raw });
    }
    // localStorage has no snapshot primitive. Verify that the captured values
    // remained byte-for-byte stable during this synchronous read pass.
    for (const entry of entries) {
      if (storage.getItem(entry.key) !== entry.raw) {
        return { ok: false, result: failure(operation, 'conflict', projectId) };
      }
    }
  } catch (error) {
    return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
  }
  return { ok: true, storage, entries, totalBytes };
}

/**
 * Synchronous, local-only emergency journal for a Tauri repository adapter.
 * It never changes the adapter's canonical SQLite head.
 */
export class NativeRecoveryJournal implements SynchronousRecoveryCapability {
  private readonly provider: StorageProvider;
  private readonly now: () => Date;
  private readonly maxProjectBytes: number;
  private readonly maxScannedKeys: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;

  constructor(options: NativeRecoveryJournalOptions) {
    this.provider = providerFor(options.storage);
    this.now = options.now ?? (() => new Date());
    this.maxProjectBytes = Math.min(
      DEFAULT_MAX_PROJECT_JSON_BYTES,
      positiveLimit(options.maxProjectBytes, DEFAULT_MAX_PROJECT_JSON_BYTES),
    );
    this.maxScannedKeys = positiveLimit(options.maxScannedKeys, DEFAULT_STORAGE_SCAN_MAX_KEYS);
    this.maxEntries = positiveLimit(options.maxEntries, DEFAULT_NATIVE_RECOVERY_MAX_ENTRIES);
    this.maxTotalBytes = positiveLimit(options.maxTotalBytes, DEFAULT_STORAGE_BOUND_BYTES);
  }

  list(projectId?: string): RepositoryResult<readonly NativeRecoveryEntry[]> {
    const expectedPrefix =
      projectId === undefined
        ? NATIVE_RECOVERY_NAMESPACE
        : `${NATIVE_RECOVERY_NAMESPACE}${encodedPart(projectId)}.`;
    const read = readRawEntries(
      this.provider,
      'list',
      (key) => key.startsWith(expectedPrefix),
      this.maxScannedKeys,
      this.maxEntries,
      this.maxTotalBytes,
      projectId,
    );
    if (!read.ok) return read.result;
    const entries: NativeRecoveryEntry[] = read.entries.map(({ key, raw }) => {
      const parsedKey = parseNativeRecoveryKey(key);
      const identity: NativeRecoveryIdentity = {
        storageKey: key,
        rawFingerprint: rawFingerprint(raw),
        rawValue: raw,
      };
      const parsed = parseRecoveryRecord(raw, key);
      if (parsed.status === 'unreadable') {
        return {
          ...identity,
          status: 'unreadable',
          ...(parsedKey?.projectId !== undefined ? { projectId: parsedKey.projectId } : {}),
          ...(parsedKey?.activationId !== undefined
            ? { activationId: parsedKey.activationId }
            : {}),
          errorCode: parsed.errorCode,
        };
      }
      const { record } = parsed;
      return {
        ...identity,
        status: 'ready',
        projectId: record.projectId,
        baseHeadKnown: record.baseHeadKnown,
        baseHeadVersion: record.baseHeadVersion,
        ...(record.predecessorWriteId !== undefined
          ? { predecessorWriteId: record.predecessorWriteId }
          : {}),
        activationId: record.activationId,
        revision: record.revision,
        writeId: record.writeId,
        savedAt: record.savedAt,
        bytes: record.bytes,
        checksum: record.checksum,
        project: parsed.project,
      };
    });
    return { ok: true, value: entries };
  }

  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt> {
    let projectId = '';
    try {
      projectId = typeof request.project.id === 'string' ? request.project.id : '';
    } catch {
      // The canonical codec reports the invalid project below.
    }
    if (
      !metadataString(request.activationId) ||
      !metadataString(request.writeId) ||
      (request.predecessorWriteId !== undefined &&
        !metadataString(request.predecessorWriteId)) ||
      (typeof request.expectedHeadVersion === 'string' &&
        !metadataString(request.expectedHeadVersion)) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0
    ) {
      return failure('save', 'invalid-project', projectId);
    }
    const encoded = encodeProjectJson(request.project, { maxBytes: this.maxProjectBytes });
    if (!encoded.ok) {
      return failure(
        'save',
        encoded.error.code === 'too-large'
          ? 'too-large'
          : encoded.error.code === 'serialization-failed'
            ? 'serialization-failed'
            : 'invalid-project',
        projectId,
      );
    }
    const verified = decodeProjectJson(encoded.json, { maxBytes: this.maxProjectBytes });
    if (!verified.ok || verified.project.id !== projectId) {
      return failure('save', 'serialization-failed', projectId);
    }

    const read = readRawEntries(
      this.provider,
      'save',
      (key) => key.startsWith(NATIVE_RECOVERY_NAMESPACE),
      this.maxScannedKeys,
      this.maxEntries,
      this.maxTotalBytes,
      projectId,
    );
    if (!read.ok) return read.result;
    const key = nativeRecoveryKey(projectId, request.activationId);
    const existing = read.entries.find((entry) => entry.key === key);
    if (existing) {
      const parsed = parseRecoveryRecord(existing.raw, key);
      if (parsed.status === 'unreadable') {
        return failure('save', parsed.errorCode, projectId);
      }
      if (parsed.record.revision > request.revision) {
        return failure('save', 'conflict', projectId);
      }
      if (parsed.record.revision === request.revision) {
        const same =
          parsed.record.writeId === request.writeId &&
          parsed.record.projectJson === encoded.json &&
          parsed.record.baseHeadKnown === (request.expectedHeadVersion !== undefined) &&
          parsed.record.baseHeadVersion === (request.expectedHeadVersion ?? null) &&
          parsed.record.predecessorWriteId === request.predecessorWriteId;
        if (!same) return failure('save', 'conflict', projectId);
        return {
          ok: true,
          value: {
            projectId,
            activationId: request.activationId,
            revision: request.revision,
            writeId: request.writeId,
            savedAt: parsed.record.savedAt,
            bytes: parsed.record.bytes,
          },
        };
      }
    } else if (read.entries.length >= this.maxEntries) {
      return failure('save', 'quota-exceeded', projectId);
    }

    let savedAt: string;
    try {
      savedAt = this.now().toISOString();
    } catch {
      return failure('save', 'write-failed', projectId);
    }
    const content: Omit<NativeRecoveryRecord, 'checksum'> = {
      storageVersion: STORAGE_VERSION,
      projectId,
      baseHeadKnown: request.expectedHeadVersion !== undefined,
      baseHeadVersion: request.expectedHeadVersion ?? null,
      ...(request.predecessorWriteId !== undefined
        ? { predecessorWriteId: request.predecessorWriteId }
        : {}),
      activationId: request.activationId,
      revision: request.revision,
      writeId: request.writeId,
      savedAt,
      bytes: encoded.bytes,
      projectJson: encoded.json,
    };
    const record: NativeRecoveryRecord = { ...content, checksum: recoveryChecksum(content) };
    const raw = JSON.stringify(record);
    const existingBytes = existing ? utf8Bytes(existing.key) + utf8Bytes(existing.raw) : 0;
    const nextTotal = read.totalBytes - existingBytes + utf8Bytes(key) + utf8Bytes(raw);
    if (!Number.isSafeInteger(nextTotal) || nextTotal > this.maxTotalBytes) {
      return failure('save', 'quota-exceeded', projectId);
    }
    try {
      read.storage.setItem(key, raw);
      if (read.storage.getItem(key) !== raw) return failure('save', 'write-failed', projectId);
    } catch (error) {
      return storageFailure('save', error, 'write-failed', projectId);
    }
    const parsed = parseRecoveryRecord(raw, key);
    if (parsed.status !== 'ready') return failure('save', 'write-failed', projectId);
    return {
      ok: true,
      value: {
        projectId,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        savedAt,
        bytes: encoded.bytes,
      },
    };
  }

  /** Removes nothing if the key has been replaced since it was listed. */
  removeExact(identity: NativeRecoveryIdentity): RepositoryResult<boolean> {
    const keyParts = parseNativeRecoveryKey(identity.storageKey);
    if (
      !keyParts ||
      !identity.rawFingerprint ||
      typeof identity.rawValue !== 'string' ||
      rawFingerprint(identity.rawValue) !== identity.rawFingerprint
    ) {
      return failure('remove', 'invalid-project', keyParts?.projectId);
    }
    let storage: StorageLike | null;
    try {
      storage = this.provider();
    } catch (error) {
      return storageFailure('remove', error, 'storage-unavailable', keyParts.projectId);
    }
    if (!storage) return failure('remove', 'storage-unavailable', keyParts.projectId);
    try {
      const current = storage.getItem(identity.storageKey);
      if (current === null || current !== identity.rawValue) {
        return { ok: true, value: false };
      }
      storage.removeItem(identity.storageKey);
      return storage.getItem(identity.storageKey) === null
        ? { ok: true, value: true }
        : failure('remove', 'delete-failed', keyParts.projectId);
    } catch (error) {
      return storageFailure('remove', error, 'delete-failed', keyParts.projectId);
    }
  }
}

/** Capture only legacy CTS persistence records, preserving exact key/value bytes. */
export function createLegacyStorageSnapshot(
  options: StorageBoundaryOptions & Readonly<{ now?: () => Date }>,
): RepositoryResult<LegacyStorageSnapshot> {
  const provider = providerFor(options.storage);
  const read = readRawEntries(
    provider,
    'list',
    (key) =>
      key.startsWith(LEGACY_PERSISTENCE_PREFIX) || key.startsWith(LEGACY_PROJECT_PREFIX),
    positiveLimit(options.maxScannedKeys, DEFAULT_STORAGE_SCAN_MAX_KEYS),
    positiveLimit(options.maxEntries, DEFAULT_STORAGE_SNAPSHOT_MAX_ENTRIES),
    positiveLimit(options.maxTotalBytes, DEFAULT_STORAGE_BOUND_BYTES),
  );
  if (!read.ok) return read.result;
  let createdAt: string;
  try {
    createdAt = (options.now ?? (() => new Date()))().toISOString();
  } catch {
    return failure('list', 'read-failed');
  }
  const entries: LegacyStorageSnapshotRecord[] = read.entries.map(({ key, raw }) => ({
    key,
    value: raw,
    valueBytes: utf8Bytes(raw),
    checksum: crc32(JSON.stringify({ key, value: raw })),
  }));
  const stableContent = {
    storageVersion: STORAGE_VERSION,
    entries,
    totalBytes: read.totalBytes,
  } as const;
  const content = {
    storageVersion: STORAGE_VERSION,
    createdAt,
    entries,
    totalBytes: read.totalBytes,
    contentChecksum: crc32(JSON.stringify(stableContent)),
  } as const;
  return {
    ok: true,
    value: {
      ...content,
      checksum: crc32(JSON.stringify(content)),
    },
  };
}
