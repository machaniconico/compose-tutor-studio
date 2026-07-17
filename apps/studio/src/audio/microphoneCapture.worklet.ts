declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processor: new (options?: {
    processorOptions?: Readonly<{
      chunkFrames?: unknown;
      maxChannels?: unknown;
    }>;
  }) => AudioWorkletProcessor,
): void;

const PROCESSOR_NAME = 'cts-humming-microphone-capture';
const DEFAULT_CHUNK_FRAMES = 4_096;
const DEFAULT_MAX_CHANNELS = 2;

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

class MicrophoneCaptureProcessor extends AudioWorkletProcessor {
  private readonly chunkFrames: number;
  private readonly maxChannels: number;
  private channelCount = 0;
  private buffers: Float32Array[] = [];
  private offset = 0;
  private stopped = false;
  private peak = 0;

  constructor(options?: {
    processorOptions?: Readonly<{
      chunkFrames?: unknown;
      maxChannels?: unknown;
    }>;
  }) {
    super();
    this.chunkFrames = boundedInteger(
      options?.processorOptions?.chunkFrames,
      DEFAULT_CHUNK_FRAMES,
      65_536,
    );
    this.maxChannels = boundedInteger(
      options?.processorOptions?.maxChannels,
      DEFAULT_MAX_CHANNELS,
      DEFAULT_MAX_CHANNELS,
    );
    this.port.onmessage = (event: MessageEvent<unknown>): void => {
      if (
        this.stopped ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        event.data.type !== 'flush'
      ) {
        return;
      }
      this.emitChunk();
      this.stopped = true;
      this.port.postMessage({ type: 'flushed' });
    };
  }

  private allocate(channelCount: number): void {
    this.channelCount = channelCount;
    this.buffers = Array.from(
      { length: channelCount },
      () => new Float32Array(this.chunkFrames),
    );
    this.offset = 0;
    this.peak = 0;
  }

  private fail(code: 'channel-limit-exceeded' | 'channel-layout-changed'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.port.postMessage({ type: 'error', code });
  }

  private emitChunk(): void {
    if (this.offset <= 0 || this.channelCount <= 0) return;
    const channels = this.buffers.map((buffer) => {
      if (this.offset === buffer.length) return buffer.buffer;
      return buffer.slice(0, this.offset).buffer;
    });
    this.port.postMessage(
      {
        type: 'chunk',
        channelCount: this.channelCount,
        frameCount: this.offset,
        peak: this.peak,
        channels,
      },
      channels,
    );
    this.allocate(this.channelCount);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    if (this.stopped) return false;

    const input = inputs[0];
    if (!input || input.length === 0 || input[0]?.length === 0) return true;
    if (input.length > this.maxChannels) {
      this.fail('channel-limit-exceeded');
      return false;
    }
    if (this.channelCount === 0) this.allocate(input.length);
    if (input.length !== this.channelCount) {
      this.fail('channel-layout-changed');
      return false;
    }

    const frameCount = input[0]?.length ?? 0;
    if (frameCount <= 0 || input.some((channel) => channel.length !== frameCount)) {
      this.fail('channel-layout-changed');
      return false;
    }

    let sourceOffset = 0;
    while (sourceOffset < frameCount) {
      const copyFrames = Math.min(
        frameCount - sourceOffset,
        this.chunkFrames - this.offset,
      );
      for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
        const source = input[channelIndex];
        const target = this.buffers[channelIndex];
        if (!source || !target) {
          this.fail('channel-layout-changed');
          return false;
        }
        const slice = source.subarray(sourceOffset, sourceOffset + copyFrames);
        target.set(slice, this.offset);
        for (let index = 0; index < slice.length; index += 1) {
          this.peak = Math.max(this.peak, Math.min(1, Math.abs(slice[index] ?? 0)));
        }
      }
      sourceOffset += copyFrames;
      this.offset += copyFrames;
      if (this.offset === this.chunkFrames) this.emitChunk();
    }
    return !this.stopped;
  }
}

registerProcessor(PROCESSOR_NAME, MicrophoneCaptureProcessor);
