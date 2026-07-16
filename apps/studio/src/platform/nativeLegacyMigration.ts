import { encodeProjectJson } from '@cts/project-model';
import {
  LocalStorageProjectRepository,
  canStageCrashDraft,
  createLegacyStorageSnapshot,
  type CrashDraftCapability,
  type CrashDraftReceipt,
  type LegacyStorageSnapshot,
  type LoadedProject,
  type DurableProjectState,
  type ProjectBranch,
  type ProjectRepository,
  type ProjectSummary,
  type RemoveReceipt,
  type RemoveRequest,
  type RepositoryResult,
  type SaveReceipt,
  type SaveRequest,
  type StorageLike,
  type StorageProvider,
} from '@cts/project-persistence';

export type LegacyMigrationStatus = Readonly<{ complete: boolean }>;
/** Bumped when archived payloads are re-encoded into a new canonical Project schema. */
export const LEGACY_MIGRATION_VERSION = 4;

export type LegacyProjectImportReceipt = Readonly<{
  projectId: string;
  status: 'imported' | 'unchanged' | 'branched';
  branchId?: string;
}>;

export type LegacyProjectImportRequest =
  | Readonly<{
      contentChecksum: string;
      migrationVersion: number;
      projectId: string;
      sourceKeys: readonly string[];
      projectJson: string;
      /** Omitted for the canonical legacy head; present for a retained branch. */
      branch?: Readonly<{
        source: 'recovery-journal' | 'interrupted-save';
        activationId: string;
        revision: number;
        writeId: string;
        savedAt: string;
      }>;
    }>
  | Readonly<{
      contentChecksum: string;
      migrationVersion: number;
      projectId: string;
      sourceKeys: readonly string[];
      diagnostic: Readonly<{
        errorCode: Extract<
          ProjectSummary,
          { status: 'unreadable' }
        >['errorCode'];
      }>;
    }>;

export type LegacyMigrationCompletion = Readonly<{
  contentChecksum: string;
  migrationVersion: number;
  recordCount: number;
  totalBytes: number;
  readyProjectCount: number;
  unreadableProjectCount: number;
  branchCount: number;
}>;

/** Strict IPC adapter implemented beside the Tauri bridge. */
export interface NativeLegacyMigrationGateway {
  getStatus(
    contentChecksum: string,
    migrationVersion: number,
  ): Promise<RepositoryResult<LegacyMigrationStatus>>;
  backupSnapshot(
    snapshot: LegacyStorageSnapshot,
  ): Promise<RepositoryResult<void>>;
  importProject(
    request: LegacyProjectImportRequest,
  ): Promise<RepositoryResult<LegacyProjectImportReceipt>>;
  complete(
    completion: LegacyMigrationCompletion,
  ): Promise<RepositoryResult<void>>;
}

export type NativeLegacyMigratingRepositoryOptions = Readonly<{
  repository: ProjectRepository;
  gateway: NativeLegacyMigrationGateway;
  storage: StorageLike | StorageProvider | null;
  now?: () => Date;
}>;

function migrationFailure(
  retry: 'automatic' | 'manual' | 'never' = 'manual',
): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'initialize',
      code: 'migration-failed',
      retry,
    },
  };
}

function providerFor(storage: StorageLike | StorageProvider | null): StorageProvider {
  return typeof storage === 'function' ? storage : () => storage;
}

function sameSnapshotContent(
  left: LegacyStorageSnapshot,
  right: LegacyStorageSnapshot,
): boolean {
  if (
    left.storageVersion !== right.storageVersion ||
    left.totalBytes !== right.totalBytes ||
    left.entries.length !== right.entries.length
  ) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const candidate = right.entries[index];
    return (
      candidate !== undefined &&
      entry.key === candidate.key &&
      entry.value === candidate.value &&
      entry.valueBytes === candidate.valueBytes &&
      entry.checksum === candidate.checksum
    );
  });
}

function sourceKeysForProject(
  snapshot: LegacyStorageSnapshot,
  projectId: string,
): readonly string[] {
  let persistencePrefix: string | null = null;
  try {
    const encodedId = encodeURIComponent(projectId).replaceAll('.', '%2E');
    persistencePrefix = `cts.persistence.v1.project.${encodedId}.`;
  } catch {
    // A legacy mirror can still preserve an unusual id for diagnostics.
  }
  const mirrorKey = `cts.project.${projectId}`;
  return snapshot.entries
    .map((entry) => entry.key)
    .filter(
      (key) => key === mirrorKey || (persistencePrefix !== null && key.startsWith(persistencePrefix)),
    );
}

