import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const SAMPLE_RATE = 44_100;

type ParsedWav = Readonly<{
  sampleRate: number;
  left: Float64Array;
  right: Float64Array;
}>;

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

function createStereoFixture(options: { mono?: boolean } = {}): Buffer {
  const frames = SAMPLE_RATE;
  const dataBytes = frames * 2 * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const center = 0.35 * Math.sin(2 * Math.PI * 1_000 * time);
    const stereoSide = options.mono ? 0 : 0.2 * Math.sin(2 * Math.PI * 2_000 * time);
    const left = Math.max(-1, Math.min(1, center + stereoSide));
    const right = Math.max(-1, Math.min(1, center - stereoSide));
    bytes.writeInt16LE(Math.round(left * 0x7fff), 44 + frame * 4);
    bytes.writeInt16LE(Math.round(right * 0x7fff), 46 + frame * 4);
  }
  return bytes;
}

function parseStereoPcm16Wav(bytes: Buffer): ParsedWav {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error(`WAV ${kind} chunk exceeds file`);
    if (kind === 'fmt ') {
      expect(bytes.readUInt16LE(start)).toBe(1);
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      bitsPerSample = bytes.readUInt16LE(start + 14);
    } else if (kind === 'data') {
      data = bytes.subarray(start, end);
    }
    offset = end + (size & 1);
  }
  expect(channels).toBe(2);
  expect(sampleRate).toBe(SAMPLE_RATE);
  expect(bitsPerSample).toBe(16);
  if (!data) throw new Error('WAV data chunk missing');
  const frames = data.length / 4;
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = data.readInt16LE(frame * 4) / 0x8000;
    right[frame] = data.readInt16LE(frame * 4 + 2) / 0x8000;
  }
  return { sampleRate, left, right };
}

function toneAmplitude(
  left: Float64Array,
  right: Float64Array,
  frequency: number,
  channel: 'mid' | 'side',
): number {
  let cosine = 0;
  let sine = 0;
  const skip = Math.round(SAMPLE_RATE * 0.1);
  const count = left.length - skip;
  for (let frame = skip; frame < left.length; frame += 1) {
    const value =
      channel === 'mid'
        ? ((left[frame] ?? 0) + (right[frame] ?? 0)) * 0.5
        : ((left[frame] ?? 0) - (right[frame] ?? 0)) * 0.5;
    const phase = (2 * Math.PI * frequency * frame) / SAMPLE_RATE;
    cosine += value * Math.cos(phase);
    sine += value * Math.sin(phase);
  }
  return (2 / count) * Math.hypot(cosine, sine);
}

test('creates, A/B previews and downloads a local karaoke WAV', async ({ page }, testInfo) => {
  await page.goto('/');
  await dismissOnboarding(page);

  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'カラオケ作成（ボーカルカット）' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('音源を外部へ送信しません');
  await expect(dialog).toContainText('完全なボーカル除去やAIステム分離ではありません');
  await expect(dialog.getByRole('button', { name: '音源ファイルを選ぶ' })).toBeFocused();

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'synthetic song.wav',
    mimeType: 'audio/wav',
    buffer: createStereoFixture(),
  });
  await expect(dialog.getByText('synthetic song.wav', { exact: true })).toBeVisible();
  await expect(dialog.getByText('0:01', { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: 'ボーカルカットを作成' }).click();
  await expect(dialog.getByRole('heading', { name: '3. 聴き比べて保存' })).toBeFocused();
  const preview = dialog.getByLabel('ボーカルカット後の試聴');
  await expect(preview).toBeVisible();
  const originalButton = dialog.getByRole('button', { name: '原曲', exact: true });
  await originalButton.click();
  await expect(originalButton).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByLabel('原曲の試聴')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'カラオケ用WAVを書き出す' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('synthetic_song_karaoke.wav');
  const path = testInfo.outputPath('synthetic_song_karaoke.wav');
  await download.saveAs(path);
  const output = parseStereoPcm16Wav(await readFile(path));
  expect(output.left.length).toBe(SAMPLE_RATE);
  expect(toneAmplitude(output.left, output.right, 1_000, 'mid')).toBeLessThan(0.05);
  expect(toneAmplitude(output.left, output.right, 2_000, 'side')).toBeGreaterThan(0.19);
  expect(toneAmplitude(output.left, output.right, 2_000, 'side')).toBeLessThan(0.21);

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'broken.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('not a wave file'),
  });
  await expect(dialog.getByRole('alert')).toContainText('破損しています');
  await expect(dialog.getByText('synthetic song.wav', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'カラオケ用WAVを書き出す' })).toBeVisible();

  await dialog.getByRole('radio', { name: /強め/ }).check();
  await expect(dialog.getByRole('heading', { name: '3. 聴き比べて保存' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'カラオケ用WAVを書き出す' })).toHaveCount(0);
});

