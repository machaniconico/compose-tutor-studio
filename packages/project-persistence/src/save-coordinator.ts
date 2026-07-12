import { encodeProjectJson, type Project } from '@cts/project-model';
import {
  canSaveSynchronously,
  canSaveRecoverySynchronously,
  canStageCrashDraft,
  type CrashDraftReceipt,
  type PersistenceError,
  type ProjectRepository,
  type RepositoryResult,
  type RecoveryReceipt,
  type SaveReceipt,
  type SaveRequest,
} from './contracts';

export type SaveSnapshot = Readonly<{
  project: Project;
  activationId: string;
  revision: number;
}>;

export type PersistenceActivation = Readonly<{
  projectId: string;
  activationId: string;
  persistedRevision: number;
  /** null means a known empty head; undefined deliberately permits repair. */
  headVersion?: string | null;
}>;

export type CoordinatorFlush = Readonly<{
  receipt: SaveReceipt | null;
  recoveryReceipt: RecoveryReceipt | null;
  clean: boolean;
  persistedRevision: number;
}>;

/** Final durable position after queued work has been cancelled and physical I/O has settled. */
export type CoordinatorCancellation = Readonly<{
  headVersion: string | null | undefined;
  persistedRevision: number;
  receipt: SaveReceipt | null;
}>;

type QueuedSave = Readonly<{
  snapshot: SaveSnapshot;
  writeId: string;
}>;

type ActivationState = {
  projectId: string;
  activationId: string;
  persistedRevision: number;
  protectedRevision: number;
  protectedWriteId?: string;
  headVersion?: string | null;
};

type CoordinatorPhase = 'inactive' | 'active' | 'cancelling' | 'sealed';

export type SaveCoordinatorOptions = Readonly<{
  repository: ProjectRepository;
  createWriteId?: () => string;
}>;

function coordinatorError(
  code: PersistenceError['code'],
  projectId?: string,
): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'save',
      code,
      retry: code === 'write-failed' ? 'automatic' : code === 'sync-unsupported' ? 'never' : 'manual',
      ...(projectId !== undefined ? { projectId } : {}),
    },
  };
}

function defaultWriteId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `write-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through for restricted runtimes.
  }
  return `write-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Single-flight, activation-aware save serialization for async repositories. */
export class ProjectSaveCoordinator {
  private readonly repository: ProjectRepository;
  private readonly createWriteId: () => string;
  private phase: CoordinatorPhase = 'inactive';
  private activation: ActivationState | null = null;
  private pending: QueuedSave | null = null;
  private inFlight: QueuedSave | null = null;
  private drainPromise: Promise<RepositoryResult<SaveReceipt | null>> | null = null;
  private protectionPending: QueuedSave | null = null;
  private protectionInFlight: QueuedSave | null = null;
  private protectionPromise: Promise<RepositoryResult<CrashDraftReceipt | null>> | null = null;
  private sealPromise: Promise<void> | null = null;

  constructor(options: SaveCoordinatorOptions) {
    this.repository = options.repository;
    this.createWriteId = options.createWriteId ?? defaultWriteId;
  }

  /** Activation changes are rejected while physical work is still in flight. */
  activate(activation: PersistenceActivation): boolean {
    if (
      this.phase === 'cancelling' ||
      this.phase === 'sealed' ||
      this.pending ||
      this.inFlight ||
      this.drainPromise ||
      this.protectionPending ||
      this.protectionInFlight ||
      this.protectionPromise
    ) {
      return false;
    }
    this.activation = {
      ...activation,
      protectedRevision: activation.persistedRevision,
    };
    this.phase = 'active';
    return true;
  }

  markDirty(snapshot: SaveSnapshot): boolean {
    const active = this.activation;
    if (
      this.phase !== 'active' ||
      !active ||
      active.projectId !== snapshot.project.id ||
      active.activationId !== snapshot.activationId ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0
    ) {
      return false;
    }
    const highestRevision = Math.max(
      active.persistedRevision,
      active.protectedRevision,
      this.pending?.snapshot.revision ?? -1,
      this.inFlight?.snapshot.revision ?? -1,
      this.protectionPending?.snapshot.revision ?? -1,
      this.protectionInFlight?.snapshot.revision ?? -1,
    );
    if (snapshot.revision < highestRevision) return false;
    if (
      (this.pending?.snapshot.activationId === snapshot.activationId &&
        this.pending.snapshot.revision === snapshot.revision) ||
      (this.inFlight?.snapshot.activationId === snapshot.activationId &&
        this.inFlight.snapshot.revision === snapshot.revision)
    ) {
      // A revision identifies one immutable logical snapshot. Never replace it
      // with a late, different object carrying the same revision.
      return true;
    }
    const queued = { snapshot, writeId: this.createWriteId() };
    this.pending = queued;
    if (canStageCrashDraft(this.repository)) this.protectionPending = queued;
    return true;
  }

