import { readFile } from 'node:fs/promises';
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

test('the export dialog saves an isolated 24-bit stem ZIP with a separate echo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();

  const keys = createTrack('鍵盤', 'instrument', { type: 'synth', preset: 'leadSine' }, undefined, undefined, 'keys');
  keys.clips = [{
    id: 'clip', trackId: 'keys', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
    notes: [{ id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 }],
  }];
  keys.solo = true;
  keys.sends = { echo: 1 };
  const other = createTrack('ベース', 'instrument', undefined, undefined, undefined, 'bass');
  const echo = createTrack('こだま', 'bus', undefined, undefined, undefined, 'echo');
  echo.effects = [{ id: 'delay', type: 'delay', enabled: true, params: { timeSeconds: 0.5, mix: 1, feedback: 0.3 } }];
  const project = {
    ...createEmptyProject({ lengthBars: 1 }), bpm: 120, tracks: [keys, other, echo],
    loopRange: { startBeat: 0, endBeat: 1 },
  };
  await page.evaluate(async (value) => {
    const modulePath = '/src/state/store.ts';
    const { useStore } = await import(modulePath) as typeof import('../src/state/store');
    useStore.getState().replaceProject(value);
  }, project);

  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  await page.getByLabel(/16ビット変換/).check();
  await page.getByLabel('WAVのビット数').selectOption('24');
  await expect(page.getByLabel(/16ビット変換/)).toBeDisabled();
  await page.getByLabel('WAVの書き出し範囲').selectOption('loop');
  await page.getByLabel('WAVのサンプルレート').selectOption('48000');
  await page.getByLabel(/一番大きい音/).check();
  await page.getByLabel(/トラックごとの WAV/).check();
  await expect(page.getByLabel(/一番大きい音/)).toHaveAccessibleDescription(/WAV ごとに音量をそろえます/);
  await page.getByRole('button', { name: 'ステム ZIP を確認' }).click();
  await expect(page.getByText(/音の瞬間的な最大レベル.*dBTP/)).toBeVisible();
  await expect(page.getByText(/−14〜−16 LUFS/)).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /ステム ZIPを書き出す|このまま書き出す/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const zipPath = await download.path();
  const zip = await readFile(zipPath);
  const stems = new Map<string, Buffer>();
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const name = zip.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + zip.readUInt16LE(offset + 28);
    stems.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  expect([...stems.keys()]).toEqual(['鍵盤.wav', 'こだま.wav']);
  const energyPresent = (wav: Buffer, start: number, end: number) =>
    wav.subarray(44 + start * 6, 44 + end * 6).some((byte) => byte !== 0);
  const dry = stems.get('鍵盤.wav')!;
  const wet = stems.get('こだま.wav')!;
  expect(energyPresent(dry, 0, 24000)).toBe(true);
  expect(energyPresent(wet, 0, 23000)).toBe(false);
  expect(energyPresent(wet, 25000, 48000)).toBe(true);
  expect(wet.length).toBeGreaterThan(dry.length);
  for (const wav of [dry, wet]) {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(34)).toBe(24);
    expect(wav.readUInt32LE(24)).toBe(48000);
  }
  await expect(page.getByText(/48 kHz \/ ループ範囲 \/ 24ビット \/ ステム ZIP \/ ピーク調整あり/)).toBeVisible();
});
