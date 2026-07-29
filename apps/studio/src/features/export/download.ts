// Browser download helpers shared by the export menu.

/** Sanitize a project title into a safe-ish filename stem. */
export function safeFileStem(title: string): string {
  const trimmed = title.trim();
  // String iteration preserves valid Unicode pairs (for example emoji) while
  // exposing a lone surrogate as its own code point. Control characters and
  // malformed Unicode must not reach native save-dialog filenames.
  const printable = Array.from(trimmed, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    )
      ? '_'
      : character;
  }).join('');
  const cleaned = printable.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
  return cleaned.length > 0 ? cleaned : 'project';
}

/** Trigger a browser download for a Blob under the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  void downloadBlobAndWaitForHandoff(blob, filename).catch(() => undefined);
}

/**
 * Trigger a browser download and settle after the object URL is revoked.
 * Callers that own a memory lease can await this handoff before releasing it.
 */
export function downloadBlobAndWaitForHandoff(
  blob: Blob,
  filename: string,
): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  // Revoke on the next tick so the click has a chance to start the download.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}
