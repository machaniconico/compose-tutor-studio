import { expect, test } from '@playwright/test';

test('compose-5 advances when a chorus section is created through the arranger UI', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('tab', { name: 'チュートリアル', exact: true }).click();
  await page
    .getByRole('button', { name: /曲の構成とミックスで仕上げる/ })
    .click();

  await expect(
    page.getByText('コーラスセクションを追加しよう', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('ステップ 1 / 6', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'ヒントを見る', exact: true }).click();
  await expect(page.getByText(/「アレンジ」タブ.*「＋ セクションを追加」/)).toBeVisible();
  await page.getByRole('button', { name: 'ヒントを見る', exact: true }).click();
  await expect(page.getByText(/「セクション種類」で「サビ」/)).toBeVisible();

  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  await page.getByRole('button', { name: '＋ セクションを追加', exact: true }).click();
  await page.getByRole('button', { name: /新しいセクション/ }).click();

  const sectionType = page.getByRole('combobox', { name: 'セクション種類', exact: true });
  await sectionType.selectOption('chorus');
  await expect(sectionType).toHaveValue('chorus');

  // Step 2 is already satisfied by the default Melody volume. Project-state
  // reconciliation must therefore continue to the first event-backed step.
  await expect(
    page.getByText('全体を再生して最終確認しよう', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('ステップ 3 / 6', { exact: true })).toBeVisible();
  await expect(page.getByText(/「セクション種類」で「サビ」/)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
