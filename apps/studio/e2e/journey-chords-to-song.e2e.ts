import { expect, test } from '@playwright/test';
import { startBlankProject } from './fixtures/journey-helpers';

// Journey: chords -> おまかせ伴奏 (P3A) -> play/stop -> Undo/Redo as one step
// -> song length (P31) -> clip split (P32).
test('journey: chords to a three-track accompaniment, then length and split', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await startBlankProject(page);

  const trackSelectors = page.getByRole('button', { name: /トラックを選択$/ });
  // Blank project: Chords / Bass / Melody / Drums / Master.
  const baseline = await trackSelectors.count();
  expect(baseline).toBe(5);

  // Place three chords with the chord-lane keyboard cursor (one per bar).
  const lane = page.getByRole('region', { name: 'コードトラック', exact: true });
  const grid = lane.getByRole('group', { name: /コードグリッド/ });
  await grid.focus();
  await grid.press('Space');
  await grid.press('ArrowRight');
  await grid.press('Space');
  await grid.press('ArrowRight');
  await grid.press('Space');
  await expect(lane.getByRole('button', { name: /コードを編集。第1小節/ })).toBeVisible();
  await expect(lane.getByRole('button', { name: /コードを編集。第2小節/ })).toBeVisible();
  await expect(lane.getByRole('button', { name: /コードを編集。第3小節/ })).toBeVisible();
  await expect(lane.locator('.chord-lane__count')).toHaveText('3 個');

  // おまかせ伴奏 adds exactly three new tracks and leaves the existing ones.
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'おまかせ伴奏', exact: true });
  await assistant.getByRole('button', { name: 'おまかせで伴奏を作る', exact: true }).click();
  await expect(assistant.getByRole('status')).toContainText('新しいトラック 3 本');
  await expect(trackSelectors).toHaveCount(baseline + 3);
  for (const name of ['伴奏', 'ベース', 'ドラム']) {
    await expect(page.getByRole('button', { name: `${name} トラックを選択`, exact: true })).toBeVisible();
  }

  // Play, watch the playhead move, then stop (pause + return to start).
  const play = page.getByRole('button', { name: '再生', exact: true });
  await play.click();
  const pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pause).toBeVisible();
  await expect(page.getByLabel('再生位置')).not.toHaveText('1.1');
  await pause.click();
  await expect(play).toBeVisible();
  await page.getByRole('button', { name: '先頭へ戻す', exact: true }).click();
  await expect(page.getByLabel('再生位置')).toHaveText('1.1');

  // One Undo removes all three tracks; one Redo brings them back.
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await undo.click();
  await expect(trackSelectors).toHaveCount(baseline);
  await expect(page.getByRole('button', { name: '伴奏 トラックを選択', exact: true })).toHaveCount(0);
  await redo.click();
  await expect(trackSelectors).toHaveCount(baseline + 3);

  // Song length (P31): 8 -> 12 bars.
  await page.getByRole('tab', { name: 'テンポ / 拍子', exact: true }).click();
  const lengthPanel = page.locator('.song-length-panel');
  await expect(lengthPanel).toContainText('いまの長さ: 8小節');
  await lengthPanel.getByRole('spinbutton', { name: '小節数を指定' }).fill('12');
  await lengthPanel.getByRole('button', { name: '変更', exact: true }).click();
  await expect(lengthPanel).toContainText('いまの長さ: 12小節');

  // Split the generated 伴奏 clip (0.0 - 3.0 bars) at bar 1.5 (P32).
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  await page.getByRole('button', { name: /^伴奏、クリップ1、0\.0小節から3\.0小節/ }).click();
  const editor = page.getByRole('region', { name: '選択クリップの編集', exact: true });
  await editor.getByRole('spinbutton', { name: '分割位置（小節）' }).fill('1.5');
  await editor.getByRole('button', { name: '分割', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'クリップを分割しました。' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^伴奏、クリップ1、0\.0小節から1\.5小節/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^伴奏、クリップ2、1\.5小節から1\.5小節/ })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
