import { describe, expect, it } from 'vitest';
import {
  clearDiagnostics,
  DIAGNOSTIC_LOG_KEY,
  formatDiagnosticReport,
  installGlobalDiagnostics,
  loadDiagnostics,
  recordDiagnostic,
  sanitizeDiagnosticText,
} from '../src/platform/diagnostics';
import { MemoryStorage } from './localStorageStub';

function makeDiagnosticTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    target: {
      navigator: { userAgent: 'test-agent' },
      addEventListener(type: string, listener: (event: Event) => void): void {
        const set = listeners.get(type) ?? new Set<(event: Event) => void>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (event: Event) => void): void {
        listeners.get(type)?.delete(listener);
      },
    } as Window,
    dispatch(type: string, event: Event): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('diagnostics', () => {
  it('records bounded local diagnostics newest first', () => {
    const storage = new MemoryStorage();

    for (let i = 0; i < 25; i += 1) {
      recordDiagnostic('window-error', new Error(`boom ${i}`), {}, storage, null);
    }

    const entries = loadDiagnostics(storage);
    expect(entries).toHaveLength(20);
    expect(entries[0]?.message).toBe('boom 24');
    expect(entries[19]?.message).toBe('boom 5');
  });

  it('ignores corrupt stored diagnostic JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(DIAGNOSTIC_LOG_KEY, '{not json');

    expect(loadDiagnostics(storage)).toEqual([]);
  });

  it('redacts local paths from messages and stacks', () => {
    const storage = new MemoryStorage();
    const error = new Error('Failed at D:\\Users\\name\\song.ctsproj.json');
    error.stack = 'Error: no\n    at D:\\workspace\\compose-tutor-studio\\src\\App.tsx:1:1';

    recordDiagnostic('render-error', error, { componentStack: 'at D:\\secret\\Component.tsx' }, storage, null);
    const [entry] = loadDiagnostics(storage);

    expect(entry?.message).toContain('[local-path]');
    expect(entry?.message).not.toContain('Users');
    expect(entry?.stack).toContain('[local-path]');
    expect(entry?.componentStack).toContain('[local-path]');
  });

  it('redacts UNC, long Windows, and POSIX local paths', () => {
    const message = [
      'share=\\\\server\\Music\\song.ctsproj.json',
      'long=\\\\?\\C:\\Users\\name\\song.wav',
      'vite=C:/Users/name/project/src/App.tsx',
      'file=file:///C:/Users/name/project/src/App.tsx',
      'mac=/Users/name/Music/song.ctsproj.json',
      'linux=/home/name/song.mid',
      'tmp=/tmp/cts-export/song.wav',
      'home=~/Music/song.wav',
    ].join(' ');

    const sanitized = sanitizeDiagnosticText(message);

    expect(sanitized).toContain('[local-path]');
    expect(sanitized).not.toContain('server\\Music');
    expect(sanitized).not.toContain('C:\\Users');
    expect(sanitized).not.toContain('C:/Users');
    expect(sanitized).not.toContain('file:///C:/Users');
    expect(sanitized).not.toContain('/Users/name');
    expect(sanitized).not.toContain('/home/name');
    expect(sanitized).not.toContain('/tmp/cts-export');
    expect(sanitized).not.toContain('~/Music');
  });

  it('formats a copyable support report', () => {
    const storage = new MemoryStorage();
    const { target } = makeDiagnosticTarget();
    recordDiagnostic('unhandled-rejection', 'lost promise', {}, storage, target);

    const report = formatDiagnosticReport(loadDiagnostics(storage));

    expect(report).toContain('Compose Tutor Studio diagnostics');
    expect(report).toContain('version:');
    expect(report).toContain('privacy: local-only log, paths redacted, not sent automatically');
    expect(report).toContain('user agent: test-agent');
    expect(report).toContain('unhandled-rejection');
    expect(report).toContain('lost promise');
  });

  it('includes a diagnostic kind summary before detailed entries', () => {
    const storage = new MemoryStorage();
    recordDiagnostic('project-import', 'bad project', {}, storage, null);
    recordDiagnostic('export-wav', 'wav failed 1', {}, storage, null);
    recordDiagnostic('export-wav', 'wav failed 2', {}, storage, null);

    const report = formatDiagnosticReport(loadDiagnostics(storage));

    expect(report).toContain('summary by kind:');
    expect(report).toContain('- export-wav: 2');
    expect(report).toContain('- project-import: 1');
    expect(report.indexOf('summary by kind:')).toBeLessThan(report.indexOf('id:'));
  });

  it('includes an empty diagnostic kind summary for clean reports', () => {
    const report = formatDiagnosticReport([]);

    expect(report).toContain('entries: 0');
    expect(report).toContain('summary by kind: none');
  });

  it('records export failures for support without leaking local paths', () => {
    const storage = new MemoryStorage();
    const error = new Error('Write failed at C:\\Users\\name\\song.wav');

    recordDiagnostic('export-wav', error, {}, storage, null);
    recordDiagnostic('export-midi', 'MIDI writer failed', {}, storage, null);
    recordDiagnostic('project-export', 'Project export failed', {}, storage, null);
    recordDiagnostic('import-midi', 'MIDI import failed', {}, storage, null);
    recordDiagnostic('audio-playback', 'AudioContext resume failed', {}, storage, null);
    recordDiagnostic('template-load', 'Template failed', {}, storage, null);

    const report = formatDiagnosticReport(loadDiagnostics(storage));
    expect(report).toContain('export-wav');
    expect(report).toContain('export-midi');
    expect(report).toContain('project-export');
    expect(report).toContain('import-midi');
    expect(report).toContain('MIDI import failed');
    expect(report).toContain('audio-playback');
    expect(report).toContain('AudioContext resume failed');
    expect(report).toContain('template-load');
    expect(report).toContain('Template failed');
    expect(report).toContain('[local-path]');
    expect(report).not.toContain('C:\\Users\\name');
  });

  it('redacts local paths when formatting pre-existing diagnostics', () => {
    const report = formatDiagnosticReport([
      {
        id: 'diag_legacy',
        kind: 'window-error',
        message: 'Failed at C:\\Users\\name\\song.ctsproj.json',
        stack: 'Error: failed\n    at C:\\workspace\\compose-tutor-studio\\src\\App.tsx:1:1',
        componentStack: 'at C:\\secret\\Component.tsx',
        occurredAt: '2026-06-23T00:00:00.000Z',
        userAgent: 'test-agent',
      },
    ]);

    expect(report).toContain('[local-path]');
    expect(report).not.toContain('C:\\Users\\name');
    expect(report).not.toContain('C:\\workspace');
    expect(report).not.toContain('C:\\secret');
  });

  it('clears stored diagnostics', () => {
    const storage = new MemoryStorage();
    recordDiagnostic('window-error', 'boom', {}, storage, null);

    expect(clearDiagnostics(storage)).toBe(true);
    expect(loadDiagnostics(storage)).toEqual([]);
  });

  it('installs and disposes global error listeners', () => {
    const storage = new MemoryStorage();
    const { target, dispatch, listenerCount } = makeDiagnosticTarget();

    const dispose = installGlobalDiagnostics(target, storage);
    expect(listenerCount('error')).toBe(1);
    expect(listenerCount('unhandledrejection')).toBe(1);

    dispatch('error', { message: 'window boom' } as ErrorEvent);
    dispatch('unhandledrejection', { reason: 'promise boom' } as PromiseRejectionEvent);
    expect(loadDiagnostics(storage).map((entry) => entry.message)).toEqual([
      'promise boom',
      'window boom',
    ]);

    dispose();
    expect(listenerCount('error')).toBe(0);
    expect(listenerCount('unhandledrejection')).toBe(0);
  });

  it('truncates long diagnostic text', () => {
    const sanitized = sanitizeDiagnosticText('x'.repeat(7000));
    expect(sanitized.length).toBeLessThan(7000);
  });
});
