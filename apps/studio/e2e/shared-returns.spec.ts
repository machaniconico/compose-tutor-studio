import { expect, test } from '@playwright/test';
import { createEmptyProject, createTrack, deserializeProject, serializeProject } from '@cts/project-model';

test('shared returns preserve the US-027 WAV at zero and render a tail above zero', async ({ page }) => {
  await page.goto('/');
  const source = createTrack('Keys', 'instrument', { type: 'synth', preset: 'leadSine' }, undefined, undefined, 'source');
  source.clips = [{
    id: 'clip', trackId: 'source', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
    notes: [{ id: 'note', pitch: 60, startBeat: 3, durationBeats: 1, velocity: 100 }],
  }];
  source.automation = { volume: { points: [{ beat: 0, value: 0.5 }] } };
  const room = createTrack('Room', 'bus', undefined, undefined, undefined, 'room');
  room.effects = [{ id: 'verb', type: 'reverb', enabled: true, params: { mix: 1 } }];
  const legacy = { ...createEmptyProject({ lengthBars: 1 }), bpm: 137, tracks: [source, room] };
  const loaded = deserializeProject(serializeProject(legacy));
  expect(loaded).toEqual(legacy);
  expect(Object.hasOwn(loaded.tracks[0]!, 'sends')).toBe(false);

  const zeroProject = { ...legacy, tracks: [{ ...source, sends: { room: 0 } }, room] };
  const loadedZero = deserializeProject(serializeProject(zeroProject));
  expect(loadedZero).toEqual(zeroProject);

  const results = await page.evaluate(async ({ loaded, loadedZero, source, room }) => {
    const modulePath = '/src/audio/wav.ts';
    const { renderProjectToWav } = await import(modulePath) as typeof import('../src/audio/wav');
    const absent = await (await renderProjectToWav(loaded)).arrayBuffer();
    const withSend = (level: number, mute = false) => ({
      ...loaded, tracks: [{ ...source, solo: true, sends: { room: level } }, { ...room, mute }],
    });
    const zero = await (await renderProjectToWav(loadedZero)).arrayBuffer();
    const positive = await (await renderProjectToWav(withSend(0.75))).arrayBuffer();
    const muted = await (await renderProjectToWav(withSend(0.75, true))).arrayBuffer();
    const hexDigest = async (buffer: ArrayBuffer) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
    // Look for reverb in the final part of the song, after the direct note has faded.
    const samples = new Int16Array(positive, 44);
    return {
      absent: await hexDigest(absent),
      zero: await hexDigest(zero),
      muted: await hexDigest(muted),
      tailIsLonger: positive.byteLength > absent.byteLength,
      wetSignal: samples.subarray(44100 * 2 * 2).some((sample) => sample !== 0),
    };
  }, { loaded, loadedZero, source, room });

  // Chromium OfflineAudioContext output captured on 2e860479 (US-027).
  expect(results.absent).toBe('4d7e2da0a2142608ef913c29c2e8ad38acd7af919fcc3b2c198aa228efa58e59');
  expect(results.zero).toBe(results.absent);
  expect(results.muted).toBe(results.absent);
  expect(results.tailIsLonger).toBe(true);
  expect(results.wetSignal).toBe(true);
});
