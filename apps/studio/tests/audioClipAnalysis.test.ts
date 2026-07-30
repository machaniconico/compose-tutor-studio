import { describe, expect, it, vi } from 'vitest';
import type { AudioClip, ReadyAudioAsset } from '@cts/project-model';
import {
  analyzeAudioClipPitch,
  AudioClipAnalysisError,
  MAX_AUDIO_CLIP_PITCH_REGIONS,
} from '../src/audio/audioClipAnalysis';
import { getReservedHeavyAudioResourceBytes } from '../src/audio/audioResourceReservation';

const sampleRate = 48_000;

function sineWav(seconds: number, frequency = 440): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 16_000,
    );
    view.setInt16(44 + frame * 2, sample, true);
  }
  return bytes;
}

function fixture(seconds = 1) {
  const bytes = sineWav(seconds);
  const frameCount = Math.round(seconds * sampleRate);
  const asset: ReadyAudioAsset = {
    id: 'asset-analysis',
    availability: 'ready',
    checksumSha256: 'a'.repeat(64),
    originalName: 'voice.wav',
    mediaType: 'audio/wav',
    byteLength: bytes.byteLength,
    sampleRate,
    channelCount: 1,
    frameCount,
  };
  const clip: AudioClip = {
    id: 'clip-analysis',
    trackId: 'track-analysis',
    type: 'audio',
    startBeat: 0,
    lengthBeats: 4,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 0,
    sourceFrameCount: frameCount,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    gainDb: 0,
  };
  return { asset, bytes, clip };
}

describe('Audio Clip monophonic analysis', () => {
  it('returns bounded source-frame candidates without mutating verified bytes', async () => {
    const source = fixture();
    const snapshot = source.bytes.slice();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await analyzeAudioClipPitch(source.bytes, source.asset, source.clip, {
      yieldControl: async () => undefined,
    });

    expect(result.regions.length).toBeGreaterThan(0);
    expect(result.regions.length).toBeLessThanOrEqual(MAX_AUDIO_CLIP_PITCH_REGIONS);
    expect(result.regions[0]?.sourceStartFrame).toBeGreaterThanOrEqual(0);
    expect(result.regions[0]?.sourcePitchCents).toBeGreaterThan(6_890);
    expect(result.regions[0]?.sourcePitchCents).toBeLessThan(6_910);
    expect(result.regions[0]?.correctionAmount).toBe(0);
    expect(result.waveform.length).toBeLessThanOrEqual(512);
    expect(result.pitchFrames.length).toBeLessThanOrEqual(3_000);
    expect(source.bytes).toEqual(snapshot);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('cancels without returning candidates', async () => {
    const source = fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(analyzeAudioClipPitch(source.bytes, source.asset, source.clip, {
      signal: controller.signal,
      yieldControl: async () => undefined,
    })).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<AudioClipAnalysisError>);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('yields and cancels during a short interactive clip analysis', async () => {
    const source = fixture();
    const controller = new AbortController();
    let yields = 0;

    await expect(analyzeAudioClipPitch(source.bytes, source.asset, source.clip, {
      signal: controller.signal,
      chunkSamples: 8_192,
      yieldControl: async () => {
        yields += 1;
        controller.abort();
      },
    })).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<AudioClipAnalysisError>);

    expect(yields).toBe(1);
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });

  it('fails closed for a clip shorter than the 40 ms canonical region', async () => {
    const source = fixture(0.02);

    await expect(analyzeAudioClipPitch(
      source.bytes,
      source.asset,
      source.clip,
    )).rejects.toMatchObject({ code: 'invalid-clip' } satisfies Partial<AudioClipAnalysisError>);
  });

  it('rejects hostile allocation metadata before PCM parsing and releases the ledger', async () => {
    const source = fixture();
    const hostileAsset = {
      ...source.asset,
      byteLength: Number.MAX_SAFE_INTEGER,
      frameCount: Number.MAX_SAFE_INTEGER,
    };

    await expect(analyzeAudioClipPitch(
      source.bytes,
      hostileAsset,
      source.clip,
    )).rejects.toMatchObject({ code: 'resource-limit' });
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
  });
});
