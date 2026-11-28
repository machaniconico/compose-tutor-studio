import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CURRENT_SCHEMA_VERSION } from '@cts/project-model';

const fixture = fileURLToPath(new URL('../tests/acceptance/fixtures/p70/inputs/roles.json', import.meta.url));

test('Wave5 project import can be cancelled and opens a saved copy only after confirmation', async ({ page }) => {
  const original = await readFile(fixture, 'utf8');
  const source = JSON.parse(original) as { id: string; title: string };
  await page.goto('/');
  await page.getByRole('dialog', { name: 'ようこそ' }).getByRole('button', { name: 'あとで' }).click();

  const title = page.getByRole('textbox', { name: 'プロジェクト名' });
  const currentTitle = await title.inputValue();
  const exportTrigger = page.getByRole('button', { name: '書き出し', exact: true });
  const exportMenu = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  const conversion = page.getByRole('dialog', { name: '以前の曲を読み込む', exact: true });

  await exportTrigger.click();
  const fileInput = exportMenu.locator('input[type="file"][accept*=".json"]');
  await fileInput.setInputFiles(fixture);
  await expect(conversion).toBeVisible();
  await expect(exportMenu).toBeHidden();
  await expect(conversion.getByRole('button', { name: 'やめる' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(conversion).toBeHidden();
  await expect(exportMenu).toBeVisible();
  await exportMenu.getByRole('button', { name: '閉じる' }).click();
  await expect(title).toHaveValue(currentTitle);

  await exportTrigger.click();
  await fileInput.setInputFiles(fixture);
  await conversion.getByRole('button', { name: '変換する' }).click();
  await expect(conversion).toContainText('変わる項目 2件');
  await expect(conversion).toContainText('元のファイルは変わりません。コピーとして開きます。');
  await expect(conversion.getByRole('listitem')).toHaveCount(2);
  await conversion.getByRole('button', { name: 'この内容で開く' }).click();
  await expect(conversion).toBeHidden();
  await expect(title).toHaveValue(source.title);
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  await exportTrigger.click();
  const downloadPromise = page.waitForEvent('download');
  await exportMenu.getByRole('button', { name: 'プロジェクト書き出し' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const copy = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number; id: string; title: string };
  expect(copy).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, title: source.title });
  expect(copy.id).not.toEqual(source.id);
  expect(await readFile(fixture, 'utf8')).toBe(original);
});
