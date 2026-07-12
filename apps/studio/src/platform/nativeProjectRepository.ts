import {
  decodeProjectJson,
  encodeProjectJson,
  type ProjectDecodeErrorCode,
} from '@cts/project-model';
import type {
  CrashDraftReceipt,
  LoadedProject,
  DurableProjectState,
  PersistenceError,
  PersistenceErrorCode,
  ProjectBranch,
  ProjectBranchSource,
  ProjectBranchSummary,
  ProjectRecoveryReason,
  ProjectRepository,
  ProjectSummary,
  RemoveReceipt,
  RemoveRequest,
  RepositoryOperation,
  RepositoryResult,
  RetryPolicy,
  SaveReceipt,
  SaveRequest,
} from '@cts/project-persistence';
import {
  PERSISTENCE_COMMANDS,
  type PersistenceCommand,
  type TauriBridge,
  type TauriInvokeArguments,
} from './tauriBridge';

type UnknownRecord = Record<string, unknown>;

type DecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code?: PersistenceErrorCode; retry?: RetryPolicy }>;

export type NativeExpectedHead =
  | Readonly<{ kind: 'repair' }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'match'; version: string }>;

export type NativeSaveRequest = Readonly<{
  projectId: string;
  projectJson: string;
  activationId: string;
  revision: number;
  writeId: string;
  expectedHead: NativeExpectedHead;
  predecessorWriteId?: string;
}>;

export type NativeRemoveRequest = Readonly<{
  projectId: string;
  deleteId: string;
  expectedHead: NativeExpectedHead;
}>;

const MAX_WIRE_ITEMS = 100_000;
const MAX_WIRE_STRING_LENGTH = 4_096;
const MAX_WIRE_TOKEN_LENGTH = 8_192;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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

const RETRY_POLICIES = new Set<RetryPolicy>(['automatic', 'manual', 'never']);
const BRANCH_SOURCES = new Set<ProjectBranchSource>([
  'recovery-journal',
  'interrupted-save',
  'legacy-migration',
]);
const RECOVERY_REASONS = new Set<ProjectRecoveryReason>([
  'head-missing',
  'head-corrupt',
  'head-stale',
  'generation-corrupt',
  'legacy-project',
  'recovery-journal',
  'interrupted-save',
]);
const UNREADABLE_CODES = new Set([
  'corrupt-data',
  'unsupported-version',
  'migration-failed',
  'conflict',
] as const);

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isString(value: unknown, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_WIRE_STRING_LENGTH &&
    (allowEmpty || value.length > 0)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOpaqueToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WIRE_TOKEN_LENGTH
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    RFC3339_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function decodeProjectFailure(code: ProjectDecodeErrorCode): DecodeResult<never> {
  if (code === 'future-schema-version') {
    return { ok: false, code: 'unsupported-version', retry: 'never' };
  }
  if (code === 'migration-failed' || code === 'migration-unavailable') {
    return { ok: false, code: 'migration-failed', retry: 'never' };
  }
  if (code === 'too-large') {
    return { ok: false, code: 'too-large', retry: 'never' };
  }
  return { ok: false, code: 'corrupt-data', retry: 'never' };
}

function defaultFailureCode(operation: RepositoryOperation): PersistenceErrorCode {
  if (operation === 'initialize') return 'storage-unavailable';
  if (operation === 'list' || operation === 'load') return 'read-failed';
  if (operation === 'remove') return 'delete-failed';
  return 'write-failed';
}

function defaultRetry(operation: RepositoryOperation): RetryPolicy {
  return operation === 'initialize' ? 'manual' : 'automatic';
}

function failure<T>(
  operation: RepositoryOperation,
  code: PersistenceErrorCode,
  retry: RetryPolicy,
  projectId?: string,
): RepositoryResult<T> {
  return {
    ok: false,
    error: {
      operation,
      code,
      retry,
      ...(projectId !== undefined ? { projectId } : {}),
    },
  };
}

function malformedFailure<T>(
  operation: RepositoryOperation,
  projectId?: string,
  decoded?: Extract<DecodeResult<never>, { ok: false }>,
): RepositoryResult<T> {
  return failure(
    operation,
    decoded?.code ?? defaultFailureCode(operation),
    decoded?.retry ?? defaultRetry(operation),
    projectId,
  );
}

function decodeStructuredError(
  value: unknown,
  operation: RepositoryOperation,
  expectedProjectId?: string,
): PersistenceError | null {
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, ['code', 'retry', 'projectId']) ||
    !ERROR_CODES.has(candidate.code as PersistenceErrorCode) ||
    !RETRY_POLICIES.has(candidate.retry as RetryPolicy)
  ) {
    return null;
  }
  const projectId = candidate.projectId;
  if (
    projectId !== undefined &&
    (!isString(projectId, false) ||
      (expectedProjectId !== undefined && projectId !== expectedProjectId))
  ) {
    return null;
  }
  return {
    operation,
    code: candidate.code as PersistenceErrorCode,
    retry: candidate.retry as RetryPolicy,
    ...(typeof projectId === 'string' ? { projectId } : {}),
  };
}

