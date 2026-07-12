import {
  decodeProjectJson,
  encodeProjectJson,
  type Project,
  type ProjectDecodeErrorCode,
} from '@cts/project-model';
import { crc32 } from './checksum';
import type {
  LoadedProject,
  PersistenceError,
  PersistenceErrorCode,
  ProjectBranch,
  ProjectBranchSource,
  ProjectBranchSummary,
  ProjectRepository,
  ProjectSummary,
  RecoveryReceipt,
  RemoveReceipt,
  RemoveRequest,
  RepositoryOperation,
  RepositoryResult,
  RetryPolicy,
  SaveReceipt,
  SaveRequest,
  SynchronousRecoveryCapability,
} from './contracts';

export type StorageLike = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StorageProvider = () => StorageLike | null;

export type LocalStorageRepositoryOptions = Readonly<{
  storage: StorageLike | StorageProvider | null;
  now?: () => Date;
  retainGenerations?: number;
  /** Maximum time spent waiting to acquire a cross-context commit lock. */
  lockTimeoutMs?: number;
  /** Override browser Web Locks; null deliberately selects the in-process fallback. */
  lockManager?: ProjectLockManager | null;
}>;

export type ProjectLockManager = {
  request<T>(
    name: string,
    options: Readonly<{ mode: 'exclusive'; signal?: AbortSignal }>,
    callback: () => Promise<T> | T,
  ): Promise<T>;
};

type HeadState = 'active' | 'deleted';

type Head = Readonly<{
  storageVersion: 1;
  state: HeadState;
  projectId: string;
  ordinal: number;
  generationKey: string;
  operationId: string;
  /** Absent only on heads written before committed ancestry was recorded. */
  parentHeadVersion?: string | null;
  /** Active payload CRC; absent only on legacy heads, null for tombstones. */
  payloadChecksum?: string | null;
  committedAt: string;
  checksum: string;
}>;

type ProjectGeneration = Readonly<{
  storageVersion: 1;
  kind: 'project';
  projectId: string;
  ordinal: number;
  parentHeadVersion: string | null;
  writeId: string;
  activationId: string;
  revision: number;
  savedAt: string;
  bytes: number;
  projectJson: string;
  checksum: string;
}>;

type TombstoneGeneration = Readonly<{
  storageVersion: 1;
  kind: 'tombstone';
  projectId: string;
  ordinal: number;
  parentHeadVersion: string | null;
  deleteId: string;
  deletedAt: string;
  checksum: string;
}>;

type Generation = ProjectGeneration | TombstoneGeneration;

type CommitIntent = Readonly<{
  storageVersion: 1;
  projectId: string;
  kind: Generation['kind'];
  generationKey: string;
  operationId: string;
  parentHeadVersion: string | null;
  checksum: string;
}>;

type RecoveryJournal = Readonly<{
  storageVersion: 1;
  projectId: string;
  /** Head observed by the activation that produced this emergency snapshot. */
  baseHeadKnown: boolean;
  baseHeadVersion: string | null;
  /** In-flight canonical write that this newer pending snapshot causally follows. */
  predecessorWriteId?: string;
  activationId: string;
  revision: number;
  writeId: string;
  savedAt: string;
  bytes: number;
  projectJson: string;
  checksum: string;
}>;

type DecodedGeneration = Readonly<{
  key: string;
  generation: Generation;
  project: Project | null;
}>;

type DecodedProjectBranch = Readonly<{
  summary: ProjectBranchSummary;
  project: Project;
}>;

type GenerationFailure = Readonly<{
  key: string;
  ordinal: number;
  code: PersistenceErrorCode;
  futureStorageVersion: boolean;
}>;

function stickyGenerationFailureCode(
  failures: readonly GenerationFailure[],
): 'unsupported-version' | 'migration-failed' | null {
  if (
    failures.some(
      (candidate) =>
        candidate.futureStorageVersion || candidate.code === 'unsupported-version',
    )
  ) {
    return 'unsupported-version';
  }
  return failures.some((candidate) => candidate.code === 'migration-failed')
    ? 'migration-failed'
    : null;
}

type ParsedRecord<T> =
  | Readonly<{ status: 'valid'; value: T }>
  | Readonly<{ status: 'future' }>
  | Readonly<{ status: 'migration-failed' }>
  | Readonly<{ status: 'corrupt' }>;

type FailedRepositoryResult = Readonly<{ ok: false; error: PersistenceError }>;

const STORAGE_VERSION = 1;
const NAMESPACE = 'cts.persistence.v1.project.';
const LEGACY_PREFIX = 'cts.project.';
const DEFAULT_RETAINED_GENERATIONS = 3;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const inProcessLockTails = new Map<string, Promise<void>>();

class ProjectLockUnavailableError extends Error {
  constructor() {
    super('The browser does not provide Web Locks for cross-context commits.');
    this.name = 'ProjectLockUnavailableError';
  }
}

async function withInProcessLock<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = inProcessLockTails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  inProcessLockTails.set(name, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (inProcessLockTails.get(name) === tail) inProcessLockTails.delete(name);
  }
}

function futureStorageVersion(record: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(record.storageVersion) &&
    (record.storageVersion as number) > STORAGE_VERSION
  );
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

export function projectHeadKey(id: string): string {
  return `${NAMESPACE}${encodedPart(id)}.head`;
}

export function projectIntentKey(id: string): string {
  return `${NAMESPACE}${encodedPart(id)}.intent`;
}

function recoveryPrefix(id: string): string {
  return `${NAMESPACE}${encodedPart(id)}.recovery`;
}

/** Legacy journals omit activationId; new writes are isolated per activation. */
export function projectRecoveryKey(id: string, activationId?: string): string {
  const prefix = recoveryPrefix(id);
  return activationId === undefined ? prefix : `${prefix}.${encodedPart(activationId)}`;
}

export function legacyProjectKey(id: string): string {
  return `${LEGACY_PREFIX}${id}`;
}

function generationPrefix(id: string): string {
  return `${NAMESPACE}${encodedPart(id)}.gen.`;
}

function generationKey(id: string, ordinal: number, operationId: string): string {
  return `${generationPrefix(id)}${String(ordinal).padStart(12, '0')}.${encodedPart(operationId)}`;
}

/** Exposed for diagnostics/tests; callers must not write generations directly. */
export const projectGenerationKey = generationKey;

function parseGenerationKey(key: string, projectId: string): { ordinal: number; operationId: string } | null {
  const prefix = generationPrefix(projectId);
  if (!key.startsWith(prefix)) return null;
  const remainder = key.slice(prefix.length);
  const separator = remainder.indexOf('.');
  if (separator <= 0) return null;
  const ordinal = Number(remainder.slice(0, separator));
  const operationId = decodedPart(remainder.slice(separator + 1));
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !operationId) return null;
  return { ordinal, operationId };
}

function headVersion(head: Head | null): string | null {
  return head ? `${head.ordinal}:${head.state}:${head.operationId}` : null;
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

function retryFor(code: PersistenceErrorCode): RetryPolicy {
  if (code === 'write-failed' || code === 'read-failed' || code === 'delete-failed') {
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
  if (name === 'ProjectLockUnavailableError') {
    return failure(operation, 'lock-unavailable', projectId);
  }
  return failure(operation, fallback, projectId);
}

function decodeErrorCode(code: ProjectDecodeErrorCode): PersistenceErrorCode {
  if (code === 'future-schema-version') return 'unsupported-version';
  if (code === 'migration-failed' || code === 'migration-unavailable') return 'migration-failed';
  return 'corrupt-data';
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function headChecksum(value: Omit<Head, 'checksum'>): string {
  return crc32(JSON.stringify(value));
}

function createHead(
  state: HeadState,
  projectId: string,
  ordinal: number,
  generationKeyValue: string,
  operationId: string,
  parentHeadVersion: string | null,
  payloadChecksum: string | null,
  committedAt: string,
): Head {
  const content: Omit<Head, 'checksum'> = {
    storageVersion: STORAGE_VERSION,
    state,
    projectId,
    ordinal,
    generationKey: generationKeyValue,
    operationId,
    parentHeadVersion,
    payloadChecksum,
    committedAt,
  };
  return { ...content, checksum: headChecksum(content) };
}

function parseHead(raw: string, expectedId: string): ParsedRecord<Head> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'corrupt' };
    }
    const record = value as Record<string, unknown>;
    if (futureStorageVersion(record)) return { status: 'future' };
    if (
      record.storageVersion !== STORAGE_VERSION ||
      (record.state !== 'active' && record.state !== 'deleted') ||
      record.projectId !== expectedId ||
      !Number.isSafeInteger(record.ordinal) ||
      (record.ordinal as number) < 1 ||
      typeof record.generationKey !== 'string' ||
      typeof record.operationId !== 'string' ||
      record.operationId.length === 0 ||
      (Object.prototype.hasOwnProperty.call(record, 'parentHeadVersion') &&
        record.parentHeadVersion !== null &&
        typeof record.parentHeadVersion !== 'string') ||
      (Object.prototype.hasOwnProperty.call(record, 'payloadChecksum') &&
        ((record.state === 'active' && typeof record.payloadChecksum !== 'string') ||
          (record.state === 'deleted' && record.payloadChecksum !== null))) ||
      !canonicalTimestamp(record.committedAt) ||
      typeof record.checksum !== 'string'
    ) {
      return { status: 'corrupt' };
    }
    const content: Omit<Head, 'checksum'> = {
      storageVersion: STORAGE_VERSION,
      state: record.state,
      projectId: expectedId,
      ordinal: record.ordinal as number,
      generationKey: record.generationKey,
      operationId: record.operationId,
      ...(Object.prototype.hasOwnProperty.call(record, 'parentHeadVersion')
        ? { parentHeadVersion: record.parentHeadVersion as string | null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(record, 'payloadChecksum')
        ? { payloadChecksum: record.payloadChecksum as string | null }
        : {}),
      committedAt: record.committedAt,
    };
    return record.checksum === headChecksum(content)
      ? { status: 'valid', value: { ...content, checksum: record.checksum } }
      : { status: 'corrupt' };
  } catch {
    return { status: 'corrupt' };
  }
}

function projectGenerationChecksum(value: Omit<ProjectGeneration, 'checksum'>): string {
  return crc32(JSON.stringify(value));
}

function tombstoneGenerationChecksum(value: Omit<TombstoneGeneration, 'checksum'>): string {
  return crc32(JSON.stringify(value));
}

function createProjectGeneration(
  request: SaveRequest,
  ordinal: number,
  parentHeadVersion: string | null,
  savedAt: string,
  projectJson: string,
  bytes: number,
): ProjectGeneration {
  const content: Omit<ProjectGeneration, 'checksum'> = {
    storageVersion: STORAGE_VERSION,
    kind: 'project',
    projectId: request.project.id,
    ordinal,
    parentHeadVersion,
    writeId: request.writeId,
    activationId: request.activationId,
    revision: request.revision,
    savedAt,
    bytes,
    projectJson,
  };
  return { ...content, checksum: projectGenerationChecksum(content) };
}

