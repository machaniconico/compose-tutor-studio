import type { WavRenderLease } from '../../audio/wav';

export type WavExportSaveResult = Readonly<{
  status: 'saved' | 'cancelled' | 'download-started';
}>;

export type WavExportSaveDependencies = Readonly<{
  runtime: 'web' | 'native';
  exportNative: (
    bytes: Uint8Array,
    fileName: string,
  ) => Promise<Readonly<{ status: 'saved' | 'cancelled' }>>;
  downloadWeb: (blob: Blob, fileName: string) => void | Promise<void>;
}>;

/**
 * Keep the render reservation through Blob read and the complete platform
 * handoff. Native cancel/errors and browser download errors share the same
 * exactly-once finally release.
 */
export async function saveWavRenderLease(
  rendered: WavRenderLease,
  fileName: string,
  dependencies: WavExportSaveDependencies,
): Promise<WavExportSaveResult> {
  try {
    if (dependencies.runtime === 'native') {
      const bytes = new Uint8Array(await rendered.blob.arrayBuffer());
      return await dependencies.exportNative(bytes, fileName);
    }
    await dependencies.downloadWeb(rendered.blob, fileName);
    return { status: 'download-started' };
  } finally {
    rendered.release();
  }
}
