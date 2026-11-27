type SampleSteps<T> = Generator<number, T, void>;

export type SampleStepOptions = {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
};

export function finishSampleSteps<T>(steps: SampleSteps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

const SAMPLE_WORK_BUDGET_MS = 40;
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function runSampleSteps<T>(
  steps: SampleSteps<T>,
  { signal, onProgress }: SampleStepOptions,
): Promise<T> {
  signal?.throwIfAborted();
  onProgress?.(0);
  // Let the browser show the new phase before its first slice.
  await yieldToEventLoop();
  signal?.throwIfAborted();
  let sliceStart = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - sliceStart >= SAMPLE_WORK_BUDGET_MS) {
      onProgress?.(step.value);
      await yieldToEventLoop();
      signal?.throwIfAborted();
      sliceStart = performance.now();
    }
    step = steps.next();
  }
  return step.value;
}