/** Read-only Storage view, so decoding can only observe the exact archived bytes. */
class SnapshotStorage implements StorageLike {
  private readonly entries: ReadonlyMap<string, string>;
  private readonly keys: readonly string[];

  constructor(snapshot: LegacyStorageSnapshot) {
    this.entries = new Map(snapshot.entries.map((entry) => [entry.key, entry.value]));
    this.keys = snapshot.entries.map((entry) => entry.key);
  }

  get length(): number {
    return this.keys.length;
  }

  key(index: number): string | null {
    return this.keys[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(): void {
    throw Object.assign(new Error('The migration snapshot is read-only.'), {
      name: 'NotAllowedError',
    });
  }

  removeItem(): void {
    throw Object.assign(new Error('The migration snapshot is read-only.'), {
      name: 'NotAllowedError',
    });
  }
}

/**
 * One-time, repeatable bridge from the previous WebView localStorage protocol
 * to SQLite. Exact raw bytes are archived before any decoded project is
 * imported, and the source is re-captured before the completion marker.
 */
export class NativeLegacyMigratingRepository implements ProjectRepository {
  readonly kind;
  declare readonly stageCrashDraft?: CrashDraftCapability['stageCrashDraft'];
  private readonly repository: ProjectRepository;
  private readonly gateway: NativeLegacyMigrationGateway;
  private readonly storage: StorageProvider;
  private readonly now: () => Date;
  private state: 'new' | 'initializing' | 'ready' | 'failed' | 'closed' = 'new';
  private initialization: Promise<RepositoryResult<void>> | null = null;
  private closing: Promise<RepositoryResult<void>> | null = null;
  private readonly crashDraftFlights = new Set<
    Promise<RepositoryResult<CrashDraftReceipt>>
  >();
  private closeRequested = false;
  private lifecycleEpoch = 0;

  constructor(options: NativeLegacyMigratingRepositoryOptions) {
    this.repository = options.repository;
    this.kind = options.repository.kind;
    this.gateway = options.gateway;
    this.storage = providerFor(options.storage);
    this.now = options.now ?? (() => new Date());
    if (canStageCrashDraft(options.repository)) {
      const crashDraftRepository = options.repository;
      this.stageCrashDraft = (request) =>
        this.stageCrashDraftWhenReady(crashDraftRepository, request);
    }
  }

  private stageCrashDraftWhenReady(
    repository: ProjectRepository & CrashDraftCapability,
    request: SaveRequest,
  ): Promise<RepositoryResult<CrashDraftReceipt>> {
    if (!this.isReady()) {
      return Promise.resolve(this.notReady('save', request.project.id));
    }
    // Register synchronously before invoking the delegate in a microtask, so a
    // close requested immediately after this call cannot overtake physical I/O.
    const flight = Promise.resolve().then(() => repository.stageCrashDraft(request));
    this.crashDraftFlights.add(flight);
    void flight.finally(() => this.crashDraftFlights.delete(flight)).catch(() => undefined);
    return flight;
  }

  initialize(): Promise<RepositoryResult<void>> {
    if (this.state === 'closed' || this.closeRequested) {
      return Promise.resolve(migrationFailure('never'));
    }
    if (this.state === 'ready') return Promise.resolve({ ok: true, value: undefined });
    if (this.initialization) return this.initialization;
    this.state = 'initializing';
    const initializationEpoch = this.lifecycleEpoch;
    this.initialization = this.initializeOnce()
      .then((result) => {
        if (
          this.lifecycleEpoch === initializationEpoch &&
          !this.closeRequested &&
          this.state !== 'closed'
        ) {
          this.state = result.ok ? 'ready' : 'failed';
        }
        return result;
      })
      .finally(() => {
        this.initialization = null;
      });
    return this.initialization;
  }

  private async initializeOnce(): Promise<RepositoryResult<void>> {
    try {
      const initialized = await this.repository.initialize();
      if (!initialized.ok) return initialized;

      const captured = createLegacyStorageSnapshot({
        storage: this.storage,
        now: this.now,
      });
      if (!captured.ok) return migrationFailure(captured.error.retry);
      const snapshot = captured.value;

      // Always submit the exact raw snapshot before trusting a checksum-keyed
      // marker. The native side compares every key/value on duplicate hashes,
      // so even an accidental CRC collision fails closed instead of skipping.
      const backedUp = await this.gateway.backupSnapshot(snapshot);
      if (!backedUp.ok) return migrationFailure(backedUp.error.retry);
      const status = await this.gateway.getStatus(
        snapshot.contentChecksum,
        LEGACY_MIGRATION_VERSION,
      );
      if (!status.ok) return migrationFailure(status.error.retry);
      if (status.value.complete) {
        // The checksum-keyed marker only describes the bytes captured before
        // the asynchronous status lookup. Re-capture the live source so a
        // concurrent legacy tab cannot make stale SQLite state current.
        const verified = createLegacyStorageSnapshot({
          storage: this.storage,
          now: this.now,
        });
        if (!verified.ok || !sameSnapshotContent(snapshot, verified.value)) {
          return migrationFailure(verified.ok ? 'manual' : verified.error.retry);
        }
        return { ok: true, value: undefined };
      }

      const legacyRepository = new LocalStorageProjectRepository({
        storage: new SnapshotStorage(snapshot),
        retainGenerations: 3,
        lockManager: null,
      });
      const legacyInitialized = await legacyRepository.initialize();
      if (!legacyInitialized.ok) return migrationFailure(legacyInitialized.error.retry);
      const listed = await legacyRepository.list();
      if (!listed.ok) return migrationFailure(listed.error.retry);

      let readyProjectCount = 0;
      let unreadableProjectCount = 0;
      let branchCount = 0;
      const summaries = [...listed.value].sort((left, right) => left.id.localeCompare(right.id));
      for (const summary of summaries) {
        const sourceKeys = sourceKeysForProject(snapshot, summary.id);
        if (sourceKeys.length === 0) return migrationFailure('never');
        let canonicalProjectJson: string | null = null;
        if (summary.status === 'unreadable') {
          unreadableProjectCount += 1;
          const diagnostic = await this.gateway.importProject({
            contentChecksum: snapshot.contentChecksum,
            migrationVersion: LEGACY_MIGRATION_VERSION,
            projectId: summary.id,
            sourceKeys,
            diagnostic: { errorCode: summary.errorCode },
          });
          if (!diagnostic.ok || diagnostic.value.projectId !== summary.id) {
            return migrationFailure(diagnostic.ok ? 'never' : diagnostic.error.retry);
          }
        } else {
          const loaded = await legacyRepository.load(summary.id);
          if (!loaded.ok || !loaded.value) {
            return migrationFailure(loaded.ok ? 'manual' : loaded.error.retry);
          }
          const encoded = encodeProjectJson(loaded.value.project);
          if (!encoded.ok) return migrationFailure('never');
          canonicalProjectJson = encoded.json;
          const imported = await this.gateway.importProject({
            contentChecksum: snapshot.contentChecksum,
            migrationVersion: LEGACY_MIGRATION_VERSION,
            projectId: summary.id,
            sourceKeys,
            projectJson: encoded.json,
          });
          if (!imported.ok || imported.value.projectId !== summary.id) {
            return migrationFailure(imported.ok ? 'never' : imported.error.retry);
          }
          readyProjectCount += 1;
        }

        const stagedBranchPayloads = new Map<string, string>();
        for (const branch of [...summary.branches].sort((left, right) => {
          const sourceOrder =
            Number(left.source !== 'recovery-journal') -
            Number(right.source !== 'recovery-journal');
          return sourceOrder || left.branchId.localeCompare(right.branchId);
        })) {
          const loadedBranch = await legacyRepository.loadProjectBranch?.(
            summary.id,
            branch.branchId,
          );
          if (!loadedBranch?.ok || !loadedBranch.value) {
            return migrationFailure(
              loadedBranch?.ok || loadedBranch === undefined
                ? 'manual'
                : loadedBranch.error.retry,
            );
          }
          const encodedBranch = encodeProjectJson(loadedBranch.value.project);
          if (!encodedBranch.ok) return migrationFailure('never');
          // The legacy resolver can promote an unambiguous recovery journal
          // while still listing that same journal as a retained branch. Stage
          // the exact bytes only once: the canonical candidate already keeps
          // the recovery content durable.
          if (canonicalProjectJson === encodedBranch.json) continue;
          const logicalIdentity = [
            branch.activationId,
            String(branch.revision),
            branch.writeId,
          ].join('\u0000');
          const existingPayload = stagedBranchPayloads.get(logicalIdentity);
          if (existingPayload !== undefined) {
            if (existingPayload !== encodedBranch.json) return migrationFailure('manual');
            continue;
          }
          stagedBranchPayloads.set(logicalIdentity, encodedBranch.json);
          const importedBranch = await this.gateway.importProject({
            contentChecksum: snapshot.contentChecksum,
            migrationVersion: LEGACY_MIGRATION_VERSION,
            projectId: summary.id,
            sourceKeys,
            projectJson: encodedBranch.json,
            branch: {
              source: branch.source === 'legacy-migration'
                ? 'recovery-journal'
                : branch.source,
              activationId: branch.activationId,
              revision: branch.revision,
              writeId: branch.writeId,
              savedAt: branch.savedAt,
            },
          });
          if (!importedBranch.ok || importedBranch.value.projectId !== summary.id) {
            return migrationFailure(importedBranch.ok ? 'never' : importedBranch.error.retry);
          }
          branchCount += 1;
        }
      }

      // localStorage has no snapshot transaction. Do not record completion if
      // an older app/tab changed any source byte during the async native import.
      const verified = createLegacyStorageSnapshot({
        storage: this.storage,
        now: this.now,
      });
      if (!verified.ok || !sameSnapshotContent(snapshot, verified.value)) {
        return migrationFailure(verified.ok ? 'manual' : verified.error.retry);
      }
      const verifiedBackup = await this.gateway.backupSnapshot(verified.value);
      if (!verifiedBackup.ok) return migrationFailure(verifiedBackup.error.retry);

      const completed = await this.gateway.complete({
        contentChecksum: snapshot.contentChecksum,
        migrationVersion: LEGACY_MIGRATION_VERSION,
        recordCount: snapshot.entries.length,
        totalBytes: snapshot.totalBytes,
        readyProjectCount,
        unreadableProjectCount,
        branchCount,
      });
      if (!completed.ok) return migrationFailure(completed.error.retry);
      return { ok: true, value: undefined };
    } catch {
      return migrationFailure('automatic');
    }
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    return this.isReady()
      ? this.repository.list()
      : Promise.resolve(this.notReady('list'));
  }

  load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    return this.isReady()
      ? this.repository.load(id)
      : Promise.resolve(this.notReady('load', id));
  }

  getDurableProjectState(
    id: string,
  ): Promise<RepositoryResult<DurableProjectState>> {
    if (!this.isReady()) return Promise.resolve(this.notReady('load', id));
    return this.repository.getDurableProjectState
      ? this.repository.getDurableProjectState(id)
      : Promise.resolve({
          ok: false,
          error: {
            operation: 'load',
            code: 'read-failed',
            retry: 'never',
            projectId: id,
          },
        });
  }

  loadProjectBranch(
    projectId: string,
    branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>> {
    if (!this.isReady()) return Promise.resolve(this.notReady('load', projectId));
    return this.repository.loadProjectBranch
      ? this.repository.loadProjectBranch(projectId, branchId)
      : Promise.resolve({ ok: true, value: null });
  }

  loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    return this.isReady()
      ? this.repository.loadMostRecent()
      : Promise.resolve(this.notReady('load'));
  }

  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    return this.isReady()
      ? this.repository.save(request)
      : Promise.resolve(this.notReady('save', request.project.id));
  }

  remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    return this.isReady()
      ? this.repository.remove(request)
      : Promise.resolve(this.notReady('remove', request.projectId));
  }

  close(): Promise<RepositoryResult<void>> {
    if (this.closing) return this.closing;

    const stateBeforeClose = this.state;
    const initialization = this.initialization;
    this.closeRequested = true;
    this.lifecycleEpoch += 1;
    const closing = this.closeOnce(stateBeforeClose, initialization).finally(() => {
      if (this.closing === closing) this.closing = null;
    });
    this.closing = closing;
    return closing;
  }

  private async closeOnce(
    stateBeforeClose: typeof this.state,
    initialization: Promise<RepositoryResult<void>> | null,
  ): Promise<RepositoryResult<void>> {
    const initializationResult = initialization ? await initialization : null;
    await Promise.allSettled([...this.crashDraftFlights]);
    const closed = await this.repository.close();
    if (closed.ok) {
      this.state = 'closed';
      return closed;
    }

    // A rejected close preserves the pre-existing lifecycle contract and
    // leaves the wrapper usable when initialization itself succeeded.
    this.closeRequested = false;
    this.state = initializationResult
      ? initializationResult.ok
        ? 'ready'
        : 'failed'
      : stateBeforeClose;
    return closed;
  }

  private isReady(): boolean {
    return this.state === 'ready' && !this.closeRequested;
  }

  private notReady<T>(
    operation: 'list' | 'load' | 'save' | 'remove',
    projectId?: string,
  ): RepositoryResult<T> {
    return {
      ok: false,
      error: {
        operation,
        code: 'migration-failed',
        retry: this.state === 'closed' || this.closeRequested ? 'never' : 'manual',
        ...(projectId !== undefined ? { projectId } : {}),
      },
    };
  }
}
