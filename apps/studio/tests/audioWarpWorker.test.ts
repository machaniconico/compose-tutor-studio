import { describe, expect, it, vi } from 'vitest';
import {
  AudioWarpWorkerClient,
  isAudioWarpWorkerRequest,
  isAudioWarpWorkerResult,
  type AudioWarpWorkerLike,
} from '../src/audio/audioWarpWorker';
import type { AudioWarpRenderRequest } from '../src/audio/audioWarpPlan';
import { installAudioWarpWorker } from '../src/audio/audioWarp.worker';

const REQUEST_FRAMES = 1_920;

function sourcePcm(values: readonly number[] = []): Float32Array {
  const result = new Float32Array(REQUEST_FRAMES);
  result.set(values);
  return result;
}

class FakeWorker implements AudioWarpWorkerLike {
  readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  addEventListener(type: 'message' | 'error', listener: EventListenerOrEventListenerObject): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: 'message' | 'error', listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(data: unknown): void {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners.get('message') ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

function request(): AudioWarpRenderRequest {
  return {
    algorithmVersion: 'wsola-v1/dsp-1',
    assetId: 'asset',
    checksumSha256: 'a'.repeat(64),
    sourceSampleRate: 48_000,
    sourceStartFrame: 0,
    sourceFrameCount: REQUEST_FRAMES,
    sourceStartIndex: 0,
    sourceFrameCountAtTargetRate: REQUEST_FRAMES,
    targetSampleRate: 48_000,
    channelCount: 1,
    outputFrameCount: REQUEST_FRAMES,
    knots: [
      { sourceFrame: 0, sourceIndex: 0, outputFrame: 0 },
      {
        sourceFrame: REQUEST_FRAMES,
        sourceIndex: REQUEST_FRAMES,
        outputFrame: REQUEST_FRAMES,
      },
    ],
    pitchRegions: [],
    cacheKey: 'key',
  };
}

describe('audio warp Worker client', () => {
  it('validates protocol structure', () => {
    expect(isAudioWarpWorkerRequest({ type: 'cancel', generation: 0 })).toBe(true);
    expect(isAudioWarpWorkerRequest({
      type: 'cancel',
      generation: 0,
      extra: true,
    })).toBe(false);
    expect(isAudioWarpWorkerRequest({ type: 'render', generation: 0 })).toBe(false);
    expect(isAudioWarpWorkerResult({
      type: 'rendered',
      id: 1,
      generation: 0,
      pcm: {
        sampleRate: 48_000,
        frameCount: REQUEST_FRAMES,
        channelCount: 1,
        channels: [new ArrayBuffer(REQUEST_FRAMES * 4)],
      },
    })).toBe(true);
    expect(isAudioWarpWorkerResult({ type: 'rendered', id: 1, generation: 0 })).toBe(false);
  });

  it('rejects non-monotonic compiled knots at the protocol boundary', () => {
    const malformed = structuredClone(request());
    (malformed.knots[1] as { outputFrame: number }).outputFrame = 0;
    expect(isAudioWarpWorkerRequest({
      type: 'render',
      id: 1,
      generation: 0,
      request: malformed,
      pcm: {
        sampleRate: 48_000,
        frameCount: 4,
        channelCount: 1,
        channels: [new ArrayBuffer(16)],
      },
    })).toBe(false);
  });

  it('transfers owned copies and accepts a current valid result', async () => {
    const worker = new FakeWorker();
    const client = new AudioWarpWorkerClient(worker);
    const source = sourcePcm([1, 2, 3, 4]);
    const pending = client.render(request(), {
      sampleRate: 48_000,
      frameCount: REQUEST_FRAMES,
      channelCount: 1,
      channels: [source],
    });
    source[0] = 9;
    const sent = worker.messages[0] as {
      id: number;
      generation: number;
      pcm: { channels: ArrayBuffer[] };
    };
    expect(new Float32Array(sent.pcm.channels[0]!)[0]).toBe(1);
    worker.emit({
      type: 'rendered',
      id: sent.id,
      generation: sent.generation,
      pcm: {
        sampleRate: 48_000,
        frameCount: REQUEST_FRAMES,
        channelCount: 1,
        channels: [sourcePcm([1, 2, 3, 4]).buffer],
      },
    });
    await expect(pending).resolves.toMatchObject({ frameCount: REQUEST_FRAMES });
  });

  it('refuses to transfer PCM beyond the exact rebased clip window', async () => {
    const worker = new FakeWorker();
    const client = new AudioWarpWorkerClient(worker);
    const pending = client.render(request(), {
      sampleRate: 48_000,
      frameCount: REQUEST_FRAMES + 1,
      channelCount: 1,
      channels: [new Float32Array(REQUEST_FRAMES + 1)],
    });
    const messageCount = worker.messages.length;
    client.dispose();
    await pending.catch(() => undefined);
    expect(messageCount).toBe(0);
  });

  it('rejects late stale results and AbortSignal cancellation', async () => {
    const worker = new FakeWorker();
    const client = new AudioWarpWorkerClient(worker);
    const controller = new AbortController();
    const pending = client.render(request(), {
      sampleRate: 48_000,
      frameCount: REQUEST_FRAMES,
      channelCount: 1,
      channels: [sourcePcm()],
    }, { signal: controller.signal });
    const sent = worker.messages[0] as { id: number; generation: number };
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    worker.emit({
      type: 'rendered',
      id: sent.id,
      generation: sent.generation,
      pcm: {
        sampleRate: 48_000,
        frameCount: 4,
        channelCount: 1,
        channels: [new ArrayBuffer(16)],
      },
    });
  });

  it('rejects a malformed matching result instead of leaving ownership pending', async () => {
    const worker = new FakeWorker();
    const client = new AudioWarpWorkerClient(worker);
    const pending = client.render(request(), {
      sampleRate: 48_000,
      frameCount: REQUEST_FRAMES,
      channelCount: 1,
      channels: [sourcePcm()],
    });
    const sent = worker.messages[0] as { id: number; generation: number };
    worker.emit({ type: 'rendered', id: sent.id, generation: sent.generation });
    await expect(pending).rejects.toMatchObject({ code: 'invalid-pcm' });
  });

  it('runs bundled Worker jobs sequentially and returns transferable ownership', async () => {
    let receive: ((event: MessageEvent<unknown>) => void) | undefined;
    const results: Array<{ id: number; pcm?: { channels: ArrayBuffer[] } }> = [];
    installAudioWarpWorker({
      addEventListener: (_type, listener) => { receive = listener; },
      postMessage: (message) => { results.push(message as typeof results[number]); },
    });
    for (const id of [1, 2]) {
      receive?.({
        data: {
          type: 'render',
          id,
          generation: 0,
          request: request(),
          pcm: {
            sampleRate: 48_000,
            frameCount: REQUEST_FRAMES,
            channelCount: 1,
            channels: [sourcePcm([0, 0.5, -0.5, 0]).buffer],
          },
        },
      } as MessageEvent);
    }
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results.map((result) => result.id)).toEqual([1, 2]);
    expect(results[0]?.pcm?.channels[0]).toBeInstanceOf(ArrayBuffer);
  });

  it('returns invalid-request instead of rendering a malformed knot plan', async () => {
    let receive: ((event: MessageEvent<unknown>) => void) | undefined;
    const results: unknown[] = [];
    installAudioWarpWorker({
      addEventListener: (_type, listener) => { receive = listener; },
      postMessage: (message) => { results.push(message); },
    });
    const malformed = structuredClone(request());
    (malformed.knots[1] as { outputFrame: number }).outputFrame = 0;
    receive?.({
      data: {
        type: 'render',
        id: 1,
        generation: 0,
        request: malformed,
        pcm: {
          sampleRate: 48_000,
          frameCount: REQUEST_FRAMES,
          channelCount: 1,
          channels: [new ArrayBuffer(REQUEST_FRAMES * 4)],
        },
      },
    } as MessageEvent);

    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({
      type: 'error',
      id: 1,
      generation: 0,
      code: 'invalid-request',
    });
  });
});
