import { expect, test, type Page } from '@playwright/test';

const SAMPLE_RATE = 48_000;

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

function createMonoFixture(): Buffer {
  const frames = SAMPLE_RATE / 2;
  const dataBytes = frames * 2;
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
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = 0.35 * Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE);
    bytes.writeInt16LE(Math.round(sample * 0x7fff), 44 + frame * 2);
  }
  return bytes;
}

async function indexedAudioAssetCount(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('compose-tutor-studio-audio-assets-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('assets', 'readonly');
      const count = transaction.objectStore('assets').count();
      count.onerror = () => reject(count.error);
      count.onsuccess = () => resolve(count.result);
      transaction.oncomplete = () => database.close();
    };
  }));
}

test('imports, edits, deduplicates and reloads a browser-persisted Audio Track', async ({ page }) => {
  const pageErrors: string[] = [];
  const fixture = createMonoFixture();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await dismissWelcome(page);

  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await dialog.getByRole('radio', { name: /オーディオトラック/ }).check();
  await dialog.getByLabel('名前', { exact: true }).fill('Reference Audio');
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'reference tone.wav',
    mimeType: 'audio/wav',
    buffer: fixture,
  });

  const trackButton = page.getByRole('button', {
    name: 'Reference Audio トラックを選択',
    exact: true,
  });
  await expect(trackButton).toBeVisible({ timeout: 20_000 });
  await expect(trackButton).toBeFocused();
  await expect(page.getByRole('tab', { name: 'アレンジ', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const editor = page.getByRole('region', { name: '選択オーディオクリップの編集' });
  await expect(editor).toContainText('reference tone.wav');
  await expect(editor).toContainText('音声素材を確認済み');

  const move = editor.getByLabel('配置開始（小節・0から）', { exact: true });
  await move.fill('1');
  await move.press('Enter');
  await expect(move).toHaveValue('1');

  const rightTrim = editor.getByLabel('右端トリム（小節）', { exact: true });
  await rightTrim.fill('1.2');
  await rightTrim.press('Enter');
  await expect(rightTrim).toHaveValue('1.2');

  const gain = editor.getByLabel('クリップゲイン（dB）', { exact: true });
  await gain.fill('-6');
  await gain.press('Enter');
  await expect(gain).toHaveValue('-6');

  const fadeIn = editor.getByLabel('フェードイン（ms）', { exact: true });
  await fadeIn.fill('25');
  await fadeIn.press('Enter');
  await expect(fadeIn).toHaveValue('25');

  const loop = editor.getByRole('checkbox', {
    name: '素材範囲をクリップ末尾まで繰り返す',
    exact: true,
  });
  await loop.check();
  await expect(loop).toBeChecked();
  await expect(editor.getByRole('button', { name: 'この位置で分割', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: '連動コピーは利用不可', exact: true })).toBeDisabled();

  await editor.getByRole('button', { name: '独立コピーを右へ', exact: true }).click();
  await expect(page.locator('.arranger__clip.is-audio')).toHaveCount(2);
  await expect.poll(() => indexedAudioAssetCount(page)).toBe(1);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(page.locator('.arranger__clip.is-audio')).toHaveCount(1);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(page.locator('.arranger__clip.is-audio')).toHaveCount(2);

  // Import the exact same encoded WAV again. This exercises IndexedDB's
  // existing-object transaction path; clip copy alone would not call store().
  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const secondDialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await secondDialog.getByRole('radio', { name: /オーディオトラック/ }).check();
  await secondDialog.getByLabel('名前', { exact: true }).fill('Reference Duplicate');
  await secondDialog.locator('input[type="file"]').setInputFiles({
    name: 'reference tone.wav',
    mimeType: 'audio/wav',
    buffer: fixture,
  });
  await expect(page.getByRole('button', {
    name: 'Reference Duplicate トラックを選択',
    exact: true,
  })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.arranger__clip.is-audio')).toHaveCount(3);
  await expect.poll(() => indexedAudioAssetCount(page)).toBe(1);

  await page.keyboard.press('Control+S');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.reload();
  await dismissWelcome(page);

  await expect(trackButton).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Reference Duplicate トラックを選択',
    exact: true,
  })).toBeVisible();
  await trackButton.click();
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  const reloadedEditor = page.getByRole('region', { name: '選択オーディオクリップの編集' });
  await expect(page.locator('.arranger__clip.is-audio')).toHaveCount(3);
  await expect(reloadedEditor).toContainText('reference tone.wav');
  await expect(reloadedEditor).toContainText('音声素材を確認済み');
  await expect(
    page.locator('.track-inspector__audio-assets').getByText('音声素材を確認済み', { exact: true }),
  ).toBeVisible();
  await expect(reloadedEditor.getByLabel('配置開始（小節・0から）', { exact: true })).toHaveValue('1');
  await expect(reloadedEditor.getByLabel('右端トリム（小節）', { exact: true })).toHaveValue('1.2');
  await expect(reloadedEditor.getByLabel('クリップゲイン（dB）', { exact: true })).toHaveValue('-6');
  await expect(reloadedEditor.getByLabel('フェードイン（ms）', { exact: true })).toHaveValue('25');
  await expect(reloadedEditor.getByRole('checkbox', {
    name: '素材範囲をクリップ末尾まで繰り返す',
    exact: true,
  })).toBeChecked();
  await expect.poll(() => indexedAudioAssetCount(page)).toBe(1);
  expect(pageErrors).toEqual([]);
});
