// localStorage persistence for projects.
//
// Keys follow `cts.project.<id>`. All JSON.parse is guarded so corrupt or
// foreign entries never crash the app. Works against any Storage-shaped object,
// so tests can inject a stub.

import { deserializeProject, validateProject, type Project } from '@cts/project-model';
import { formatDiagnosticValue, loadDiagnostics, recordDiagnostic } from '../platform/diagnostics';

const KEY_PREFIX = 'cts.project.';
const BACKUP_KEY_PREFIX = 'cts.projectBackup.';
const MAX_RECOVERY_DETAIL_LENGTH = 600;
const DEFAULT_PROJECT_SUMMARY_TITLE = '無題のプロジェクト';
const MAX_PROJECT_SUMMARY_TITLE_LENGTH = 80;
const MAX_DIAGNOSTIC_KEY_LENGTH = 120;
const MAX_DIAGNOSTIC_DETAIL_LENGTH = 600;

export type ProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type ProjectRecoveryIssue = {
  key: string;
  reason: 'invalid-json' | 'invalid-shape' | 'invalid-project' | 'unsupported-schema';
  detail: string;
};

export type BeforeUnloadTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/** Resolve the active Storage, or null when none is available (e.g. SSR). */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed contexts.
  }
  return null;
}

function getBeforeUnloadTarget(): BeforeUnloadTarget | null {
  if (typeof window === 'undefined') return null;
  return window;
}

/** Build the storage key for a project id. */
export function projectKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/** Build the storage key for the previous known-good copy of a project. */
export function projectBackupKey(id: string): string {
  return `${BACKUP_KEY_PREFIX}${id}`;
}

function projectIdFromKey(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  return key.slice(KEY_PREFIX.length);
}

/** Persist a project under its id. Returns true on success. */
export function saveProject(project: Project, storage: Storage | null = getStorage()): boolean {
  if (!storage) return false;
  const key = projectKey(project.id);
  let payload = '';
  try {
    payload = JSON.stringify(project);
    preservePreviousValidProject(project.id, key, storage);
    storage.setItem(key, payload);
    return true;
  } catch (error) {
    recordProjectSaveFailure(key, payload.length, error, storage);
    return false;
  }
}

function recordProjectSaveFailure(
  key: string,
  payloadLength: number,
  error: unknown,
  storage: Storage,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  recordDiagnostic(
    'storage-save',
    `Project save failed. key=${diagnosticStorageKey(
      key,
    )}; payloadBytes=${payloadLength}; detail=${diagnosticDetail(detail)}`,
    {},
    storage,
    null,
  );
}

function preservePreviousValidProject(id: string, key: string, storage: Storage): void {
  const existing = storage.getItem(key);
  if (!existing) return;
  const result = parseProject(existing, key);
  if (!result.project) return;
  try {
    storage.setItem(projectBackupKey(id), existing);
  } catch {
    // A backup failure must not block the primary save attempt.
  }
}

/** Flush debounced persistence synchronously before a page reload/navigation. */
export function installBeforeUnloadFlush(
  flush: () => boolean,
  target: BeforeUnloadTarget | null = getBeforeUnloadTarget(),
): () => void {
  if (!target) return () => {};
  const flushBeforeExit = (): void => {
    flush();
  };
  target.addEventListener('beforeunload', flushBeforeExit);
  target.addEventListener('pagehide', flushBeforeExit);
  return () => {
    target.removeEventListener('beforeunload', flushBeforeExit);
    target.removeEventListener('pagehide', flushBeforeExit);
  };
}

/** Load one project by id, or null if missing/corrupt. */
export function loadProject(id: string, storage: Storage | null = getStorage()): Project | null {
  if (!storage) return null;
  const key = projectKey(id);
  const raw = storage.getItem(key);
  if (!raw) return null;
  const result = parseRecoverableProject(raw, key, storage);
  if (result.issue) recordProjectRecoveryIssue(result.issue, storage);
  return result.project;
}

/** Parse + minimally validate a stored project string. */
function parseProject(raw: string, key: string): { project: Project | null; issue: ProjectRecoveryIssue | null } {
  try {
    const project = deserializeProject(raw);
    if (!isProjectLike(project)) {
      return {
        project: null,
        issue: makeRecoveryIssue(key, 'invalid-shape', 'Saved project is missing required fields.'),
      };
    }

    const validation = validateProject(project);
    if (!validation.ok) {
      return {
        project: null,
        issue: makeRecoveryIssue(
          key,
          'invalid-project',
          validation.errors
            .slice(0, 4)
            .map((error) => `${error.path}: ${error.message}`)
            .join('; '),
        ),
      };
    }

    return { project, issue: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      project: null,
      issue: makeRecoveryIssue(key, isSchemaError(detail) ? 'unsupported-schema' : 'invalid-json', detail),
    };
  }
}

function parseRecoverableProject(
  raw: string,
  key: string,
  storage: Storage,
): { project: Project | null; issue: ProjectRecoveryIssue | null } {
  const primary = parseProject(raw, key);
  if (!primary.issue) return primary;

  const id = projectIdFromKey(key);
  if (!id) return primary;
  const backupRaw = storage.getItem(projectBackupKey(id));
  if (!backupRaw) return primary;

  const backup = parseProject(backupRaw, projectBackupKey(id));
  if (!backup.project) return primary;

  recordProjectBackupRecovery(key, primary.issue, storage);
  repairPrimaryProjectFromBackup(key, backupRaw, storage);
  return { project: backup.project, issue: null };
}

