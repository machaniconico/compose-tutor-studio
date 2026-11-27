import { expect, test } from '@playwright/test';
import { expectValidWavFile } from './exportAssertions';

test('a mix with EQ and a fade-in exports at 48 kHz and appears in history', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('navigation', { name: 'トラック一覧' })
    .getByText('Chords', { exact: true }).click();
  await page.getByRole('button', { name: 'コードをノートにする' }).click();
  await expect(page.locator('.pr__note').first()).toBeVisible();

  const channel = page.locator('.mix-ch').filter({ has: page.getByTitle('Chords', { exact: true }) });
  const effects = channel.getByText('FX', { exact: true });
  await effects.click();
  const eq = channel.getByRole('checkbox', { name: 'Chords イコライザー', exact: true });
  await eq.check();
  await expect(eq).toBeChecked();
  const highs = channel.getByRole('slider', { name: 'Chords イコライザー 高音' });
  await highs.fill('6');
  await expect(highs).toHaveValue('6');
  await effects.click();

  await page.getByRole('tab', { name: '曲全体' }).click();
  await page.getByLabel('Chordsの音の変化').click();
  await page.getByRole('button', { name: 'フェードイン', exact: true }).click();
  await expect(page.getByRole('button', { name: '曲の始まりから 0 拍、音量 0%' })).toBeVisible();
  await expect(page.getByRole('button', { name: '曲の始まりから 4 拍、音量 100%' })).toBeVisible();

  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const history = page.getByRole('region', { name: '書き出し履歴' });
  await expect(history.getByText('まだ書き出し履歴はありません。')).toBeVisible();
  await page.getByLabel('WAVのサンプルレート').selectOption('48000');
  await page.getByRole('button', { name: 'WAVエクスポート' }).click();
  const checklist = page.getByRole('dialog', { name: '書き出し前チェック（WAV）' });
  const downloadPending = page.waitForEvent('download');
  await checklist.getByRole('button', { name: /WAVを書き出す|このまま書き出す/ }).click();
  const download = await downloadPending;
  const filename = download.suggestedFilename();
  expect(filename).toMatch(/\.wav$/);
  await expectValidWavFile(await download.path(), 48000);

  const entry = history.getByRole('listitem').filter({ hasText: filename });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('48 kHz / 全体');
});
