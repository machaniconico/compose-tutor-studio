import { afterEach, describe, expect, it, vi } from 'vitest';

type TestPort = Readonly<{
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  send: (message: unknown) => void;
}>;

type CapturingProcessor = Readonly<{
  port: TestPort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}>;

type CapturingProcessorConstructor = new (options?: unknown) => CapturingProcessor;

function createTestPort(): TestPort {
  const port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: vi.fn(),
    send(message: unknown): void {
      port.onmessage?.({ data: message } as MessageEvent<unknown>);
    },
  };
  return port;
}

function setCurrentFrame(frame: number): void {
  Reflect.set(globalThis, 'currentFrame', frame);
}

function postedMessages(port: TestPort, type: string): Array<Record<string, unknown>> {
  return (port.postMessage.mock.calls as unknown[][])
    .map(([message]) => message)
    .filter((message): message is Record<string, unknown> => (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === type
    ));
}

async function createProcessor(
  processorOptions: Readonly<{ chunkFrames: number; maxChannels: number }> = {
    chunkFrames: 4,
    maxChannels: 2,
  },
): Promise<Readonly<{
  processor: CapturingProcessor;
  port: TestPort;
  registeredName: string;
}>> {
  let registeredName = '';
  let Processor: CapturingProcessorConstructor | null = null;
  class FakeAudioWorkletProcessor {
    readonly port = createTestPort();
  }
  vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('renderQuantumSize', 128);
  vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
  vi.stubGlobal(
    'registerProcessor',
    (name: string, constructor: CapturingProcessorConstructor) => {
      registeredName = name;
      Processor = constructor;
    },
  );

  await import('../src/audio/microphoneCapture.worklet');
  const RegisteredProcessor = Processor as CapturingProcessorConstructor | null;
  if (!RegisteredProcessor) throw new Error('worklet processor was not registered');
  const processor = new RegisteredProcessor({ processorOptions });
  return { processor, port: processor.port, registeredName };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('microphone capture worklet protocol', () => {
  it('announces its clock and down-mixes dry input while waiting to be armed', async () => {
    const { processor, port, registeredName } = await createProcessor();
    expect(registeredName).toBe('cts-humming-microphone-capture');
    expect(postedMessages(port, 'ready')).toEqual([{
      type: 'ready',
      currentFrame: 0,
      renderQuantumSize: 128,
    }]);
    const monitor = new Float32Array(4).fill(1);

    expect(processor.process(
      [[
        Float32Array.from([1, -1, 0.5, -0.5]),
        Float32Array.from([-1, 1, 0.5, -0.5]),
      ]],
      [[monitor]],
    )).toBe(true);
    expect(Array.from(monitor)).toEqual([0, 0, 0.5, -0.5]);
    expect(postedMessages(port, 'chunk')).toHaveLength(0);
  });

  it('acknowledges a future arm, slices a mid-quantum gate, and stops at the exact max frame', async () => {
    const { processor, port } = await createProcessor({
      chunkFrames: 256,
      maxChannels: 2,
    });
    port.send({ type: 'arm', startFrame: 130, maximumFrames: 100 });

    expect(postedMessages(port, 'armed')).toEqual([{
      type: 'armed',
      startFrame: 130,
      endFrameExclusive: 230,
      observedFrame: 0,
    }]);

    setCurrentFrame(128);
    const input = Float32Array.from({ length: 128 }, (_, index) => index / 128);
    expect(processor.process([[input]], [[new Float32Array(128)]])).toBe(false);

    const [chunk] = postedMessages(port, 'chunk');
    expect(chunk).toMatchObject({
      type: 'chunk',
      sequence: 0,
      firstContextFrame: 130,
      channelCount: 1,
      frameCount: 100,
    });
    const channelBuffers = chunk?.channels as ArrayBuffer[] | undefined;
    const firstChannel = channelBuffers?.[0];
    if (!firstChannel) throw new Error('worklet chunk omitted channel data');
    const samples = new Float32Array(firstChannel);
    expect(samples).toHaveLength(100);
    expect(samples[0]).toBeCloseTo(2 / 128);
    expect(samples.at(-1)).toBeCloseTo(101 / 128);
    expect(postedMessages(port, 'stopped')).toEqual([{
      type: 'stopped',
      reason: 'duration-limit',
      firstContextFrame: 130,
      endContextFrameExclusive: 230,
    }]);
  });

  it('numbers contiguous absolute-frame chunks monotonically across render quanta', async () => {
    const { processor, port } = await createProcessor({
      chunkFrames: 64,
      maxChannels: 1,
    });
    port.send({ type: 'arm', startFrame: 128, maximumFrames: 300 });

    for (const frame of [128, 256, 384]) {
      setCurrentFrame(frame);
      processor.process(
        [[new Float32Array(128).fill(0.25)]],
        [[new Float32Array(128)]],
      );
    }

    expect(postedMessages(port, 'chunk').map((message) => ({
      sequence: message.sequence,
      firstContextFrame: message.firstContextFrame,
      frameCount: message.frameCount,
    }))).toEqual([
      { sequence: 0, firstContextFrame: 128, frameCount: 64 },
      { sequence: 1, firstContextFrame: 192, frameCount: 64 },
      { sequence: 2, firstContextFrame: 256, frameCount: 64 },
      { sequence: 3, firstContextFrame: 320, frameCount: 64 },
      { sequence: 4, firstContextFrame: 384, frameCount: 44 },
    ]);
    expect(postedMessages(port, 'stopped')).toEqual([expect.objectContaining({
      reason: 'duration-limit',
      firstContextFrame: 128,
      endContextFrameExclusive: 428,
    })]);
  });

  it('fails closed when the rendering clock skips a quantum', async () => {
    const { processor, port } = await createProcessor({
      chunkFrames: 256,
      maxChannels: 1,
    });
    port.send({ type: 'arm', startFrame: 128, maximumFrames: 300 });
    setCurrentFrame(128);
    expect(processor.process(
      [[new Float32Array(128)]],
      [[new Float32Array(128)]],
    )).toBe(true);

    setCurrentFrame(384);
    expect(processor.process(
      [[new Float32Array(128)]],
      [[new Float32Array(128)]],
    )).toBe(false);
    expect(postedMessages(port, 'error')).toEqual([{
      type: 'error',
      code: 'clock-discontinuity',
    }]);
    expect(postedMessages(port, 'stopped')).toHaveLength(0);
  });
});
