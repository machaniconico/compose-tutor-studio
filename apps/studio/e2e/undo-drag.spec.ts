import { expect, test } from '@playwright/test';

test('deleting a note mid-drag leaves the next edit as its own undo step', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /サンプルプロジェクトを聴く/ }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('button', { name: '一時停止' }).click();

  const notes = page.locator('.pr__note');
  await expect(notes.first()).toBeVisible();
  const noteCount = await notes.count();
  await notes.first().scrollIntoViewIfNeeded();
  const box = await notes.first().boundingBox();
  if (!box) throw new Error('note has no position');
  const keySelect = page.getByLabel('キー', { exact: true });
  const keyBefore = await keySelect.inputValue();
  const otherKey = keyBefore === 'G' ? 'D' : 'G';

  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
  await page.keyboard.press('Delete');
  await expect(notes).toHaveCount(noteCount - 1);

  // Released outside the grid: the captured note is gone, so the grid hears nothing.
  await page.mouse.move(5, 5);
  await page.mouse.up();

  await keySelect.selectOption(otherKey);
  const undo = page.getByRole('button', { name: /元に戻す/ });
  await undo.click();
  await expect(keySelect).toHaveValue(keyBefore);
  await expect(notes).toHaveCount(noteCount - 1);

  await undo.click();
  await expect(notes).toHaveCount(noteCount);
});