function createTombstoneGeneration(
  request: RemoveRequest,
  ordinal: number,
  parentHeadVersion: string | null,
  deletedAt: string,
): TombstoneGeneration {
  const content: Omit<TombstoneGeneration, 'checksum'> = {
    storageVersion: STORAGE_VERSION,
    kind: 'tombstone',
    projectId: request.projectId,
    ordinal,
    parentHeadVersion,
    deleteId: request.deleteId,
    deletedAt,
  };
  return { ...content, checksum: tombstoneGenerationChecksum(content) };
}

function generationFailure(
  key: string,
  ordinal: number,
  code: PersistenceErrorCode = 'corrupt-data',
  isFutureStorageVersion = false,
): { ok: false; failure: GenerationFailure } {
  return {
    ok: false,
    failure: { key, ordinal, code, futureStorageVersion: isFutureStorageVersion },
  };
}

function parseGeneration(
  raw: string,
  key: string,
  expectedId: string,
):
  | { ok: true; value: DecodedGeneration }
  | { ok: false; failure: GenerationFailure } {
  const keyParts = parseGenerationKey(key, expectedId);
  if (!keyParts) return generationFailure(key, 0);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return generationFailure(key, keyParts.ordinal);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return generationFailure(key, keyParts.ordinal);
  }
  const record = value as Record<string, unknown>;
  if (futureStorageVersion(record)) {
    return generationFailure(key, keyParts.ordinal, 'unsupported-version', true);
  }
  if (
    record.storageVersion !== STORAGE_VERSION ||
    record.projectId !== expectedId ||
    record.ordinal !== keyParts.ordinal ||
    (record.parentHeadVersion !== null && typeof record.parentHeadVersion !== 'string') ||
    typeof record.checksum !== 'string'
  ) {
    return generationFailure(key, keyParts.ordinal);
  }

  if (record.kind === 'project') {
    if (
      record.writeId !== keyParts.operationId ||
      typeof record.activationId !== 'string' ||
      record.activationId.length === 0 ||
      !Number.isSafeInteger(record.revision) ||
      (record.revision as number) < 0 ||
      !canonicalTimestamp(record.savedAt) ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) < 0 ||
      typeof record.projectJson !== 'string'
    ) {
      return generationFailure(key, keyParts.ordinal);
    }
    const content: Omit<ProjectGeneration, 'checksum'> = {
      storageVersion: STORAGE_VERSION,
      kind: 'project',
      projectId: expectedId,
      ordinal: keyParts.ordinal,
      parentHeadVersion: record.parentHeadVersion as string | null,
      writeId: keyParts.operationId,
      activationId: record.activationId,
      revision: record.revision as number,
      savedAt: record.savedAt,
      bytes: record.bytes as number,
      projectJson: record.projectJson,
    };
    if (
      record.checksum !== projectGenerationChecksum(content) ||
      new TextEncoder().encode(content.projectJson).byteLength !== content.bytes
    ) {
      return generationFailure(key, keyParts.ordinal);
    }
    const decoded = decodeProjectJson(content.projectJson);
    if (!decoded.ok) {
      return generationFailure(key, keyParts.ordinal, decodeErrorCode(decoded.error.code));
    }
    if (decoded.project.id !== expectedId) {
      return generationFailure(key, keyParts.ordinal);
    }
    return {
      ok: true,
      value: {
        key,
        generation: { ...content, checksum: record.checksum },
        project: decoded.project,
      },
    };
  }

  if (record.kind === 'tombstone') {
    if (
      record.deleteId !== keyParts.operationId ||
      !canonicalTimestamp(record.deletedAt)
    ) {
      return generationFailure(key, keyParts.ordinal);
    }
    const content: Omit<TombstoneGeneration, 'checksum'> = {
      storageVersion: STORAGE_VERSION,
      kind: 'tombstone',
      projectId: expectedId,
      ordinal: keyParts.ordinal,
      parentHeadVersion: record.parentHeadVersion as string | null,
      deleteId: keyParts.operationId,
      deletedAt: record.deletedAt,
    };
    if (record.checksum !== tombstoneGenerationChecksum(content)) {
      return generationFailure(key, keyParts.ordinal);
    }
    return {
      ok: true,
      value: {
        key,
        generation: { ...content, checksum: record.checksum },
        project: null,
      },
    };
  }

  return generationFailure(key, keyParts.ordinal);
}

function generationOperationId(generation: Generation): string {
  return generation.kind === 'project' ? generation.writeId : generation.deleteId;
}

function generationHeadVersion(generation: Generation): string {
  const state: HeadState = generation.kind === 'project' ? 'active' : 'deleted';
  return `${generation.ordinal}:${state}:${generationOperationId(generation)}`;
}

function generationKeyFromHeadVersion(projectId: string, version: string): string | null {
  const match = /^(\d+):(active|deleted):(.+)$/s.exec(version);
  if (!match) return null;
  const ordinal = Number(match[1]);
  const operationId = match[3];
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !operationId) return null;
  return generationKey(projectId, ordinal, operationId);
}

function generationMatchesIntent(
  candidate: DecodedGeneration,
  intent: CommitIntent,
): boolean {
  return (
    candidate.key === intent.generationKey &&
    candidate.generation.kind === intent.kind &&
    generationOperationId(candidate.generation) === intent.operationId &&
    candidate.generation.parentHeadVersion === intent.parentHeadVersion
  );
}

function projectBranchId(source: ProjectBranchSource, identity: string): string {
  const first = crc32(`cts-project-branch-v1:first\u0000${source}\u0000${identity}`).slice(6);
  const second = crc32(`cts-project-branch-v1:second\u0000${identity}\u0000${source}`).slice(6);
  return `branch-v1-${first}${second}`;
}

function intentChecksum(value: Omit<CommitIntent, 'checksum'>): string {
  return crc32(JSON.stringify(value));
}

function createIntent(generation: Generation, key: string): CommitIntent {
  const operationId = generation.kind === 'project' ? generation.writeId : generation.deleteId;
  const content: Omit<CommitIntent, 'checksum'> = {
    storageVersion: STORAGE_VERSION,
    projectId: generation.projectId,
    kind: generation.kind,
    generationKey: key,
    operationId,
    parentHeadVersion: generation.parentHeadVersion,
  };
  return { ...content, checksum: intentChecksum(content) };
}

function parseIntent(raw: string, expectedId: string): ParsedRecord<CommitIntent> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'corrupt' };
    }
    const record = value as Record<string, unknown>;
    if (futureStorageVersion(record)) return { status: 'future' };
    if (
      record.storageVersion !== STORAGE_VERSION ||
      record.projectId !== expectedId ||
      (record.kind !== 'project' && record.kind !== 'tombstone') ||
      typeof record.generationKey !== 'string' ||
      typeof record.operationId !== 'string' ||
      record.operationId.length === 0 ||
      (record.parentHeadVersion !== null && typeof record.parentHeadVersion !== 'string') ||
      typeof record.checksum !== 'string'
    ) {
      return { status: 'corrupt' };
    }
    const content: Omit<CommitIntent, 'checksum'> = {
      storageVersion: STORAGE_VERSION,
      projectId: expectedId,
      kind: record.kind,
      generationKey: record.generationKey,
      operationId: record.operationId,
      parentHeadVersion: record.parentHeadVersion as string | null,
    };
    return record.checksum === intentChecksum(content)
      ? { status: 'valid', value: { ...content, checksum: record.checksum } }
      : { status: 'corrupt' };
  } catch {
    return { status: 'corrupt' };
  }
}

function recoveryChecksum(value: Omit<RecoveryJournal, 'checksum'>): string {
  return crc32(JSON.stringify(value));
}

function createRecoveryJournal(
  request: SaveRequest,
  projectJson: string,
  bytes: number,
  savedAt: string,
): RecoveryJournal {
  const content: Omit<RecoveryJournal, 'checksum'> = {
    storageVersion: STORAGE_VERSION,
    projectId: request.project.id,
    baseHeadKnown: request.expectedHeadVersion !== undefined,
    baseHeadVersion: request.expectedHeadVersion ?? null,
    ...(request.predecessorWriteId !== undefined
      ? { predecessorWriteId: request.predecessorWriteId }
      : {}),
    activationId: request.activationId,
    revision: request.revision,
    writeId: request.writeId,
    savedAt,
    bytes,
    projectJson,
  };
  return { ...content, checksum: recoveryChecksum(content) };
}

function parseRecoveryJournal(
  raw: string,
  expectedId: string,
): ParsedRecord<{ journal: RecoveryJournal; project: Project }> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'corrupt' };
    }
    const record = value as Record<string, unknown>;
    if (futureStorageVersion(record)) return { status: 'future' };
    if (
      record.storageVersion !== STORAGE_VERSION ||
      record.projectId !== expectedId ||
      typeof record.baseHeadKnown !== 'boolean' ||
      (record.baseHeadVersion !== null && typeof record.baseHeadVersion !== 'string') ||
      (!record.baseHeadKnown && record.baseHeadVersion !== null) ||
      (record.predecessorWriteId !== undefined &&
        (typeof record.predecessorWriteId !== 'string' || record.predecessorWriteId.length === 0)) ||
      typeof record.activationId !== 'string' ||
      record.activationId.length === 0 ||
      !Number.isSafeInteger(record.revision) ||
      (record.revision as number) < 0 ||
      typeof record.writeId !== 'string' ||
      record.writeId.length === 0 ||
      !canonicalTimestamp(record.savedAt) ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) < 0 ||
      typeof record.projectJson !== 'string' ||
      typeof record.checksum !== 'string'
    ) {
      return { status: 'corrupt' };
    }
    const content: Omit<RecoveryJournal, 'checksum'> = {
      storageVersion: STORAGE_VERSION,
      projectId: expectedId,
      baseHeadKnown: record.baseHeadKnown,
      baseHeadVersion: record.baseHeadVersion as string | null,
      ...(typeof record.predecessorWriteId === 'string'
        ? { predecessorWriteId: record.predecessorWriteId }
        : {}),
      activationId: record.activationId,
      revision: record.revision as number,
      writeId: record.writeId,
      savedAt: record.savedAt,
      bytes: record.bytes as number,
      projectJson: record.projectJson,
    };
    if (
      record.checksum !== recoveryChecksum(content) ||
      new TextEncoder().encode(content.projectJson).byteLength !== content.bytes
    ) {
      return { status: 'corrupt' };
    }
    const decoded = decodeProjectJson(content.projectJson);
    if (!decoded.ok) {
      const code = decodeErrorCode(decoded.error.code);
      if (code === 'unsupported-version') return { status: 'future' };
      if (code === 'migration-failed') return { status: 'migration-failed' };
      return { status: 'corrupt' };
    }
    if (decoded.project.id !== expectedId) return { status: 'corrupt' };
    return {
      status: 'valid',
      value: {
        journal: { ...content, checksum: record.checksum },
        project: decoded.project,
      },
    };
  } catch {
    return { status: 'corrupt' };
  }
}