test('cancels promptly while the browser decoder is still pending', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'カラオケ作成（ボーカルカット）' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'slow-decode.wav',
    mimeType: 'audio/wav',
    buffer: createStereoFixture(),
  });
  await expect(dialog.getByText('slow-decode.wav', { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const original = AudioContext.prototype.decodeAudioData;
    const testWindow = window as typeof window & {
      __decodeCalls?: number;
      __releaseDecode?: () => void;
    };
    let pending: {
      context: AudioContext;
      args: Parameters<AudioContext['decodeAudioData']>;
      resolve: (value: AudioBuffer) => void;
      reject: (reason?: unknown) => void;
    } | null = null;
    testWindow.__decodeCalls = 0;
    testWindow.__releaseDecode = () => {
      if (!pending) return;
      const current = pending;
      pending = null;
      original.apply(current.context, current.args).then(current.resolve, current.reject);
    };
    AudioContext.prototype.decodeAudioData = function heldDecode(...args) {
      testWindow.__decodeCalls = (testWindow.__decodeCalls ?? 0) + 1;
      return new Promise((resolve, reject) => {
        pending = { context: this, args, resolve, reject };
      });
    };
  });

  await dialog.getByRole('button', { name: 'ボーカルカットを作成' }).click();
  await dialog.getByRole('button', { name: '処理を中止' }).click();
  await expect(dialog.getByLabel('処理の進行状況')).toHaveCount(0, { timeout: 5_000 });
  await expect(dialog.getByRole('button', { name: '閉じる' })).toBeEnabled();
  await expect(dialog.getByText('中止した音源の読み込みを端末内で終了しています。', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'ボーカルカットを作成' })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __decodeCalls?: number }
  ).__decodeCalls)).toBe(1);

  await dialog.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  await expect(dialog.getByRole('button', { name: '読み込み終了待ち…' })).toBeDisabled();
  await page.evaluate(() => (
    window as typeof window & { __releaseDecode?: () => void }
  ).__releaseDecode?.());
  await expect(dialog.getByRole('button', { name: '音源ファイルを選ぶ' })).toBeEnabled();
  await expect(dialog.getByRole('status')).toHaveText(
    '前の音源の読み込みが終了しました。音源を選び直してください。',
  );
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __decodeCalls?: number }
  ).__decodeCalls)).toBe(1);
});

test('allows closing during source validation without stacking file reads', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'カラオケ作成（ボーカルカット）' });
  await page.clock.install();

  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    const testWindow = window as typeof window & {
      __blobReadCalls?: number;
      __releaseBlobRead?: () => void;
    };
    let pending: {
      blob: Blob;
      resolve: (value: ArrayBuffer) => void;
      reject: (reason?: unknown) => void;
    } | null = null;
    testWindow.__blobReadCalls = 0;
    testWindow.__releaseBlobRead = () => {
      if (!pending) return;
      const current = pending;
      pending = null;
      original.call(current.blob).then(current.resolve, current.reject);
    };
    Blob.prototype.arrayBuffer = function heldBlobRead() {
      testWindow.__blobReadCalls = (testWindow.__blobReadCalls ?? 0) + 1;
      return new Promise((resolve, reject) => {
        pending = { blob: this, resolve, reject };
      });
    };
  });

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'held-source.wav',
    mimeType: 'audio/wav',
    buffer: createStereoFixture(),
  });
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __blobReadCalls?: number }
  ).__blobReadCalls)).toBe(1);
  await page.clock.fastForward(30_001);
  await expect(dialog.getByText('音源確認に時間がかかっています。', { exact: false })).toBeVisible();
  await expect(dialog.getByText('作曲内容を保存してからアプリを再読み込みしてください。', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '閉じる' })).toBeEnabled();
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  await expect(dialog.getByRole('button', { name: '音源確認の終了待ち…' })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __blobReadCalls?: number }
  ).__blobReadCalls)).toBe(1);

  await page.evaluate(() => (
    window as typeof window & { __releaseBlobRead?: () => void }
  ).__releaseBlobRead?.());
  await expect(dialog.getByRole('button', { name: '音源ファイルを選ぶ' })).toBeEnabled();
  await expect(dialog.getByRole('status')).toHaveText(
    '前の音源確認が終了しました。音源を選び直してください。',
  );
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __blobReadCalls?: number }
  ).__blobReadCalls)).toBe(1);
});

test('rejects a near-mono source instead of destroying its accompaniment', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'カラオケ作成（ボーカルカット）' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'mono.wav',
    mimeType: 'audio/wav',
    buffer: createStereoFixture({ mono: true }),
  });
  await expect(dialog.getByText('mono.wav', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'ボーカルカットを作成' }).click();
  await expect(dialog.getByRole('alert')).toContainText('左右の差がほとんどない音源');
  await expect(dialog.getByRole('button', { name: 'ボーカルカットを作成' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'カラオケ用WAVを書き出す' })).toHaveCount(0);
});

test('keeps the karaoke dialog operable in a narrow web viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'カラオケ用音源を作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'カラオケ作成（ボーカルカット）' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '音源ファイルを選ぶ' })).toBeInViewport();
  const layout = await page.evaluate(() => {
    const dialogElement = document.querySelector<HTMLElement>('.dialog--vocal-cut');
    const body = dialogElement?.querySelector<HTMLElement>('.dialog__body');
    if (!dialogElement || !body) throw new Error('karaoke dialog layout missing');
    const bounds = dialogElement.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: document.documentElement.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
    };
  });
  expect(layout.documentWidth).toBe(layout.viewportWidth);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.bodyOverflowY).toBe('auto');
});
