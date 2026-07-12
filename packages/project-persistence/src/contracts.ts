import type { Project } from '@cts/project-model';

export type RepositoryKind = 'local-storage' | 'memory' | 'sqlite';
export type RepositoryOperation =
  | 'initialize'
  | 'list'
  | 'load'
  | 'save'
  | 'remove'
  | 'close';

export type PersistenceErrorCode =
  | 'storage-unavailable'
  | 'quota-exceeded'
  | 'access-denied'
  | 'invalid-project'
  | 'serialization-failed'
  | 'too-large'
  | 'corrupt-data'
  | 'unsupported-version'
  | 'conflict'
  | 'read-failed'
  | 'write-failed'
  | 'delete-failed'
  | 'migration-failed'
  | 'lock-unavailable'
  | 'sync-unsupported';

export type RetryPolicy = 'automatic' | 'manual' | 'never';

export type PersistenceError = Readonly<{
  operation: RepositoryOperation;
  code: PersistenceErrorCode;
  retry: RetryPolicy;
  projectId?: string;
}>;

export type RepositoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: PersistenceError }>;

export type ProjectBranchSource =
  | 'recovery-journal'
  | 'interrupted-save'
  | 'legacy-migration';

export type ProjectBranchSummary = Readonly<{
  /** Opaque repository-defined selector. */
  branchId: string;
  source: ProjectBranchSource;
  activationId: string;
  revision: number;
  writeId: string;
  savedAt: string;
  title: string;
  updatedAt: string;
}>;

export type ProjectBranch = ProjectBranchSummary &
  Readonly<{
    project: Project;
  }>;

export type ReadyProjectSummary = Readonly<{
  status: 'ready';
  id: string;
  title: string;
  updatedAt: string;
  recovered: boolean;
  branches: readonly ProjectBranchSummary[];
}>;

export type UnreadableProjectSummary = Readonly<{
  status: 'unreadable';
  id: string;
  errorCode: Extract<
    PersistenceErrorCode,
    'corrupt-data' | 'unsupported-version' | 'migration-failed' | 'conflict'
  >;
  branches: readonly ProjectBranchSummary[];
}>;

export type ProjectSummary = ReadyProjectSummary | UnreadableProjectSummary;

export type ProjectRecoveryReason =
  | 'head-missing'
  | 'head-corrupt'
  | 'head-stale'
  | 'generation-corrupt'
  | 'legacy-project'
  | 'recovery-journal'
  | 'interrupted-save';

export type DurableProjectState = 'missing' | 'active' | 'deleted' | 'unreadable';

export type LoadedProject = Readonly<{
  project: Project;
  /** Version of the committed head, or null when recovery must repair it. */
  headVersion: string | null;
  source: 'generation' | 'legacy';
  recovered: boolean;
  recoveryReason: ProjectRecoveryReason | null;
}>;

export type SaveRequest = Readonly<{
  project: Project;
  activationId: string;
  revision: number;
  /** Stable across retries of the same logical revision. */
  writeId: string;
  /** undefined repairs an unreadable head unless verified deletion evidence remains. */
  expectedHeadVersion?: string | null;
  /**
   * Recovery-only causal link: a newer emergency snapshot was journaled while
   * this canonical write had physically committed but its Promise was unsettled.
   */
  predecessorWriteId?: string;
}>;

export type SaveReceipt = Readonly<{
  projectId: string;
  activationId: string;
  revision: number;
  writeId: string;
  headVersion: string;
  savedAt: string;
  bytes: number;
  retainedGenerations: number;
  legacyMirrorWritten: boolean;
}>;

export type CrashDraftReceipt = Readonly<{
  projectId: string;
  activationId: string;
  revision: number;
  writeId: string;
  protectedAt: string;
  bytes: number;
}>;

export type RemoveRequest = Readonly<{
  projectId: string;
  /** Stable across retries of the same logical deletion. */
  deleteId: string;
  expectedHeadVersion?: string | null;
}>;

export type RemoveReceipt = Readonly<{
  projectId: string;
  deleteId: string;
  headVersion: string;
  removed: boolean;
  cleanupComplete: boolean;
}>;

export interface ProjectRepository {
  readonly kind: RepositoryKind;

  initialize(): Promise<RepositoryResult<void>>;
  list(): Promise<RepositoryResult<readonly ProjectSummary[]>>;
  load(id: string): Promise<RepositoryResult<LoadedProject | null>>;
  /** Native-only tombstone visibility used to suppress stale recovery bytes. */
  getDurableProjectState?(
    id: string,
  ): Promise<RepositoryResult<DurableProjectState>>;
  /** Loads a listed recovery branch without promoting or deleting it. */
  loadProjectBranch?(
    projectId: string,
    branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>>;
  loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>>;
  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>>;
  remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>>;
  close(): Promise<RepositoryResult<void>>;
}

/** Explicit capability for pagehide, where browsers do not await Promises. */
export interface SynchronousSaveCapability {
  saveSynchronously(request: SaveRequest): RepositoryResult<SaveReceipt>;
}

export type RecoveryReceipt = Readonly<{
  projectId: string;
  activationId: string;
  revision: number;
  writeId: string;
  savedAt: string;
  bytes: number;
}>;

/** Safe pagehide fallback that never races the canonical repository head. */
export interface SynchronousRecoveryCapability {
  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt>;
}

/** Native write-ahead capability for protecting edits before canonical debounce. */
export interface CrashDraftCapability {
  stageCrashDraft(request: SaveRequest): Promise<RepositoryResult<CrashDraftReceipt>>;
}

export function canSaveSynchronously(
  repository: ProjectRepository,
): repository is ProjectRepository & SynchronousSaveCapability {
  return (
    'saveSynchronously' in repository &&
    typeof (repository as Partial<SynchronousSaveCapability>).saveSynchronously === 'function'
  );
}

export function canSaveRecoverySynchronously(
  repository: ProjectRepository,
): repository is ProjectRepository & SynchronousRecoveryCapability {
  return (
    'saveRecoverySynchronously' in repository &&
    typeof (repository as Partial<SynchronousRecoveryCapability>).saveRecoverySynchronously ===
      'function'
  );
}

export function canStageCrashDraft(
  repository: ProjectRepository,
): repository is ProjectRepository & CrashDraftCapability {
  return (
    'stageCrashDraft' in repository &&
    typeof (repository as Partial<CrashDraftCapability>).stageCrashDraft === 'function'
  );
}
