// Runtime-aware file dialog helpers.
//
// Browser builds keep using download/input flows. Tauri desktop builds use
// native OS dialogs plus scoped filesystem access granted by the dialog result.

import { isTauri } from '@tauri-apps/api/core';
import { open, save, type DialogFilter } from '@tauri-apps/plugin-dialog';
import { readFile, readTextFile, writeFile } from '@tauri-apps/plugin-fs';
import { downloadBlob } from '../features/export/download';

export type SaveFileResult = 'saved' | 'downloaded' | 'cancelled';

function firstSafeFilterExtension(filters: DialogFilter[]): string | null {
  for (const filter of filters) {
    for (const extension of filter.extensions ?? []) {
      const normalized = extension.trim().replace(/^\.+/, '');
      if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)) return normalized;
    }
  }
  return null;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function hasFileExtension(path: string): boolean {
  const fileName = fileNameFromPath(path);
  return /^[^.].*\.[^.\s]+$/.test(fileName);
}

export function withDefaultExtension(path: string, filters: DialogFilter[]): string {
  const trimmedPath = path.replace(/[.\s]+$/g, '');
  const candidatePath = trimmedPath.length > 0 ? trimmedPath : path;
  if (hasFileExtension(candidatePath)) return candidatePath;

  const extension = firstSafeFilterExtension(filters);
  return extension ? `${candidatePath}.${extension}` : candidatePath;
}

/** Whether the current runtime can show native Tauri file dialogs. */
export function canUseNativeFileDialogs(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** Save a Blob via native dialog on desktop, or browser download on web. */
export async function saveBlob(
  blob: Blob,
  filename: string,
  filters: DialogFilter[],
): Promise<SaveFileResult> {
  if (!canUseNativeFileDialogs()) {
    downloadBlob(blob, filename);
    return 'downloaded';
  }

  const path = await save({
    title: 'ファイルを書き出す',
    defaultPath: filename,
    filters,
  });
  if (!path) return 'cancelled';

  const buffer = await blob.arrayBuffer();
  await writeFile(withDefaultExtension(path, filters), new Uint8Array(buffer));
  return 'saved';
}

/** Pick and read a text file with the desktop file dialog. */
export async function openTextFileFromDialog(filters: DialogFilter[]): Promise<string | null> {
  if (!canUseNativeFileDialogs()) return null;
  const path = await open({
    title: 'ファイルを読み込む',
    multiple: false,
    filters,
  });
  if (!path || Array.isArray(path)) return null;
  return readTextFile(path);
}

/** Pick and read a binary file with the desktop file dialog. */
export async function openBinaryFileFromDialog(filters: DialogFilter[]): Promise<Uint8Array | null> {
  if (!canUseNativeFileDialogs()) return null;
  const path = await open({
    title: 'ファイルを読み込む',
    multiple: false,
    filters,
  });
  if (!path || Array.isArray(path)) return null;
  return readFile(path);
}
