import { encodeProjectJson } from '@cts/project-model';
import { crc32 } from './checksum';
import type {
  CrashDraftCapability,
  CrashDraftReceipt,
  LoadedProject,
  ProjectBranch,
  ProjectBranchSummary,
  ProjectRepository,
  ProjectSummary,
  RecoveryReceipt,
  RemoveReceipt,
  RemoveRequest,
  RepositoryKind,
  RepositoryResult,
  SaveReceipt,
  SaveRequest,
  SynchronousRecoveryCapability,
} from './contracts';
import { canStageCrashDraft } from './contracts';
import {
  NativeRecoveryJournal,
  type NativeRecoveryEntry,
  type ReadyNativeRecoveryEntry,
} from './native-recovery-journal';

const MAX_LOOKUP_ID_LENGTH = 4_096;
const NATIVE_BRANCH_PREFIX = 'native-recovery-branch-v1-';
const NATIVE_BRANCH_PATTERN = /^native-recovery-branch-v1-[0-9a-f]{16}$/;

type StickyJournalErrorCode = 'unsupported-version' | 'migration-failed';

const DIAGNOSTIC_PRIORITY = {
  'corrupt-data': 1,
  'migration-failed': 2,
  'unsupported-version': 3,
} as const;

export type NativeRecoveryProjectRepositoryOptions = Readonly<{
  /** Canonical repository, normally the Tauri/SQLite adapter. */
  delegate: ProjectRepository;
  /** Synchronous local journal used only for emergency snapshots and branches. */
  journal: NativeRecoveryJournal;
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidLookup(projectId?: string): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'load',
      code: 'invalid-project',
      retry: 'never',
      ...(projectId !== undefined ? { projectId } : {}),
    },
  };
}

function conflict(projectId: string): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'load',
      code: 'conflict',
      retry: 'manual',
      projectId,
    },
  };
}

function journalReadFailure(projectId: string): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'load',
      code: 'read-failed',
      retry: 'automatic',
      projectId,
    },
  };
}

function journalSaveReadFailure(projectId: string): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'save',
      code: 'read-failed',
      retry: 'automatic',
      projectId,
    },
  };
}

function stickyJournalFailure(
  operation: 'load' | 'save' | 'remove',
  code: StickyJournalErrorCode,
  projectId: string,
): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation,
      code,
      retry: 'never',
      projectId,
    },
  };
}

function unreadableLoadFailure(
  code: 'corrupt-data' | 'unsupported-version' | 'migration-failed' | 'conflict',
  projectId: string,
): RepositoryResult<never> {
  return {
    ok: false,
    error: {
      operation: 'load',
      code,
      retry: code === 'conflict' ? 'manual' : 'never',
      projectId,
    },
  };
}

function isStickyJournalError(
  code: 'corrupt-data' | 'unsupported-version' | 'migration-failed' | undefined,
): code is StickyJournalErrorCode {
  return code === 'unsupported-version' || code === 'migration-failed';
}

function stickyJournalError(
  entries: readonly NativeRecoveryEntry[],
  projectId: string,
): StickyJournalErrorCode | undefined {
  let code: StickyJournalErrorCode | undefined;
  for (const entry of entries) {
    if (
      entry.status !== 'unreadable' ||
      entry.projectId !== projectId ||
      !isStickyJournalError(entry.errorCode)
    ) {
      continue;
    }
    if (entry.errorCode === 'unsupported-version') return entry.errorCode;
    code = entry.errorCode;
  }
  return code;
}

function validLookupId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_LOOKUP_ID_LENGTH;
}

function branchIdFor(entry: ReadyNativeRecoveryEntry): string {
  const identity = `${entry.storageKey}\u0000${entry.rawFingerprint}`;
  const first = crc32(`cts-native-branch-v1:first\u0000${identity}`).slice(6);
  const second = crc32(`cts-native-branch-v1:second\u0000${identity}`).slice(6);
  return `${NATIVE_BRANCH_PREFIX}${first}${second}`;
}

function branchSummary(entry: ReadyNativeRecoveryEntry): ProjectBranchSummary {
  return {
    branchId: branchIdFor(entry),
    source: 'recovery-journal',
    activationId: entry.activationId,
    revision: entry.revision,
    writeId: entry.writeId,
    savedAt: entry.savedAt,
    title: entry.project.title,
    updatedAt: entry.project.updatedAt,
  };
}

