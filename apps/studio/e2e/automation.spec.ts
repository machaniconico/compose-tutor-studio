import { expect, test } from '@playwright/test';
import { createEmptyProject, createTrack } from '@cts/project-model';

test('WAV bytes match US-034 HEAD with volume automation and an active send', async ({ page }) => {
  await page.goto('/');
  const source = createTrack('Keys', 'instrument', { type: 'synth', preset: 'leadSine' }, undefined, undefined, 'source');
  source.pan = -0.3;
  source.clips = [{
    id: 'clip', trackId: 'source', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
    notes: [{ id: 'note', pitch: 60, startBeat: 1, durationBeats: 3, velocity: 100 }],
  }];
  source.automation = { volume: { points: [{ beat: 0, value: 0.5 }, { beat: 4, value: 1 }] } };
  source.sends = { room: 0.75 };
  const room = createTrack('Room', 'bus', undefined, undefined, undefined, 'room');
  room.effects = [{ id: 'verb', type: 'reverb', enabled: true, params: { mix: 1 } }];
  const project = { ...createEmptyProject({ lengthBars: 1 }), bpm: 137, tracks: [source, room] };
  const digests = await page.evaluate(async (project) => {
    const modulePath = '/src/audio/wav.ts';
    const { renderProjectToWav } = await import(modulePath) as typeof import('../src/audio/wav');
    const digest = async () => {
      const wav = await (await renderProjectToWav(project)).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wav)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const legacy = await digest();
    const source = project.tracks[0]!;
    source.automation = { ...source.automation, pan: { points: [] }, cutoff: { points: [] } };
    return { legacy, empty: await digest() };
  }, project);
  // Chromium OfflineAudioContext output from 0d4c7b0 at 44.1 kHz.
  expect(digests.legacy).toBe('58c3d3dca3aafdccbc42052174e05334e8049207e75e4d9b7a9ac68a0ffe664e');
  expect(digests.empty).toBe(digests.legacy);
});

test('48 kHz WAV export applies pan and a moving cutoff to the audio', async ({ page }) => {
  await page.goto('/');
  const source = createTrack('Keys', 'instrument', { type: 'synth', preset: 'brightLead' }, undefined, undefined, 'source');
  source.clips = [{
    id: 'clip', trackId: 'source', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
    notes: [{ id: 'note', pitch: 84, startBeat: 0, durationBeats: 4, velocity: 100 }],
  }];
  const project = { ...createEmptyProject({ lengthBars: 1 }), bpm: 120, tracks: [source] };
  const { hardRight, neutralMatches, sweepStart, sweepEnd } = await page.evaluate(async (project) => {
    const modulePath = '/src/audio/wav.ts';
    const { renderProjectToWav } = await import(modulePath) as typeof import('../src/audio/wav');
    const sampleRate = 48000;
    const energy = (wav: ArrayBuffer, start: number, end: number) => {
      const samples = new Int16Array(wav, 44);
      const sum = [0, 0];
      for (let frame = start * sampleRate; frame < end * sampleRate; frame++) {
        sum[0]! += samples[2 * frame]! ** 2;
        sum[1]! += samples[2 * frame + 1]! ** 2;
      }
      return sum as [number, number];
    };
    const source = project.tracks[0]!;
    source.automation = { pan: { points: [{ beat: 0, value: 1 }] } };
    const panned = await (await renderProjectToWav(project, { sampleRate })).arrayBuffer();
    source.automation.cutoff = { points: [{ beat: 0, value: 1 }, { beat: 4, value: 1 }] };
    const neutral = await (await renderProjectToWav(project, { sampleRate })).arrayBuffer();
    source.automation.cutoff = { points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 10 }] };
    const swept = await (await renderProjectToWav(project, { sampleRate })).arrayBuffer();
    const neutralBytes = new Uint8Array(neutral);
    return {
      hardRight: energy(panned, 0.25, 0.5),
      neutralMatches: panned.byteLength === neutral.byteLength
        && new Uint8Array(panned).every((sample, index) => sample === neutralBytes[index]),
      sweepStart: energy(swept, 0.25, 0.5)[1] / energy(panned, 0.25, 0.5)[1],
      sweepEnd: energy(swept, 1.5, 1.75)[1] / energy(panned, 1.5, 1.75)[1],
    };
  }, project);
  expect(neutralMatches).toBe(true);
  expect(hardRight[0]).toBe(0);
  expect(hardRight[1]).toBeGreaterThan(0);
  expect(sweepStart).toBeLessThan(0.5);
  expect(sweepEnd).toBeGreaterThan(0.8);
});