  private requestFor(
    queued: QueuedSave,
    active: ActivationState,
    predecessorWriteId?: string,
  ): SaveRequest {
    return {
      project: queued.snapshot.project,
      activationId: queued.snapshot.activationId,
      revision: queued.snapshot.revision,
      writeId: queued.writeId,
      expectedHeadVersion: active.headVersion,
      ...(predecessorWriteId !== undefined ? { predecessorWriteId } : {}),
    };
  }

  private receiptMatches(receipt: SaveReceipt, queued: QueuedSave): boolean {
    return (
      receipt.projectId === queued.snapshot.project.id &&
      receipt.activationId === queued.snapshot.activationId &&
      receipt.revision === queued.snapshot.revision &&
      receipt.writeId === queued.writeId
    );
  }

  private protectionReceiptMatches(
    receipt: CrashDraftReceipt,
    queued: QueuedSave,
  ): boolean {
    const encoded = encodeProjectJson(queued.snapshot.project);
    return (
      encoded.ok &&
      receipt.projectId === queued.snapshot.project.id &&
      receipt.activationId === queued.snapshot.activationId &&
      receipt.revision === queued.snapshot.revision &&
      receipt.writeId === queued.writeId &&
      receipt.bytes === encoded.bytes
    );
  }

  private restoreProtectionAfterFailure(queued: QueuedSave): void {
    if (this.phase !== 'active') return;
    const active = this.activation;
    if (
      active &&
      active.projectId === queued.snapshot.project.id &&
      active.activationId === queued.snapshot.activationId &&
      Math.max(active.persistedRevision, active.protectedRevision) >= queued.snapshot.revision
    ) {
      return;
    }
    const pendingRevision = this.protectionPending?.snapshot.revision ?? -1;
    if (pendingRevision < queued.snapshot.revision) this.protectionPending = queued;
  }

  private ensureProtectionDrain(): Promise<RepositoryResult<CrashDraftReceipt | null>> {
    if (this.protectionPromise) return this.protectionPromise;
    this.protectionPromise = this.drainProtection().finally(() => {
      this.protectionPromise = null;
    });
    return this.protectionPromise;
  }

  private async drainProtection(): Promise<RepositoryResult<CrashDraftReceipt | null>> {
    if (!canStageCrashDraft(this.repository)) return { ok: true, value: null };
    let latestReceipt: CrashDraftReceipt | null = null;
    while (this.phase === 'active' && this.protectionPending) {
      const queued = this.protectionPending;
      const active = this.activation;
      this.protectionPending = null;
      if (
        !active ||
        active.projectId !== queued.snapshot.project.id ||
        active.activationId !== queued.snapshot.activationId
      ) {
        continue;
      }
      const predecessorWriteId =
        this.inFlight && this.inFlight.snapshot.revision < queued.snapshot.revision
          ? this.inFlight.writeId
          : active.protectedWriteId;
      this.protectionInFlight = queued;
      let result: RepositoryResult<CrashDraftReceipt>;
      try {
        result = await this.repository.stageCrashDraft(
          this.requestFor(queued, active, predecessorWriteId),
        );
      } catch {
        result = coordinatorError('write-failed', active.projectId);
      }
      this.protectionInFlight = null;
      if (!result.ok) {
        this.restoreProtectionAfterFailure(queued);
        return result;
      }
      if (!this.protectionReceiptMatches(result.value, queued)) {
        this.restoreProtectionAfterFailure(queued);
        return coordinatorError('write-failed', active.projectId);
      }
      latestReceipt = result.value;
      const current = this.activation;
      if (
        this.phase === 'active' &&
        current?.activationId === queued.snapshot.activationId &&
        current.projectId === queued.snapshot.project.id
      ) {
        current.protectedRevision = Math.max(
          current.protectedRevision,
          queued.snapshot.revision,
        );
        current.protectedWriteId = queued.writeId;
      }
    }
    return { ok: true, value: latestReceipt };
  }

