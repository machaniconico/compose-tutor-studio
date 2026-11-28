import { expect, test } from '@playwright/test';

test('keeps a MIDI keyboard take after reloading the page', async ({ page }) => {
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
  await expect(panel.getByRole('button', { name: 'MIDI 録音を停止', exact: true })).toBeEnabled();
  await page.keyboard.press('a', { delay: 120 });
  await page.keyboard.press('s', { delay: 120 });

  const unloadPrevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(unloadPrevented).toBe(true);
  await page.reload();

  await expect(page.locator('.pr__note[aria-label^="C4。"]')).toHaveCount(1);
  await expect(page.locator('.pr__note[aria-label^="D4。"]')).toHaveCount(1);
});

test('refuses Play and Space while a MIDI take is running and keeps the take', async ({ page }) => {
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
  await expect(panel.getByRole('button', { name: 'MIDI 録音を停止', exact: true })).toBeEnabled();

  const play = page.getByRole('button', { name: /^再生（録音中は使えません）$/ });
  await expect(play).toBeDisabled();
  await expect(play).toHaveAttribute('title', '録音中は再生できません。録音を止めてから再生してください。');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await expect(page.locator('.persistence-notice'))
    .toContainText('録音中は再生できません。録音を止めてから再生してください。');
  await expect(page.locator('#transport-playback-status')).toHaveText('再生は停止しています。');

  await page.keyboard.press('a', { delay: 120 });
  await panel.getByRole('button', { name: 'MIDI 録音を停止', exact: true }).click();
  await expect(page.locator('.pr__note[aria-label^="C4。"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
});
