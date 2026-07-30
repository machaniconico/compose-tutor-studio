import { expect, test, type Page } from '@playwright/test';

const SAMPLE_RATE = 48_000;

function monitorExternalRuntimeNetwork(page: Page, baseURL: string): string[] {
  const allowedHost = new URL(baseURL).host;
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!/^(?:https?|wss?):/u.test(url)) return;
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      externalRequests.push(url);
      return;
    }
    if (target.host !== allowedHost) {
      externalRequests.push(`${request.resourceType()}:${url}`);
    }
  });
  page.on('websocket', (socket) => {
    const url = socket.url();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      externalRequests.push(`websocket:${url}`);
      return;
    }
    if (target.host !== allowedHost) {
      externalRequests.push(`websocket:${url}`);
    }
  });
  return externalRequests;
}

function selfAuthoredSineWav(): Buffer {
  const frameCount = SAMPLE_RATE / 4;
  const dataBytes = frameCount * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.sin((2 * Math.PI * 330 * frame) / SAMPLE_RATE) * 0.25;
    bytes.writeInt16LE(Math.round(sample * 0x7fff), 44 + frame * 2);
  }
  return bytes;
}

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

type StoredProject = {
  id: string;
  title: string;
  audioAssets: Array<{
    availability: string;
    checksumSha256?: string;
    byteLength?: number;
  }>;
};

async function newestStoredProject(page: Page): Promise<StoredProject> {
  return page.evaluate(() => {
    const projects: Array<StoredProject & { updatedAt: string }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith('cts.persistence.v1.project.') || !key.endsWith('.head')) continue;
      const head = JSON.parse(localStorage.getItem(key) ?? '{}') as {
        state?: string;
        generationKey?: string;
      };
      if (head.state !== 'active' || !head.generationKey) continue;
      const generation = JSON.parse(localStorage.getItem(head.generationKey) ?? '{}') as {
        projectJson?: string;
      };
      if (generation.projectJson) {
        projects.push(JSON.parse(generation.projectJson) as StoredProject & { updatedAt: string });
      }
    }
    projects.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const project = projects[0];
    if (!project) throw new Error('No stored project');
    return project;
  });
}

test('moves a self-authored Audio Track bundle into a fresh browser context', async ({
  baseURL,
  browser,
  page,
}) => {
  if (!baseURL) throw new Error('Playwright baseURL is required');
  const sourceExternalRequests = monitorExternalRuntimeNetwork(page, baseURL);
  const wav = selfAuthoredSineWav();
  await page.goto('/');
  await dismissWelcome(page);
  await page.getByLabel('プロジェクト名', { exact: true }).fill('Portable Sine Song');
  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const addTrack = page.getByRole('dialog', { name: 'トラックを追加' });
  await addTrack.getByRole('radio', { name: /オーディオトラック/ }).check();
  await addTrack.getByLabel('名前', { exact: true }).fill('Portable Sine');
  await addTrack.locator('input[type="file"]').setInputFiles({
    name: 'self-authored-sine.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  });
  await expect(page.getByRole('button', {
    name: 'Portable Sine トラックを選択',
    exact: true,
  })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Control+S');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  const before = await newestStoredProject(page);
  const sourceAsset = before.audioAssets.find((asset) => asset.availability === 'ready');
  expect(sourceAsset?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(sourceAsset?.byteLength).toBe(wav.byteLength);

  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {
    name: '音声込みポータブルを書き出し',
    exact: true,
  }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Portable_Sine_Song.ctsbundle');
  const bundlePath = await download.path();
  if (!bundlePath) throw new Error('Bundle download path is unavailable');

  const destinationContext = await browser.newContext();
  let destinationExternalRequests: string[] = [];
  try {
    const destination = await destinationContext.newPage();
    destinationExternalRequests = monitorExternalRuntimeNetwork(destination, baseURL);
    await destination.goto(page.url());
    await dismissWelcome(destination);
    await destination.getByRole('button', { name: '書き出し', exact: true }).click();
    await destination.locator('input[accept^=".ctsbundle"]').setInputFiles(bundlePath);
    await expect(destination.getByLabel('プロジェクト名', { exact: true }))
      .toHaveValue('Portable Sine Song');
    await expect(destination.getByRole('button', {
      name: 'Portable Sine トラックを選択',
      exact: true,
    })).toBeVisible();
    await destination.getByRole('button', {
      name: 'Portable Sine トラックを選択',
      exact: true,
    }).click();
    await expect(destination.getByText('音声素材を確認済み', { exact: true }).first())
      .toBeVisible();
    await expect(destination.locator('#project-save-status')).toContainText('保存済み');

    await destination.getByRole('button', { name: '再生', exact: true }).click();
    await expect(destination.locator('#transport-playback-status')).toHaveText('再生中です。');
    await expect(destination.getByRole('button', { name: '一時停止', exact: true }))
      .toBeVisible();
    await destination.getByRole('button', { name: '一時停止', exact: true }).click();
    await expect(destination.locator('#transport-playback-status'))
      .toHaveText('再生は停止しています。');

    const after = await newestStoredProject(destination);
    const importedAsset = after.audioAssets.find((asset) => asset.availability === 'ready');
    expect(after.id).not.toBe(before.id);
    expect(importedAsset?.checksumSha256).toBe(sourceAsset?.checksumSha256);
    expect(importedAsset?.byteLength).toBe(sourceAsset?.byteLength);
    const storedAsset = await destination.evaluate(async () => {
      return new Promise<{ checksumSha256: string; byteLength: number }>((resolve, reject) => {
        const open = indexedDB.open('compose-tutor-studio-audio-assets-v1', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database.transaction('assets', 'readonly')
            .objectStore('assets').getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const record = request.result[0] as {
              checksumSha256: string;
              byteLength: number;
            };
            resolve(record);
            database.close();
          };
        };
      });
    });
    expect(storedAsset.checksumSha256).toBe(sourceAsset?.checksumSha256);
    expect(storedAsset.byteLength).toBe(wav.byteLength);
    expect(sourceExternalRequests).toEqual([]);
    expect(destinationExternalRequests).toEqual([]);
  } finally {
    await destinationContext.close();
  }
  expect(sourceExternalRequests).toEqual([]);
  expect(destinationExternalRequests).toEqual([]);
});
