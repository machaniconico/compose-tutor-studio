import { expect, test } from '@playwright/test';

test('PC keyboard recording can be quantized and Undo restores the recorded position', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.goto('/');
  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('navigation', { name: 'トラック一覧' })
    .getByText('Melody', { exact: true }).click();
  await page.getByLabel('BPM', { exact: true }).fill('60');
  await page.getByLabel('音の位置を自動でそろえる').selectOption('0');
  await page.getByLabel('グリッド分解能').selectOption('2');
  await page.getByLabel('クオンタイズの強さ').selectOption('100');

  const playOnPc = page.getByRole('button', { name: 'PC で演奏' });
  await playOnPc.click();
  await expect(playOnPc).toHaveAttribute('aria-pressed', 'true');
  const notes = page.locator('.pr__note');
  await expect(notes).toHaveCount(0);

  const record = page.getByRole('button', { name: '● 録音', exact: true });
  await record.click();
  await expect(page.getByText(/カウントイン中/)).toBeVisible();
  await page.keyboard.press('s');
  await expect(page.getByText('録音中', { exact: true })).toBeVisible();

  // Playing on the second beat leaves the note off the two-beat grid.
  await expect(page.getByLabel('再生位置(小節.拍)', { exact: true })).toHaveText('1.2');
  await page.keyboard.press('a');
  await page.getByRole('button', { name: '■ 録音を止める' }).click();
  await expect(record).toBeVisible();
  await expect(notes).toHaveCount(1);
  await expect(notes).toHaveAttribute('title', /^C4 \/ 強さ /);
  await playOnPc.click();

  const recordedLeft = await notes.evaluate((note) => getComputedStyle(note).left);
  await notes.click();
  await page.getByRole('button', { name: '選択をクオンタイズ' }).click();
  // The two-beat grid line is at 56 px at the initial zoom.
  await expect(notes).toHaveCSS('left', '56px');
  expect(recordedLeft).not.toBe('56px');

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(notes).toHaveCSS('left', recordedLeft);
});
