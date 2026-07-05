import { describe, expect, it } from 'vitest';
import type { DiagnosticEntry } from '../src/platform/diagnostics';
import {
  diagnosticKindLabel,
  formatSupportDiagnosticTime,
  isBackupRecoveryDiagnostic,
  summarizeRecentDiagnostics,
} from '../src/features/support/SupportMenu';

function diagnostic(overrides: Partial<DiagnosticEntry>): DiagnosticEntry {
  return {
    id: 'diag_default',
    kind: 'window-error',
    message: 'default message',
    stack: null,
    componentStack: null,
    occurredAt: '2026-07-01T00:00:00.000Z',
    userAgent: 'test-agent',
    ...overrides,
  };
}

describe('support menu diagnostics summary', () => {
  it('labels recent diagnostic kinds with beginner-readable support categories', () => {
    expect(diagnosticKindLabel('storage-save')).toBe('保存');
    expect(diagnosticKindLabel('audio-playback')).toBe('音声');
    expect(diagnosticKindLabel('import-midi')).toBe('MIDI読み込み');
    expect(diagnosticKindLabel('export-wav')).toBe('WAV書き出し');
  });

  it('formats diagnostic timestamps without locale-dependent output', () => {
    expect(formatSupportDiagnosticTime('2026-07-01T09:30:45.000Z')).toBe('2026-07-01 09:30 UTC');
    expect(formatSupportDiagnosticTime('not-a-date')).toBe('日時不明');
  });

  it('summarizes the newest five diagnostics with redacted and bounded messages', () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      diagnostic({
        id: `diag_${index}`,
        kind: index === 0 ? 'project-export' : 'window-error',
        message:
          index === 0
            ? `Failed at C:\\Users\\tester\\song-${index}.ctsproj ${'x'.repeat(160)}`
            : `message ${index}`,
      }),
    );

    const summaries = summarizeRecentDiagnostics(entries);

    expect(summaries).toHaveLength(5);
    expect(summaries.map((entry) => entry.id)).toEqual(['diag_0', 'diag_1', 'diag_2', 'diag_3', 'diag_4']);
    expect(summaries[0]?.label).toBe('プロジェクト書き出し');
    expect(summaries[0]?.message).toContain('[local-path]');
    expect(summaries[0]?.message).not.toContain('C:\\Users\\tester');
    expect(summaries[0]?.message.length).toBeLessThanOrEqual(120);
  });

  it('distinguishes backup recovery from unrecoverable saved project diagnostics', () => {
    expect(
      isBackupRecoveryDiagnostic(
        diagnostic({
          kind: 'storage-recovery',
          message:
            'Saved project recovered from backup. key=cts.project.demo; reason=invalid-json; detail=broken',
        }),
      ),
    ).toBe(true);
    expect(
      isBackupRecoveryDiagnostic(
        diagnostic({
          kind: 'storage-recovery',
          message:
            'Saved project was skipped. key=cts.project.demo; reason=invalid-json; detail=broken',
        }),
      ),
    ).toBe(false);
  });
});
