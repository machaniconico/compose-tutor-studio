import { expect, test } from '@playwright/test';

test('arranger section editor exposes expansion and restores deterministic focus', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();

  const mainSection = page.locator('.arranger__section').filter({ hasText: 'メイン' });
  await mainSection.focus();
  await mainSection.press('Enter');
  await expect(mainSection).toHaveAttribute('aria-expanded', 'true');
  await expect(mainSection).toHaveAttribute('aria-controls', 'arranger-section-editor');
  const sectionEditor = page.getByRole('region', { name: '選択セクションの編集', exact: true });
  const sectionName = sectionEditor.getByRole('textbox', { name: 'セクション名', exact: true });
  await expect(sectionName).toBeFocused();
  for (const next of [
    sectionEditor.getByRole('combobox', { name: 'セクション種類', exact: true }),
    sectionEditor.getByRole('spinbutton', { name: '開始小節', exact: true }),
    sectionEditor.getByRole('spinbutton', { name: '長さ（小節）', exact: true }),
    sectionEditor.getByRole('button', { name: 'このセクションを削除', exact: true }),
    sectionEditor.getByRole('button', { name: '閉じる', exact: true }),
  ]) {
    await page.keyboard.press('Tab');
    await expect(next).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(mainSection).toBeFocused();
  await expect(mainSection).toHaveAttribute('aria-expanded', 'false');

  const addSection = page.getByRole('button', { name: '＋ セクションを追加', exact: true });
  await addSection.click();
  const nextSection = page.locator('.arranger__section').filter({ hasText: '新しいセクション' });
  await expect(nextSection).toHaveCount(1);

  await mainSection.focus();
  await mainSection.press('Enter');
  await expect(sectionName).toBeFocused();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('Tab');
  await expect(
    sectionEditor.getByRole('button', { name: 'このセクションを削除', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(nextSection).toBeFocused();

  await nextSection.press('Enter');
  await expect(sectionName).toBeFocused();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('Tab');
  await expect(
    sectionEditor.getByRole('button', { name: 'このセクションを削除', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(addSection).toBeFocused();
  expect(pageErrors).toEqual([]);
});
