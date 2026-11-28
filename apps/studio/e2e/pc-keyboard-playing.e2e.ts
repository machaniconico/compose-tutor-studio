import { expect, test } from '@playwright/test';

for (const size of [{ width: 1_024, height: 640 }, { width: 1_440, height: 900 }]) {
  test(`PC keyboard playing panel stays inside the window at ${size.width}x${size.height}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize(size);
    await page.goto('/');
    const welcome = page.getByRole('dialog', { name: 'ようこそ' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'あとで', exact: true }).click();

    const toggle = page.getByRole('button', { name: 'PC鍵盤で弾く', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const panel = page.getByRole('group', { name: 'PC鍵盤で弾く' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('スケールロックをオンにすると、どのキーを押してもスケールの音だけが鳴ります')).toBeVisible();
    await panel.getByRole('checkbox', { name: 'スケールロック' }).check();
    await expect(panel.getByRole('list', { name: 'キーと音の割り当て' })).toContainText('D4');

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);

    // Letter keys are played, not typed: a held key sounds without changing the project.
    await page.keyboard.down('a');
    await page.keyboard.up('a');
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(panel).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
}

test('records a PC keyboard note into the selected clip and undoes the take', async ({ page }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  await page.getByRole('button', { name: '☰ プロジェクト', exact: true }).click();
  await page.getByRole('dialog', { name: 'プロジェクト', exact: true })
    .locator('button.template-card--blank').click();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true })).toHaveValue('新しい曲');

  await page.getByRole('button', { name: 'PC鍵盤で弾く', exact: true }).click();
  const panel = page.getByRole('group', { name: 'PC鍵盤で弾く' });
  await panel.getByRole('button', { name: 'MIDI 録音', exact: true }).click();
  const stop = panel.getByRole('button', { name: 'MIDI 録音を停止', exact: true });
  await expect(stop).toBeEnabled();
  await page.keyboard.press('a', { delay: 120 });
  await stop.click();
  await expect(panel.getByText('録音を反映しました。 入らなかった音は 0 音です。')).toBeVisible();
  const note = page.locator('.pr__note[aria-label^="C4。"]');
  await expect(note).toHaveCount(1);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(note).toHaveCount(0);
});