function compareReadyEntries(
  left: ReadyNativeRecoveryEntry,
  right: ReadyNativeRecoveryEntry,
): number {
  return (
    compareText(left.projectId, right.projectId) ||
    compareText(left.activationId, right.activationId) ||
    right.revision - left.revision ||
    compareText(left.writeId, right.writeId) ||
    compareText(left.storageKey, right.storageKey) ||
    compareText(left.rawFingerprint, right.rawFingerprint)
  );
}

function compareBranches(left: ProjectBranchSummary, right: ProjectBranchSummary): number {
  return (
    compareText(left.activationId, right.activationId) ||
    right.revision - left.revision ||
    compareText(left.writeId, right.writeId) ||
    compareText(left.source, right.source) ||
    compareText(left.branchId, right.branchId)
  );
}

function saveRequestFor(entry: ReadyNativeRecoveryEntry): SaveRequest {
  return {
    project: entry.project,
    activationId: entry.activationId,
    revision: entry.revision,
    writeId: entry.writeId,
    ...(entry.baseHeadKnown ? { expectedHeadVersion: entry.baseHeadVersion } : {}),
    ...(entry.predecessorWriteId !== undefined
      ? { predecessorWriteId: entry.predecessorWriteId }
      : {}),
  };
}

function receiptMatches(receipt: SaveReceipt, request: SaveRequest): boolean {
  return (
    receipt.projectId === request.project.id &&
    receipt.activationId === request.activationId &&
    receipt.revision === request.revision &&
    receipt.writeId === request.writeId
  );
}

function exactSameRevision(entry: ReadyNativeRecoveryEntry, request: SaveRequest): boolean {
  if (
    entry.revision !== request.revision ||
    entry.writeId !== request.writeId
  ) {
    return false;
  }
  const journalProject = encodeProjectJson(entry.project);
  const committedProject = encodeProjectJson(request.project);
  return (
    journalProject.ok &&
    committedProject.ok &&
    journalProject.json === committedProject.json
  );
}

/**
 * Adds a synchronous emergency journal to an async canonical repository.
 *
 * Canonical availability wins: journal enumeration failures never turn a
 * successful canonical initialize, list, save, load, or close into a failure.
 * An explicit journal-branch load and the synchronous pagehide write still
 * report journal failures because those operations have no canonical fallback.
 */
