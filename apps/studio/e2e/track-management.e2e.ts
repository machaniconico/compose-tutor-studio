import { expect, test, type Page } from '@playwright/test';

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function trackNames(page: Page): Promise<string[]> {
  return page.locator('.track-list__items .track-row__name').allTextContents();
}

test('manages a track atomically, restores focus, and persists its sound and order', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_024, height: 640 });
  await page.goto('/');
  await dismissWelcome(page);

  const learningManagement = page.getByRole('group', { name: 'Chords 管理', exact: true });
  await expect(learningManagement.getByRole('button', { name: '削除', exact: true })).toHaveCount(0);

  const addButton = page.getByRole('button', { name: '＋ 追加', exact: true });
  await addButton.focus();
  await page.keyboard.press('Enter');
  const addDialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await expect(addDialog).toBeVisible();
  await addDialog.getByLabel('名前', { exact: true }).fill('Counterline');
  await addDialog.getByLabel('音色', { exact: true }).selectOption('brightLead');
  await addDialog.getByRole('button', { name: '追加', exact: true }).click();

  let selectedTrack = page.getByRole('button', {
    name: 'Counterline トラックを選択',
    exact: true,
  });
  await expect(selectedTrack).toBeFocused();
  await expect(selectedTrack).toHaveAttribute('aria-pressed', 'true');

  const rename = page.getByLabel('名前', { exact: true });
  await rename.fill('Bass');
  await page.getByRole('button', { name: '名前を変更', exact: true }).click();
  await expect(page.getByRole('button', {
    name: 'Bass（同名 1/2） トラックを選択',
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Bass（同名 2/2） トラックを選択',
    exact: true,
  })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', {
    name: 'Bass 学習での役割',
    exact: true,
  })).toHaveValue('general');
  await rename.fill('Counterline Pro');
  await page.getByRole('button', { name: '名前を変更', exact: true }).click();
  selectedTrack = page.getByRole('button', {
    name: 'Counterline Pro トラックを選択',
    exact: true,
  });
  await expect(selectedTrack).toBeVisible();

  const preset = page.getByRole('combobox', { name: 'Counterline Pro 音色', exact: true });
  await preset.selectOption('warmBass');
  await expect(preset).toHaveValue('warmBass');

  const management = page.getByRole('group', { name: 'Counterline Pro 管理', exact: true });
  await management.getByRole('button', { name: '上へ移動', exact: true }).click();
  const namesAfterMove = await trackNames(page);
  expect(namesAfterMove.indexOf('Counterline Pro')).toBeLessThan(namesAfterMove.indexOf('Drums'));

  await management.getByRole('button', { name: '複製', exact: true }).click();
  const copyName = 'Counterline Pro コピー';
  const copyTrack = page.getByRole('button', {
    name: `${copyName} トラックを選択`,
    exact: true,
  });
  await expect(copyTrack).toBeFocused();
  await expect(copyTrack).toHaveAttribute('aria-pressed', 'true');

  const copyManagement = page.getByRole('group', { name: `${copyName} 管理`, exact: true });
  const deleteButton = copyManagement.getByRole('button', { name: '削除', exact: true });
  await deleteButton.click();
  const deleteDialog = page.getByRole('dialog', { name: 'トラックを削除' });
  const cancel = deleteDialog.getByRole('button', { name: 'キャンセル', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
  await deleteDialog.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(copyTrack).toHaveCount(0);
  await expect(page.locator('.track-row button[aria-pressed="true"]')).toBeFocused();

  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await undo.click();
  await expect(copyTrack).toBeVisible();
  await redo.click();
  await expect(copyTrack).toHaveCount(0);

  await page.keyboard.press('Control+S');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.reload();
  await dismissWelcome(page);

  await expect(
    page.getByRole('button', {
      name: 'Counterline Pro トラックを選択',
      exact: true,
    }),
  ).toBeVisible();
  const reloadedNames = await trackNames(page);
  expect(reloadedNames.indexOf('Counterline Pro')).toBeLessThan(reloadedNames.indexOf('Drums'));
  await page
    .getByRole('button', { name: 'Counterline Pro トラックを選択', exact: true })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Counterline Pro 音色', exact: true }),
  ).toHaveValue('warmBass');
  expect(pageErrors).toEqual([]);
});

test('keeps the track list and add dialog usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await dismissWelcome(page);

  const layout = await page.evaluate(() => {
    const trackList = document.querySelector<HTMLElement>('.track-list');
    if (!trackList) throw new Error('track list missing');
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      trackListHeight: trackList.getBoundingClientRect().height,
    };
  });
  expect(layout.documentWidth).toBe(layout.viewportWidth);
  expect(layout.trackListHeight).toBeLessThanOrEqual(268);

  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(375);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(667);
  await expect(dialog.getByRole('button', { name: '追加', exact: true })).toBeInViewport();

  await dialog.getByLabel('名前', { exact: true }).fill('Narrow Track');
  await dialog.getByRole('button', { name: '追加', exact: true }).click();
  const added = page.getByRole('button', {
    name: 'Narrow Track トラックを選択',
    exact: true,
  });
  await expect(added).toBeFocused();
  const visibility = await added.evaluate((element) => {
    const row = element.closest('.track-row');
    const list = element.closest('.track-list__items');
    if (!row || !list) throw new Error('track list geometry missing');
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      rowTop: rowRect.top,
      rowBottom: rowRect.bottom,
      listTop: listRect.top,
      listBottom: listRect.bottom,
    };
  });
  expect(visibility.rowTop).toBeGreaterThanOrEqual(visibility.listTop - 1);
  expect(visibility.rowBottom).toBeLessThanOrEqual(visibility.listBottom + 1);
});