function repairPrimaryProjectFromBackup(key: string, backupRaw: string, storage: Storage): void {
  try {
    storage.setItem(key, backupRaw);
  } catch {
    // The caller can still use the recovered project even if self-repair fails.
  }
}

function isSchemaError(detail: string): boolean {
  return detail.includes('schemaVersion') || detail.includes('migration');
}

function makeRecoveryIssue(
  key: string,
  reason: ProjectRecoveryIssue['reason'],
  detail: string,
): ProjectRecoveryIssue {
  return {
    key,
    reason,
    detail: detail.slice(0, MAX_RECOVERY_DETAIL_LENGTH),
  };
}

function recordProjectRecoveryIssue(issue: ProjectRecoveryIssue, storage: Storage): void {
  const message = `Saved project was skipped. key=${diagnosticStorageKey(issue.key)}; reason=${
    issue.reason
  }; detail=${diagnosticDetail(issue.detail)}`;
  const alreadyRecorded = loadDiagnostics(storage).some(
    (entry) => entry.kind === 'storage-recovery' && entry.message === message,
  );
  if (alreadyRecorded) return;
  recordDiagnostic(
    'storage-recovery',
    message,
    {},
    storage,
    null,
  );
}

function recordProjectBackupRecovery(key: string, issue: ProjectRecoveryIssue, storage: Storage): void {
  const message = `Saved project recovered from backup. key=${diagnosticStorageKey(
    key,
  )}; reason=${issue.reason}; detail=${diagnosticDetail(issue.detail)}`;
  const alreadyRecorded = loadDiagnostics(storage).some(
    (entry) => entry.kind === 'storage-recovery' && entry.message === message,
  );
  if (alreadyRecorded) return;
  recordDiagnostic(
    'storage-recovery',
    message,
    {},
    storage,
    null,
  );
}

function diagnosticStorageKey(key: string): string {
  return formatDiagnosticValue(key, MAX_DIAGNOSTIC_KEY_LENGTH);
}

function diagnosticDetail(detail: string): string {
  return formatDiagnosticValue(detail, MAX_DIAGNOSTIC_DETAIL_LENGTH);
}

export function normalizeProjectSummaryTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return DEFAULT_PROJECT_SUMMARY_TITLE;
  if (normalized.length <= MAX_PROJECT_SUMMARY_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_PROJECT_SUMMARY_TITLE_LENGTH - 3)}...`;
}

/** Narrow an unknown value to a Project with the fields we rely on. */
function isProjectLike(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.schemaVersion === 'number' &&
    typeof v.title === 'string' &&
    typeof v.bpm === 'number' &&
    typeof v.updatedAt === 'string' &&
    Array.isArray(v.timeSignature) &&
    v.timeSignature.length === 2 &&
    typeof v.key === 'string' &&
    typeof v.scale === 'string' &&
    typeof v.lengthBars === 'number' &&
    Array.isArray(v.tracks) &&
    Array.isArray(v.chordTrack) &&
    Array.isArray(v.sections)
  );
}

/** List saved project summaries, newest first. */
export function listSavedProjects(storage: Storage | null = getStorage()): ProjectSummary[] {
  if (!storage) return [];
  const summaries: ProjectSummary[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    const result = parseRecoverableProject(raw, key, storage);
    if (result.issue) recordProjectRecoveryIssue(result.issue, storage);
    const { project } = result;
    if (!project) continue;
    summaries.push({
      id: project.id,
      title: normalizeProjectSummaryTitle(project.title),
      updatedAt: project.updatedAt,
    });
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/** List saved project entries that could not be restored. */
export function listProjectRecoveryIssues(storage: Storage | null = getStorage()): ProjectRecoveryIssue[] {
  if (!storage) return [];
  const issues: ProjectRecoveryIssue[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    const { project, issue } = parseRecoverableProject(raw, key, storage);
    if (project) continue;
    if (!issue) continue;
    recordProjectRecoveryIssue(issue, storage);
    issues.push(issue);
  }
  return issues;
}

/** Delete one saved project entry only when it is known to be unrecoverable. */
export function deleteProjectRecoveryIssue(
  key: string,
  storage: Storage | null = getStorage(),
): boolean {
  if (!storage || !key.startsWith(KEY_PREFIX)) return false;
  const raw = storage.getItem(key);
  if (!raw) return false;
  const { project, issue } = parseRecoverableProject(raw, key, storage);
  if (project) return false;
  if (!issue) return false;
  try {
    storage.removeItem(key);
    const id = projectIdFromKey(key);
    if (id) storage.removeItem(projectBackupKey(id));
    return true;
  } catch {
    return false;
  }
}

/** Delete every saved project entry that cannot be restored. */
export function deleteProjectRecoveryIssues(storage: Storage | null = getStorage()): number {
  if (!storage) return 0;
  let deleted = 0;
  const issues = listProjectRecoveryIssues(storage);
  for (const issue of issues) {
    if (deleteProjectRecoveryIssue(issue.key, storage)) deleted += 1;
  }
  return deleted;
}

/** Load the most recently updated saved project, or null. */
export function loadMostRecentProject(storage: Storage | null = getStorage()): Project | null {
  const summaries = listSavedProjects(storage);
  const first = summaries[0];
  if (!first) return null;
  return loadProject(first.id, storage);
}

/** Delete a saved project by id. Returns true on success. */
export function deleteProject(id: string, storage: Storage | null = getStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(projectKey(id));
    storage.removeItem(projectBackupKey(id));
    return true;
  } catch {
    return false;
  }
}