export class NativeRecoveryProjectRepository
  implements ProjectRepository, SynchronousRecoveryCapability
{
  readonly kind: RepositoryKind;
  declare readonly stageCrashDraft?: CrashDraftCapability['stageCrashDraft'];
  private readonly delegate: ProjectRepository;
  private readonly journal: NativeRecoveryJournal;
  private initializeFlight: Promise<RepositoryResult<void>> | null = null;

  constructor(options: NativeRecoveryProjectRepositoryOptions) {
    this.delegate = options.delegate;
    this.journal = options.journal;
    this.kind = options.delegate.kind;
    if (canStageCrashDraft(options.delegate)) {
      const crashDraftDelegate = options.delegate;
      this.stageCrashDraft = (request) =>
        this.stageCrashDraftWithJournalPolicy(crashDraftDelegate, request);
    }
  }

  private async stageCrashDraftWithJournalPolicy(
    delegate: ProjectRepository & CrashDraftCapability,
    request: SaveRequest,
  ): Promise<RepositoryResult<CrashDraftReceipt>> {
    let listed: ReturnType<NativeRecoveryJournal['list']> | null = null;
    try {
      listed = this.journal.list(request.project.id);
    } catch {
      // Journal availability never downgrades native SQLite crash protection.
    }
    if (listed?.ok) {
      const stickyError = stickyJournalError(listed.value, request.project.id);
      if (stickyError && !(await this.durableProjectIsDeleted(request.project.id))) {
        return stickyJournalFailure('save', stickyError, request.project.id);
      }
    }
    return delegate.stageCrashDraft(request);
  }

  private async durableProjectIsDeleted(projectId: string): Promise<boolean> {
    if (!this.delegate.getDurableProjectState) return false;
    try {
      const state = await this.delegate.getDurableProjectState(projectId);
      return state.ok && state.value === 'deleted';
    } catch {
      return false;
    }
  }

  initialize(): Promise<RepositoryResult<void>> {
    if (this.initializeFlight) return this.initializeFlight;
    this.initializeFlight = this.initializeAndReplay().finally(() => {
      this.initializeFlight = null;
    });
    return this.initializeFlight;
  }

  private async initializeAndReplay(): Promise<RepositoryResult<void>> {
    const initialized = await this.delegate.initialize();
    if (!initialized.ok) return initialized;

    let listed: ReturnType<NativeRecoveryJournal['list']>;
    try {
      listed = this.journal.list();
    } catch {
      return initialized;
    }
    if (!listed.ok) return initialized;

    const blockedProjects = new Set(
      listed.value
        .filter((entry) => entry.status === 'unreadable' && entry.projectId !== undefined)
        .map((entry) => entry.projectId as string),
    );
    const ready = listed.value
      .filter((entry): entry is ReadyNativeRecoveryEntry => entry.status === 'ready')
      .sort(compareReadyEntries);
    const byProject = new Map<string, ReadyNativeRecoveryEntry[]>();
    for (const entry of ready) {
      const entries = byProject.get(entry.projectId) ?? [];
      entries.push(entry);
      byProject.set(entry.projectId, entries);
    }

    // More than one activation for the same project is an incomparable branch
    // set. Stable lexical order must never be mistaken for causal authority.
    const replayable = [...byProject.values()]
      .filter(
        (entries) => entries.length === 1 && !blockedProjects.has(entries[0]!.projectId),
      )
      .map((entries) => entries[0]!)
      .sort(compareReadyEntries);
    for (const entry of replayable) {
      const request = saveRequestFor(entry);
      let saved: RepositoryResult<SaveReceipt>;
      try {
        saved = await this.delegate.save(request);
      } catch {
        continue;
      }
      if (!saved.ok || !receiptMatches(saved.value, request)) continue;
      // removeExact re-reads the raw fingerprint, so a journal replaced while
      // replay was awaiting SQLite cannot be removed accidentally.
      try {
        this.journal.removeExact(entry);
      } catch {
        // The canonical commit is already durable. A duplicate branch is safe.
      }
    }
    return initialized;
  }

  async list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    const canonical = await this.delegate.list();
    if (!canonical.ok) return canonical;

    let journalEntries: ReturnType<NativeRecoveryJournal['list']>;
    try {
      journalEntries = this.journal.list();
    } catch {
      return canonical;
    }
    if (!journalEntries.ok) return canonical;
    const diagnostics = new Map<
      string,
      'corrupt-data' | 'unsupported-version' | 'migration-failed'
    >();
    for (const entry of journalEntries.value) {
      if (entry.status !== 'unreadable' || entry.projectId === undefined) continue;
      const current = diagnostics.get(entry.projectId);
      if (!current || DIAGNOSTIC_PRIORITY[entry.errorCode] > DIAGNOSTIC_PRIORITY[current]) {
        diagnostics.set(entry.projectId, entry.errorCode);
      }
    }
    const ready = journalEntries.value
      .filter(
        (entry): entry is ReadyNativeRecoveryEntry =>
          entry.status === 'ready' && !isStickyJournalError(diagnostics.get(entry.projectId)),
      )
      .sort(compareReadyEntries);
    if (ready.length === 0 && diagnostics.size === 0) return canonical;

    const byProject = new Map<string, ReadyNativeRecoveryEntry[]>();
    for (const entry of ready) {
      const entries = byProject.get(entry.projectId) ?? [];
      entries.push(entry);
      byProject.set(entry.projectId, entries);
    }

    const verifiedDeleted = new Set<string>();
    if (this.delegate.getDurableProjectState) {
      const canonicalReady = new Set(
        canonical.value
          .filter((summary) => summary.status === 'ready')
          .map((summary) => summary.id),
      );
      const states = await Promise.all(
        [...new Set([...byProject.keys(), ...diagnostics.keys()])]
          .filter(
            (projectId) =>
              !canonicalReady.has(projectId) ||
              isStickyJournalError(diagnostics.get(projectId)),
          )
          .map(async (projectId) => {
            try {
              return [projectId, await this.delegate.getDurableProjectState!(projectId)] as const;
            } catch {
              return [projectId, null] as const;
            }
          }),
      );
      for (const [projectId, state] of states) {
        const diagnostic = diagnostics.get(projectId);
        if (state?.ok && state.value === 'deleted') {
          verifiedDeleted.add(projectId);
          byProject.delete(projectId);
          diagnostics.delete(projectId);
        } else if (!state?.ok && !isStickyJournalError(diagnostic)) {
          byProject.delete(projectId);
          diagnostics.delete(projectId);
        }
      }
    }

    const summaries = canonical.value
      .filter((summary) => !verifiedDeleted.has(summary.id))
      .map((summary): ProjectSummary => {
        const diagnostic = diagnostics.get(summary.id);
        if (isStickyJournalError(diagnostic)) {
          diagnostics.delete(summary.id);
          byProject.delete(summary.id);
          return {
            status: 'unreadable',
            id: summary.id,
            errorCode: diagnostic,
            branches: [],
          };
        }
        diagnostics.delete(summary.id);
        const entries = byProject.get(summary.id);
        if (!entries) return summary;
        byProject.delete(summary.id);
        const nativeBranches = entries.map(branchSummary);
        const branchIds = new Set<string>();
        const branches = [...summary.branches, ...nativeBranches]
          .filter((branch) => {
            if (branchIds.has(branch.branchId)) return false;
            branchIds.add(branch.branchId);
            return true;
          })
          .sort(compareBranches);
        return { ...summary, branches };
      });

    for (const [projectId, errorCode] of diagnostics) {
      if (isStickyJournalError(errorCode)) byProject.delete(projectId);
    }

    for (const [projectId, entries] of [...byProject.entries()].sort(([left], [right]) =>
      compareText(left, right),
    )) {
      summaries.push({
        status: 'unreadable',
        id: projectId,
        errorCode: 'conflict',
        branches: entries.map(branchSummary).sort(compareBranches),
      });
      diagnostics.delete(projectId);
    }
    for (const [projectId, errorCode] of [...diagnostics.entries()].sort(([left], [right]) =>
      compareText(left, right),
    )) {
      summaries.push({
        status: 'unreadable',
        id: projectId,
        errorCode,
        branches: [],
      });
    }
    return { ok: true, value: summaries };
  }

  async load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    if (!validLookupId(id)) return this.delegate.load(id);
    let listed: ReturnType<NativeRecoveryJournal['list']>;
    try {
      listed = this.journal.list(id);
    } catch {
      return this.delegate.load(id);
    }
    if (!listed.ok) return this.delegate.load(id);
    const stickyError = stickyJournalError(listed.value, id);
    if (!stickyError) return this.delegate.load(id);
    if (await this.durableProjectIsDeleted(id)) return { ok: true, value: null };
    return stickyJournalFailure('load', stickyError, id);
  }

  async loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    const listed = await this.list();
    if (!listed.ok) return listed;
    const ready = listed.value.find((entry) => entry.status === 'ready');
    if (ready?.status === 'ready') return this.load(ready.id);
    const unreadable = listed.value.find((entry) => entry.status === 'unreadable');
    return unreadable?.status === 'unreadable'
      ? unreadableLoadFailure(unreadable.errorCode, unreadable.id)
      : { ok: true, value: null };
  }

  async loadProjectBranch(
    projectId: string,
    branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>> {
    if (!validLookupId(projectId) || !validLookupId(branchId)) return invalidLookup(projectId);
    const nativeBranch = NATIVE_BRANCH_PATTERN.test(branchId);
    let listed: ReturnType<NativeRecoveryJournal['list']>;
    try {
      listed = this.journal.list(projectId);
    } catch {
      return nativeBranch
        ? journalReadFailure(projectId)
        : this.delegate.loadProjectBranch
          ? this.delegate.loadProjectBranch(projectId, branchId)
          : { ok: true, value: null };
    }
    if (!listed.ok) {
      return nativeBranch
        ? {
            ok: false,
            error: { ...listed.error, operation: 'load', projectId },
          }
        : this.delegate.loadProjectBranch
          ? this.delegate.loadProjectBranch(projectId, branchId)
          : { ok: true, value: null };
    }
    const stickyError = stickyJournalError(listed.value, projectId);
    if (stickyError) {
      if (await this.durableProjectIsDeleted(projectId)) return { ok: true, value: null };
      return stickyJournalFailure('load', stickyError, projectId);
    }
    if (!nativeBranch) {
      return this.delegate.loadProjectBranch
        ? this.delegate.loadProjectBranch(projectId, branchId)
        : { ok: true, value: null };
    }

    if (this.delegate.getDurableProjectState) {
      let state: Awaited<ReturnType<NonNullable<ProjectRepository['getDurableProjectState']>>>;
      try {
        state = await this.delegate.getDurableProjectState(projectId);
      } catch {
        return conflict(projectId);
      }
      if (!state.ok) return state;
      if (state.value === 'deleted') return { ok: true, value: null };
    }

    const matches = listed.value.filter(
      (entry): entry is ReadyNativeRecoveryEntry =>
        entry.status === 'ready' && branchIdFor(entry) === branchId,
    );
    if (matches.length > 1) return conflict(projectId);
    const entry = matches[0];
    if (!entry) return { ok: true, value: null };
    return {
      ok: true,
      value: { ...branchSummary(entry), project: entry.project },
    };
  }

  async save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    let listed: ReturnType<NativeRecoveryJournal['list']> | null = null;
    try {
      listed = this.journal.list(request.project.id);
    } catch {
      // Journal availability never downgrades a canonical save.
    }
    if (listed?.ok) {
      const stickyError = stickyJournalError(listed.value, request.project.id);
      if (stickyError && !(await this.durableProjectIsDeleted(request.project.id))) {
        return stickyJournalFailure('save', stickyError, request.project.id);
      }
    }
    const saved = await this.delegate.save(request);
    if (!saved.ok || !receiptMatches(saved.value, request)) return saved;
    this.cleanupAfterCanonicalSave(request);
    return saved;
  }

  private cleanupAfterCanonicalSave(request: SaveRequest): void {
    let listed: ReturnType<NativeRecoveryJournal['list']>;
    try {
      listed = this.journal.list(request.project.id);
    } catch {
      return;
    }
    if (!listed.ok) return;
    for (const entry of listed.value) {
      if (entry.status !== 'ready' || entry.activationId !== request.activationId) continue;
      const superseded = entry.revision < request.revision;
      if (!superseded && !exactSameRevision(entry, request)) continue;
      try {
        this.journal.removeExact(entry);
      } catch {
        // Canonical success is never downgraded by best-effort cleanup.
      }
    }
  }

  async remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    let snapshot: readonly NativeRecoveryEntry[] | null = null;
    try {
      const listed = this.journal.list(request.projectId);
      if (listed.ok) snapshot = listed.value;
    } catch {
      // Canonical deletion can still commit, but no journal cleanup is safe.
    }

    const stickyError = snapshot
      ? stickyJournalError(snapshot, request.projectId)
      : undefined;
    if (stickyError) {
      const alreadyDeleted = await this.durableProjectIsDeleted(request.projectId);
      if (!alreadyDeleted) {
        return stickyJournalFailure('remove', stickyError, request.projectId);
      }
    }

    const removed = await this.delegate.remove(request);
    if (!removed.ok) return removed;

    let journalCleanupComplete = snapshot !== null;
    if (
      removed.value.projectId !== request.projectId ||
      removed.value.deleteId !== request.deleteId
    ) {
      journalCleanupComplete = false;
    } else if (snapshot) {
      for (const entry of snapshot) {
        if (entry.status === 'unreadable' && isStickyJournalError(entry.errorCode)) {
          journalCleanupComplete = false;
          continue;
        }
        try {
          const cleanup = this.journal.removeExact(entry);
          if (!cleanup.ok || !cleanup.value) journalCleanupComplete = false;
        } catch {
          journalCleanupComplete = false;
        }
      }
      try {
        const remaining = this.journal.list(request.projectId);
        if (!remaining.ok || remaining.value.length > 0) journalCleanupComplete = false;
      } catch {
        journalCleanupComplete = false;
      }
    }
    return {
      ok: true,
      value: {
        ...removed.value,
        cleanupComplete: removed.value.cleanupComplete && journalCleanupComplete,
      },
    };
  }

  close(): Promise<RepositoryResult<void>> {
    return this.delegate.close();
  }

  saveRecoverySynchronously(request: SaveRequest): RepositoryResult<RecoveryReceipt> {
    let projectId: unknown;
    try {
      projectId = request.project.id;
    } catch {
      return this.journal.saveRecoverySynchronously(request);
    }
    if (typeof projectId !== 'string' || !validLookupId(projectId)) {
      return this.journal.saveRecoverySynchronously(request);
    }
    let listed: ReturnType<NativeRecoveryJournal['list']>;
    try {
      listed = this.journal.list(projectId);
    } catch {
      return journalSaveReadFailure(projectId);
    }
    if (!listed.ok) {
      return {
        ok: false,
        error: { ...listed.error, operation: 'save', projectId },
      };
    }
    const stickyError = stickyJournalError(listed.value, projectId);
    if (stickyError) return stickyJournalFailure('save', stickyError, projectId);
    return this.journal.saveRecoverySynchronously(request);
  }
}