function decodeDurableProjectState(value: unknown): DecodeResult<DurableProjectState> {
  const candidate = record(value);
  return candidate &&
    hasOnlyKeys(candidate, ['state']) &&
    (candidate.state === 'missing' ||
      candidate.state === 'active' ||
      candidate.state === 'deleted' ||
      candidate.state === 'unreadable')
    ? { ok: true, value: candidate.state }
    : { ok: false, code: 'read-failed', retry: 'automatic' };
}

function decodeBranchSummary(value: unknown): DecodeResult<ProjectBranchSummary> {
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, [
      'branchId',
      'source',
      'activationId',
      'revision',
      'writeId',
      'savedAt',
      'title',
      'updatedAt',
    ]) ||
    !isString(candidate.branchId, false) ||
    !BRANCH_SOURCES.has(candidate.source as ProjectBranchSource) ||
    !isString(candidate.activationId, false) ||
    !isNonNegativeInteger(candidate.revision) ||
    !isString(candidate.writeId, false) ||
    !isTimestamp(candidate.savedAt) ||
    !isString(candidate.title) ||
    !isTimestamp(candidate.updatedAt)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      branchId: candidate.branchId,
      source: candidate.source as ProjectBranchSource,
      activationId: candidate.activationId,
      revision: candidate.revision,
      writeId: candidate.writeId,
      savedAt: candidate.savedAt,
      title: candidate.title,
      updatedAt: candidate.updatedAt,
    },
  };
}

function decodeBranches(value: unknown): DecodeResult<ProjectSummary['branches']> {
  if (!Array.isArray(value) || value.length > MAX_WIRE_ITEMS) return { ok: false };
  const branches: ProjectBranchSummary[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const decoded = decodeBranchSummary(item);
    if (!decoded.ok || ids.has(decoded.value.branchId)) return { ok: false };
    ids.add(decoded.value.branchId);
    branches.push(decoded.value);
  }
  return { ok: true, value: branches };
}

function decodeSummary(value: unknown): DecodeResult<ProjectSummary> {
  const candidate = record(value);
  if (!candidate || typeof candidate.status !== 'string') return { ok: false };
  const branches = decodeBranches(candidate.branches);
  if (!branches.ok || !isString(candidate.id, false)) return { ok: false };

  if (candidate.status === 'ready') {
    if (
      !hasOnlyKeys(candidate, [
        'status',
        'id',
        'title',
        'updatedAt',
        'recovered',
        'branches',
      ]) ||
      !isString(candidate.title) ||
      !isTimestamp(candidate.updatedAt) ||
      typeof candidate.recovered !== 'boolean'
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      value: {
        status: 'ready',
        id: candidate.id,
        title: candidate.title,
        updatedAt: candidate.updatedAt,
        recovered: candidate.recovered,
        branches: branches.value,
      },
    };
  }

  if (
    candidate.status !== 'unreadable' ||
    !hasOnlyKeys(candidate, ['status', 'id', 'errorCode', 'branches']) ||
    !UNREADABLE_CODES.has(
      candidate.errorCode as 'corrupt-data' | 'unsupported-version' | 'migration-failed' | 'conflict',
    )
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      status: 'unreadable',
      id: candidate.id,
      errorCode: candidate.errorCode as
        | 'corrupt-data'
        | 'unsupported-version'
        | 'migration-failed'
        | 'conflict',
      branches: branches.value,
    },
  };
}

function decodeSummaryList(value: unknown): DecodeResult<readonly ProjectSummary[]> {
  if (!Array.isArray(value) || value.length > MAX_WIRE_ITEMS) return { ok: false };
  const summaries: ProjectSummary[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const decoded = decodeSummary(item);
    if (!decoded.ok || ids.has(decoded.value.id)) return { ok: false };
    ids.add(decoded.value.id);
    summaries.push(decoded.value);
  }
  return { ok: true, value: summaries };
}

