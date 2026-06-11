import { describe, expect, it } from 'vitest';
import type { EffectConfig } from '@cts/project-model';
import {
  createDefaultEffectConfig,
  delaySettings,
  effectSignature,
  filterSettings,
  getCachedReverbImpulse,
  reverbSettings,
  upsertEffect,
} from '../src/audio/effects';

function effect(
  type: EffectConfig['type'],
  enabled: boolean,
  params: Record<string, number> = {},
): EffectConfig {
  return {
    id: `fx-${type}`,
    type,
    enabled,
    params,
  };
}

class FakeAudioBuffer {
  private readonly channels: Float32Array[];

  constructor(
    numberOfChannels: number,
    length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new Error(`missing channel ${channel}`);
    return data;
  }
}

class FakeAudioContext {
  readonly sampleRate = 44100;
  createBufferCalls = 0;

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    this.createBufferCalls += 1;
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate) as unknown as AudioBuffer;
  }
}

describe('effect settings', () => {
  it('normalizes and clamps filter params', () => {
    const settings = filterSettings(effect('filter', true, { cutoff: 24000, Q: -2 }));
    expect(settings.cutoffHz).toBe(18000);
    expect(settings.resonance).toBe(0.0001);
  });

  it('normalizes and clamps delay params', () => {
    const settings = delaySettings(
      effect('delay', true, { delayTime: 2, feedback: 1, mix: -1 }),
    );
    expect(settings.timeSeconds).toBe(1.5);
    expect(settings.feedback).toBe(0.85);
    expect(settings.mix).toBe(0);
  });

  it('normalizes and clamps reverb mix', () => {
    expect(reverbSettings(effect('reverb', true, { mix: 1.3 })).mix).toBe(1);
  });
});

describe('effect list helpers', () => {
  it('adds default configs without dropping unsupported effects', () => {
    const compressor = effect('compressor', true, { threshold: -12 });
    const next = upsertEffect([compressor], 'delay', (current) => ({
      ...current,
      params: { ...current.params, feedback: 0.4 },
    }));

    expect(next[0]).toBe(compressor);
    expect(next[1]).toMatchObject({
      id: 'fx-delay',
      type: 'delay',
      enabled: true,
      params: expect.objectContaining({ feedback: 0.4 }),
    });
  });

  it('only includes enabled supported effects in graph signatures', () => {
    const signature = effectSignature([
      effect('filter', true),
      effect('delay', false),
      effect('reverb', true),
      effect('eq', true),
    ]);
    expect(signature).toBe('fx-filter:filter|fx-reverb:reverb');
  });

  it('creates enabled default effect configs for mixer toggles', () => {
    expect(createDefaultEffectConfig('filter')).toMatchObject({
      id: 'fx-filter',
      enabled: true,
      params: expect.objectContaining({ cutoffHz: expect.any(Number) }),
    });
  });
});

describe('reverb impulse cache', () => {
  it('reuses the generated impulse buffer for a context', () => {
    const ctx = new FakeAudioContext() as unknown as BaseAudioContext & FakeAudioContext;
    const first = getCachedReverbImpulse(ctx);
    const second = getCachedReverbImpulse(ctx);

    expect(first).toBe(second);
    expect(ctx.createBufferCalls).toBe(1);
  });
});
