import { expect, test } from '@playwright/test';

test('chord-lane ruler scrolls to the last bar and seeks there when zoomed in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /サンプルプロジェクトを聴く/ }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('button', { name: '一時停止' }).click();

  // Zoom from 100% to the 400% maximum (12 steps of 25%) so the lane overflows its pane.
  const zoomIn = page.getByRole('button', { name: 'ズームイン' });
  for (let step = 0; step < 12; step += 1) await zoomIn.click();
  await expect(page.locator('.pr__zoom-val')).toHaveText('400%');

  const viewport = page.getByTestId('chord-lane-scroll');
  const widths = await viewport.evaluate((el) => ({
    client: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  expect(widths.scroll).toBeGreaterThan(widths.client);

  const bars = viewport.getByTestId('timeline-ruler').locator('.timeline-ruler__bar');
  const barCount = await bars.count();
  expect(barCount).toBeGreaterThan(1);
  const lastBar = bars.nth(barCount - 1);

  // Before scrolling, the last bar sits beyond the right edge of the lane.
  const viewportBox = await viewport.boundingBox();
  const lastBarBefore = await lastBar.boundingBox();
  if (!viewportBox || !lastBarBefore) throw new Error('chord lane has no layout');
  expect(lastBarBefore.x).toBeGreaterThan(viewportBox.x + viewportBox.width);

  // Scroll the way a user does: a horizontal wheel over the lane. A clipped
  // (overflow: hidden) ancestor would ignore this, so the lane itself must scroll.
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2);
  await page.mouse.wheel(widths.scroll, 0);
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  expect(await page.locator('.center-pane').evaluate((el) => el.scrollLeft)).toBe(0);

  const lastBarAfter = await lastBar.boundingBox();
  if (!lastBarAfter) throw new Error('last bar has no layout after scrolling');
  expect(lastBarAfter.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(lastBarAfter.x + lastBarAfter.width).toBeLessThanOrEqual(viewportBox.x + viewportBox.width);

  await lastBar.click({ position: { x: 4, y: 10 } });
  await expect(page.getByLabel('再生位置(小節.拍)')).toHaveText(`${barCount}.1`);

  const playhead = viewport.getByTestId('playhead');
  const lastBarBox = await lastBar.boundingBox();
  const playheadBox = await playhead.boundingBox();
  if (!lastBarBox || !playheadBox) throw new Error('ruler bar or playhead has no layout');
  // The playhead is a 2px line centered on the beat; the ruler bar starts at its 1px border.
  expect(Math.abs(playheadBox.x + playheadBox.width / 2 - lastBarBox.x)).toBeLessThanOrEqual(2);
  expect(playheadBox.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(playheadBox.x).toBeLessThanOrEqual(viewportBox.x + viewportBox.width);
});
