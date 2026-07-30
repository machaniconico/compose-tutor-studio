/// <reference lib="webworker" />

import { renderAudioWarp, type DerivedAudioPcm } from './audioWarpDsp';
import {
  isAudioWarpWorkerRequest,
  type AudioWarpWorkerResult,
} from './audioWarpWorker';

type WorkerPort = Readonly<{
  postMessage: (message: AudioWarpWorkerResult, transfer?: Transferable[]) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
}>;

/** Installable for protocol tests; the real Worker installs exactly once below. */
export function installAudioWarpWorker(port: WorkerPort): void {
  let acceptedGeneration = 0;
  let queue = Promise.resolve();
  port.addEventListener('message', (event) => {
    const message = event.data;
    if (!isAudioWarpWorkerRequest(message)) {
      const candidate = message as Partial<{ type: unknown; id: unknown; generation: unknown }>;
      if (
        candidate?.type === 'render'
        && Number.isSafeInteger(candidate.id)
        && Number.isSafeInteger(candidate.generation)
      ) {
        postError(
          port,
          candidate.id as number,
          candidate.generation as number,
          'invalid-request',
          'Worker request failed protocol validation.',
        );
      }
      return;
    }
    if (message.type === 'cancel') {
      acceptedGeneration = Math.max(acceptedGeneration, message.generation);
      return;
    }
    queue = queue.then(async () => {
      if (message.generation < acceptedGeneration) {
        postError(port, message.id, message.generation, 'cancelled', 'Stale render cancelled.');
        return;
      }
      acceptedGeneration = Math.max(acceptedGeneration, message.generation);
      try {
        const channels = message.pcm.channels.map((buffer) => new Float32Array(buffer));
        const pcm: DerivedAudioPcm = {
          sampleRate: message.pcm.sampleRate,
          frameCount: message.pcm.frameCount,
          channelCount: message.pcm.channelCount,
          channels,
        };
        const rendered = renderAudioWarp(message.request, pcm);
        if (message.generation !== acceptedGeneration) {
          postError(port, message.id, message.generation, 'cancelled', 'Stale render cancelled.');
          return;
        }
        const buffers = rendered.channels.map((channel) =>
          channel.buffer.slice(
            channel.byteOffset,
            channel.byteOffset + channel.byteLength,
          ) as ArrayBuffer);
        port.postMessage({
          type: 'rendered',
          id: message.id,
          generation: message.generation,
          pcm: {
            sampleRate: rendered.sampleRate,
            frameCount: rendered.frameCount,
            channelCount: rendered.channelCount,
            channels: buffers,
          },
        }, buffers);
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown };
        const code = (
          candidate.code === 'invalid-request'
          || candidate.code === 'invalid-pcm'
          || candidate.code === 'resource-limit'
          || candidate.code === 'cancelled'
        ) ? candidate.code : 'invalid-pcm';
        postError(
          port,
          message.id,
          message.generation,
          code,
          typeof candidate.message === 'string' ? candidate.message : 'Elastic Audio render failed.',
        );
      }
    });
  });
}

function postError(
  port: WorkerPort,
  id: number,
  generation: number,
  code: 'invalid-request' | 'invalid-pcm' | 'resource-limit' | 'cancelled',
  message: string,
): void {
  port.postMessage({ type: 'error', id, generation, code, message });
}

const scope = globalThis as unknown as Partial<DedicatedWorkerGlobalScope>;
if (
  typeof scope.postMessage === 'function'
  && typeof scope.addEventListener === 'function'
  && typeof (globalThis as { document?: unknown }).document === 'undefined'
) {
  installAudioWarpWorker(scope as unknown as WorkerPort);
}
