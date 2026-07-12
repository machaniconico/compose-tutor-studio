import {
  LocalStorageProjectRepository,
  legacyProjectKey,
  type PersistenceError,
  type PersistenceErrorCode,
  type ProjectRepository,
  type RetryPolicy,
  type StorageLike,
} from '@cts/project-persistence';

/** Failures that the save status UI can explain to a beginner. */
export type SaveFailureCode =
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

export type SaveFailure = Readonly<{
  code: SaveFailureCode;
  retry: RetryPolicy;
}>;

function browserStorage(): StorageLike | null {
  // Accessing the global itself can throw in sandboxed/private contexts. The
  // repository calls this provider inside its structured error boundary.
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function createBrowserProjectRepository(
  storage: StorageLike | (() => StorageLike | null) | null = browserStorage,
): ProjectRepository & LocalStorageProjectRepository {
  return new LocalStorageProjectRepository({
    storage,
    retainGenerations: 3,
  });
}

export const browserProjectRepository = createBrowserProjectRepository();

export function toSaveFailure(error: PersistenceError): SaveFailure {
  return {
    code: error.code as Extract<PersistenceErrorCode, SaveFailureCode>,
    retry: error.retry,
  };
}

/** Legacy raw JSON mirror retained for compatibility with pre-repository builds. */
export const projectKey = legacyProjectKey;
