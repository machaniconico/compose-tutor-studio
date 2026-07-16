import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_AUDIO_SAMPLE_RATE,
  canonicalizeAudioAsset,
  planCanonicalAudioAsset,
  type CanonicalAudioResampleJob,
} from '../src/audio/canonicalAudioAsset';

function audioBufferShape(
  length: number,
  sampleRate: number,
  channels = 1,
): AudioBuffer {
  const channelData = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    getChannelData: (channel: number) => channelData[channel]!,
  } as AudioBuffer;
}

describe('canonical Audio Track assets', () => {
  it('preflights the exact 48 kHz PCM16 allocation before resampling', () => {
    expect(planCanonicalAudioAsset(audioBufferShape(44_100, 44_100, 2))).toEqual({
      sampleRate: 48_000,
      channelCount: 2,
      frameCount: 48_000,
      byteLength: 44 + 48_000 * 2 * 2,
      requiresResample: true,
    });
  });

  it('encodes an already-canonical buffer without allocating an offline context', async () => {
    const source = audioBufferShape(48, CANONICAL_AUDIO_SAMPLE_RATE);
    const createOfflineContext = vi.fn();
    const result = await canonicalizeAudioAsset(source, { createOfflineContext });

    expect(createOfflineContext).not.toHaveBeenCalled();
    expect(result.frameCount).toBe(48);
    expect(result.bytes.byteLength).toBe(44 + 48 * 2);
    expect(new TextDecoder().decode(result.bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(result.bytes.slice(8, 12))).toBe('WAVE');
  });

  it('rejects malformed, multichannel, oversized, and cancelled input before work', async () => {
    expect(() => planCanonicalAudioAsset({
      ...audioBufferShape(48_000, 48_000),
      duration: 2,
    })).toThrowError(/invalid-audio/);
    expect(() => planCanonicalAudioAsset(audioBufferShape(48_000, 48_000, 3)))
      .toThrowError(/channel-limit-exceeded/);
    expect(() => planCanonicalAudioAsset(audioBufferShape(40_000_000, 48_000, 2)))
      .toThrowError(/resource-limit-exceeded/);

    const controller = new AbortController();
    controller.abort();
    await expect(canonicalizeAudioAsset(audioBufferShape(48, 48_000), {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports actual offline-render settlement after a cancelled caller returns', async () => {
    let releaseRender: ((value: AudioBuffer) => void) | undefined;
    let observedJob: CanonicalAudioResampleJob | undefined;
    const rendering = new Promise<AudioBuffer>((resolve) => {
      releaseRender = resolve;
    });
    const controller = new AbortController();
    const pending = canonicalizeAudioAsset(audioBufferShape(44_100, 44_100), {
      signal: controller.signal,
      createOfflineContext: () => ({
        destination: {},
        createBufferSource: () => ({
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
        }),
        startRendering: () => rendering,
      }) as unknown as OfflineAudioContext,
      onResampleJob: (job) => {
        observedJob = job;
      },
    });

    await vi.waitFor(() => expect(observedJob).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    let actuallySettled = false;
    void observedJob?.settled.then(() => {
      actuallySettled = true;
    });
    await Promise.resolve();
    expect(actuallySettled).toBe(false);

    if (!releaseRender || !observedJob) throw new Error('offline render was not started');
    releaseRender(audioBufferShape(48_000, 48_000));
    await observedJob.settled;
    expect(actuallySettled).toBe(true);
  });
});
