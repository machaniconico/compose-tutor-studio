// Local-only diagnostic logging for supportability.
//
// This intentionally never sends data over the network. It stores a small,
// bounded, path-redacted log in localStorage so a user can copy it when asking
// for help after a crash.

export type DiagnosticKind =
  | 'render-error'
  | 'window-error'
  | 'unhandled-rejection'
  | 'storage-recovery'
  | 'storage-save'
  | 'audio-playback'
  | 'template-load'
  | 'import-midi'
  | 'project-import'
  | 'project-export'
  | 'export-midi'
  | 'export-wav';

export type DiagnosticEntry = {
  id: string;
  kind: DiagnosticKind;
  message: string;
  stack: string | null;
  componentStack: string | null;
  occurredAt: string;
  userAgent: string | null;
};

export type DiagnosticTarget = Pick<Window, 'addEventListener' | 'removeEventListener' | 'navigator'>;

export const DIAGNOSTIC_LOG_KEY = 'cts.diagnostics.v1';
const MAX_DIAGNOSTICS = 20;
const MAX_TEXT_LENGTH = 6000;

export function appVersion(): string {
  return typeof __CTS_APP_VERSION__ === 'string' ? __CTS_APP_VERSION__ : 'development';
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed contexts.
  }
  return null;
}

function getTarget(): DiagnosticTarget | null {
  if (typeof window === 'undefined') return null;
  return window;
}

function makeId(): string {
  return `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s)"']+/g, 'file:///[local-path]')
    .replace(/\\\\\?\\[A-Za-z]:\\[^\s)"']+/g, '[local-path]')
    .replace(/[A-Za-z]:\\[^\s)"']+/g, '[local-path]')
    .replace(/[A-Za-z]:\/[^\s)"']+/g, '[local-path]')
    .replace(/\\\\[^\\\s)"']+\\[^\s)"']+/g, '[local-path]')
    .replace(/(?:\/Users|\/home|\/tmp|\/var\/folders)\/[^\s)"']+/g, '[local-path]')
    .replace(/~\/[^\s)"']+/g, '[local-path]')
    .replace(/file:\/\/\/[^\s)"']+/g, 'file:///[local-path]')
    .slice(0, MAX_TEXT_LENGTH);
}

function normalizeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: sanitizeDiagnosticText(error.message || error.name || 'Unknown error'),
      stack: error.stack ? sanitizeDiagnosticText(error.stack) : null,
    };
  }
  if (typeof error === 'string') {
    return { message: sanitizeDiagnosticText(error), stack: null };
  }
  try {
    return { message: sanitizeDiagnosticText(JSON.stringify(error)), stack: null };
  } catch {
    return { message: 'Unknown error', stack: null };
  }
}

function parseDiagnostics(raw: string | null): DiagnosticEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isDiagnosticEntry).slice(0, MAX_DIAGNOSTICS);
  } catch {
    return [];
  }
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.kind === 'render-error' ||
      v.kind === 'window-error' ||
      v.kind === 'unhandled-rejection' ||
      v.kind === 'storage-recovery' ||
      v.kind === 'storage-save' ||
      v.kind === 'audio-playback' ||
      v.kind === 'template-load' ||
      v.kind === 'import-midi' ||
      v.kind === 'project-import' ||
      v.kind === 'project-export' ||
      v.kind === 'export-midi' ||
      v.kind === 'export-wav') &&
    typeof v.message === 'string' &&
    (typeof v.stack === 'string' || v.stack === null) &&
    (typeof v.componentStack === 'string' || v.componentStack === null) &&
    typeof v.occurredAt === 'string' &&
    (typeof v.userAgent === 'string' || v.userAgent === null)
  );
}

export function loadDiagnostics(storage: Storage | null = getStorage()): DiagnosticEntry[] {
  if (!storage) return [];
  return parseDiagnostics(storage.getItem(DIAGNOSTIC_LOG_KEY));
}

export function clearDiagnostics(storage: Storage | null = getStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(DIAGNOSTIC_LOG_KEY);
    return true;
  } catch {
    return false;
  }
}

export function recordDiagnostic(
  kind: DiagnosticKind,
  error: unknown,
  options: { componentStack?: string | null } = {},
  storage: Storage | null = getStorage(),
  target: DiagnosticTarget | null = getTarget(),
): DiagnosticEntry | null {
  if (!storage) return null;
  const normalized = normalizeError(error);
  const entry: DiagnosticEntry = {
    id: makeId(),
    kind,
    message: normalized.message,
    stack: normalized.stack,
    componentStack: options.componentStack
      ? sanitizeDiagnosticText(options.componentStack)
      : null,
    occurredAt: new Date().toISOString(),
    userAgent: target?.navigator?.userAgent ?? null,
  };

  try {
    const next = [entry, ...loadDiagnostics(storage)].slice(0, MAX_DIAGNOSTICS);
    storage.setItem(DIAGNOSTIC_LOG_KEY, JSON.stringify(next));
    return entry;
  } catch {
    return null;
  }
}

function formatDiagnosticKindSummary(entries: DiagnosticEntry[]): string[] {
  if (entries.length === 0) return ['summary by kind: none'];
  const counts = new Map<DiagnosticKind, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const rows = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([kind, count]) => `- ${kind}: ${count}`);
  return ['summary by kind:', ...rows];
}

export function formatDiagnosticReport(entries: DiagnosticEntry[]): string {
  const header = [
    'Compose Tutor Studio diagnostics',
    `version: ${appVersion()}`,
    `generated: ${new Date().toISOString()}`,
    'privacy: local-only log, paths redacted, not sent automatically',
  ];

  if (entries.length === 0) {
    return [...header, 'entries: 0', ...formatDiagnosticKindSummary(entries), 'No diagnostic entries.'].join('\n');
  }
  return [
    ...header,
    `entries: ${entries.length}`,
    ...formatDiagnosticKindSummary(entries),
    ...entries.map((entry) =>
      [
        '',
        `id: ${entry.id}`,
        `kind: ${entry.kind}`,
        `time: ${entry.occurredAt}`,
        `user agent: ${entry.userAgent ?? '(unknown)'}`,
        `message: ${sanitizeDiagnosticText(entry.message)}`,
        entry.stack ? `stack:\n${sanitizeDiagnosticText(entry.stack)}` : 'stack: (none)',
        entry.componentStack
          ? `component stack:\n${sanitizeDiagnosticText(entry.componentStack)}`
          : 'component stack: (none)',
      ].join('\n'),
    ),
  ].join('\n');
}

export function installGlobalDiagnostics(
  target: DiagnosticTarget | null = getTarget(),
  storage: Storage | null = getStorage(),
): () => void {
  if (!target) return () => {};

  const onError = (event: Event): void => {
    const errorEvent = event as ErrorEvent;
    recordDiagnostic(
      'window-error',
      errorEvent.error ?? errorEvent.message ?? 'Window error',
      {},
      storage,
      target,
    );
  };

  const onUnhandledRejection = (event: Event): void => {
    const rejection = event as PromiseRejectionEvent;
    recordDiagnostic(
      'unhandled-rejection',
      rejection.reason ?? 'Unhandled promise rejection',
      {},
      storage,
      target,
    );
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
