import { describe, expect, it } from 'vitest';
import type { DiagnosticEntry } from '../src/platform/diagnostics';
import {
  diagnosticKindLabel,
  formatSupportDiagnosticTime,
  isBackupRecoveryDiagnostic,
  summarizeProjectRecoveryIssue,
  summarizeRecentDiagnostics,
  summarizeSupportDiagnosticCounts,
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
    expect(diagnosticKindLabel('project-load')).toBe('保存済み読み込み');
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

  it('summarizes unrecoverable saved project keys without leaking local paths', () => {
    const summary = summarizeProjectRecoveryIssue({
      key: `cts.project.C:\\Users\\tester\\song.ctsproj.json
      ${'x'.repeat(180)}`,
      reason: 'invalid-json',
      detail: 'Unexpected token',
    });

    expect(summary.key).toContain('cts.project.[local-path]');
    expect(summary.key).not.toContain('C:\\Users\\tester');
    expect(summary.key).not.toContain('\n');
    expect(summary.key.endsWith('...')).toBe(true);
    expect(summary.reason).toBe('JSONが壊れています');
  });

  it('counts saved-project load failures separately from file transfer and app flow failures', () => {
    const counts = summarizeSupportDiagnosticCounts([
      diagnostic({ kind: 'project-load', message: 'Saved project load failed. id=demo' }),
      diagnostic({ kind: 'project-import', message: 'Project file import failed' }),
      diagnostic({ kind: 'template-load', message: 'Template failed' }),
      diagnostic({ kind: 'audio-playback', message: 'AudioContext failed' }),
      diagnostic({ kind: 'storage-save', message: 'QuotaExceededError' }),
      diagnostic({
        kind: 'storage-recovery',
        message:
          'Saved project recovered from backup. key=cts.project.demo; reason=invalid-json; detail=broken',
      }),
    ]);

    expect(counts.savedProjectLoadFailureCount).toBe(1);
    expect(counts.fileTransferFailureCount).toBe(1);
    expect(counts.appFlowFailureCount).toBe(1);
    expect(counts.audioFailureCount).toBe(1);
    expect(counts.saveFailureCount).toBe(1);
    expect(counts.backupRecoveryCount).toBe(1);
  });
});
