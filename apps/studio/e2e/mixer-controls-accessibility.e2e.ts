import { expect, test } from '@playwright/test';

test('mute and solo controls expose their track and action names', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  const trackList = page.getByRole('navigation', { name: 'トラック一覧', exact: true });
  await expect(trackList.getByRole('button', { name: 'Chords ミュート', exact: true }))
    .toHaveCount(1);
  await expect(trackList.getByRole('button', { name: 'Chords ソロ', exact: true }))
    .toHaveCount(1);
  const bassTrack = trackList.getByRole('button', {
    name: 'Bass トラックを選択',
    exact: true,
  });
  await bassTrack.click();
  await expect(bassTrack).toHaveAttribute('aria-pressed', 'true');
  await expect(
    trackList.getByRole('button', { name: 'Chords トラックを選択', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');

  await expect(page.getByRole('main')).toHaveCount(1);
  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  const mute = mixer.getByRole('button', { name: 'Chords ミュート', exact: true });
  const solo = mixer.getByRole('button', { name: 'Chords ソロ', exact: true });
  await expect(mute).toHaveCount(1);
  await expect(solo).toHaveCount(1);

  await mute.focus();
  await mute.press('Space');
  await expect(mute).toBeFocused();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect(
    trackList.getByRole('button', { name: 'Chords ミュート', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(pageErrors).toEqual([]);
});

test('repeated effects expose stable unique names for every editor control', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  const addEffect = mixer.getByRole('combobox', {
    name: 'Chords エフェクト追加',
    exact: true,
  });
  await addEffect.selectOption('filter');
  const first = mixer.getByRole('group', { name: 'Chords フィルター 1', exact: true });
  await expect(first).toBeVisible();

  await addEffect.selectOption('filter');
  const second = mixer.getByRole('group', { name: 'Chords フィルター 2', exact: true });
  await expect(second).toBeVisible();
  await expect(
    first.getByRole('slider', { name: 'Chords フィルター 1 明るさ', exact: true }),
  ).toHaveCount(1);
  await expect(
    second.getByRole('slider', { name: 'Chords フィルター 2 明るさ', exact: true }),
  ).toHaveCount(1);

  await second
    .getByRole('button', { name: 'Chords フィルター 2を削除', exact: true })
    .press('Enter');
  await expect(second).toHaveCount(0);
  await expect(first).toBeVisible();
  expect(pageErrors).toEqual([]);
});
