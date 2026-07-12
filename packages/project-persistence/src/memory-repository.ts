import { decodeProjectJson, encodeProjectJson } from '@cts/project-model';
import type {
  LoadedProject,
  ProjectBranch,
  ProjectRepository,
  ProjectSummary,
  RemoveReceipt,
  RemoveRequest,
  RepositoryResult,
  SaveReceipt,
  SaveRequest,
} from './contracts';

/** Deterministic repository for domain and coordinator tests. */
export class MemoryProjectRepository implements ProjectRepository {
  readonly kind = 'memory' as const;
  private readonly projects = new Map<
    string,
    {
      json: string;
      headVersion: string;
      savedAt: string;
      writeId: string;
      activationId: string;
      revision: number;
    }
  >();
  private readonly tombstones = new Map<string, { deleteId: string; headVersion: string }>();
  private ordinal = 0;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  initialize(): Promise<RepositoryResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  list(): Promise<RepositoryResult<readonly ProjectSummary[]>> {
    const value: ProjectSummary[] = [];
    for (const [id, stored] of this.projects) {
      const decoded = decodeProjectJson(stored.json);
      if (!decoded.ok) {
        value.push({ status: 'unreadable', id, errorCode: 'corrupt-data', branches: [] });
      } else {
        value.push({
          status: 'ready',
          id,
          title: decoded.project.title,
          updatedAt: decoded.project.updatedAt,
          recovered: false,
          branches: [],
        });
      }
    }
    value.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ready' ? -1 : 1;
      if (a.status === 'unreadable' || b.status === 'unreadable') return a.id.localeCompare(b.id);
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
    return Promise.resolve({ ok: true, value });
  }

  load(id: string): Promise<RepositoryResult<LoadedProject | null>> {
    const stored = this.projects.get(id);
    if (!stored) return Promise.resolve({ ok: true, value: null });
    const decoded = decodeProjectJson(stored.json);
    if (!decoded.ok) {
      return Promise.resolve({
        ok: false,
        error: { operation: 'load', code: 'corrupt-data', retry: 'never', projectId: id },
      });
    }
    return Promise.resolve({
      ok: true,
      value: {
        project: decoded.project,
        headVersion: stored.headVersion,
        source: 'generation',
        recovered: false,
        recoveryReason: null,
      },
    });
  }

  loadProjectBranch(
    _projectId: string,
    _branchId: string,
  ): Promise<RepositoryResult<ProjectBranch | null>> {
    return Promise.resolve({ ok: true, value: null });
  }

  async loadMostRecent(): Promise<RepositoryResult<LoadedProject | null>> {
    const listed = await this.list();
    if (!listed.ok) return listed;
    const first = listed.value.find((entry) => entry.status === 'ready');
    return first?.status === 'ready' ? this.load(first.id) : { ok: true, value: null };
  }

  save(request: SaveRequest): Promise<RepositoryResult<SaveReceipt>> {
    const encoded = encodeProjectJson(request.project);
    if (!encoded.ok) {
      return Promise.resolve({
        ok: false,
        error: {
          operation: 'save',
          code: encoded.error.code === 'too-large' ? 'too-large' : 'invalid-project',
          retry: 'never',
          projectId: request.project.id,
        },
      });
    }
    const existing = this.projects.get(request.project.id);
    if (
      existing?.writeId === request.writeId &&
      existing.json === encoded.json &&
      existing.activationId === request.activationId &&
      existing.revision === request.revision
    ) {
      return Promise.resolve({
        ok: true,
        value: {
          projectId: request.project.id,
          activationId: request.activationId,
          revision: request.revision,
          writeId: request.writeId,
          headVersion: existing.headVersion,
          savedAt: existing.savedAt,
          bytes: encoded.bytes,
          retainedGenerations: 1,
          legacyMirrorWritten: false,
        },
      });
    }
    const tombstone = this.tombstones.get(request.project.id);
    if (tombstone) {
      return Promise.resolve({
        ok: false,
        error: {
          operation: 'save',
          code: 'conflict',
          retry: 'manual',
          projectId: request.project.id,
        },
      });
    }
    const currentHeadVersion = existing?.headVersion ?? null;
    if (
      request.expectedHeadVersion === undefined ||
      currentHeadVersion !== request.expectedHeadVersion
    ) {
      return Promise.resolve({
        ok: false,
        error: {
          operation: 'save',
          code: 'conflict',
          retry: 'manual',
          projectId: request.project.id,
        },
      });
    }
    this.ordinal += 1;
    const headVersion = `${this.ordinal}:active:${request.writeId}`;
    const savedAt = this.now().toISOString();
    this.projects.set(request.project.id, {
      json: encoded.json,
      headVersion,
      savedAt,
      writeId: request.writeId,
      activationId: request.activationId,
      revision: request.revision,
    });
    this.tombstones.delete(request.project.id);
    return Promise.resolve({
      ok: true,
      value: {
        projectId: request.project.id,
        activationId: request.activationId,
        revision: request.revision,
        writeId: request.writeId,
        headVersion,
        savedAt,
        bytes: encoded.bytes,
        retainedGenerations: 1,
        legacyMirrorWritten: false,
      },
    });
  }

  remove(request: RemoveRequest): Promise<RepositoryResult<RemoveReceipt>> {
    const existing = this.projects.get(request.projectId);
    const tombstone = this.tombstones.get(request.projectId);
    if (tombstone?.deleteId === request.deleteId) {
      return Promise.resolve({
        ok: true,
        value: {
          projectId: request.projectId,
          deleteId: request.deleteId,
          headVersion: tombstone.headVersion,
          removed: true,
          cleanupComplete: true,
        },
      });
    }
    const currentHeadVersion = existing?.headVersion ?? tombstone?.headVersion ?? null;
    if (
      request.expectedHeadVersion === undefined ||
      currentHeadVersion !== request.expectedHeadVersion
    ) {
      return Promise.resolve({
        ok: false,
        error: {
          operation: 'remove',
          code: 'conflict',
          retry: 'manual',
          projectId: request.projectId,
        },
      });
    }
    const removed = this.projects.delete(request.projectId);
    this.ordinal += 1;
    const deletedHeadVersion = `${this.ordinal}:deleted:${request.deleteId}`;
    this.tombstones.set(request.projectId, {
      deleteId: request.deleteId,
      headVersion: deletedHeadVersion,
    });
    return Promise.resolve({
      ok: true,
      value: {
        projectId: request.projectId,
        deleteId: request.deleteId,
        headVersion: deletedHeadVersion,
        removed,
        cleanupComplete: true,
      },
    });
  }

  close(): Promise<RepositoryResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}
