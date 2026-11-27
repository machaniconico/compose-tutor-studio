import { describe, expect, it } from 'vitest';
import {
  EXPORT_HISTORY_LIMIT,
  EXPORT_HISTORY_STORAGE_KEY,
  addExportHistoryEntry,
  clearExportHistory,
  formatExportRelativeTimeJa,
  formatWavExportSettingsJa,
  loadExportHistory,
  recordExportHistory,
} from '../src/features/export/exportHistory';
import { MemoryStorage } from './localStorageStub';

describe('export history', () => {
  it('persists 48 kHz loop exports and displays legacy WAV entries as 44.1 kHz / full', () => {
    const storage = new MemoryStorage();
    const legacy = { kind: 'wav', fileName: 'old.wav', projectId: 'p', exportedAt: '2026-01-01T00:00:00Z' } as const;
    storage.setItem(EXPORT_HISTORY_STORAGE_KEY, JSON.stringify([legacy]));
    recordExportHistory({
      ...legacy, fileName: 'loop.wav', sampleRate: 48000, range: 'loop', exportedAt: '2026-01-02T00:00:00Z',
    }, storage);
    const entries = loadExportHistory(storage);
    expect(entries[0]).toMatchObject({ sampleRate: 48000, range: 'loop' });
    expect(entries[1]).toEqual(legacy);
    expect(entries.map(formatWavExportSettingsJa)).toEqual(['48 kHz / ループ範囲 / 16ビット / 曲をまとめた WAV', '44.1 kHz / 全体 / 16ビット / 曲をまとめた WAV']);
  });

  it('persists the new WAV options, including the effective dither setting for 24-bit', () => {
    const storage = new MemoryStorage();
    const settings = { kind: 'wav', projectId: 'p', dither: true, normalize: true, stems: true } as const;
    recordExportHistory({ ...settings, fileName: '16.zip', bitDepth: 16, exportedAt: '2026-01-01' }, storage);
    recordExportHistory({ ...settings, fileName: '24.zip', bitDepth: 24, exportedAt: '2026-01-02' }, storage);
    const [high, low] = loadExportHistory(storage);
    expect(high).toMatchObject({ bitDepth: 24, dither: false, normalize: true, stems: true });
    expect(low).toMatchObject({ bitDepth: 16, dither: true, normalize: true, stems: true });
    expect(formatWavExportSettingsJa(low!)).toContain('ステム ZIP / ディザあり / ピーク調整あり');
  });

  it('records successful exports newest first in localStorage', () => {
    const storage = new MemoryStorage();

    recordExportHistory(
      {
        kind: 'midi',
        fileName: 'first.mid',
        exportedAt: '2026-01-01T00:00:00.000Z',
        projectId: 'project-1',
      },
      storage,
    );
    const history = recordExportHistory(
      {
        kind: 'wav',
        fileName: 'second.wav',
        exportedAt: '2026-01-01T00:01:00.000Z',
        projectId: 'project-1',
      },
      storage,
    );

    expect(storage.getItem(EXPORT_HISTORY_STORAGE_KEY)).not.toBeNull();
    expect(history.map((entry) => entry.fileName)).toEqual(['second.wav', 'first.mid']);
    expect(loadExportHistory(storage).map((entry) => entry.kind)).toEqual(['wav', 'midi']);
  });

  it('keeps at most 50 entries', () => {
    const storage = new MemoryStorage();

    for (let i = 0; i < EXPORT_HISTORY_LIMIT + 5; i += 1) {
      recordExportHistory(
        {
          kind: 'project',
          fileName: `song-${i}.ctsproj.json`,
          exportedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          projectId: 'project-1',
        },
        storage,
      );
    }

    const history = loadExportHistory(storage);
    expect(history.length).toBe(EXPORT_HISTORY_LIMIT);
    expect(history[0]?.fileName).toBe('song-54.ctsproj.json');
    expect(history.at(-1)?.fileName).toBe('song-5.ctsproj.json');
  });

  it('adds entries without mutating the input history', () => {
    const original = [
      {
        kind: 'midi' as const,
        fileName: 'original.mid',
        exportedAt: '2026-01-01T00:00:00.000Z',
        projectId: 'project-1',
      },
    ];

    const next = addExportHistoryEntry(original, {
      kind: 'wav',
      fileName: 'new.wav',
      exportedAt: '2026-01-01T00:01:00.000Z',
      projectId: 'project-1',
    });

    expect(original.map((entry) => entry.fileName)).toEqual(['original.mid']);
    expect(next.map((entry) => entry.fileName)).toEqual(['new.wav', 'original.mid']);
  });

  it('clears stored export history', () => {
    const storage = new MemoryStorage();
    recordExportHistory(
      {
        kind: 'midi',
        fileName: 'song.mid',
        exportedAt: '2026-01-01T00:00:00.000Z',
        projectId: 'project-1',
      },
      storage,
    );

    expect(clearExportHistory(storage)).toBe(true);
    expect(loadExportHistory(storage)).toEqual([]);
    expect(storage.getItem(EXPORT_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it('formats relative times in Japanese', () => {
    const now = new Date('2026-01-02T12:00:00.000Z');

    expect(formatExportRelativeTimeJa('2026-01-02T11:59:30.000Z', now)).toBe('たった今');
    expect(formatExportRelativeTimeJa('2026-01-02T11:45:00.000Z', now)).toBe('15分前');
    expect(formatExportRelativeTimeJa('2026-01-02T09:00:00.000Z', now)).toBe('3時間前');
    expect(formatExportRelativeTimeJa('2026-01-01T12:00:00.000Z', now)).toBe('1日前');
  });
});
