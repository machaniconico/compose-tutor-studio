import { describe, expect, it } from 'vitest';
import type { EffectConfig } from '@cts/project-model';
import {
  createDefaultEffectConfig,
  delaySettings,
  delayTimeSeconds,
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
      effect('delay', true, { delayTime: 4, feedback: 1, mix: -1 }),
    );
    expect(settings.timeSeconds).toBe(1.5);
    expect(settings.feedback).toBe(0.85);
    expect(settings.mix).toBe(0);
  });

  it.each([
    ['legacy delayTime over the limit', { delayTime: 4 }, 1.5],
    ['legacy time at the limit', { time: 1.5 }, 1.5],
    ['legacy time in range', { time: 0.6 }, 0.6],
    ['timeSeconds over the limit', { timeSeconds: 2 }, 1.5],
    ['timeSeconds below zero', { timeSeconds: -1 }, 0],
    ['missing value falls back to the default', {}, 0.25],
  ])('keeps the pre-tempo-sync delay time for %s', (_label, params, expected) => {
    expect(delaySettings(effect('delay', true, params)).timeSeconds).toBe(expected);
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
      effect('eq', false),
    ]);
    expect(signature).toBe('fx-filter:filter|fx-reverb:reverb');
  });

  it('orders signatures eq -> compressor -> filter -> delay -> reverb', () => {
    const signature = effectSignature([
      effect('reverb', true),
      effect('delay', true),
      effect('filter', true),
      effect('compressor', true),
      effect('eq', true),
    ]);
    expect(signature).toBe(
      'fx-eq:eq|fx-compressor:compressor|fx-filter:filter|fx-delay:delay|fx-reverb:reverb',
    );
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

describe('delayTimeSeconds', () => {
  it('stays a pure conversion; over-limit results clamp to the legacy maximum', () => {
    const division = delayTimeSeconds(20, '1/4');
    expect(division).toBe(3);
    expect(delaySettings(effect('delay', true, { timeSeconds: division })).timeSeconds).toBe(1.5);
    expect(delayTimeSeconds(40, '1/4')).toBe(1.5);
  });

  it('syncs the delay time to the tempo', () => {
    expect(delayTimeSeconds(120, '1/4')).toBe(0.5);
    expect(delayTimeSeconds(120, '1/8')).toBe(0.25);
    expect(delayTimeSeconds(120, '1/8d')).toBe(0.375);
  });
});
