import { encodeProjectJson, type Project } from '@cts/project-model';
import type { NativeExportFileResult } from '../../platform/nativeFileGateway';
import { safeFileStem } from './download';

export type EmergencyProjectBackupResult =
  | Readonly<{ status: 'saved'; fileName: string }>
  | Readonly<{ status: 'download-started'; fileName: string }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'invalid-project' }>
  | Readonly<{ status: 'failed' }>;

export type EmergencyProjectBackupDependencies = Readonly<{
  runtime: 'web' | 'native';
  now?: () => Date;
  exportNative: (
    bytes: Uint8Array,
    suggestedFileName: string,
  ) => Promise<NativeExportFileResult>;
  downloadWeb: (blob: Blob, fileName: string) => void;
}>;

/** Export only canonical, importer-compatible bytes; never label raw invalid state as a backup. */
export async function exportEmergencyProjectBackup(
  project: Project,
  dependencies: EmergencyProjectBackupDependencies,
): Promise<EmergencyProjectBackupResult> {
  const encoded = encodeProjectJson(project);
  if (!encoded.ok) return { status: 'invalid-project' };

  try {
    const timestamp = (dependencies.now ?? (() => new Date()))()
      .toISOString()
      .replaceAll(':', '-');
    const fileName = `${safeFileStem(project.title)}.emergency-${timestamp}.ctsproj.json`;
    if (dependencies.runtime === 'native') {
      const result = await dependencies.exportNative(
        new TextEncoder().encode(encoded.json),
        fileName,
      );
      return result.status === 'cancelled'
        ? { status: 'cancelled' }
        : { status: 'saved', fileName };
    }

    dependencies.downloadWeb(
      new Blob([encoded.json], { type: 'application/json' }),
      fileName,
    );
    // Browsers do not expose completion of a user-agent download. Claim only
    // that the verified download was started, not that a file reached disk.
    return { status: 'download-started', fileName };
  } catch {
    return { status: 'failed' };
  }
}