  /** Protect the latest accepted revision without forcing the canonical save debounce. */
  async protectLatest(): Promise<RepositoryResult<CrashDraftReceipt | null>> {
    if (!canStageCrashDraft(this.repository)) return { ok: true, value: null };
    const activeAtCall = this.activation;
    if (this.phase !== 'active' || !activeAtCall) return coordinatorError('conflict');
    const activationId = activeAtCall.activationId;
    const watermark = Math.max(
      activeAtCall.protectedRevision,
      this.protectionPending?.snapshot.revision ?? -1,
      this.protectionInFlight?.snapshot.revision ?? -1,
    );
    let latestReceipt: CrashDraftReceipt | null = null;

    while (true) {
      if (this.protectionPending || this.protectionInFlight || this.protectionPromise) {
        const protectedResult = await this.ensureProtectionDrain();
        if (!protectedResult.ok) return protectedResult;
        latestReceipt = protectedResult.value ?? latestReceipt;
      }
      const active = this.activation;
      if (this.phase !== 'active' || !active || active.activationId !== activationId) {
        return coordinatorError('conflict', activeAtCall.projectId);
      }
      if (active.protectedRevision >= watermark) {
        return { ok: true, value: latestReceipt };
      }
      if (!this.protectionPending && !this.protectionInFlight) {
        return coordinatorError('write-failed', active.projectId);
      }
    }
  }

  supportsCrashProtection(): boolean {
    return canStageCrashDraft(this.repository);
  }

  private restoreAfterFailure(queued: QueuedSave): void {
    if (this.phase !== 'active') return;
    const pendingRevision = this.pending?.snapshot.revision ?? -1;
    if (pendingRevision < queued.snapshot.revision) this.pending = queued;
  }

  private ensureDrain(): Promise<RepositoryResult<SaveReceipt | null>> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drain(): Promise<RepositoryResult<SaveReceipt | null>> {
    let latestReceipt: SaveReceipt | null = null;
    while (this.phase === 'active' && this.pending) {
      const queued = this.pending;
      const active = this.activation;
      this.pending = null;
      if (
        !active ||
        active.projectId !== queued.snapshot.project.id ||
        active.activationId !== queued.snapshot.activationId
      ) {
        continue;
      }
      this.inFlight = queued;
      let result: RepositoryResult<SaveReceipt>;
      try {
        result = await this.repository.save(this.requestFor(queued, active));
      } catch {
        result = coordinatorError('write-failed', active.projectId);
      }
      this.inFlight = null;
      if (!result.ok) {
        this.restoreAfterFailure(queued);
        return result;
      }
      if (!this.receiptMatches(result.value, queued)) {
        this.restoreAfterFailure(queued);
        return coordinatorError('write-failed', active.projectId);
      }
      latestReceipt = result.value;

      const current = this.activation;
      if (
        this.phase === 'active' &&
        current?.activationId === queued.snapshot.activationId &&
        current.projectId === queued.snapshot.project.id
      ) {
        current.persistedRevision = Math.max(current.persistedRevision, queued.snapshot.revision);
        current.protectedRevision = Math.max(current.protectedRevision, queued.snapshot.revision);
        current.protectedWriteId = queued.writeId;
        current.headVersion = result.value.headVersion;
        if (
          this.protectionPending?.snapshot.activationId === queued.snapshot.activationId &&
          this.protectionPending.snapshot.revision <= queued.snapshot.revision
        ) {
          this.protectionPending = null;
        }
      }
    }
    return { ok: true, value: latestReceipt };
  }

  async flush(): Promise<RepositoryResult<CoordinatorFlush>> {
    const activeAtCall = this.activation;
    if (this.phase !== 'active' || !activeAtCall) return coordinatorError('conflict');
    const activationId = activeAtCall.activationId;
    const watermark = Math.max(
      activeAtCall.persistedRevision,
      this.pending?.snapshot.revision ?? -1,
      this.inFlight?.snapshot.revision ?? -1,
    );
    let latestReceipt: SaveReceipt | null = null;

    while (true) {
      if (this.pending || this.inFlight || this.drainPromise) {
        const drained = await this.ensureDrain();
        if (!drained.ok) return drained;
        latestReceipt = drained.value ?? latestReceipt;
      }
      const active = this.activation;
      if (this.phase !== 'active' || !active || active.activationId !== activationId) {
        return coordinatorError('conflict', activeAtCall.projectId);
      }
      if (active.persistedRevision >= watermark) {
        if (this.protectionPromise) {
          try {
            await this.protectionPromise;
          } catch {
            // The canonical save already protected this watermark. Only wait
            // for the physical draft write to settle before switching state.
          }
          continue;
        }
        return {
          ok: true,
          value: {
            receipt: latestReceipt,
            recoveryReceipt: null,
            clean: this.pending === null && this.inFlight === null,
            persistedRevision: active.persistedRevision,
          },
        };
      }
      if (!this.pending && !this.inFlight) return coordinatorError('write-failed', active.projectId);
    }
  }

