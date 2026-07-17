import { afterEach, describe, expect, it, vi } from 'vitest';

type CapturingProcessor = Readonly<{
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}>;

type CapturingProcessorConstructor = new (options?: unknown) => CapturingProcessor;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('microphone capture worklet monitor output', () => {
  it('down-mixes the dry input to one monitor channel while capture remains active', async () => {
    let registeredName = '';
    let Processor: CapturingProcessorConstructor | null = null;
    class FakeAudioWorkletProcessor {
      readonly port = {
        onmessage: null,
        postMessage: vi.fn(),
      } as unknown as MessagePort;
    }
    vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
    vi.stubGlobal(
      'registerProcessor',
      (name: string, constructor: CapturingProcessorConstructor) => {
        registeredName = name;
        Processor = constructor;
      },
    );

    await import('../src/audio/microphoneCapture.worklet');
    expect(registeredName).toBe('cts-humming-microphone-capture');
    const RegisteredProcessor = Processor as unknown as CapturingProcessorConstructor | null;
    if (!RegisteredProcessor) throw new Error('worklet processor was not registered');
    const processor = new RegisteredProcessor({
      processorOptions: { chunkFrames: 4, maxChannels: 2 },
    });
    const monitor = new Float32Array(4).fill(1);

    expect(processor.process(
      [[
        Float32Array.from([1, -1, 0.5, -0.5]),
        Float32Array.from([-1, 1, 0.5, -0.5]),
      ]],
      [[monitor]],
    )).toBe(true);
    expect(Array.from(monitor)).toEqual([0, 0, 0.5, -0.5]);
  });
});
