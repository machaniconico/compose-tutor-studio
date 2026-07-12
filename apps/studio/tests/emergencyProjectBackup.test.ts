import { describe, expect, it, vi } from 'vitest';
import { createEmptyProject, decodeProjectJson, type Project } from '@cts/project-model';
import { exportEmergencyProjectBackup } from '../src/features/export/emergencyProjectBackup';

const NOW = new Date('2026-07-11T01:02:03.000Z');

function project(): Project {
  return createEmptyProject({
    title: 'Emergency / Song',
    clock: () => NOW,
  });
}

describe('emergency project backup', () => {
  it('uses the native file gateway with exact importer-compatible bytes', async () => {
    const exportNative = vi.fn(async (_bytes: Uint8Array, _fileName: string) => ({
      status: 'saved' as const,
    }));
    const downloadWeb = vi.fn((_blob: Blob, _fileName: string) => undefined);
    const value = project();

    await expect(
      exportEmergencyProjectBackup(value, {
        runtime: 'native',
        now: () => NOW,
        exportNative,
        downloadWeb,
      }),
    ).resolves.toMatchObject({ status: 'saved' });
    expect(downloadWeb).not.toHaveBeenCalled();
    const nativeCall = exportNative.mock.calls[0];
    if (!nativeCall) throw new Error('native export was not called');
    const [bytes, fileName] = nativeCall;
    expect(fileName).toMatch(/^Emergency___Song\.emergency-.*\.ctsproj\.json$/);
    const decoded = decodeProjectJson(new TextDecoder().decode(bytes));
    expect(decoded).toMatchObject({ ok: true, project: { id: value.id, title: value.title } });
  });

  it('reports native picker cancellation without claiming a saved file', async () => {
    await expect(
      exportEmergencyProjectBackup(project(), {
        runtime: 'native',
        now: () => NOW,
        exportNative: async () => ({ status: 'cancelled' }),
        downloadWeb: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it('starts a browser download only with canonical project JSON', async () => {
    const downloadWeb = vi.fn((_blob: Blob, _fileName: string) => undefined);
    const exportNative = vi.fn(async (_bytes: Uint8Array, _fileName: string) => ({
      status: 'saved' as const,
    }));
    const value = project();
    const result = await exportEmergencyProjectBackup(value, {
      runtime: 'web',
      now: () => NOW,
      exportNative,
      downloadWeb,
    });

    expect(result).toMatchObject({ status: 'download-started' });
    expect(exportNative).not.toHaveBeenCalled();
    const webCall = downloadWeb.mock.calls[0];
    if (!webCall) throw new Error('browser download was not called');
    const [blob, fileName] = webCall;
    expect(fileName).toMatch(/\.ctsproj\.json$/);
    const decoded = decodeProjectJson(await blob.text());
    expect(decoded).toMatchObject({ ok: true, project: { id: value.id } });
  });

  it('never exports raw invalid state under a restorable project extension', async () => {
    const exportNative = vi.fn();
    const downloadWeb = vi.fn();
    const invalid = { ...project(), bpm: 999 } as Project;

    await expect(
      exportEmergencyProjectBackup(invalid, {
        runtime: 'web',
        now: () => NOW,
        exportNative,
        downloadWeb,
      }),
    ).resolves.toEqual({ status: 'invalid-project' });
    expect(exportNative).not.toHaveBeenCalled();
    expect(downloadWeb).not.toHaveBeenCalled();
  });

  it('returns a visible failure outcome when the destination write throws', async () => {
    await expect(
      exportEmergencyProjectBackup(project(), {
        runtime: 'native',
        now: () => NOW,
        exportNative: async () => {
          throw new Error('path must not escape to UI');
        },
        downloadWeb: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'failed' });
  });
});
