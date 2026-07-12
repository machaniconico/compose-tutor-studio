import { expect, test } from '@playwright/test';

test('section timing inputs never push the project outside its song length', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  await page.getByRole('button', { name: /メイン/ }).click();

  const sectionEditor = page.getByRole('region', { name: '選択セクションの編集' });
  const start = sectionEditor.getByRole('spinbutton', { name: '開始小節', exact: true });
  const length = sectionEditor.getByRole('spinbutton', { name: '長さ（小節）', exact: true });
  await expect(start).toHaveAttribute('max', '0');
  await expect(length).toHaveAttribute('max', '8');

  // The default section already fills all 8 bars. A typed start of 1 must be
  // rejected at the editor boundary without turning the current save state
  // into a false, permanent "invalid project" error.
  await start.fill('1');
  await expect(start).toHaveValue('1');
  await expect(page.locator('#project-save-status')).toHaveText('未保存');
  await start.press('Enter');
  await expect(start).toHaveValue('0');
  await expect(page.locator('#project-save-status')).not.toContainText('保存できません');
  await expect(page.getByRole('button', { name: '保存不可', exact: true })).toHaveCount(0);

  // Once the length leaves one bar available, the same start becomes valid and
  // both input maxima update atomically.
  await length.selectText();
  await length.press('Backspace');
  await expect(length).toHaveValue('');
  await expect(page.locator('#project-save-status')).toHaveText('未保存');
  await length.type('4');
  await expect(length).toHaveValue('4');
  await length.blur();
  await expect(start).toHaveAttribute('max', '4');
  await start.fill('3');
  await start.press('Escape');
  await expect(start).toHaveValue('0');
  await start.fill('1');
  await start.press('Enter');
  await expect(start).toHaveValue('1');
  await expect(length).toHaveAttribute('max', '7');
  await expect(page.locator('#project-save-status')).not.toContainText('保存できません');

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.reload();
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  await page.getByRole('button', { name: /メイン/ }).click();
  const restoredEditor = page.getByRole('region', { name: '選択セクションの編集' });
  await expect(
    restoredEditor.getByRole('spinbutton', { name: '開始小節', exact: true }),
  ).toHaveValue('1');
  await expect(
    restoredEditor.getByRole('spinbutton', { name: '長さ（小節）', exact: true }),
  ).toHaveValue('4');
  expect(pageErrors).toEqual([]);
});
