import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRUM_NOISE_BUFFER_SEED_V1,
  DrumVoiceManager,
  createNoiseBuffer,
  drumNoiseStartOffsetSeconds,
} from '../src/audio/drums';

class FakeAudioParam {
  value = 0;

  setValueAtTime(value: number): void {
    this.value = value;
  }

  exponentialRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnectCalls = 0;

  connect(destination: FakeNode): FakeNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.length = 0;
  }
}

class FakeBuffer {
  readonly numberOfChannels: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(channels: number, readonly length: number, readonly sampleRate: number) {
    this.numberOfChannels = channels;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new Error(`Missing fake channel ${channel}`);
    return data;
  }
}

class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly starts: Array<{ time: number; offset: number }> = [];
  readonly stops: number[] = [];
  onended: (() => void) | null = null;
  throwOnStart = false;

  start(time: number, offset = 0): void {
    if (this.throwOnStart) throw new Error('fake buffer source start failed');
    this.starts.push({ time, offset });
  }

  stop(time?: number): void {
    this.stops.push(time ?? -1);
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam();
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  onended: (() => void) | null = null;

  start(time: number): void {
    this.starts.push(time);
  }

  stop(time?: number): void {
    this.stops.push(time ?? -1);
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeAudioParam();
}

class FakeBiquadFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

class FakeContext {
  readonly sources: FakeBufferSource[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly filters: FakeBiquadFilter[] = [];
  currentTime = 0;
  throwOnBufferSourceStart = false;
  throwOnGainCall: number | null = null;
  private gainCalls = 0;

  constructor(readonly sampleRate = 32) {}

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    source.throwOnStart = this.throwOnBufferSourceStart;
    this.sources.push(source);
    return source;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    this.gainCalls += 1;
    if (this.gainCalls === this.throwOnGainCall) {
      throw new Error('fake gain allocation failed');
    }
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter(): FakeBiquadFilter {
    const filter = new FakeBiquadFilter();
    this.filters.push(filter);
    return filter;
  }
}

function context(fake = new FakeContext()): BaseAudioContext {
  return fake as unknown as BaseAudioContext;
}

function samples(seed: number): number[] {
  const buffer = createNoiseBuffer(context(), seed);
  return Array.from(buffer.getChannelData(0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deterministic synthesized drum noise', () => {
  it('renders byte-identical source PCM for the same seed', () => {
    const first = samples(DRUM_NOISE_BUFFER_SEED_V1);

    expect(samples(DRUM_NOISE_BUFFER_SEED_V1)).toEqual(first);
    expect(samples(DRUM_NOISE_BUFFER_SEED_V1 + 1)).not.toEqual(first);
  });

  it('derives repeatable, bounded offsets from voice seed and subvoice salt', () => {
    const buffer = { length: 44_100, sampleRate: 44_100 } as AudioBuffer;
    const first = drumNoiseStartOffsetSeconds(buffer, 0x1234_5678, 7);

    expect(drumNoiseStartOffsetSeconds(buffer, 0x1234_5678, 7)).toBe(first);
    expect(drumNoiseStartOffsetSeconds(buffer, 0x1234_5679, 7)).not.toBe(first);
    expect(drumNoiseStartOffsetSeconds(buffer, 0x1234_5678, 8)).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0.6);
    expect(Number.isInteger(first * buffer.sampleRate)).toBe(true);
    expect(drumNoiseStartOffsetSeconds(
      { length: 17_640, sampleRate: 44_100 } as AudioBuffer,
      123,
      7,
    )).toBe(0);
    expect(drumNoiseStartOffsetSeconds(
      { length: 44_100, sampleRate: Number.NaN } as AudioBuffer,
      123,
      7,
    )).toBe(0);
  });

  it('replays clap subvoices exactly and salts every burst independently', () => {
    const fake = new FakeContext();
    const audioContext = context(fake);
    const noise = createNoiseBuffer(audioContext);
    const manager = new DrumVoiceManager(
      audioContext,
      new FakeNode() as unknown as AudioNode,
      noise,
    );

    manager.trigger('clap', 2, 100, 0x1234_5678);
    manager.trigger('clap', 4, 100, 0x1234_5678);
    manager.trigger('clap', 6, 100, 0x1234_5679);

    const offsets = fake.sources.map((source) => source.starts[0]?.offset);
    expect(offsets.slice(3, 6)).toEqual(offsets.slice(0, 3));
    expect(offsets.slice(6, 9)).not.toEqual(offsets.slice(0, 3));
    expect(new Set(offsets.slice(0, 3)).size).toBe(3);
  });

  it('never consults process-global randomness for buffers or voices', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used by synthesized drums');
    });
    const fake = new FakeContext();
    const audioContext = context(fake);
    const manager = new DrumVoiceManager(
      audioContext,
      new FakeNode() as unknown as AudioNode,
      createNoiseBuffer(audioContext),
    );

    expect(() => {
      manager.trigger('kick', 0, 100, 1);
      manager.trigger('snare', 1, 100, 2);
      manager.trigger('closedHat', 2, 100, 3);
      manager.trigger('openHat', 3, 100, 4);
      manager.trigger('clap', 4, 100, 5);
      manager.trigger('perc', 5, 100, 6);
    }).not.toThrow();
  });
});