function decodeLoadedProject(
  value: unknown,
  expectedProjectId?: string,
): DecodeResult<LoadedProject | null> {
  if (value === null) return { ok: true, value: null };
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, [
      'projectJson',
      'headVersion',
      'source',
      'recovered',
      'recoveryReason',
    ]) ||
    typeof candidate.projectJson !== 'string' ||
    !(
      candidate.headVersion === null ||
      isOpaqueToken(candidate.headVersion)
    ) ||
    (candidate.source !== 'generation' && candidate.source !== 'legacy') ||
    typeof candidate.recovered !== 'boolean' ||
    !(
      candidate.recoveryReason === null ||
      RECOVERY_REASONS.has(candidate.recoveryReason as ProjectRecoveryReason)
    ) ||
    (candidate.recovered
      ? candidate.recoveryReason === null
      : candidate.recoveryReason !== null)
  ) {
    return { ok: false };
  }

  const decoded = decodeProjectJson(candidate.projectJson);
  if (!decoded.ok) return decodeProjectFailure(decoded.error.code);
  if (expectedProjectId !== undefined && decoded.project.id !== expectedProjectId) {
    return { ok: false, code: 'corrupt-data', retry: 'never' };
  }
  return {
    ok: true,
    value: {
      project: decoded.project,
      headVersion: candidate.headVersion,
      source: candidate.source,
      recovered: candidate.recovered,
      recoveryReason: candidate.recoveryReason as ProjectRecoveryReason | null,
    },
  };
}

function decodeProjectBranch(
  value: unknown,
  expectedProjectId: string,
  expectedBranchId: string,
): DecodeResult<ProjectBranch | null> {
  if (value === null) return { ok: true, value: null };
  const candidate = record(value);
  if (!candidate || !hasOwn(candidate, 'projectJson') || typeof candidate.projectJson !== 'string') {
    return { ok: false };
  }
  const summaryCandidate = { ...candidate };
  delete summaryCandidate.projectJson;
  const summary = decodeBranchSummary(summaryCandidate);
  if (!summary.ok || summary.value.branchId !== expectedBranchId) return { ok: false };
  const decoded = decodeProjectJson(candidate.projectJson);
  if (!decoded.ok) return decodeProjectFailure(decoded.error.code);
  if (decoded.project.id !== expectedProjectId) {
    return { ok: false, code: 'corrupt-data', retry: 'never' };
  }
  return { ok: true, value: { ...summary.value, project: decoded.project } };
}

function decodeSaveReceipt(value: unknown): DecodeResult<SaveReceipt> {
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, [
      'projectId',
      'activationId',
      'revision',
      'writeId',
      'headVersion',
      'savedAt',
      'bytes',
      'retainedGenerations',
      'legacyMirrorWritten',
    ]) ||
    !isString(candidate.projectId, false) ||
    !isString(candidate.activationId, false) ||
    !isNonNegativeInteger(candidate.revision) ||
    !isString(candidate.writeId, false) ||
    !isOpaqueToken(candidate.headVersion) ||
    !isTimestamp(candidate.savedAt) ||
    !isNonNegativeInteger(candidate.bytes) ||
    !isPositiveInteger(candidate.retainedGenerations) ||
    typeof candidate.legacyMirrorWritten !== 'boolean'
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      projectId: candidate.projectId,
      activationId: candidate.activationId,
      revision: candidate.revision,
      writeId: candidate.writeId,
      headVersion: candidate.headVersion,
      savedAt: candidate.savedAt,
      bytes: candidate.bytes,
      retainedGenerations: candidate.retainedGenerations,
      legacyMirrorWritten: candidate.legacyMirrorWritten,
    },
  };
}

function decodeCrashDraftReceipt(value: unknown): DecodeResult<CrashDraftReceipt> {
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, [
      'projectId',
      'activationId',
      'revision',
      'writeId',
      'protectedAt',
      'bytes',
    ]) ||
    !isString(candidate.projectId, false) ||
    !isString(candidate.activationId, false) ||
    !isNonNegativeInteger(candidate.revision) ||
    !isString(candidate.writeId, false) ||
    !isTimestamp(candidate.protectedAt) ||
    !isNonNegativeInteger(candidate.bytes)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      projectId: candidate.projectId,
      activationId: candidate.activationId,
      revision: candidate.revision,
      writeId: candidate.writeId,
      protectedAt: candidate.protectedAt,
      bytes: candidate.bytes,
    },
  };
}

