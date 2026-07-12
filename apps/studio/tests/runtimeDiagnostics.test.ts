import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRuntimeDiagnosticsForTest,
  copyRuntimeDiagnosticReport,
  formatRuntimeDiagnosticReport,
  getRuntimeDiagnostics,
  recordRuntimeDiagnostic,
  tryRecordRuntimeDiagnostic,
} from '../src/platform/runtimeDiagnostics';

beforeEach(() => {
  __resetRuntimeDiagnosticsForTest();
});

describe('runtime diagnostics privacy boundary', () => {
  it('retains only allowlisted metadata and never exports raw user/error text', () => {
    const secretTitle = '秘密の曲名';
    const secretPath = '/Users/example/private/song.ctsproj.json';
    const error = new TypeError(`${secretTitle} failed at ${secretPath}`);
    error.stack = `TypeError: ${secretTitle}\n    at ${secretPath}:12:3`;

    const entry = recordRuntimeDiagnostic({
      stage: 'render',
      error,
      runtime: 'native',
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    const report = formatRuntimeDiagnosticReport();

    expect(entry.kind).toBe('type-error');
    expect(entry.fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(report).not.toContain(secretTitle);
    expect(report).not.toContain(secretPath);
    expect(report).not.toContain(error.message);
    expect(report).not.toContain('TypeError:');
    expect(report).toContain('No project content');
  });

  it('deduplicates identical failures and bounds the in-memory ring', () => {
    const duplicate = new Error('same private message');
    duplicate.stack = 'Error: private\n    at stable-frame';
    recordRuntimeDiagnostic({ stage: 'render', error: duplicate });
    recordRuntimeDiagnostic({ stage: 'render', error: duplicate });
    expect(getRuntimeDiagnostics()).toHaveLength(1);
    expect(getRuntimeDiagnostics()[0]?.occurrences).toBe(2);

    for (let index = 0; index < 25; index += 1) {
      const error = new Error(`private-${index}`);
      error.stack = `Error: private-${index}\n    at frame-${index}`;
      recordRuntimeDiagnostic({ stage: 'startup', error });
    }
    expect(getRuntimeDiagnostics()).toHaveLength(20);
    expect(getRuntimeDiagnostics().every((entry) => entry.schemaVersion === 1)).toBe(true);
  });

  it('copies only the sanitized report and fails closed when clipboard is unavailable', async () => {
    recordRuntimeDiagnostic({ stage: 'startup', error: new Error('never copy this') });
    const writer = vi.fn(async (_value: string) => undefined);

    await expect(copyRuntimeDiagnosticReport(writer)).resolves.toBe('copied');
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0]?.[0]).not.toContain('never copy this');
    await expect(copyRuntimeDiagnosticReport(undefined)).resolves.toBe('unavailable');
  });

  it('never replaces the original failure when recording or formatting diagnostics fails', () => {
    const hostileInput = new Proxy(
      {},
      {
        get() {
          throw new Error('instrumentation getter failed');
        },
      },
    );
    expect(
      tryRecordRuntimeDiagnostic(
        hostileInput as Parameters<typeof tryRecordRuntimeDiagnostic>[0],
      ),
    ).toBeNull();

    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('formatter failed');
    });
    const report = formatRuntimeDiagnosticReport();
    stringify.mockRestore();

    expect(report).toContain('Diagnostics could not be formatted');
    expect(report).toContain('"diagnostics": []');
    expect(report).not.toContain('instrumentation getter failed');
  });
});
