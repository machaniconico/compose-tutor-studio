// Export history persistence helpers. The storage-facing functions accept an
// optional Storage object so the core behavior stays easy to test.

export const EXPORT_HISTORY_STORAGE_KEY = 'cts.exportHistory';
export const EXPORT_HISTORY_LIMIT = 50;

export type ExportHistoryKind = 'midi' | 'wav' | 'project';

export type ExportHistoryEntry = {
  kind: ExportHistoryKind;
  fileName: string;
  exportedAt: string;
  projectId: string;
};

export type ExportHistoryInput = {
  kind: ExportHistoryKind;
  fileName: string;
  projectId: string;
  exportedAt?: string;
};

const KIND_LABELS: Record<ExportHistoryKind, string> = {
  midi: 'MIDI',
  wav: 'WAV',
  project: 'プロジェクト',
};

const KIND_ICONS: Record<ExportHistoryKind, string> = {
  midi: '♪',
  wav: '波',
  project: '箱',
};

/** Add one export entry, newest first, while enforcing the history cap. */
export function addExportHistoryEntry(
  history: ExportHistoryEntry[],
  input: ExportHistoryInput,
  limit = EXPORT_HISTORY_LIMIT,
): ExportHistoryEntry[] {
  const entry: ExportHistoryEntry = {
    kind: input.kind,
    fileName: input.fileName,
    projectId: input.projectId,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
  };

  return [entry, ...history].slice(0, Math.max(0, limit));
}

/** Read export history from localStorage-compatible storage. */
export function loadExportHistory(storage: Storage | null = getLocalStorage()): ExportHistoryEntry[] {
  if (!storage) return [];

  try {
    const raw = storage.getItem(EXPORT_HISTORY_STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isExportHistoryEntry)
      .sort((a, b) => Date.parse(b.exportedAt) - Date.parse(a.exportedAt))
      .slice(0, EXPORT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Persist one successful export and return the updated newest-first history. */
export function recordExportHistory(
  input: ExportHistoryInput,
  storage: Storage | null = getLocalStorage(),
): ExportHistoryEntry[] {
  if (!storage) return [];

  const next = addExportHistoryEntry(loadExportHistory(storage), input);

  try {
    storage.setItem(EXPORT_HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return loadExportHistory(storage);
  }

  return next;
}

/** Remove all stored export history. */
export function clearExportHistory(storage: Storage | null = getLocalStorage()): boolean {
  if (!storage) return false;

  try {
    storage.removeItem(EXPORT_HISTORY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Short Japanese label for the export kind. */
export function formatExportKindJa(kind: ExportHistoryKind): string {
  return KIND_LABELS[kind];
}

/** Compact visual marker for the export kind. */
export function getExportKindIcon(kind: ExportHistoryKind): string {
  return KIND_ICONS[kind];
}

/** Beginner-friendly Japanese relative time for the history list. */
export function formatExportRelativeTimeJa(exportedAt: string, now = new Date()): string {
  const exportedTime = Date.parse(exportedAt);
  const nowTime = now.getTime();
  if (Number.isNaN(exportedTime) || Number.isNaN(nowTime)) return '日時不明';

  const elapsedSeconds = Math.max(0, Math.floor((nowTime - exportedTime) / 1000));
  if (elapsedSeconds < 60) return 'たった今';

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}時間前`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}日前`;

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}か月前`;

  return `${Math.floor(elapsedMonths / 12)}年前`;
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isExportHistoryEntry(value: unknown): value is ExportHistoryEntry {
  if (!value || typeof value !== 'object') return false;

  const entry = value as Partial<ExportHistoryEntry>;
  return (
    isExportHistoryKind(entry.kind) &&
    typeof entry.fileName === 'string' &&
    entry.fileName.length > 0 &&
    typeof entry.projectId === 'string' &&
    entry.projectId.length > 0 &&
    typeof entry.exportedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.exportedAt))
  );
}

function isExportHistoryKind(value: unknown): value is ExportHistoryKind {
  return value === 'midi' || value === 'wav' || value === 'project';
}