export class LocalStorageProjectRepository
  implements ProjectRepository, SynchronousRecoveryCapability
{
  readonly kind = 'local-storage' as const;
  private readonly provider: StorageProvider;
  private readonly now: () => Date;
  private readonly retainGenerations: number;
  private readonly lockTimeoutMs: number;
  private readonly configuredLockManager: ProjectLockManager | null | undefined;

  constructor(options: LocalStorageRepositoryOptions) {
    const storageOption = options.storage;
    this.provider =
      typeof storageOption === 'function'
        ? (storageOption as StorageProvider)
        : () => storageOption;
    this.now = options.now ?? (() => new Date());
    this.configuredLockManager = options.lockManager;
    this.lockTimeoutMs =
      Number.isFinite(options.lockTimeoutMs) && (options.lockTimeoutMs ?? 0) > 0
        ? Math.max(1, Math.floor(options.lockTimeoutMs as number))
        : DEFAULT_LOCK_TIMEOUT_MS;
    this.retainGenerations = Math.max(
      3,
      Number.isSafeInteger(options.retainGenerations)
        ? (options.retainGenerations as number)
        : DEFAULT_RETAINED_GENERATIONS,
    );
  }

  private lockManager(): ProjectLockManager | null {
    if (this.configuredLockManager !== undefined) return this.configuredLockManager;
    try {
      // The in-process mutex is sufficient only in non-browser/test runtimes.
      // Browser localStorage is shared across realms, so canonical mutations
      // must fail closed when a cross-context lock is unavailable.
      if (typeof navigator === 'undefined') return null;
      if (!navigator.locks) throw new ProjectLockUnavailableError();
      return navigator.locks as unknown as ProjectLockManager;
    } catch (error) {
      if (errorName(error) === 'ProjectLockUnavailableError') throw error;
      throw new ProjectLockUnavailableError();
    }
  }

  private async withProjectLock<T>(
    projectId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const name = `${NAMESPACE}${encodedPart(projectId)}.commit-lock`;
    const lockManager = this.lockManager();
    if (lockManager && typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = setTimeout(
        () => controller.abort(),
        this.lockTimeoutMs,
      );
      const clearLockTimeout = (): void => {
        if (timeout === null) return;
        clearTimeout(timeout);
        timeout = null;
      };
      try {
        return await lockManager.request(
          name,
          { mode: 'exclusive', signal: controller.signal },
          () => {
            // AbortSignal only governs waiting. Once granted, the synchronous
            // localStorage commit must run to completion.
            clearLockTimeout();
            return operation();
          },
        );
      } finally {
        clearLockTimeout();
      }
    }
    if (lockManager) return lockManager.request(name, { mode: 'exclusive' }, operation);
    return withInProcessLock(name, operation);
  }

  private resolveStorage(operation: RepositoryOperation, projectId?: string):
    | { ok: true; storage: StorageLike }
    | { ok: false; result: FailedRepositoryResult } {
    try {
      const storage = this.provider();
      return storage
        ? { ok: true, storage }
        : { ok: false, result: failure(operation, 'storage-unavailable', projectId) };
    } catch (error) {
      return {
        ok: false,
        result: storageFailure(operation, error, 'storage-unavailable', projectId),
      };
    }
  }

  private keys(storage: StorageLike, operation: RepositoryOperation, projectId?: string):
    | { ok: true; keys: string[] }
    | { ok: false; result: FailedRepositoryResult } {
    try {
      const keys: string[] = [];
      const length = storage.length;
      for (let index = 0; index < length; index += 1) {
        const key = storage.key(index);
        if (key !== null) keys.push(key);
      }
      return { ok: true, keys: [...new Set(keys)] };
    } catch (error) {
      return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
    }
  }

  private readHead(storage: StorageLike, projectId: string, operation: RepositoryOperation):
    | {
        ok: true;
        raw: string | null;
        status: 'missing' | ParsedRecord<Head>['status'];
        head: Head | null;
      }
    | { ok: false; result: FailedRepositoryResult } {
    try {
      const raw = storage.getItem(projectHeadKey(projectId));
      if (raw === null) return { ok: true, raw, status: 'missing', head: null };
      const parsed = parseHead(raw, projectId);
      return {
        ok: true,
        raw,
        status: parsed.status,
        head: parsed.status === 'valid' ? parsed.value : null,
      };
    } catch (error) {
      return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
    }
  }

  private readIntent(storage: StorageLike, projectId: string, operation: RepositoryOperation):
    | {
        ok: true;
        raw: string | null;
        status: 'missing' | ParsedRecord<CommitIntent>['status'];
        intent: CommitIntent | null;
      }
    | { ok: false; result: FailedRepositoryResult } {
    try {
      const raw = storage.getItem(projectIntentKey(projectId));
      if (raw === null) return { ok: true, raw, status: 'missing', intent: null };
      const parsed = parseIntent(raw, projectId);
      return {
        ok: true,
        raw,
        status: parsed.status,
        intent: parsed.status === 'valid' ? parsed.value : null,
      };
    } catch (error) {
      return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
    }
  }

  private readRecovery(storage: StorageLike, projectId: string, operation: RepositoryOperation):
    | {
        ok: true;
        raw: string | null;
        status: 'missing' | ReturnType<typeof parseRecoveryJournal>['status'];
        recovery: { key: string; journal: RecoveryJournal; project: Project } | null;
        recoveries: Array<{ key: string; journal: RecoveryJournal; project: Project }>;
        keys: string[];
      }
    | { ok: false; result: FailedRepositoryResult } {
    const listed = this.keys(storage, operation, projectId);
    if (!listed.ok) return listed;
    const prefix = recoveryPrefix(projectId);
    const keys = listed.keys.filter((key) => key === prefix || key.startsWith(`${prefix}.`));
    const recoveries: Array<{ key: string; journal: RecoveryJournal; project: Project }> = [];
    let firstRaw: string | null = null;
    let sawCorrupt = false;
    let sawFuture = false;
    let sawMigrationFailure = false;
    try {
      for (const key of keys) {
        const raw = storage.getItem(key);
        if (raw === null) {
          sawCorrupt = true;
          continue;
        }
        firstRaw ??= raw;
        const parsed = parseRecoveryJournal(raw, projectId);
        if (parsed.status === 'valid') {
          recoveries.push({ key, ...parsed.value });
        } else if (parsed.status === 'future') {
          sawFuture = true;
        } else if (parsed.status === 'migration-failed') {
          sawMigrationFailure = true;
        } else {
          sawCorrupt = true;
        }
      }
    } catch (error) {
      return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
    }
    recoveries.sort(
      (a, b) =>
        Date.parse(b.journal.savedAt) - Date.parse(a.journal.savedAt) ||
        b.journal.revision - a.journal.revision ||
        b.journal.writeId.localeCompare(a.journal.writeId),
    );
    const status = sawFuture
      ? 'future'
      : sawMigrationFailure
        ? 'migration-failed'
        : recoveries.length > 0
          ? 'valid'
          : sawCorrupt
            ? 'corrupt'
            : 'missing';
    return {
      ok: true,
      raw: firstRaw,
      status,
      recovery: recoveries[0] ?? null,
      recoveries,
      keys,
    };
  }

  private scanGenerations(storage: StorageLike, projectId: string, operation: RepositoryOperation):
    | {
        ok: true;
        keys: string[];
        valid: DecodedGeneration[];
        failures: GenerationFailure[];
        maxOrdinal: number;
      }
    | { ok: false; result: FailedRepositoryResult } {
    const listed = this.keys(storage, operation, projectId);
    if (!listed.ok) return listed;
    const keys = listed.keys.filter((key) => key.startsWith(generationPrefix(projectId)));
    const valid: DecodedGeneration[] = [];
    const failures: GenerationFailure[] = [];
    let maxOrdinal = 0;
    for (const key of keys) {
      const keyParts = parseGenerationKey(key, projectId);
      if (keyParts) maxOrdinal = Math.max(maxOrdinal, keyParts.ordinal);
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch (error) {
        return { ok: false, result: storageFailure(operation, error, 'read-failed', projectId) };
      }
      if (raw === null) {
        failures.push({
          key,
          ordinal: keyParts?.ordinal ?? 0,
          code: 'corrupt-data',
          futureStorageVersion: false,
        });
        continue;
      }
      const parsed = parseGeneration(raw, key, projectId);
      if (parsed.ok) valid.push(parsed.value);
      else failures.push(parsed.failure);
    }
    valid.sort((a, b) => b.generation.ordinal - a.generation.ordinal);
    failures.sort((a, b) => b.ordinal - a.ordinal);
    return { ok: true, keys, valid, failures, maxOrdinal };
  }

  private pointedGeneration(
    scan: Extract<ReturnType<LocalStorageProjectRepository['scanGenerations']>, { ok: true }>,
    head: Head,
  ):
    | { ok: true; generation: DecodedGeneration }
    | { ok: false; code: PersistenceErrorCode } {
    const valid = scan.valid.find((candidate) => candidate.key === head.generationKey);
    if (valid) {
      const operationId =
        valid.generation.kind === 'project'
          ? valid.generation.writeId
          : valid.generation.deleteId;
      if (
        valid.generation.ordinal === head.ordinal &&
        operationId === head.operationId &&
        valid.generation.kind === (head.state === 'active' ? 'project' : 'tombstone')
      ) {
        return { ok: true, generation: valid };
      }
      return { ok: false, code: 'corrupt-data' };
    }
    const failed = scan.failures.find((candidate) => candidate.key === head.generationKey);
    return { ok: false, code: failed?.code ?? 'corrupt-data' };
  }

  private readProjectBranches(
    storage: StorageLike,
    projectId: string,
    operation: RepositoryOperation,
  ):
    | { ok: true; branches: DecodedProjectBranch[] }
    | { ok: false; result: FailedRepositoryResult } {
    const intentRead = this.readIntent(storage, projectId, operation);
    if (!intentRead.ok) return intentRead;
    const recoveryRead = this.readRecovery(storage, projectId, operation);
    if (!recoveryRead.ok) return recoveryRead;
    const scan = this.scanGenerations(storage, projectId, operation);
    if (!scan.ok) return scan;
    const headRead = this.readHead(storage, projectId, operation);
    if (!headRead.ok) return headRead;

    // Recovery inspection must honor the same deletion privacy boundary as
    // normal load: cleanup leftovers are never a back door into deleted data.
    if (
      headRead.head?.state === 'deleted' ||
      ((headRead.status === 'missing' || headRead.status === 'corrupt') &&
        scan.valid.some((candidate) => candidate.generation.kind === 'tombstone'))
    ) {
      return { ok: true, branches: [] };
    }

    const branches: DecodedProjectBranch[] = recoveryRead.recoveries.map(
      ({ key, journal, project }) => ({
        summary: {
          branchId: projectBranchId(
            'recovery-journal',
            `${key}\u0000${journal.checksum}`,
          ),
          source: 'recovery-journal',
          activationId: journal.activationId,
          revision: journal.revision,
          writeId: journal.writeId,
          savedAt: journal.savedAt,
          title: project.title,
          updatedAt: project.updatedAt,
        },
        project,
      }),
    );

    const intent = intentRead.intent;
    const intentGeneration =
      intent?.kind === 'project'
        ? scan.valid.find((candidate) => generationMatchesIntent(candidate, intent))
        : undefined;
    if (
      intent &&
      intentGeneration?.generation.kind === 'project' &&
      intentGeneration.project
    ) {
      const generation = intentGeneration.generation;
      branches.push({
        summary: {
          branchId: projectBranchId(
            'interrupted-save',
            `${intent.checksum}\u0000${intentGeneration.key}\u0000${generation.checksum}`,
          ),
          source: 'interrupted-save',
          activationId: generation.activationId,
          revision: generation.revision,
          writeId: generation.writeId,
          savedAt: generation.savedAt,
          title: intentGeneration.project.title,
          updatedAt: intentGeneration.project.updatedAt,
        },
        project: intentGeneration.project,
      });
    }

    branches.sort(
      (a, b) =>
        Date.parse(b.summary.savedAt) - Date.parse(a.summary.savedAt) ||
        b.summary.revision - a.summary.revision ||
        a.summary.source.localeCompare(b.summary.source) ||
        a.summary.branchId.localeCompare(b.summary.branchId),
    );
    return { ok: true, branches };
  }

  private loadSync(projectId: string): RepositoryResult<LoadedProject | null> {
    const resolved = this.resolveStorage('load', projectId);
    if (!resolved.ok) return resolved.result;
    const { storage } = resolved;
    const headRead = this.readHead(storage, projectId, 'load');
    if (!headRead.ok) return headRead.result;
    const scan = this.scanGenerations(storage, projectId, 'load');
    if (!scan.ok) return scan.result;
    const intentRead = this.readIntent(storage, projectId, 'load');
    if (!intentRead.ok) return intentRead.result;
    const recoveryRead = this.readRecovery(storage, projectId, 'load');
    if (!recoveryRead.ok) return recoveryRead.result;

    // A checksummed deleted head is the authoritative privacy boundary even
    // when cleanup left auxiliary records from a newer/unknown schema.
    if (headRead.head?.state === 'deleted') return { ok: true, value: null };

    const stickyGenerationFailure = stickyGenerationFailureCode(scan.failures);
    if (
      headRead.status === 'future' ||
      intentRead.status === 'future' ||
      recoveryRead.status === 'future' ||
      stickyGenerationFailure === 'unsupported-version'
    ) {
      return failure('load', 'unsupported-version', projectId);
    }
    if (
      headRead.status === 'migration-failed' ||
      intentRead.status === 'migration-failed' ||
      recoveryRead.status === 'migration-failed' ||
      stickyGenerationFailure === 'migration-failed'
    ) {
      return failure('load', 'migration-failed', projectId);
    }
    let preflightLegacyRaw: string | null;
    try {
      preflightLegacyRaw = storage.getItem(legacyProjectKey(projectId));
    } catch (error) {
      return storageFailure('load', error, 'read-failed', projectId);
    }
    if (preflightLegacyRaw !== null) {
      const decoded = decodeProjectJson(preflightLegacyRaw);
      if (!decoded.ok) {
        const code = decodeErrorCode(decoded.error.code);
        if (code === 'unsupported-version' || code === 'migration-failed') {
          return failure('load', code, projectId);
        }
      }
    }

    type RecoveryCandidate = (typeof recoveryRead.recoveries)[number];
    const selectRecovery = (
      candidates: RecoveryCandidate[],
    ):
      | { ok: true; candidate: RecoveryCandidate | null }
      | { ok: false } => {
      const latestByActivation = new Map<string, RecoveryCandidate>();
      for (const candidate of candidates) {
        const current = latestByActivation.get(candidate.journal.activationId);
        if (
          !current ||
          candidate.journal.revision > current.journal.revision ||
          (candidate.journal.revision === current.journal.revision &&
            Date.parse(candidate.journal.savedAt) > Date.parse(current.journal.savedAt))
        ) {
          latestByActivation.set(candidate.journal.activationId, candidate);
        }
      }
      const latest = [...latestByActivation.values()];
      if (new Set(latest.map((candidate) => candidate.journal.projectJson)).size > 1) {
        return { ok: false };
      }
      latest.sort(
        (a, b) =>
          Date.parse(b.journal.savedAt) - Date.parse(a.journal.savedAt) ||
          b.journal.revision - a.journal.revision ||
          b.journal.writeId.localeCompare(a.journal.writeId),
      );
      return { ok: true, candidate: latest[0] ?? null };
    };
    const recoveryValue = (
      candidate: RecoveryCandidate | null,
      observedHeadVersion: string | null = null,
    ): LoadedProject | null =>
      candidate
        ? {
            project: candidate.project,
            headVersion: observedHeadVersion,
            source: 'generation',
            recovered: true,
            recoveryReason: 'recovery-journal',
          }
        : null;
    const interruptedCandidate = (): DecodedGeneration | null => {
      const intent = intentRead.intent;
      if (!intent || intent.kind !== 'project') return null;
      const failureAtIntent = scan.failures.find(
        (candidate) => candidate.key === intent.generationKey,
      );
      if (
        failureAtIntent?.code === 'unsupported-version' ||
        failureAtIntent?.code === 'migration-failed'
      ) {
        return null;
      }
      return scan.valid.find((candidate) => generationMatchesIntent(candidate, intent)) ?? null;
    };
    const intentTargetFailure = intentRead.intent
      ? scan.failures.find((candidate) => candidate.key === intentRead.intent?.generationKey)
      : undefined;
    if (
      intentTargetFailure?.code === 'unsupported-version' ||
      intentTargetFailure?.code === 'migration-failed'
    ) {
      return failure('load', intentTargetFailure.code, projectId);
    }
    const recoveryFollowsHead = (candidate: RecoveryCandidate, head: Head): boolean => {
      const { journal } = candidate;
      return (
        ((journal.baseHeadKnown && journal.baseHeadVersion === headVersion(head)) ||
          journal.predecessorWriteId === head.operationId)
      );
    };
    const recoveryHasMissingHeadEvidence = (recoveryCandidate: RecoveryCandidate): boolean => {
      const projectGenerations = scan.valid.filter(
        (candidate) => candidate.generation.kind === 'project',
      );
      if (projectGenerations.length === 0) {
        return (
          recoveryCandidate.journal.baseHeadKnown &&
          recoveryCandidate.journal.baseHeadVersion === null
        );
      }
      const latestOrdinal = projectGenerations[0]?.generation.ordinal;
      const latest = projectGenerations.filter(
        (candidate) => candidate.generation.ordinal === latestOrdinal,
      );
      if (latest.length !== 1) return false;
      const [latestGeneration] = latest;
      if (!latestGeneration || latestGeneration.generation.kind !== 'project') return false;
      const exactLatest =
        latestGeneration.generation.activationId === recoveryCandidate.journal.activationId &&
        latestGeneration.generation.revision === recoveryCandidate.journal.revision &&
        latestGeneration.generation.writeId === recoveryCandidate.journal.writeId &&
        latestGeneration.generation.projectJson === recoveryCandidate.journal.projectJson;
      if (exactLatest) return true;
      if (
        recoveryCandidate.journal.predecessorWriteId ===
        latestGeneration.generation.writeId
      ) {
        return true;
      }
      return (
        recoveryCandidate.journal.baseHeadKnown &&
        recoveryCandidate.journal.baseHeadVersion ===
          generationHeadVersion(latestGeneration.generation)
      );
    };
    const recoveryOutranksInterrupted = (
      candidate: RecoveryCandidate | null,
      interrupted: DecodedGeneration | null,
    ): boolean => {
      const journal = candidate?.journal;
      if (!journal) return false;
      if (!interrupted || interrupted.generation.kind !== 'project') return true;
      if (journal.activationId === interrupted.generation.activationId) {
        return journal.revision > interrupted.generation.revision;
      }
      return Date.parse(journal.savedAt) > Date.parse(interrupted.generation.savedAt);
    };
    const recoveryConflictsWithInterrupted = (
      candidate: RecoveryCandidate | null,
      interrupted: DecodedGeneration | null,
    ): boolean =>
      candidate !== null &&
      interrupted?.generation.kind === 'project' &&
      candidate.journal.activationId !== interrupted.generation.activationId &&
      candidate.journal.projectJson !== interrupted.generation.projectJson;
    const recoveredInterrupted = (
      interrupted: DecodedGeneration,
      reason: 'head-stale' | 'head-missing' | 'head-corrupt',
      observedHeadVersion: string | null = null,
    ): RepositoryResult<LoadedProject | null> => ({
      ok: true,
      value: {
        project: interrupted.project!,
        headVersion: observedHeadVersion,
        source: 'generation',
        recovered: true,
        recoveryReason: reason,
      },
    });

    if (headRead.head) {
      const pointed = this.pointedGeneration(scan, headRead.head);
      if (pointed.ok) {
        const committed = pointed.generation;
        const committedGeneration = committed.generation;
        if (!committed.project || committedGeneration.kind !== 'project') {
          return failure('load', 'corrupt-data', projectId);
        }

        const intent = intentRead.intent;
        const interrupted =
          intent?.kind === 'project' &&
          intent.parentHeadVersion === headVersion(headRead.head)
            ? interruptedCandidate()
            : null;
        const interruptedFailure = intent
          ? scan.failures.find((candidate) => candidate.key === intent.generationKey)
          : undefined;
        if (
          interruptedFailure?.code === 'unsupported-version' ||
          interruptedFailure?.code === 'migration-failed'
        ) {
          return failure('load', interruptedFailure.code, projectId);
        }
        const eligibleInterrupted =
          interrupted?.generation.kind === 'project' &&
          interrupted.project &&
          interrupted.generation.ordinal > headRead.head.ordinal
            ? interrupted
            : null;
        const observedHeadVersion = headVersion(headRead.head);
        const recoverySelection = selectRecovery(
          recoveryRead.recoveries.filter(
            (candidate) =>
              recoveryFollowsHead(candidate, headRead.head!) &&
              (candidate.journal.activationId !== committedGeneration.activationId ||
                candidate.journal.revision > committedGeneration.revision),
          ),
        );
        if (!recoverySelection.ok) return failure('load', 'conflict', projectId);
        const eligibleRecoveryRecord = recoverySelection.candidate;
        const eligibleRecovery = recoveryValue(eligibleRecoveryRecord, observedHeadVersion);
        if (recoveryConflictsWithInterrupted(eligibleRecoveryRecord, eligibleInterrupted)) {
          return failure('load', 'conflict', projectId);
        }
        if (
          eligibleInterrupted &&
          !recoveryOutranksInterrupted(eligibleRecoveryRecord, eligibleInterrupted)
        ) {
          return recoveredInterrupted(eligibleInterrupted, 'head-stale', observedHeadVersion);
        }
        if (eligibleRecovery) {
          return { ok: true, value: eligibleRecovery };
        }
        if (eligibleInterrupted) {
          return recoveredInterrupted(eligibleInterrupted, 'head-stale', observedHeadVersion);
        }

        return {
          ok: true,
          value: {
            project: committed.project,
            headVersion: headVersion(headRead.head),
            source: 'generation',
            recovered: false,
            recoveryReason: null,
          },
        };
      }

      const intent = intentRead.intent;
      const interrupted = interruptedCandidate();
      const eligibleInterrupted =
        intent?.parentHeadVersion === headVersion(headRead.head) &&
        interrupted?.project &&
        interrupted.generation.ordinal > headRead.head.ordinal
          ? interrupted
          : null;
      const observedHeadVersion = headVersion(headRead.head);
      const recoverySelection = selectRecovery(
        recoveryRead.recoveries.filter((candidate) =>
          recoveryFollowsHead(candidate, headRead.head!),
        ),
      );
      if (!recoverySelection.ok) return failure('load', 'conflict', projectId);
      const eligibleRecoveryRecord = recoverySelection.candidate;
      const eligibleRecovery = recoveryValue(eligibleRecoveryRecord, observedHeadVersion);
      if (recoveryConflictsWithInterrupted(eligibleRecoveryRecord, eligibleInterrupted)) {
        return failure('load', 'conflict', projectId);
      }
      if (
        eligibleInterrupted &&
        !recoveryOutranksInterrupted(eligibleRecoveryRecord, eligibleInterrupted)
      ) {
        return recoveredInterrupted(eligibleInterrupted, 'head-stale', observedHeadVersion);
      }
      if (eligibleRecovery) {
        return { ok: true, value: eligibleRecovery };
      }
      if (eligibleInterrupted) {
        return recoveredInterrupted(eligibleInterrupted, 'head-stale', observedHeadVersion);
      }

      // Never open an older schema when the committed head is from the future.
      if (pointed.code === 'unsupported-version' || pointed.code === 'migration-failed') {
        return failure('load', pointed.code, projectId);
      }

      // Prefer the post-commit mirror only when the checksummed head proves it
      // is the exact active payload. Legacy heads predate this binding and keep
      // their established mirror fallback behavior.
      try {
        const legacyRaw = preflightLegacyRaw;
        const mirrorMatchesHead =
          legacyRaw !== null &&
          (headRead.head.payloadChecksum === undefined ||
            (typeof headRead.head.payloadChecksum === 'string' &&
              crc32(legacyRaw) === headRead.head.payloadChecksum));
        if (legacyRaw !== null && mirrorMatchesHead) {
          const decoded = decodeProjectJson(legacyRaw);
          if (!decoded.ok) return failure('load', decodeErrorCode(decoded.error.code), projectId);
          if (decoded.project.id !== projectId) return failure('load', 'corrupt-data', projectId);
          return {
            ok: true,
            value: {
              project: decoded.project,
              headVersion: observedHeadVersion,
              source: 'legacy',
              recovered: true,
              recoveryReason: 'generation-corrupt',
            },
          };
        }
      } catch (error) {
        return storageFailure('load', error, 'read-failed', projectId);
      }

      // New heads carry the exact previous committed token. Following that
      // chain distinguishes a real backup from failed sibling generations.
      if (headRead.head.parentHeadVersion !== undefined) {
        const parentVersion = headRead.head.parentHeadVersion;
        if (parentVersion !== null) {
          const parentCandidate = scan.valid.find(
            (candidate) => generationHeadVersion(candidate.generation) === parentVersion,
          );
          if (parentCandidate?.generation.kind === 'tombstone') {
            return failure('load', 'corrupt-data', projectId);
          }
          if (parentCandidate?.generation.kind === 'project' && parentCandidate.project) {
            return {
              ok: true,
              value: {
                project: parentCandidate.project,
                headVersion: observedHeadVersion,
                source: 'generation',
                recovered: true,
                recoveryReason: 'generation-corrupt',
              },
            };
          }
          const parentKey = generationKeyFromHeadVersion(projectId, parentVersion);
          const parentFailure = parentKey
            ? scan.failures.find((candidate) => candidate.key === parentKey)
            : undefined;
          if (
            parentFailure?.code === 'unsupported-version' ||
            parentFailure?.code === 'migration-failed'
          ) {
            return failure('load', parentFailure.code, projectId);
          }
        }
      }

      return failure('load', 'corrupt-data', projectId);
    }

    // A missing/corrupt head is not permission to adopt an arbitrary high
    // ordinal. Only a checksummed intent or recovery journal can own an
    // interrupted write; a legacy mirror is explicit evidence of an older
    // committed save.
    // A tombstone can be either an interrupted delete or a committed deletion
    // whose head was later damaged. In neither case may older project bytes be
    // made visible automatically.
    if (scan.valid.some((candidate) => candidate.generation.kind === 'tombstone')) {
      return failure('load', 'corrupt-data', projectId);
    }

    let legacyRaw: string | null = null;
    let legacyProject: Project | null = null;
    let legacyErrorCode: PersistenceErrorCode | null = null;
    try {
      legacyRaw = preflightLegacyRaw;
      if (legacyRaw !== null) {
        const decoded = decodeProjectJson(legacyRaw);
        if (!decoded.ok) {
          legacyErrorCode = decodeErrorCode(decoded.error.code);
        } else if (decoded.project.id !== projectId) {
          legacyErrorCode = 'corrupt-data';
        } else {
          legacyProject = decoded.project;
        }
      }
    } catch (error) {
      return storageFailure('load', error, 'read-failed', projectId);
    }
    const evidencedGeneration =
      legacyRaw === null
        ? null
        : (scan.valid.find(
            (candidate) =>
              candidate.generation.kind === 'project' &&
              candidate.generation.projectJson === legacyRaw &&
              candidate.project !== null,
          ) ?? null);
    const evidenceVersion = evidencedGeneration
      ? generationHeadVersion(evidencedGeneration.generation)
      : null;

    const interrupted = interruptedCandidate();
    const eligibleInterrupted =
      interrupted?.generation.kind === 'project' &&
      (!evidencedGeneration ||
        (intentRead.intent?.parentHeadVersion === evidenceVersion &&
          interrupted.generation.ordinal > evidencedGeneration.generation.ordinal))
        ? interrupted
        : null;
    const recoverySelection = selectRecovery(
      recoveryRead.recoveries.filter((candidate) => {
        const { journal } = candidate;
        const followsEvidence = evidencedGeneration
          ? (journal.baseHeadKnown && journal.baseHeadVersion === evidenceVersion) ||
            (evidencedGeneration.generation.kind === 'project' &&
              journal.predecessorWriteId === evidencedGeneration.generation.writeId)
          : legacyRaw !== null
            ? legacyProject !== null && journal.projectJson === legacyRaw
            : recoveryHasMissingHeadEvidence(candidate);
        const isNewerThanEvidence =
          !evidencedGeneration ||
          evidencedGeneration.generation.kind !== 'project' ||
          journal.activationId !== evidencedGeneration.generation.activationId ||
          journal.revision > evidencedGeneration.generation.revision;
        return followsEvidence && isNewerThanEvidence;
      }),
    );
    if (!recoverySelection.ok) return failure('load', 'conflict', projectId);
    const eligibleRecoveryRecord = recoverySelection.candidate;
    const eligibleRecovery = recoveryValue(eligibleRecoveryRecord);
    if (recoveryConflictsWithInterrupted(eligibleRecoveryRecord, eligibleInterrupted)) {
      return failure('load', 'conflict', projectId);
    }
    const preferRecovery =
      eligibleRecovery !== null &&
      recoveryOutranksInterrupted(eligibleRecoveryRecord, eligibleInterrupted);
    if (preferRecovery) return { ok: true, value: eligibleRecovery };
    if (eligibleInterrupted?.generation.kind === 'project' && eligibleInterrupted.project) {
      return {
        ok: true,
        value: {
          project: eligibleInterrupted.project,
          headVersion: null,
          source: 'generation',
          recovered: true,
          recoveryReason: headRead.status === 'missing' ? 'head-missing' : 'head-corrupt',
        },
      };
    }
    if (eligibleRecovery) {
      return { ok: true, value: eligibleRecovery };
    }
    if (evidencedGeneration?.project) {
      return {
        ok: true,
        value: {
          project: evidencedGeneration.project,
          headVersion: null,
          source: 'generation',
          recovered: true,
          recoveryReason: headRead.status === 'missing' ? 'head-missing' : 'head-corrupt',
        },
      };
    }

    const hasUnrelatedKnownEmptyRecovery = recoveryRead.recoveries.some((candidate) => {
      const { journal } = candidate;
      if (!journal.baseHeadKnown || journal.baseHeadVersion !== null) return false;
      return !scan.valid.some(
        (generationCandidate) =>
          generationCandidate.generation.kind === 'project' &&
          generationCandidate.generation.activationId === journal.activationId &&
          generationCandidate.generation.revision === journal.revision &&
          generationCandidate.generation.writeId === journal.writeId &&
          generationCandidate.generation.projectJson === journal.projectJson,
      );
    });
    const hasRecoveryBasedOnNonlatestGeneration = recoveryRead.recoveries.some((candidate) => {
      if (recoveryHasMissingHeadEvidence(candidate)) return false;
      const { journal } = candidate;
      return scan.valid.some((generationCandidate) => {
        if (generationCandidate.generation.kind !== 'project') return false;
        return (
          journal.predecessorWriteId === generationCandidate.generation.writeId ||
          (journal.baseHeadKnown &&
            journal.baseHeadVersion === generationHeadVersion(generationCandidate.generation))
        );
      });
    });
    if (
      legacyProject === null &&
      (hasUnrelatedKnownEmptyRecovery || hasRecoveryBasedOnNonlatestGeneration) &&
      scan.valid.some((candidate) => candidate.generation.kind === 'project')
    ) {
      return failure('load', 'conflict', projectId);
    }

    const newestFailure = scan.failures[0];
    if (
      newestFailure &&
      (newestFailure.code === 'unsupported-version' || newestFailure.code === 'migration-failed')
    ) {
      return failure('load', newestFailure.code, projectId);
    }

    if (legacyProject) {
      return {
        ok: true,
        value: {
          project: legacyProject,
          headVersion: null,
          source: 'legacy',
          recovered: true,
          recoveryReason: 'legacy-project',
        },
      };
    }
    if (legacyErrorCode) return failure('load', legacyErrorCode, projectId);

    if (
      headRead.raw !== null ||
      intentRead.raw !== null ||
      recoveryRead.raw !== null ||
      scan.keys.length > 0
    ) {
      return failure('load', scan.failures[0]?.code ?? 'corrupt-data', projectId);
    }
    return { ok: true, value: null };
  }

  initialize(): Promise<RepositoryResult<void>> {
    const resolved = this.resolveStorage('initialize');
    return Promise.resolve(resolved.ok ? { ok: true, value: undefined } : resolved.result);
  }

  load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    return Promise.resolve(this.loadSync(id));
  }

  loadProjectBranch(
    projectId: string,
    branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>> {
    const projectState = this.loadSync(projectId);
    if (
      !projectState.ok &&
      (projectState.error.code === 'unsupported-version' ||
        projectState.error.code === 'migration-failed')
    ) {
      return Promise.resolve(projectState);
    }
    const resolved = this.resolveStorage('load', projectId);
    if (!resolved.ok) return Promise.resolve(resolved.result);
    const read = this.readProjectBranches(resolved.storage, projectId, 'load');
    if (!read.ok) return Promise.resolve(read.result);
    const matches = read.branches.filter((candidate) => candidate.summary.branchId === branchId);
    if (matches.length > 1) {
      return Promise.resolve(failure('load', 'conflict', projectId));
    }
    const match = matches[0];
    return Promise.resolve({
      ok: true,
      value: match ? { ...match.summary, project: match.project } : null,
    });
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    const resolved = this.resolveStorage('list');
    if (!resolved.ok) return Promise.resolve(resolved.result);
    const listed = this.keys(resolved.storage, 'list');
    if (!listed.ok) return Promise.resolve(listed.result);
    const ids = new Set<string>();
    for (const key of listed.keys) {
      if (key.startsWith(LEGACY_PREFIX)) {
        ids.add(key.slice(LEGACY_PREFIX.length));
        continue;
      }
      if (!key.startsWith(NAMESPACE)) continue;
      const suffix = key.slice(NAMESPACE.length);
      for (const marker of ['.head', '.intent', '.recovery', '.gen.']) {
        const markerIndex = suffix.indexOf(marker);
        if (markerIndex <= 0) continue;
        const id = decodedPart(suffix.slice(0, markerIndex));
        if (id) ids.add(id);
        break;
      }
    }

    const summaries: ProjectSummary[] = [];
    for (const id of ids) {
      const loaded = this.loadSync(id);
      const branchRead = this.readProjectBranches(resolved.storage, id, 'list');
      if (!branchRead.ok) return Promise.resolve(branchRead.result);
      const branches =
        !loaded.ok &&
        (loaded.error.code === 'unsupported-version' || loaded.error.code === 'migration-failed')
          ? []
          : branchRead.branches.map((candidate) => candidate.summary);
      if (loaded.ok) {
        if (!loaded.value) continue;
        summaries.push({
          status: 'ready',
          id,
          title: loaded.value.project.title,
          updatedAt: loaded.value.project.updatedAt,
          recovered: loaded.value.recovered,
          branches,
        });
      } else if (
        loaded.error.code === 'corrupt-data' ||
        loaded.error.code === 'unsupported-version' ||
        loaded.error.code === 'migration-failed' ||
        loaded.error.code === 'conflict'
      ) {
        summaries.push({ status: 'unreadable', id, errorCode: loaded.error.code, branches });
      } else {
        return Promise.resolve({ ok: false, error: { ...loaded.error, operation: 'list' } });
      }
    }
    summaries.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ready' ? -1 : 1;
      if (a.status === 'unreadable' || b.status === 'unreadable') return a.id.localeCompare(b.id);
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
    return Promise.resolve({ ok: true, value: summaries });
  }

  async loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    const listed = await this.list();
    if (!listed.ok) return listed;
    const ready = listed.value.find((entry) => entry.status === 'ready');
    if (ready?.status === 'ready') return this.load(ready.id);
    const unreadable = listed.value.find((entry) => entry.status === 'unreadable');
    return unreadable?.status === 'unreadable'
      ? failure('load', unreadable.errorCode, unreadable.id)
      : { ok: true, value: null };
  }

  private writeVerified(
    storage: StorageLike,
    key: string,
    raw: string,
    operation: RepositoryOperation,
    projectId: string,
  ): FailedRepositoryResult | null {
    try {
      storage.setItem(key, raw);
      return storage.getItem(key) === raw
        ? null
        : failure(operation, operation === 'remove' ? 'delete-failed' : 'write-failed', projectId);
    } catch (error) {
      return storageFailure(
        operation,
        error,
        operation === 'remove' ? 'delete-failed' : 'write-failed',
        projectId,
      );
    }
  }

  private removeIfOwnedIntent(storage: StorageLike, projectId: string, operationId: string): void {
    try {
      const raw = storage.getItem(projectIntentKey(projectId));
      const parsed = raw === null ? null : parseIntent(raw, projectId);
      if (parsed?.status === 'valid' && parsed.value.operationId === operationId) {
        storage.removeItem(projectIntentKey(projectId));
      }
    } catch {
      // A leftover intent is safe: it is checksummed and parent-version guarded.
    }
  }

  private receiptFromGeneration(
    request: SaveRequest,
    generation: ProjectGeneration,
    retainedGenerations: number,
    legacyMirrorWritten: boolean,
  ): SaveReceipt {
    return {
      projectId: generation.projectId,
      activationId: request.activationId,
      revision: request.revision,
      writeId: generation.writeId,
      headVersion: `${generation.ordinal}:active:${generation.writeId}`,
      savedAt: generation.savedAt,
      bytes: generation.bytes,
      retainedGenerations,
      legacyMirrorWritten,
    };
  }

  private mirrorLegacy(storage: StorageLike, projectId: string, json: string): boolean {
    try {
      storage.setItem(legacyProjectKey(projectId), json);
      return storage.getItem(legacyProjectKey(projectId)) === json;
    } catch {
      return false;
    }
  }

  private clearRecoveryThrough(
    storage: StorageLike,
    request: SaveRequest,
    committedProjectJson: string,
  ): void {
    try {
      const read = this.readRecovery(storage, request.project.id, 'save');
      if (!read.ok) return;
      for (const recovery of read.recoveries) {
        const sameActivationThroughRevision =
          recovery.journal.activationId === request.activationId &&
          recovery.journal.revision <= request.revision;
        const promotedExactSnapshot = recovery.journal.projectJson === committedProjectJson;
        if (sameActivationThroughRevision || promotedExactSnapshot) {
          storage.removeItem(recovery.key);
        }
      }
    } catch {
      // Keeping a verified duplicate journal is safe; bootstrap de-duplicates it.
    }
  }

  private pruneGenerations(
    storage: StorageLike,
    scan: Extract<ReturnType<LocalStorageProjectRepository['scanGenerations']>, { ok: true }>,
    committedKey: string,
  ): number {
    const keep = new Set<string>();
    let ancestor = scan.valid.find((candidate) => candidate.key === committedKey) ?? null;
    while (ancestor && keep.size < this.retainGenerations) {
      keep.add(ancestor.key);
      const parentVersion = ancestor.generation.parentHeadVersion;
      ancestor =
        parentVersion === null
          ? null
          : (scan.valid.find(
              (candidate) => generationHeadVersion(candidate.generation) === parentVersion,
            ) ?? null);
    }
    // Backward compatibility and failed-cleanup tolerance: fill any remaining
    // slots with the newest verified records, but never ahead of known ancestry.
    for (const candidate of scan.valid) {
      if (keep.size >= this.retainGenerations) break;
      keep.add(candidate.key);
    }
    for (const key of scan.keys) {
      if (keep.has(key)) continue;
      try {
        storage.removeItem(key);
      } catch {
        keep.add(key);
      }
    }
    return keep.size;
  }

  private saveSync(request: SaveRequest): RepositoryResult<SaveReceipt> {
    let projectId = '';
    try {
      projectId = typeof request.project.id === 'string' ? request.project.id : '';
    } catch {
      // canonical encoder below reports invalid-project.
    }
    if (
      !request.activationId ||
      !request.writeId ||
      (request.predecessorWriteId !== undefined && !request.predecessorWriteId) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0
    ) {
      return failure('save', 'invalid-project', projectId);
    }
    const encoded = encodeProjectJson(request.project);
    if (!encoded.ok) {
      return failure(
        'save',
        encoded.error.code === 'serialization-failed'
          ? 'serialization-failed'
          : encoded.error.code === 'too-large'
            ? 'too-large'
            : 'invalid-project',
        projectId,
      );
    }
    const resolved = this.resolveStorage('save', projectId);
    if (!resolved.ok) return resolved.result;
    const { storage } = resolved;
    const headRead = this.readHead(storage, projectId, 'save');
    if (!headRead.ok) return { ok: false, error: { ...headRead.result.error, operation: 'save' } };
    const scan = this.scanGenerations(storage, projectId, 'save');
    if (!scan.ok) return { ok: false, error: { ...scan.result.error, operation: 'save' } };
    const intentRead = this.readIntent(storage, projectId, 'save');
    if (!intentRead.ok) return { ok: false, error: { ...intentRead.result.error, operation: 'save' } };
    const recoveryRead = this.readRecovery(storage, projectId, 'save');
    if (!recoveryRead.ok) {
      return { ok: false, error: { ...recoveryRead.result.error, operation: 'save' } };
    }
    if (headRead.head?.state === 'deleted') {
      return failure('save', 'conflict', projectId);
    }
    const stickyGenerationFailure = stickyGenerationFailureCode(scan.failures);
    if (
      headRead.status === 'future' ||
      intentRead.status === 'future' ||
      recoveryRead.status === 'future' ||
      stickyGenerationFailure === 'unsupported-version'
    ) {
      return failure('save', 'unsupported-version', projectId);
    }
    if (
      headRead.status === 'migration-failed' ||
      intentRead.status === 'migration-failed' ||
      recoveryRead.status === 'migration-failed' ||
      stickyGenerationFailure === 'migration-failed'
    ) {
      return failure('save', 'migration-failed', projectId);
    }
    let legacyRaw: string | null;
    try {
      legacyRaw = storage.getItem(legacyProjectKey(projectId));
    } catch (error) {
      return storageFailure('save', error, 'read-failed', projectId);
    }
    if (legacyRaw !== null) {
      const decoded = decodeProjectJson(legacyRaw);
      if (!decoded.ok) {
        const code = decodeErrorCode(decoded.error.code);
        if (code === 'unsupported-version' || code === 'migration-failed') {
          return failure('save', code, projectId);
        }
      }
    }
    if (headRead.head) {
      const pointed = this.pointedGeneration(scan, headRead.head);
      if (
        !pointed.ok &&
        (pointed.code === 'unsupported-version' || pointed.code === 'migration-failed')
      ) {
        return failure('save', pointed.code, projectId);
      }
    }

    // A retry after the head commit but before the response/read-back is a
    // success when the stable writeId and payload metadata match exactly.
    if (headRead.head?.state === 'active' && headRead.head.operationId === request.writeId) {
      const pointed = this.pointedGeneration(scan, headRead.head);
      if (
        pointed.ok &&
        pointed.generation.generation.kind === 'project' &&
        pointed.generation.generation.projectJson === encoded.json &&
        pointed.generation.generation.activationId === request.activationId &&
        pointed.generation.generation.revision === request.revision
      ) {
        this.removeIfOwnedIntent(storage, projectId, request.writeId);
        this.clearRecoveryThrough(storage, request, encoded.json);
        const mirrored = this.mirrorLegacy(storage, projectId, encoded.json);
        return {
          ok: true,
          value: this.receiptFromGeneration(
            request,
            pointed.generation.generation,
            Math.min(scan.valid.length, this.retainGenerations),
            mirrored,
          ),
        };
      }
      return failure('save', 'conflict', projectId);
    }

    const currentVersion = headVersion(headRead.head);
    const headNeedsRepair = headRead.status === 'missing' || headRead.status === 'corrupt';
    // A missing/corrupt pointer cannot prove whether the tombstone or an older
    // project generation was canonical, so an unconditional save must not turn
    // ambiguous durable deletion evidence into a resurrection.
    if (
      headNeedsRepair &&
      scan.valid.some((candidate) => candidate.generation.kind === 'tombstone')
    ) {
      return failure('save', 'conflict', projectId);
    }
    // A retry may observe the exact immutable generation written by its own
    // earlier attempt before that attempt managed to publish the head. Validate
    // that identity before the known-empty CAS check so the retry can finish
    // without treating its own bytes as a competing project.
    const existing = scan.valid.find(
      (candidate) =>
        candidate.generation.kind === 'project' &&
        candidate.generation.writeId === request.writeId,
    );
    if (existing) {
      const generation = existing.generation;
      if (
        generation.kind !== 'project' ||
        generation.projectJson !== encoded.json ||
        generation.activationId !== request.activationId ||
        generation.revision !== request.revision ||
        generation.parentHeadVersion !== currentVersion
      ) {
        return failure('save', 'conflict', projectId);
      }
    }
    if (request.expectedHeadVersion === null) {
      const ownedEmptyIntent =
        intentRead.intent?.kind === 'project' &&
        intentRead.intent.operationId === request.writeId &&
        intentRead.intent.parentHeadVersion === null;
      const onlyOwnedGeneration =
        existing !== undefined &&
        scan.keys.length === 1 &&
        scan.valid.length === 1 &&
        scan.failures.length === 0 &&
        scan.valid[0]?.key === existing.key &&
        intentRead.intent !== null &&
        generationMatchesIntent(existing, intentRead.intent);
      const knownEmpty =
        headRead.raw === null &&
        ((scan.keys.length === 0 && (intentRead.raw === null || ownedEmptyIntent)) ||
          onlyOwnedGeneration) &&
        legacyRaw === null;
      if (!knownEmpty) {
        const observed = this.loadSync(projectId);
        if (
          !observed.ok &&
          observed.error.code !== 'corrupt-data' &&
          observed.error.code !== 'conflict'
        ) {
          return { ok: false, error: { ...observed.error, operation: 'save' } };
        }
        return failure('save', 'conflict', projectId);
      }
    } else if (request.expectedHeadVersion === undefined) {
      if (!headNeedsRepair) return failure('save', 'conflict', projectId);
      const observed = this.loadSync(projectId);
      if (!observed.ok) {
        return { ok: false, error: { ...observed.error, operation: 'save' } };
      }
      if (observed.value === null) return failure('save', 'conflict', projectId);
    } else if (request.expectedHeadVersion !== currentVersion) {
      return failure('save', 'conflict', projectId);
    }

    const ordinal = existing?.generation.ordinal ?? Math.max(scan.maxOrdinal, headRead.head?.ordinal ?? 0) + 1;
    const savedAt = existing?.generation.kind === 'project'
      ? existing.generation.savedAt
      : this.now().toISOString();
    const generation =
      existing?.generation.kind === 'project'
        ? existing.generation
        : createProjectGeneration(
            request,
            ordinal,
            currentVersion,
            savedAt,
            encoded.json,
            encoded.bytes,
          );
    const genKey = existing?.key ?? generationKey(projectId, ordinal, request.writeId);
    const intent = createIntent(generation, genKey);
    const intentRaw = JSON.stringify(intent);
    const intentFailure = this.writeVerified(
      storage,
      projectIntentKey(projectId),
      intentRaw,
      'save',
      projectId,
    );
    if (intentFailure) return intentFailure;

    if (!existing) {
      const generationFailure = this.writeVerified(
        storage,
        genKey,
        JSON.stringify(generation),
        'save',
        projectId,
      );
      if (generationFailure) return generationFailure;
      const verified = parseGeneration(JSON.stringify(generation), genKey, projectId);
      if (!verified.ok) return failure('save', 'write-failed', projectId);
    }

    const currentHead = this.readHead(storage, projectId, 'save');
    if (!currentHead.ok) return { ok: false, error: { ...currentHead.result.error, operation: 'save' } };
    const currentIntent = this.readIntent(storage, projectId, 'save');
    if (!currentIntent.ok) return { ok: false, error: { ...currentIntent.result.error, operation: 'save' } };
    if (currentHead.status === 'future' || currentIntent.status === 'future') {
      return failure('save', 'unsupported-version', projectId);
    }
    if (
      headVersion(currentHead.head) !== currentVersion ||
      currentIntent.intent?.kind !== 'project' ||
      currentIntent.intent.operationId !== request.writeId ||
      currentIntent.intent.generationKey !== genKey ||
      currentIntent.intent.parentHeadVersion !== currentVersion
    ) {
      this.removeIfOwnedIntent(storage, projectId, request.writeId);
      return failure('save', 'conflict', projectId);
    }

    const nextHead = createHead(
      'active',
      projectId,
      ordinal,
      genKey,
      request.writeId,
      currentVersion,
      crc32(encoded.json),
      generation.savedAt,
    );
    const headFailure = this.writeVerified(
      storage,
      projectHeadKey(projectId),
      JSON.stringify(nextHead),
      'save',
      projectId,
    );
    if (headFailure) return headFailure;
    this.removeIfOwnedIntent(storage, projectId, request.writeId);
    this.clearRecoveryThrough(storage, request, encoded.json);
    const legacyMirrorWritten = this.mirrorLegacy(storage, projectId, encoded.json);
    const refreshed = this.scanGenerations(storage, projectId, 'save');
    const retainedGenerations = refreshed.ok
      ? this.pruneGenerations(storage, refreshed, genKey)
      : this.retainGenerations;
    return {
      ok: true,
      value: this.receiptFromGeneration(
        request,
        generation,
        retainedGenerations,
        legacyMirrorWritten,
      ),
    };
  }

  async save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    let projectId: string | undefined;
    try {
      projectId = request.project.id;
      return await this.withProjectLock(projectId, () => this.saveSync(request));
    } catch (error) {
      return storageFailure('save', error, 'write-failed', projectId);
    }
  }

  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt> {
    const projectId = (() => {
      try {
        return typeof request.project.id === 'string' ? request.project.id : '';
      } catch {
        return '';
      }
    })();
    if (
      !request.activationId ||
      !request.writeId ||
      (request.predecessorWriteId !== undefined && !request.predecessorWriteId) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0
    ) {
      return failure('save', 'invalid-project', projectId);
    }
    const encoded = encodeProjectJson(request.project);
    if (!encoded.ok) {
      return failure(
        'save',
        encoded.error.code === 'serialization-failed'
          ? 'serialization-failed'
          : encoded.error.code === 'too-large'
            ? 'too-large'
            : 'invalid-project',
        projectId,
      );
    }
    const resolved = this.resolveStorage('save', projectId);
    if (!resolved.ok) return resolved.result;
    const { storage } = resolved;
    const headRead = this.readHead(storage, projectId, 'save');
    if (!headRead.ok) return headRead.result;
    const scan = this.scanGenerations(storage, projectId, 'save');
    if (!scan.ok) return scan.result;
    const intentRead = this.readIntent(storage, projectId, 'save');
    if (!intentRead.ok) return intentRead.result;
    const existing = this.readRecovery(storage, projectId, 'save');
    if (!existing.ok) return existing.result;
    if (headRead.head?.state === 'deleted') {
      return failure('save', 'conflict', projectId);
    }
    const stickyGenerationFailure = stickyGenerationFailureCode(scan.failures);
    if (
      headRead.status === 'future' ||
      intentRead.status === 'future' ||
      existing.status === 'future' ||
      stickyGenerationFailure === 'unsupported-version'
    ) {
      return failure('save', 'unsupported-version', projectId);
    }
    if (
      headRead.status === 'migration-failed' ||
      intentRead.status === 'migration-failed' ||
      existing.status === 'migration-failed' ||
      stickyGenerationFailure === 'migration-failed'
    ) {
      return failure('save', 'migration-failed', projectId);
    }
    let legacyRaw: string | null;
    try {
      legacyRaw = storage.getItem(legacyProjectKey(projectId));
    } catch (error) {
      return storageFailure('save', error, 'read-failed', projectId);
    }
    if (legacyRaw !== null) {
      const decoded = decodeProjectJson(legacyRaw);
      if (!decoded.ok) {
        const code = decodeErrorCode(decoded.error.code);
        if (code === 'unsupported-version' || code === 'migration-failed') {
          return failure('save', code, projectId);
        }
      }
    }
    if (
      (headRead.status === 'missing' || headRead.status === 'corrupt') &&
      scan.valid.some((candidate) => candidate.generation.kind === 'tombstone')
    ) {
      return failure('save', 'conflict', projectId);
    }
    const existingForActivation = existing.recoveries.find(
      (candidate) => candidate.journal.activationId === request.activationId,
    );
    if (existingForActivation && existingForActivation.journal.revision > request.revision) {
      return failure('save', 'conflict', projectId);
    }
    if (existingForActivation?.journal.revision === request.revision) {
      const journal = existingForActivation.journal;
      if (
        journal.writeId !== request.writeId ||
        journal.projectJson !== encoded.json ||
        journal.baseHeadKnown !== (request.expectedHeadVersion !== undefined) ||
        journal.baseHeadVersion !== (request.expectedHeadVersion ?? null) ||
        journal.predecessorWriteId !== request.predecessorWriteId
      ) {
        return failure('save', 'conflict', projectId);
      }
      return {
        ok: true,
        value: {
          projectId,
          activationId: journal.activationId,
          revision: journal.revision,
          writeId: journal.writeId,
          savedAt: journal.savedAt,
          bytes: journal.bytes,
        },
      };
    }
    const savedAt = this.now().toISOString();
    const journal = createRecoveryJournal(
      request,
      encoded.json,
      encoded.bytes,
      savedAt,
    );
    const writeFailure = this.writeVerified(
      storage,
      projectRecoveryKey(projectId, request.activationId),
      JSON.stringify(journal),
      'save',
      projectId,
    );
    if (writeFailure) return writeFailure;
    const verified = parseRecoveryJournal(JSON.stringify(journal), projectId);
    if (verified.status !== 'valid') return failure('save', 'write-failed', projectId);
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

  private cleanupDeletedProject(
    storage: StorageLike,
    projectId: string,
    tombstoneKey: string,
  ): boolean {
    const scan = this.scanGenerations(storage, projectId, 'remove');
    let complete = scan.ok;
    if (scan.ok) {
      for (const key of scan.keys) {
        if (key === tombstoneKey) continue;
        try {
          const raw = storage.getItem(key);
          if (raw !== null) {
            const parsed = parseGeneration(raw, key, projectId);
            if (
              !parsed.ok &&
              (parsed.failure.futureStorageVersion ||
                parsed.failure.code === 'unsupported-version' ||
                parsed.failure.code === 'migration-failed')
            ) {
              // A verified deleted head controls visibility, but an older app
              // must retain records that only a newer decoder can understand.
              complete = false;
              continue;
            }
          }
          storage.removeItem(key);
        } catch {
          complete = false;
        }
      }
    }
    const listed = this.keys(storage, 'remove', projectId);
    if (!listed.ok) complete = false;
    const recoveryKeys = listed.ok
      ? listed.keys.filter(
          (key) => key === recoveryPrefix(projectId) || key.startsWith(`${recoveryPrefix(projectId)}.`),
        )
      : [];
    const legacyKey = legacyProjectKey(projectId);
    const intentKey = projectIntentKey(projectId);
    for (const key of [legacyKey, intentKey, ...recoveryKeys]) {
      try {
        const raw = storage.getItem(key);
        if (raw === null) continue;
        const preserve =
          key === legacyKey
            ? (() => {
                const decoded = decodeProjectJson(raw);
                if (decoded.ok) return false;
                const code = decodeErrorCode(decoded.error.code);
                return code === 'unsupported-version' || code === 'migration-failed';
              })()
            : key === intentKey
              ? (() => {
                  const status = parseIntent(raw, projectId).status;
                  return status === 'future' || status === 'migration-failed';
                })()
              : (() => {
                  const status = parseRecoveryJournal(raw, projectId).status;
                  return status === 'future' || status === 'migration-failed';
                })();
        if (preserve) {
          complete = false;
          continue;
        }
        storage.removeItem(key);
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private removeSync(request: RemoveRequest): RepositoryResult<RemoveReceipt> {
    const { projectId } = request;
    if (!request.deleteId) return failure('remove', 'delete-failed', projectId);
    const resolved = this.resolveStorage('remove', projectId);
    if (!resolved.ok) return resolved.result;
    const { storage } = resolved;
    const headRead = this.readHead(storage, projectId, 'remove');
    if (!headRead.ok) {
      return { ok: false, error: { ...headRead.result.error, operation: 'remove' } };
    }
    const scan = this.scanGenerations(storage, projectId, 'remove');
    if (!scan.ok) {
      return { ok: false, error: { ...scan.result.error, operation: 'remove' } };
    }
    const intentRead = this.readIntent(storage, projectId, 'remove');
    if (!intentRead.ok) return intentRead.result;
    const recoveryRead = this.readRecovery(storage, projectId, 'remove');
    if (!recoveryRead.ok) return recoveryRead.result;
    if (headRead.head?.state === 'deleted') {
      if (headRead.head.operationId !== request.deleteId) {
        return failure('remove', 'conflict', projectId);
      }
      const pointed = this.pointedGeneration(scan, headRead.head);
      const verifiedTombstoneKey =
        pointed.ok && pointed.generation.generation.kind === 'tombstone'
          ? pointed.generation.key
          : null;
      const cleanupComplete = this.cleanupDeletedProject(
        storage,
        projectId,
        verifiedTombstoneKey ?? '',
      );
      return {
        ok: true,
        value: {
          projectId,
          deleteId: request.deleteId,
          headVersion: headVersion(headRead.head) ?? '',
          removed: true,
          cleanupComplete,
        },
      };
    }
    const stickyGenerationFailure = stickyGenerationFailureCode(scan.failures);
    if (
      headRead.status === 'future' ||
      intentRead.status === 'future' ||
      recoveryRead.status === 'future' ||
      stickyGenerationFailure === 'unsupported-version'
    ) {
      return failure('remove', 'unsupported-version', projectId);
    }
    if (
      headRead.status === 'migration-failed' ||
      intentRead.status === 'migration-failed' ||
      recoveryRead.status === 'migration-failed' ||
      stickyGenerationFailure === 'migration-failed'
    ) {
      return failure('remove', 'migration-failed', projectId);
    }

    const currentVersion = headVersion(headRead.head);
    const headNeedsRepair = headRead.status === 'missing' || headRead.status === 'corrupt';
    const existing = scan.valid.find(
      (candidate) =>
        candidate.generation.kind === 'tombstone' &&
        candidate.generation.deleteId === request.deleteId,
    );
    if (existing && existing.generation.parentHeadVersion !== currentVersion) {
      return failure('remove', 'conflict', projectId);
    }
    let legacyRaw: string | null;
    try {
      legacyRaw = storage.getItem(legacyProjectKey(projectId));
    } catch (error) {
      return storageFailure('remove', error, 'read-failed', projectId);
    }
    if (legacyRaw !== null) {
      const decoded = decodeProjectJson(legacyRaw);
      if (!decoded.ok) {
        const code = decodeErrorCode(decoded.error.code);
        if (code === 'unsupported-version' || code === 'migration-failed') {
          return failure('remove', code, projectId);
        }
      }
    }
    if (request.expectedHeadVersion === null) {
      const ownedEmptyIntent =
        intentRead.intent?.kind === 'tombstone' &&
        intentRead.intent.operationId === request.deleteId &&
        intentRead.intent.parentHeadVersion === null;
      const onlyOwnedTombstone =
        existing !== undefined &&
        scan.keys.length === 1 &&
        scan.valid.length === 1 &&
        scan.failures.length === 0 &&
        scan.valid[0]?.key === existing.key &&
        intentRead.intent !== null &&
        generationMatchesIntent(existing, intentRead.intent);
      const knownEmpty =
        headRead.raw === null &&
        ((scan.keys.length === 0 && (intentRead.raw === null || ownedEmptyIntent)) ||
          onlyOwnedTombstone) &&
        legacyRaw === null;
      if (!knownEmpty) {
        const observed = this.loadSync(projectId);
        if (
          !observed.ok &&
          observed.error.code !== 'corrupt-data' &&
          observed.error.code !== 'conflict'
        ) {
          return { ok: false, error: { ...observed.error, operation: 'remove' } };
        }
        return failure('remove', 'conflict', projectId);
      }
    } else if (request.expectedHeadVersion === undefined) {
      if (!headNeedsRepair) return failure('remove', 'conflict', projectId);
      if (
        existing &&
        existing.generation.parentHeadVersion === null &&
        intentRead.intent !== null &&
        generationMatchesIntent(existing, intentRead.intent) &&
        legacyRaw === null
      ) {
        return failure('remove', 'conflict', projectId);
      }
      const hasTombstone = scan.valid.some(
        (candidate) => candidate.generation.kind === 'tombstone',
      );
      if (!hasTombstone) {
        const observed = this.loadSync(projectId);
        if (!observed.ok) {
          if (
            observed.error.code !== 'corrupt-data' &&
            observed.error.code !== 'conflict'
          ) {
            return { ok: false, error: { ...observed.error, operation: 'remove' } };
          }
        } else if (observed.value === null) {
          return failure('remove', 'conflict', projectId);
        }
      }
    } else if (request.expectedHeadVersion !== currentVersion) {
      return failure('remove', 'conflict', projectId);
    }
    const ordinal =
      existing?.generation.ordinal ?? Math.max(scan.maxOrdinal, headRead.head?.ordinal ?? 0) + 1;
    const deletedAt =
      existing?.generation.kind === 'tombstone'
        ? existing.generation.deletedAt
        : this.now().toISOString();
    const tombstone =
      existing?.generation.kind === 'tombstone'
        ? existing.generation
        : createTombstoneGeneration(request, ordinal, currentVersion, deletedAt);
    const tombstoneKey = existing?.key ?? generationKey(projectId, ordinal, request.deleteId);
    const intent = createIntent(tombstone, tombstoneKey);
    const intentFailure = this.writeVerified(
      storage,
      projectIntentKey(projectId),
      JSON.stringify(intent),
      'remove',
      projectId,
    );
    if (intentFailure) return intentFailure;
    if (!existing) {
      const generationFailure = this.writeVerified(
        storage,
        tombstoneKey,
        JSON.stringify(tombstone),
        'remove',
        projectId,
      );
      if (generationFailure) return generationFailure;
    }

    const currentHead = this.readHead(storage, projectId, 'remove');
    const currentIntent = this.readIntent(storage, projectId, 'remove');
    if (!currentHead.ok) return currentHead.result;
    if (!currentIntent.ok) return currentIntent.result;
    if (currentHead.status === 'future' || currentIntent.status === 'future') {
      return failure('remove', 'unsupported-version', projectId);
    }
    if (
      headVersion(currentHead.head) !== currentVersion ||
      currentIntent.intent?.kind !== 'tombstone' ||
      currentIntent.intent.operationId !== request.deleteId ||
      currentIntent.intent.generationKey !== tombstoneKey ||
      currentIntent.intent.parentHeadVersion !== currentVersion
    ) {
      this.removeIfOwnedIntent(storage, projectId, request.deleteId);
      return failure('remove', 'conflict', projectId);
    }

    const deletedHead = createHead(
      'deleted',
      projectId,
      ordinal,
      tombstoneKey,
      request.deleteId,
      currentVersion,
      null,
      deletedAt,
    );
    const headFailure = this.writeVerified(
      storage,
      projectHeadKey(projectId),
      JSON.stringify(deletedHead),
      'remove',
      projectId,
    );
    if (headFailure) return headFailure;
    this.removeIfOwnedIntent(storage, projectId, request.deleteId);
    const cleanupComplete = this.cleanupDeletedProject(storage, projectId, tombstoneKey);
    return {
      ok: true,
      value: {
        projectId,
        deleteId: request.deleteId,
        headVersion: headVersion(deletedHead) ?? '',
        removed: headRead.raw !== null || scan.keys.length > 0,
        cleanupComplete,
      },
    };
  }

  async remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    try {
      return await this.withProjectLock(request.projectId, () => this.removeSync(request));
    } catch (error) {
      return storageFailure('remove', error, 'delete-failed', request.projectId);
    }
  }

  close(): Promise<RepositoryResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}
