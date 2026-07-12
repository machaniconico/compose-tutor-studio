import { expect, test } from '@playwright/test';

test('contains a real render failure and refreshes the sanitized recovery report', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/fatal-boundary.html');

  const heading = page.getByRole('heading', { name: 'アプリを続行できませんでした' });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();

  await page.getByText('診断情報を表示').click();
  const report = page.getByRole('textbox', { name: 'サポートへ共有する診断情報' });
  await expect(report).toHaveValue(/"stage": "render"/);
  await expect(report).not.toHaveValue(/秘密の曲|\/Users\/example/);
});

test('keeps fallback DOM when diagnostic formatting itself throws', async ({ page }) => {
  await page.goto('/e2e/fixtures/fatal-boundary.html?formatter=failed');

  await expect(
    page.getByRole('heading', { name: 'アプリを続行できませんでした' }),
  ).toBeVisible();
  await page.getByText('診断情報を表示').click();
  await expect(
    page.getByRole('textbox', { name: 'サポートへ共有する診断情報' }),
  ).toHaveValue(/Diagnostics could not be formatted/);
});

for (const copyMode of ['unavailable', 'failed'] as const) {
  test(`keeps a keyboard-copyable report when clipboard copy is ${copyMode}`, async ({
    page,
  }) => {
    await page.goto(`/e2e/fixtures/fatal-boundary.html?copy=${copyMode}`);
    await page.getByRole('button', { name: '診断情報をコピー' }).click();

    await expect(
      page.getByText(
        '自動コピーできませんでした。下の診断情報を選択してコピーしてください。',
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByText('診断情報を表示').click();

    const report = page.getByRole('textbox', { name: 'サポートへ共有する診断情報' });
    await report.focus();
    await expect(report).toBeFocused();
    await expect
      .poll(() =>
        report.evaluate((element) =>
          element instanceof HTMLTextAreaElement ? element.selectionEnd : 0,
        ),
      )
      .toBeGreaterThan(0);
  });
}
