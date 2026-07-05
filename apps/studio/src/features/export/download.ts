// Browser download helpers shared by file export flows.

const FALLBACK_FILE_STEM = 'project';
const MAX_FILE_STEM_LENGTH = 80;
const WINDOWS_RESERVED_FILE_STEMS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const UNSAFE_FILE_STEM_CHARS = /[\x00-\x1f\x7f-\x9f\\/:*?"<>|\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g;

function normalizeFileStemEdges(stem: string): string {
  return stem.replace(/^[._\s]+/g, '').replace(/[._\s]+$/g, '');
}

function isWindowsReservedFileStem(stem: string): boolean {
  const baseName = stem.split('.')[0] ?? stem;
  return WINDOWS_RESERVED_FILE_STEMS.test(baseName);
}

function limitFileStemLength(stem: string): string {
  const chars = Array.from(stem);
  if (chars.length <= MAX_FILE_STEM_LENGTH) return stem;
  return chars.slice(0, MAX_FILE_STEM_LENGTH).join('');
}

/** Sanitize a project title into a safe filename stem for browser/Tauri exports. */
export function safeFileStem(title: string): string {
  let cleaned = title
    .replace(UNSAFE_FILE_STEM_CHARS, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');

  cleaned = normalizeFileStemEdges(cleaned);
  if (cleaned.length === 0) return FALLBACK_FILE_STEM;

  if (isWindowsReservedFileStem(cleaned)) {
    cleaned = `${FALLBACK_FILE_STEM}_${cleaned}`;
  }

  cleaned = normalizeFileStemEdges(limitFileStemLength(cleaned));
  return cleaned.length > 0 ? cleaned : FALLBACK_FILE_STEM;
}

/** Trigger a browser download for a Blob under the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
