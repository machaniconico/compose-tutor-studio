/** Read a local Blob URL's browser presentation duration with bounded cleanup. */
export function loadSourceAudioPresentationDuration(
  url: string,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    let settled = false;
    const timeout = window.setTimeout(() => finish(undefined), 15_000);
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
    const finish = (duration: number | undefined, reason?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason !== undefined) {
        reject(reason);
      } else if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
        resolve(duration);
      } else {
        reject(new Error('source-audio-metadata'));
      }
    };
    const onLoadedMetadata = (): void => finish(audio.duration);
    const onError = (): void => finish(undefined);
    const onAbort = (): void =>
      finish(undefined, new DOMException('Aborted', 'AbortError'));
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('error', onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    audio.src = url;
    audio.load();
  });
}