  flushSynchronously(): RepositoryResult<CoordinatorFlush> {
    const active = this.activation;
    if (this.phase !== 'active' || !active) return coordinatorError('write-failed');
    const recoveryTarget = this.pending ?? this.inFlight;
    if (recoveryTarget && canSaveRecoverySynchronously(this.repository)) {
      // Page lifecycle writes must never bypass an async repository's cross-tab
      // lock or overtake its canonical head. Journal even when no local request
      // is in flight; the next bootstrap promotes it through normal locked I/O.
      const recovered = this.repository.saveRecoverySynchronously(
        this.requestFor(
          recoveryTarget,
          active,
          this.pending && this.inFlight ? this.inFlight.writeId : undefined,
        ),
      );
      if (!recovered.ok) return recovered;
      if (
        recovered.value.projectId !== recoveryTarget.snapshot.project.id ||
        recovered.value.activationId !== recoveryTarget.snapshot.activationId ||
        recovered.value.revision !== recoveryTarget.snapshot.revision ||
        recovered.value.writeId !== recoveryTarget.writeId
      ) {
        return coordinatorError('write-failed', active.projectId);
      }
      active.protectedRevision = Math.max(
        active.protectedRevision,
        recoveryTarget.snapshot.revision,
      );
      active.protectedWriteId = recoveryTarget.writeId;
      return {
        ok: true,
        value: {
          receipt: null,
          recoveryReceipt: recovered.value,
          clean: false,
          persistedRevision: active.persistedRevision,
        },
      };
    }
    if (this.inFlight || this.drainPromise) {
      return coordinatorError('sync-unsupported', active.projectId);
    }
    const queued = this.pending;
    if (!queued) {
      return {
        ok: true,
        value: {
          receipt: null,
          recoveryReceipt: null,
          clean: true,
          persistedRevision: active.persistedRevision,
        },
      };
    }
    if (!canSaveSynchronously(this.repository)) {
      return coordinatorError('sync-unsupported', active.projectId);
    }
    this.pending = null;
    const result = this.repository.saveSynchronously(this.requestFor(queued, active));
    if (!result.ok) {
      this.restoreAfterFailure(queued);
      return result;
    }
    if (!this.receiptMatches(result.value, queued)) {
      this.restoreAfterFailure(queued);
      return coordinatorError('write-failed', active.projectId);
    }
    active.persistedRevision = Math.max(active.persistedRevision, queued.snapshot.revision);
    active.protectedRevision = Math.max(active.protectedRevision, queued.snapshot.revision);
    active.protectedWriteId = queued.writeId;
    active.headVersion = result.value.headVersion;
    return {
      ok: true,
      value: {
        receipt: result.value,
        recoveryReceipt: null,
        clean: this.pending === null,
        persistedRevision: active.persistedRevision,
      },
    };
  }