function decodeRemoveReceipt(value: unknown): DecodeResult<RemoveReceipt> {
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, [
      'projectId',
      'deleteId',
      'headVersion',
      'removed',
      'cleanupComplete',
    ]) ||
    !isString(candidate.projectId, false) ||
    !isString(candidate.deleteId, false) ||
    !isOpaqueToken(candidate.headVersion) ||
    typeof candidate.removed !== 'boolean' ||
    typeof candidate.cleanupComplete !== 'boolean'
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      projectId: candidate.projectId,
      deleteId: candidate.deleteId,
      headVersion: candidate.headVersion,
      removed: candidate.removed,
      cleanupComplete: candidate.cleanupComplete,
    },
  };
}

function decodeVoid(value: unknown): DecodeResult<void> {
  return value === null ? { ok: true, value: undefined } : { ok: false };
}

export function nativeExpectedHead(value: string | null | undefined): NativeExpectedHead {
  if (value === undefined) return { kind: 'repair' };
  if (value === null) return { kind: 'empty' };
  return { kind: 'match', version: value };
}

export class NativeProjectRepository implements ProjectRepository {
  readonly kind = 'sqlite' as const;

  constructor(private readonly bridge: TauriBridge) {}

  private async call<T>(
    operation: RepositoryOperation,
    command: PersistenceCommand,
    args: TauriInvokeArguments | undefined,
    decode: (value: unknown) => DecodeResult<T>,
    projectId?: string,
  ): Promise<RepositoryResult<T>> {
    try {
      const raw = await this.bridge.invoke(command, args);
      let decoded: DecodeResult<T>;
      try {
        decoded = decode(raw);
      } catch {
        return malformedFailure(operation, projectId);
      }
      return decoded.ok
        ? { ok: true, value: decoded.value }
        : malformedFailure(operation, projectId, decoded);
    } catch (error) {
      let structured: PersistenceError | null = null;
      try {
        structured = decodeStructuredError(error, operation, projectId);
      } catch {
        // Proxies/getters from a rejected value are not trusted either.
      }
      return structured
        ? { ok: false, error: structured }
        : malformedFailure(operation, projectId);
    }
  }

  initialize(): Promise<RepositoryResult<void>> {
    return this.call('initialize', PERSISTENCE_COMMANDS.initialize, undefined, decodeVoid);
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    return this.call('list', PERSISTENCE_COMMANDS.list, undefined, decodeSummaryList);
  }

