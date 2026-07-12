export type RuntimeDiagnosticStage =
  | 'render'
  | 'startup'
  | 'bootstrap-recovered'
  | 'close-guard'
  | 'deferred-feature'
  | 'window-error'
  | 'unhandled-rejection';

export type RuntimeDiagnosticKind =
  | 'error'
  | 'type-error'
  | 'range-error'
  | 'reference-error'
  | 'syntax-error'
  | 'dom-exception'
  | 'non-error';

export type RuntimeDiagnostic = Readonly<{
  schemaVersion: 1;
  id: string;
  stage: RuntimeDiagnosticStage;
  kind: RuntimeDiagnosticKind;
  runtime: 'web' | 'native';
  fingerprint: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  occurrences: number;
}>;

export type RuntimeDiagnosticInput = Readonly<{
  stage: RuntimeDiagnosticStage;
  error: unknown;
  runtime?: 'web' | 'native';
  now?: Date;
}>;

export type DiagnosticCopyResult = 'copied' | 'unavailable' | 'failed';

const MAX_RUNTIME_DIAGNOSTICS = 20;
const diagnostics: RuntimeDiagnostic[] = [];

function createSessionSalt(): string {
  try {
    const bytes = new Uint32Array(2);
    crypto.getRandomValues(bytes);
    return `${bytes[0]?.toString(16)}${bytes[1]?.toString(16)}`;
  } catch {
    // The salt is never exported. This fallback still prevents the report from
    // exposing the unhashed source when Web Crypto is unavailable.
    return `${Date.now().toString(16)}${Math.random().toString(16)}`;
  }
}

const sessionSalt = createSessionSalt();

function detectRuntime(): 'web' | 'native' {
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      ? 'native'
      : 'web';
  } catch {
    return 'web';
  }
}

function diagnosticKind(error: unknown): RuntimeDiagnosticKind {
  try {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return 'dom-exception';
    }
    if (error instanceof TypeError) return 'type-error';
    if (error instanceof RangeError) return 'range-error';
    if (error instanceof ReferenceError) return 'reference-error';
    if (error instanceof SyntaxError) return 'syntax-error';
    if (error instanceof Error) return 'error';
  } catch {
    return 'non-error';
  }
  return 'non-error';
}

/** Salted FNV-1a is only a process-local correlation token; raw input is never retained. */
function fingerprint(source: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    value ^= source.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function fingerprintSource(stage: RuntimeDiagnosticStage, error: unknown): string {
  try {
    if (error instanceof Error) {
      // Messages/stacks may contain titles, filenames, or local paths. They are
      // used transiently for correlation and are never retained or exported.
      const name = String(error.name).slice(0, 128);
      const stack = typeof error.stack === 'string' ? error.stack.slice(0, 16_384) : '';
      return `${stage}\u0000${name}\u0000${stack}`;
    }
  } catch {
    return `${stage}\u0000uninspectable`;
  }
  return `${stage}\u0000${typeof error}`;
}

function safeTimestamp(now: Date | undefined): string {
  try {
    const candidate = now ?? new Date();
    return Number.isFinite(candidate.getTime())
      ? candidate.toISOString()
      : new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Record only allowlisted metadata in a bounded, process-memory ring.
 * No exception message, stack, project content, filename, or path is retained.
 */
export function recordRuntimeDiagnostic(input: RuntimeDiagnosticInput): RuntimeDiagnostic {
  const occurredAt = safeTimestamp(input.now);
  const eventFingerprint = fingerprint(
    `${sessionSalt}\u0000${fingerprintSource(input.stage, input.error)}`,
  );
  const existingIndex = diagnostics.findIndex(
    (entry) => entry.stage === input.stage && entry.fingerprint === eventFingerprint,
  );
  if (existingIndex >= 0) {
    const existing = diagnostics[existingIndex]!;
    const updated: RuntimeDiagnostic = {
      ...existing,
      lastOccurredAt: occurredAt,
      occurrences: existing.occurrences + 1,
    };
    diagnostics[existingIndex] = updated;
    return updated;
  }

  const entry: RuntimeDiagnostic = {
    schemaVersion: 1,
    id: `runtime-${input.stage}-${eventFingerprint}`,
    stage: input.stage,
    kind: diagnosticKind(input.error),
    runtime: input.runtime ?? detectRuntime(),
    fingerprint: eventFingerprint,
    firstOccurredAt: occurredAt,
    lastOccurredAt: occurredAt,
    occurrences: 1,
  };
  diagnostics.push(entry);
  if (diagnostics.length > MAX_RUNTIME_DIAGNOSTICS) diagnostics.shift();
  return entry;
}

/**
 * Last-resort callers must not let diagnostics replace the original failure.
 * This wrapper deliberately swallows every instrumentation error.
 */
export function tryRecordRuntimeDiagnostic(
  input: RuntimeDiagnosticInput,
): RuntimeDiagnostic | null {
  try {
    return recordRuntimeDiagnostic(input);
  } catch {
    return null;
  }
}

export function getRuntimeDiagnostics(): readonly RuntimeDiagnostic[] {
  return diagnostics.map((entry) => ({ ...entry }));
}

export function formatRuntimeDiagnosticReport(): string {
  try {
    return `${JSON.stringify(
      {
        schemaVersion: 1,
        product: 'Compose Tutor Studio',
        appVersion: __CTS_APP_VERSION__,
        privacy:
          'No project content, title, filename, local path, raw error message, or stack is included.',
        diagnostics: getRuntimeDiagnostics(),
      },
      null,
      2,
    )}\n`;
  } catch {
    // Keep a useful, privacy-safe handoff available even if instrumentation is
    // damaged. This literal cannot include project or exception data.
    return '{\n  "schemaVersion": 1,\n  "product": "Compose Tutor Studio",\n  "privacy": "Diagnostics could not be formatted; no project content was collected.",\n  "diagnostics": []\n}\n';
  }
}

export async function copyRuntimeDiagnosticReport(
  writeText?: (value: string) => Promise<void>,
): Promise<DiagnosticCopyResult> {
  let writer = writeText;
  if (!writer) {
    try {
      writer = navigator.clipboard?.writeText.bind(navigator.clipboard);
    } catch {
      writer = undefined;
    }
  }
  if (!writer) return 'unavailable';
  try {
    await writer(formatRuntimeDiagnosticReport());
    return 'copied';
  } catch {
    return 'failed';
  }
}

let globalHandlersRegistered = false;

/** Capture unexpected global failures for an explicit, local support handoff. */
export function registerGlobalRuntimeDiagnostics(): void {
  if (globalHandlersRegistered || typeof window === 'undefined') return;
  try {
    window.addEventListener('error', (event) => {
      tryRecordRuntimeDiagnostic({
        stage: 'window-error',
        error: event.error ?? 'script-error',
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      tryRecordRuntimeDiagnostic({ stage: 'unhandled-rejection', error: event.reason });
    });
    globalHandlersRegistered = true;
  } catch {
    // Diagnostics must never become a second startup failure.
  }
}

/** Test isolation only. Production diagnostics are intentionally memory-only. */
export function __resetRuntimeDiagnosticsForTest(): void {
  diagnostics.length = 0;
}