describe('DrumVoiceManager node ownership', () => {
  it('disconnects every lane subgraph exactly once after natural source endings', () => {
    const fake = new FakeContext();
    const output = new FakeNode();
    const audioContext = context(fake);
    const manager = new DrumVoiceManager(
      audioContext,
      output as unknown as AudioNode,
      createNoiseBuffer(audioContext),
    );

    manager.trigger('kick', 0, 100, 1);
    manager.trigger('snare', 1, 100, 2);
    manager.trigger('closedHat', 2, 100, 3);
    manager.trigger('openHat', 3, 100, 4);
    manager.trigger('clap', 4, 100, 5);
    manager.trigger('perc', 5, 100, 6);

    expect(fake.sources).toHaveLength(7);
    expect(fake.oscillators).toHaveLength(3);
    expect(fake.gains).toHaveLength(10);
    expect(fake.filters).toHaveLength(7);
    const staleHandlers = [...fake.sources, ...fake.oscillators].map(
      (source) => source.onended,
    );

    for (const source of fake.sources) source.finish();
    for (const oscillator of fake.oscillators) oscillator.finish();
    expect([...fake.sources, ...fake.oscillators].every(
      (node) => node.disconnectCalls === 1,
    )).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(output.disconnectCalls).toBe(0);

    for (const handler of staleHandlers) handler?.();
    manager.dispose();
    expect([...fake.sources, ...fake.oscillators].every(
      (node) => node.disconnectCalls === 1,
    )).toBe(true);
  });

  it('hard-disposes future subvoices and rejects stale triggers without touching output', () => {
    const fake = new FakeContext();
    const output = new FakeNode();
    const audioContext = context(fake);
    const manager = new DrumVoiceManager(
      audioContext,
      output as unknown as AudioNode,
      createNoiseBuffer(audioContext),
    );

    manager.trigger('kick', 10, 100, 1);
    manager.trigger('snare', 11, 100, 2);
    manager.trigger('clap', 12, 100, 3);
    const sourcesBeforeDispose = [...fake.sources, ...fake.oscillators];
    const staleHandlers = sourcesBeforeDispose.map((source) => source.onended);
    manager.dispose();
    manager.dispose();

    expect(sourcesBeforeDispose.every((source) => source.stops.at(-1) === -1)).toBe(true);
    expect(sourcesBeforeDispose.every((source) => source.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
    for (const handler of staleHandlers) handler?.();

    const sourceCount = sourcesBeforeDispose.length;
    manager.trigger('openHat', 13, 100, 4);
    expect(fake.sources.length + fake.oscillators.length).toBe(sourceCount);
    expect(output.disconnectCalls).toBe(0);
  });

  it('disconnects a partially scheduled subgraph when source start fails', () => {
    const fake = new FakeContext();
    fake.throwOnBufferSourceStart = true;
    const audioContext = context(fake);
    const manager = new DrumVoiceManager(
      audioContext,
      new FakeNode() as unknown as AudioNode,
      createNoiseBuffer(audioContext),
    );

    expect(() => manager.trigger('closedHat', 0, 100, 1)).toThrow(
      'fake buffer source start failed',
    );
    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]?.stops).toEqual([-1]);
    expect(fake.sources[0]?.disconnectCalls).toBe(1);
    expect(fake.gains[0]?.disconnectCalls).toBe(1);
    expect(fake.filters[0]?.disconnectCalls).toBe(1);
    manager.dispose();
    expect(fake.sources[0]?.disconnectCalls).toBe(1);
  });

  it('rolls back every branch when a later compound-hit allocation fails', () => {
    const fake = new FakeContext();
    fake.throwOnGainCall = 2;
    const audioContext = context(fake);
    const manager = new DrumVoiceManager(
      audioContext,
      new FakeNode() as unknown as AudioNode,
      createNoiseBuffer(audioContext),
    );

    expect(() => manager.trigger('kick', 0, 100, 1)).toThrow('fake gain allocation failed');
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.sources).toHaveLength(1);
    expect([...fake.oscillators, ...fake.sources].every(
      (node) => node.disconnectCalls === 1,
    )).toBe(true);
    expect(fake.gains).toHaveLength(1);
    expect(fake.gains[0]?.disconnectCalls).toBe(1);
    expect(fake.filters[0]?.disconnectCalls).toBe(1);
    manager.dispose();
    expect(fake.oscillators[0]?.disconnectCalls).toBe(1);
  });

  it('disconnects 10,000 naturally ended hat graphs without retaining output edges', () => {
    const fake = new FakeContext();
    const output = new FakeNode();
    const audioContext = context(fake);
    const manager = new DrumVoiceManager(
      audioContext,
      output as unknown as AudioNode,
      createNoiseBuffer(audioContext),
    );

    for (let index = 0; index < 10_000; index += 1) {
      manager.trigger('closedHat', index, 100, index);
      fake.sources[index]?.finish();
    }
    manager.dispose();

    expect(fake.sources).toHaveLength(10_000);
    expect(fake.gains).toHaveLength(10_000);
    expect(fake.filters).toHaveLength(10_000);
    expect(fake.sources.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.gains.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(fake.filters.every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(output.disconnectCalls).toBe(0);
  });
});