  load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    if (!isString(id, false)) return Promise.resolve(failure('load', 'read-failed', 'never'));
    return this.call(
      'load',
      PERSISTENCE_COMMANDS.load,
      { projectId: id },
      (value) => decodeLoadedProject(value, id),
      id,
    );
  }

  getDurableProjectState(
    id: string,
  ): Promise<RepositoryResult<DurableProjectState>> {
    if (!isString(id, false)) return Promise.resolve(failure('load', 'read-failed', 'never'));
    return this.call(
      'load',
      PERSISTENCE_COMMANDS.projectState,
      { projectId: id },
      decodeDurableProjectState,
      id,
    );
  }

  loadProjectBranch(
    projectId: string,
    branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>> {
    if (!isString(projectId, false) || !isString(branchId, false)) {
      return Promise.resolve(failure('load', 'read-failed', 'never'));
    }
    return this.call(
      'load',
      PERSISTENCE_COMMANDS.loadBranch,
      { projectId, branchId },
      (value) => decodeProjectBranch(value, projectId, branchId),
      projectId,
    );
  }

  loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    return this.call(
      'load',
      PERSISTENCE_COMMANDS.loadMostRecent,
      undefined,
      (value) => decodeLoadedProject(value),
    );
  }

  stageCrashDraft(request: SaveRequest): Promise<RepositoryResult<CrashDraftReceipt>> {
    const encoded = encodeProjectJson(request.project);
    const projectId = (() => {
      try {
        return typeof request.project.id === 'string' ? request.project.id : undefined;
      } catch {
        return undefined;
      }
    })();
    if (!encoded.ok) {
      return Promise.resolve(
        failure(
          'save',
          encoded.error.code === 'too-large'
            ? 'too-large'
            : encoded.error.code === 'serialization-failed'
              ? 'serialization-failed'
              : 'invalid-project',
          'never',
          projectId,
        ),
      );
    }
    if (
      !projectId ||
      !isString(request.activationId, false) ||
      !isNonNegativeInteger(request.revision) ||
      !isString(request.writeId, false) ||
      (request.predecessorWriteId !== undefined &&
        !isString(request.predecessorWriteId, false)) ||
      (request.expectedHeadVersion !== undefined &&
        request.expectedHeadVersion !== null &&
        !isOpaqueToken(request.expectedHeadVersion))
    ) {
      return Promise.resolve(failure('save', 'invalid-project', 'never', projectId));
    }

    const nativeRequest: NativeSaveRequest = {
      projectId,
      projectJson: encoded.json,
      activationId: request.activationId,
      revision: request.revision,
      writeId: request.writeId,
      expectedHead: nativeExpectedHead(request.expectedHeadVersion),
      ...(request.predecessorWriteId !== undefined
        ? { predecessorWriteId: request.predecessorWriteId }
        : {}),
    };
    return this.call(
      'save',
      PERSISTENCE_COMMANDS.stageCrashDraft,
      { request: nativeRequest },
      (value) => {
        const decoded = decodeCrashDraftReceipt(value);
        if (!decoded.ok) return decoded;
        const receipt = decoded.value;
        return receipt.projectId === projectId &&
          receipt.activationId === request.activationId &&
          receipt.revision === request.revision &&
          receipt.writeId === request.writeId &&
          receipt.bytes === encoded.bytes
          ? decoded
          : { ok: false, code: 'write-failed', retry: 'automatic' };
      },
      projectId,
    );
  }

  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    const encoded = encodeProjectJson(request.project);
    const projectId = (() => {
      try {
        return typeof request.project.id === 'string' ? request.project.id : undefined;
      } catch {
        return undefined;
      }
    })();
    if (!encoded.ok) {
      return Promise.resolve(
        failure(
          'save',
          encoded.error.code === 'too-large'
            ? 'too-large'
            : encoded.error.code === 'serialization-failed'
              ? 'serialization-failed'
              : 'invalid-project',
          'never',
          projectId,
        ),
      );
    }
    if (
      !projectId ||
      !isString(request.activationId, false) ||
      !isNonNegativeInteger(request.revision) ||
      !isString(request.writeId, false) ||
      (request.predecessorWriteId !== undefined &&
        !isString(request.predecessorWriteId, false)) ||
      (request.expectedHeadVersion !== undefined &&
        request.expectedHeadVersion !== null &&
        !isOpaqueToken(request.expectedHeadVersion))
    ) {
      return Promise.resolve(failure('save', 'invalid-project', 'never', projectId));
    }

    const nativeRequest: NativeSaveRequest = {
      projectId,
      projectJson: encoded.json,
      activationId: request.activationId,
      revision: request.revision,
      writeId: request.writeId,
      expectedHead: nativeExpectedHead(request.expectedHeadVersion),
      ...(request.predecessorWriteId !== undefined
        ? { predecessorWriteId: request.predecessorWriteId }
        : {}),
    };
    return this.call(
      'save',
      PERSISTENCE_COMMANDS.save,
      { request: nativeRequest },
      (value) => {
        const decoded = decodeSaveReceipt(value);
        if (!decoded.ok) return decoded;
        const receipt = decoded.value;
        return receipt.projectId === projectId &&
          receipt.activationId === request.activationId &&
          receipt.revision === request.revision &&
          receipt.writeId === request.writeId &&
          receipt.bytes === encoded.bytes
          ? decoded
          : { ok: false, code: 'write-failed', retry: 'automatic' };
      },
      projectId,
    );
  }

  remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    if (
      !isString(request.projectId, false) ||
      !isString(request.deleteId, false) ||
      (request.expectedHeadVersion !== undefined &&
        request.expectedHeadVersion !== null &&
        !isOpaqueToken(request.expectedHeadVersion))
    ) {
      return Promise.resolve(
        failure(
          'remove',
          'invalid-project',
          'never',
          isString(request.projectId, false) ? request.projectId : undefined,
        ),
      );
    }
    const nativeRequest: NativeRemoveRequest = {
      projectId: request.projectId,
      deleteId: request.deleteId,
      expectedHead: nativeExpectedHead(request.expectedHeadVersion),
    };
    return this.call(
      'remove',
      PERSISTENCE_COMMANDS.remove,
      { request: nativeRequest },
      (value) => {
        const decoded = decodeRemoveReceipt(value);
        if (!decoded.ok) return decoded;
        return decoded.value.projectId === request.projectId &&
          decoded.value.deleteId === request.deleteId
          ? decoded
          : { ok: false, code: 'delete-failed', retry: 'automatic' };
      },
      request.projectId,
    );
  }

  close(): Promise<RepositoryResult<void>> {
    // Native repository shutdown is intentionally fused into Rust's
    // OS-authorized final-close command. A renderer-callable close IPC would
    // let script code create the precondition for destructive window teardown.
    return Promise.resolve(failure('close', 'access-denied', 'never'));
  }
}

export function createNativeProjectRepository(bridge: TauriBridge): NativeProjectRepository {
  return new NativeProjectRepository(bridge);
}