  isDirty(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  persistedRevision(): number {
    return this.activation?.persistedRevision ?? -1;
  }

  protectedRevision(): number {
    return this.activation?.protectedRevision ?? -1;
  }

  currentHeadVersion(): string | null | undefined {
    return this.activation?.headVersion;
  }

  private isSealed(): boolean {
    return this.phase === 'sealed';
  }

  /**
   * Permanently prevents this coordinator from producing any more durable
   * writes. Queued work is discarded immediately; a physical save that has
   * already entered the repository is allowed only to settle. Unlike
   * cancelAndWait(), sealing never reloads durable state and can never be
   * reversed or reactivated.
   */
  sealAndWait(): Promise<void> {
    if (this.sealPromise) return this.sealPromise;

    this.phase = 'sealed';
    this.pending = null;
    this.protectionPending = null;
    const settling = this.drainPromise;
    const protectionSettling = this.protectionPromise;
    this.sealPromise = (async () => {
      await Promise.allSettled([
        ...(settling ? [settling] : []),
        ...(protectionSettling ? [protectionSettling] : []),
      ]);
      this.pending = null;
      this.inFlight = null;
      this.protectionPending = null;
      this.protectionInFlight = null;
      this.activation = null;
    })();
    return this.sealPromise;
  }

  /** Rejects new enqueue, clears queued work, and waits for physical I/O. */
  async cancelAndWait(
    projectId: string,
    activationId: string,
  ): Promise<RepositoryResult<CoordinatorCancellation>> {
    const active = this.activation;
    if (
      this.phase !== 'active' ||
      !active ||
      active.projectId !== projectId ||
      active.activationId !== activationId
    ) {
      return coordinatorError('conflict', projectId);
    }
    this.phase = 'cancelling';
    const cancelledPending = this.pending;
    this.pending = null;
    const cancelledProtectionPending = this.protectionPending;
    this.protectionPending = null;
    const settling = this.inFlight;
    const restoreCancelledWork = (): void => {
      if (this.isSealed()) {
        this.pending = null;
        this.inFlight = null;
        this.protectionPending = null;
        this.protectionInFlight = null;
        this.activation = null;
        return;
      }
      const latest =
        cancelledPending &&
        (!settling || cancelledPending.snapshot.revision >= settling.snapshot.revision)
          ? cancelledPending
          : settling;
      this.inFlight = null;
      this.activation = active;
      this.phase = 'active';
      if (latest) this.pending = latest;
      const latestProtection =
        cancelledProtectionPending &&
        cancelledProtectionPending.snapshot.revision > active.protectedRevision
          ? cancelledProtectionPending
          : null;
      if (latestProtection) this.protectionPending = latestProtection;
    };
    let receipt: SaveReceipt | null = null;
    if (this.drainPromise) {
      try {
        const drained = await this.drainPromise;
        if (drained.ok && drained.value) {
          receipt = drained.value;
          active.persistedRevision = Math.max(active.persistedRevision, receipt.revision);
          active.headVersion = receipt.headVersion;
        }
      } catch {
        // The repository contract uses Result, but physical completion is all a
        // deletion needs before committing its tombstone.
      }
    }
    if (this.protectionPromise) {
      try {
        const protectedResult = await this.protectionPromise;
        if (protectedResult.ok && protectedResult.value) {
          active.protectedRevision = Math.max(
            active.protectedRevision,
            protectedResult.value.revision,
          );
          active.protectedWriteId = protectedResult.value.writeId;
        }
      } catch {
        // Physical settlement is required before delete/reactivation; a
        // canonical reconciliation below remains authoritative.
      }
    }
    if (this.isSealed()) {
      this.pending = null;
      this.inFlight = null;
      this.protectionPending = null;
      this.protectionInFlight = null;
      this.activation = null;
      return coordinatorError('conflict', projectId);
    }
    if (!receipt) {
      // A transport/response failure may happen after the repository has
      // physically committed the write. Re-read the durable head before
      // handing a deletion or reactivation a stale compare-and-swap token.
      let reconciled: Awaited<ReturnType<ProjectRepository['load']>>;
      try {
        reconciled = await this.repository.load(projectId);
      } catch {
        reconciled = coordinatorError('read-failed', projectId);
      }
      if (this.isSealed()) {
        this.pending = null;
        this.inFlight = null;
        this.protectionPending = null;
        this.protectionInFlight = null;
        this.activation = null;
        return coordinatorError('conflict', projectId);
      }
      if (!reconciled.ok) {
        restoreCancelledWork();
        return reconciled;
      }
      const durableHeadVersion = reconciled.value?.headVersion ?? null;
      if (settling && durableHeadVersion !== active.headVersion) {
        const expected = encodeProjectJson(settling.snapshot.project);
        const actual = reconciled.value ? encodeProjectJson(reconciled.value.project) : null;
        if (
          !reconciled.value ||
          reconciled.value.recovered ||
          !expected.ok ||
          !actual?.ok ||
          expected.json !== actual.json
        ) {
          restoreCancelledWork();
          return coordinatorError('conflict', projectId);
        }
        active.headVersion = durableHeadVersion;
        active.persistedRevision = Math.max(
          active.persistedRevision,
          settling.snapshot.revision,
        );
      }
    }
    if (this.isSealed()) {
      this.pending = null;
      this.inFlight = null;
      this.protectionPending = null;
      this.protectionInFlight = null;
      this.activation = null;
      return coordinatorError('conflict', projectId);
    }
    const cancellation: CoordinatorCancellation = {
      headVersion: active.headVersion,
      persistedRevision: active.persistedRevision,
      receipt,
    };
    this.inFlight = null;
    this.protectionInFlight = null;
    this.protectionPending = null;
    this.activation = null;
    this.phase = 'inactive';
    return { ok: true, value: cancellation };
  }
}
