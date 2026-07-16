export type SourceAudioDecodeJob = Readonly<{
  result: Promise<AudioBuffer>;
  settled: Promise<void>;
  startedAt: number;
}>;

export class SourceAudioDecodeBusyError extends Error {
  constructor() {
    super('source-audio-decode-busy');
    this.name = 'SourceAudioDecodeBusyError';
  }
}

let activeSourceAudioDecodeJob: SourceAudioDecodeJob | null = null;

/** The single app-scoped browser decode lease shared by every source-audio tool. */
export function getActiveSourceAudioDecodeJob(): SourceAudioDecodeJob | null {
  return activeSourceAudioDecodeJob;
}

export function startExclusiveSourceAudioDecode(
  context: AudioContext,
  blob: Blob,
): SourceAudioDecodeJob {
  if (activeSourceAudioDecodeJob) throw new SourceAudioDecodeBusyError();
  const result = blob.arrayBuffer().then((bytes) => context.decodeAudioData(bytes));
  let job: SourceAudioDecodeJob;
  const settled = result.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (activeSourceAudioDecodeJob === job) activeSourceAudioDecodeJob = null;
  });
  job = { result, settled, startedAt: Date.now() };
  activeSourceAudioDecodeJob = job;
  return job;
}

/** Return promptly on cancellation while the underlying browser job keeps its lease until settle. */
export function awaitSourceAudioDecodeOrCancel(
  job: SourceAudioDecodeJob,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => finish(new DOMException('Aborted', 'AbortError'));
    const finish = (error?: unknown, decoded?: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else if (decoded) resolve(decoded);
      else reject(new Error('source-audio-decode-empty'));
    };
    if (signal.aborted) {
      finish(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void job.result.then(
      (decoded) => finish(undefined, decoded),
      (error) => finish(error),
    );
  });
}
