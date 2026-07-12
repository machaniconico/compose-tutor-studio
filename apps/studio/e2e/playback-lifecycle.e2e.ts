import { expect, test } from '@playwright/test';

test('audio startup failure returns to a retryable stopped state', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    class BlockedAudioContext {
      constructor() {
        throw new Error('e2e audio start blocked');
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: BlockedAudioContext,
    });
  });

  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  await welcome.getByRole('button', { name: 'あとで', exact: true }).click();

  const playButton = page.getByRole('button', { name: '再生', exact: true });
  await playButton.click();

  const alert = page.getByRole('alert').filter({ hasText: '音を再生できませんでした' });
  await expect(alert).toContainText('もう一度「再生」を押してください');
  await expect(playButton).toBeVisible();
  await expect(playButton).not.toHaveAttribute('aria-busy', 'true');
  expect(pageErrors).toEqual([]);

  // The failed context was not committed: a new user gesture remains a safe,
  // bounded retry instead of leaving the UI in a fake playing state.
  await playButton.click();
  await expect(alert).toBeVisible();
  await expect(playButton).toBeVisible();
  expect(pageErrors).toEqual([]);
});
