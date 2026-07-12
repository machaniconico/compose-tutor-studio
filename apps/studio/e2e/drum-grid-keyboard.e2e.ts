import { expect, test } from '@playwright/test';

test('drum grid has one roving tab stop and stays local under keyboard editing', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('tab', { name: 'ドラム', exact: true }).click();

  const grid = page.getByRole('grid', { name: /^ドラムステップ、小節 1 \/ / });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('row')).toHaveCount(6);
  await expect(grid.getByRole('rowheader')).toHaveCount(6);
  await expect(grid.getByRole('gridcell')).toHaveCount(96);
  const cells = page.locator('.drum-cell:not(:disabled)');
  await expect(cells).toHaveCount(96);
  await expect(page.locator('.drum-cell[tabindex="0"]:not(:disabled)')).toHaveCount(1);

  const first = page.getByRole('button', { name: /^小節 1、キック ステップ 1(?: |$)/ });
  await first.focus();
  await first.press('ArrowRight');
  const kickSecond = page.getByRole('button', { name: /^小節 1、キック ステップ 2(?: |$)/ });
  await expect(kickSecond).toBeFocused();
  await kickSecond.press('ArrowDown');
  const snareSecond = page.getByRole('button', { name: /^小節 1、スネア ステップ 2(?: |$)/ });
  await expect(snareSecond).toBeFocused();
  await snareSecond.press('End');
  const snareLast = page.getByRole('button', { name: /^小節 1、スネア ステップ 16(?: |$)/ });
  await expect(snareLast).toBeFocused();

  await snareLast.press('Space');
  await expect(snareLast).toBeFocused();
  await expect(snareLast).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.locator('.drum-cell[tabindex="0"]:not(:disabled)')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});
