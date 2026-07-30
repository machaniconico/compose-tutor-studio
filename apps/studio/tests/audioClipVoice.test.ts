import { describe, expect, it } from 'vitest';
import type { AudioClipPlaybackPlan } from '../src/audio/audioClipPlanner';
import { AudioClipVoiceManager } from '../src/audio/audioClipVoice';

class FakeAudioParam {
  value = 0;
  readonly commands: Array<{ kind: string; value?: number; time: number }> = [];

  cancelScheduledValues(time: number): void {
    this.commands.push({ kind: 'cancel', time });
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.commands.push({ kind: 'set', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.commands.push({ kind: 'linear', value, time });
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

class FakeGain extends FakeNode {
  readonly gain = new FakeAudioParam();
}

class FakeBufferSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  readonly starts: Array<{ when: number; offset: number; duration: number }> = [];
  readonly stops: number[] = [];
  throwOnStart = false;
  readonly playbackRate = { value: 1 };
  readonly detune = { value: 0 };

  start(when: number, offset: number, duration: number): void {
    if (this.throwOnStart) throw new Error('source start failed');
    this.starts.push({ when, offset, duration });
  }

  stop(when: number): void {
    this.stops.push(when);
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeContext {
  currentTime = 3;
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGain[] = [];
  throwOnCreateGain = false;
  throwOnStart = false;

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    source.throwOnStart = this.throwOnStart;
    this.sources.push(source);
    return source;
  }

  createGain(): FakeGain {
    if (this.throwOnCreateGain) throw new Error('gain allocation failed');
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

function plan(overrides: Partial<AudioClipPlaybackPlan> = {}): AudioClipPlaybackPlan {
  return {
    occurrenceId: 'occurrence-1',
    trackId: 'audio-track',
    clipId: 'clip-1',
    assetId: 'asset-1',
    checksumSha256: 'a'.repeat(64),
    playbackBufferKey: {
      kind: 'source',
      assetId: 'asset-1',
      checksumSha256: 'a'.repeat(64),
    },
    startBeat: 2,
    endBeat: 6,
    sourceOffsetSeconds: 1.25,
    durationSeconds: 2,
    loopStartSeconds: null,
    loopEndSeconds: null,
    gainPoints: [
      { offsetSeconds: 0, value: 0.25 },
      { offsetSeconds: 0.5, value: 0.5 },
      { offsetSeconds: 2, value: 0 },
    ],
    ...overrides,
  };
}

function buffer(duration = 8): AudioBuffer {
  return { duration } as AudioBuffer;
}

function manager(fake: FakeContext, output: FakeNode): AudioClipVoiceManager {
  return new AudioClipVoiceManager(
    fake as unknown as BaseAudioContext,
    output as unknown as AudioNode,
  );
}

describe('AudioClipVoiceManager', () => {
  it('connects source to clip gain and schedules exact offset, duration, and ramps', () => {
    const fake = new FakeContext();
    const output = new FakeNode();
    const voices = manager(fake, output);

    expect(voices.schedule(plan(), buffer(), 10)).toBe(true);
    expect(fake.sources[0]?.connections[0]).toBe(fake.gains[0]);
    expect(fake.gains[0]?.connections[0]).toBe(output);
    expect(fake.sources[0]?.starts).toEqual([{ when: 10, offset: 1.25, duration: 2 }]);
    expect(fake.sources[0]?.playbackRate.value).toBe(1);
    expect(fake.sources[0]?.detune.value).toBe(0);
    expect(fake.gains[0]?.gain.commands).toEqual([
      { kind: 'cancel', time: 10 },
      { kind: 'set', value: 0.25, time: 10 },
      { kind: 'linear', value: 0.5, time: 10.5 },
      { kind: 'linear', value: 0, time: 12 },
    ]);
    expect(output.disconnectCalls).toBe(0);
  });

  it('uses native source loop bounds without expanding repetitions', () => {
    const fake = new FakeContext();
    const voices = manager(fake, new FakeNode());

    voices.schedule(plan({
      sourceOffsetSeconds: 2.5,
      durationSeconds: 20,
      loopStartSeconds: 2,
      loopEndSeconds: 3,
    }), buffer(), 4);

    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]).toMatchObject({
      loop: true,
      loopStart: 2,
      loopEnd: 3,
      starts: [{ when: 4, offset: 2.5, duration: 20 }],
    });
  });

  it('deduplicates repeated lookahead plans while the logical source is owned', () => {
    const fake = new FakeContext();
    const voices = manager(fake, new FakeNode());

    expect(voices.schedule(plan(), buffer(), 1)).toBe(true);
    expect(voices.schedule(plan({ sourceOffsetSeconds: 1.5 }), buffer(), 1.1)).toBe(false);
    expect(fake.sources).toHaveLength(1);
  });

  it('disconnects source and clip gain exactly once after natural end', () => {
    const fake = new FakeContext();
    const output = new FakeNode();
    const voices = manager(fake, output);
    voices.schedule(plan(), buffer(), 1);
    const staleHandler = fake.sources[0]?.onended;

    fake.sources[0]?.finish();
    staleHandler?.();
    voices.dispose();

    expect(fake.sources[0]?.disconnectCalls).toBe(1);
    expect(fake.gains[0]?.disconnectCalls).toBe(1);
    expect(fake.sources[0]?.stops).toEqual([]);
    expect(output.disconnectCalls).toBe(0);
  });

  it('hard-stops future voices on idempotent dispose and ignores later schedules', () => {
    const fake = new FakeContext();
    const output = new FakeNode();
    const voices = manager(fake, output);
    voices.schedule(plan(), buffer(), 100);
    const staleHandler = fake.sources[0]?.onended;

    voices.dispose();
    voices.dispose();
    staleHandler?.();
    expect(voices.schedule(plan({ occurrenceId: 'later' }), buffer(), 101)).toBe(false);

    expect(fake.sources).toHaveLength(1);
    expect(fake.sources[0]?.stops).toEqual([3]);
    expect(fake.sources[0]?.disconnectCalls).toBe(1);
    expect(fake.gains[0]?.disconnectCalls).toBe(1);
    expect(output.disconnectCalls).toBe(0);
  });

  it('rolls back the source when gain allocation fails', () => {
    const fake = new FakeContext();
    fake.throwOnCreateGain = true;
    const voices = manager(fake, new FakeNode());

    expect(() => voices.schedule(plan(), buffer(), 1)).toThrow('gain allocation failed');
    expect(fake.sources[0]?.stops).toEqual([3]);
    expect(fake.sources[0]?.disconnectCalls).toBe(1);
    voices.dispose();
    expect(fake.sources[0]?.disconnectCalls).toBe(1);
  });

  it('rolls back both nodes when source start fails', () => {
    const fake = new FakeContext();
    fake.throwOnStart = true;
    const voices = manager(fake, new FakeNode());

    expect(() => voices.schedule(plan(), buffer(), 1)).toThrow('source start failed');
    expect(fake.sources[0]?.stops).toEqual([3]);
    expect(fake.sources[0]?.disconnectCalls).toBe(1);
    expect(fake.gains[0]?.disconnectCalls).toBe(1);
    voices.dispose();
  });
});
