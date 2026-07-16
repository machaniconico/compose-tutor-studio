import { describe, expect, it, vi } from 'vitest';
import {
  SourceAudioDecodeBusyError,
  awaitSourceAudioDecodeOrCancel,
  getActiveSourceAudioDecodeJob,
  startExclusiveSourceAudioDecode,
} from '../src/audio/sourceAudioDecode';

describe('source audio decode lease', () => {
  it('keeps one app-scoped lease until the underlying decoder settles', async () => {
    let release: ((value: AudioBuffer) => void) | undefined;
    const decoded = {} as AudioBuffer;
    const context = {
      decodeAudioData: vi.fn(
        () => new Promise<AudioBuffer>((resolve) => {
          release = resolve;
        }),
      ),
    } as unknown as AudioContext;
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const first = startExclusiveSourceAudioDecode(context, blob);
    expect(getActiveSourceAudioDecodeJob()).toBe(first);
    expect(() => startExclusiveSourceAudioDecode(context, blob)).toThrow(
      SourceAudioDecodeBusyError,
    );

    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    if (!release) throw new Error('decoder release was not installed');
    release(decoded);
    await expect(first.result).resolves.toBe(decoded);
    await first.settled;
    expect(getActiveSourceAudioDecodeJob()).toBeNull();
  });

  it('returns on cancellation without releasing the still-running lease', async () => {
    let release: ((value: AudioBuffer) => void) | undefined;
    const context = {
      decodeAudioData: () =>
        new Promise<AudioBuffer>((resolve) => {
          release = resolve;
        }),
    } as unknown as AudioContext;
    const job = startExclusiveSourceAudioDecode(
      context,
      new Blob([new Uint8Array([1])]),
    );
    const controller = new AbortController();
    const awaited = awaitSourceAudioDecodeOrCancel(job, controller.signal);
    controller.abort();
    await expect(awaited).rejects.toMatchObject({ name: 'AbortError' });
    expect(getActiveSourceAudioDecodeJob()).toBe(job);

    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (!release) throw new Error('decoder release was not installed');
    release({} as AudioBuffer);
    await job.settled;
    expect(getActiveSourceAudioDecodeJob()).toBeNull();
  });
});
