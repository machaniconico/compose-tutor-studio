// localStorage persistence for projects.
//
// Keys follow `cts.project.<id>`. All JSON.parse is guarded so corrupt or
// foreign entries never crash the app. Works against any Storage-shaped object,
// so tests can inject a stub.

import type { Project } from '@cts/project-model';

const KEY_PREFIX = 'cts.project.';

export type ProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

/** Resolve the active Storage, or null when none is available (e.g. SSR). */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed contexts.
  }
  return null;
}

/** Build the storage key for a project id. */
export function projectKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/** Persist a project under its id. Returns true on success. */
export function saveProject(project: Project, storage: Storage | null = getStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(projectKey(project.id), JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

/** Load one project by id, or null if missing/corrupt. */
export function loadProject(id: string, storage: Storage | null = getStorage()): Project | null {
  if (!storage) return null;
  const raw = storage.getItem(projectKey(id));
  if (!raw) return null;
  return parseProject(raw);
}

/** Parse + minimally validate a stored project string. */
function parseProject(raw: string): Project | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isProjectLike(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/** Narrow an unknown value to a Project with the fields we rely on. */
function isProjectLike(value: unknown): value is Project {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.updatedAt === 'string' &&
    Array.isArray(v.tracks) &&
    Array.isArray(v.chordTrack)
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
    const project = parseProject(raw);
    if (!project) continue;
    summaries.push({ id: project.id, title: project.title, updatedAt: project.updatedAt });
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
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
    return true;
  } catch {
    return false;
  }
}
