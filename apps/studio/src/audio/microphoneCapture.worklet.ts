declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const currentFrame: number;
declare const renderQuantumSize: number;

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
const DEFAULT_RENDER_QUANTUM_SIZE = 128;

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function safeFrame(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function currentRenderQuantumSize(): number {
  return typeof renderQuantumSize === 'number'
    ? boundedInteger(renderQuantumSize, DEFAULT_RENDER_QUANTUM_SIZE, 65_536)
    : DEFAULT_RENDER_QUANTUM_SIZE;
}

class MicrophoneCaptureProcessor extends AudioWorkletProcessor {
  private readonly chunkFrames: number;
  private readonly maxChannels: number;
  private channelCount = 0;
  private buffers: Float32Array[] = [];
  private offset = 0;
  private stopped = false;
  private armed = false;
  private peak = 0;
  private sequence = 0;
  private startFrame = 0;
  private endFrameExclusive = 0;
  private chunkFirstContextFrame: number | null = null;
  private firstContextFrame: number | null = null;
  private endContextFrameExclusive: number | null = null;
  private expectedRenderFrame: number | null = null;

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
        this.stopped
        || typeof event.data !== 'object'
        || event.data === null
        || !('type' in event.data)
      ) return;

      if (event.data.type === 'arm') {
        if (this.armed) {
          this.fail('invalid-arm');
          return;
        }
        const candidate = event.data as Partial<{
          startFrame: number;
          maximumFrames: number;
        }>;
        const maximumFrames = candidate.maximumFrames;
        const startFrame = candidate.startFrame;
        const endFrameExclusive = Number(startFrame) + Number(maximumFrames);
        if (
          !safeFrame(startFrame)
          || !Number.isSafeInteger(maximumFrames)
          || (maximumFrames ?? 0) <= 0
          || !safeFrame(endFrameExclusive)
          || endFrameExclusive <= startFrame
        ) {
          this.fail('invalid-arm');
          return;
        }
        if (startFrame < currentFrame) {
          this.fail('arm-frame-passed');
          return;
        }
        this.armed = true;
        this.startFrame = startFrame;
        this.endFrameExclusive = endFrameExclusive;
        this.expectedRenderFrame = null;
        this.port.postMessage({
          type: 'armed',
          startFrame,
          endFrameExclusive,
          observedFrame: currentFrame,
        });
        return;
      }

      if (event.data.type === 'stop' || event.data.type === 'flush') {
        this.finish('manual');
      }
    };
    this.port.postMessage({
      type: 'ready',
      currentFrame,
      renderQuantumSize: currentRenderQuantumSize(),
    });
  }

  private allocate(channelCount: number): void {
    this.channelCount = channelCount;
    this.buffers = Array.from(
      { length: channelCount },
      () => new Float32Array(this.chunkFrames),
    );
    this.offset = 0;
    this.peak = 0;
    this.chunkFirstContextFrame = null;
  }

  private fail(
    code:
      | 'channel-limit-exceeded'
      | 'channel-layout-changed'
      | 'clock-discontinuity'
      | 'invalid-arm'
      | 'arm-frame-passed',
  ): void {
    if (this.stopped) return;
    this.stopped = true;
    this.port.postMessage({ type: 'error', code });
  }

  private emitChunk(): void {
    if (
      this.offset <= 0
      || this.channelCount <= 0
      || this.chunkFirstContextFrame === null
    ) return;
    const channels = this.buffers.map((buffer) => {
      if (this.offset === buffer.length) return buffer.buffer;
      return buffer.slice(0, this.offset).buffer;
    });
    this.port.postMessage(
      {
        type: 'chunk',
        sequence: this.sequence,
        firstContextFrame: this.chunkFirstContextFrame,
        channelCount: this.channelCount,
        frameCount: this.offset,
        peak: this.peak,
        channels,
      },
      channels,
    );
    this.sequence += 1;
    this.allocate(this.channelCount);
  }

  private finish(reason: 'manual' | 'duration-limit'): void {
    if (this.stopped) return;
    this.emitChunk();
    this.stopped = true;
    this.port.postMessage({
      type: 'stopped',
      reason,
      firstContextFrame: this.firstContextFrame,
      endContextFrameExclusive: this.endContextFrameExclusive,
    });
  }

  private monitorInput(input: Float32Array[], outputs: Float32Array[][]): void {
    const monitor = outputs[0]?.[0];
    const frameCount = input[0]?.length ?? 0;
    if (!monitor || frameCount <= 0) return;
    const monitoredFrames = Math.min(frameCount, monitor.length);
    for (let frame = 0; frame < monitoredFrames; frame += 1) {
      let sample = 0;
      for (const channel of input) sample += channel[frame] ?? 0;
      monitor[frame] = sample / input.length;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    if (this.stopped) return false;

    const input = inputs[0] ?? [];
    this.monitorInput(input, outputs);
    if (!this.armed) return true;

    const inputFrameCount = input[0]?.length ?? 0;
    const outputFrameCount = outputs[0]?.[0]?.length ?? 0;
    const frameCount = inputFrameCount > 0 ? inputFrameCount : outputFrameCount;
    if (frameCount <= 0) return true;
    const blockStartFrame = currentFrame;
    const blockEndFrame = blockStartFrame + frameCount;
    if (!safeFrame(blockStartFrame) || !safeFrame(blockEndFrame)) {
      this.fail('clock-discontinuity');
      return false;
    }
    if (
      this.expectedRenderFrame !== null
      && blockStartFrame !== this.expectedRenderFrame
    ) {
      this.fail('clock-discontinuity');
      return false;
    }
    this.expectedRenderFrame = blockEndFrame;

    if (blockEndFrame <= this.startFrame) return true;
    if (blockStartFrame >= this.endFrameExclusive) {
      this.finish('duration-limit');
      return false;
    }
    if (inputFrameCount <= 0 || input.length < 1) {
      this.fail('clock-discontinuity');
      return false;
    }
    if (input.length > this.maxChannels) {
      this.fail('channel-limit-exceeded');
      return false;
    }
    if (input.some((channel) => channel.length !== inputFrameCount)) {
      this.fail('channel-layout-changed');
      return false;
    }
    if (this.channelCount === 0) this.allocate(input.length);
    if (input.length !== this.channelCount) {
      this.fail('channel-layout-changed');
      return false;
    }

    const captureStartFrame = Math.max(blockStartFrame, this.startFrame);
    const captureEndFrame = Math.min(blockEndFrame, this.endFrameExclusive);
    if (
      this.endContextFrameExclusive !== null
      && captureStartFrame !== this.endContextFrameExclusive
    ) {
      this.fail('clock-discontinuity');
      return false;
    }
    const sourceStartOffset = captureStartFrame - blockStartFrame;
    const captureFrameCount = captureEndFrame - captureStartFrame;
    let sourceOffset = 0;
    while (sourceOffset < captureFrameCount) {
      const copyFrames = Math.min(
        captureFrameCount - sourceOffset,
        this.chunkFrames - this.offset,
      );
      if (this.offset === 0) {
        this.chunkFirstContextFrame = captureStartFrame + sourceOffset;
      }
      for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
        const source = input[channelIndex];
        const target = this.buffers[channelIndex];
        if (!source || !target) {
          this.fail('channel-layout-changed');
          return false;
        }
        const sliceStart = sourceStartOffset + sourceOffset;
        const slice = source.subarray(sliceStart, sliceStart + copyFrames);
        target.set(slice, this.offset);
        for (let index = 0; index < slice.length; index += 1) {
          this.peak = Math.max(this.peak, Math.min(1, Math.abs(slice[index] ?? 0)));
        }
      }
      sourceOffset += copyFrames;
      this.offset += copyFrames;
      if (this.offset === this.chunkFrames) this.emitChunk();
    }
    if (this.firstContextFrame === null) this.firstContextFrame = captureStartFrame;
    this.endContextFrameExclusive = captureEndFrame;

    if (captureEndFrame === this.endFrameExclusive) {
      this.finish('duration-limit');
    }
    return !this.stopped;
  }
}

registerProcessor(PROCESSOR_NAME, MicrophoneCaptureProcessor);

export {};
