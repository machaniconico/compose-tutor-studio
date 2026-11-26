import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Project } from '@cts/project-model';

test('reopening a project with the same clip ID brings its new pitch range into view', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: /新規作成/ }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  const scroll = page.locator('.pr__scroll');
  // At this window height the editor itself scrolls around the piano roll.
  await scroll.scrollIntoViewIfNeeded();
  await expect(page.locator('.pr__note')).toHaveCount(0);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId('piano-key-108')).toHaveCount(0);

  await page.getByRole('button', { name: '書き出し' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクト書き出し' }).click();
  const projectFile = testInfo.outputPath('same-clip.ctsproj.json');
  await (await downloadPromise).saveAs(projectFile);
  const project = JSON.parse(await readFile(projectFile, 'utf8')) as Project;
  const clip = project.tracks[0]!.clips[0]!;
  expect(clip.type).toBe('midi');
  clip.notes = [{ id: 'high-note', pitch: 108, startBeat: 0, durationBeats: 1, velocity: 100 }];

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'プロジェクト読み込み' }).click();
  await (await fileChooserPromise).setFiles({
    name: 'same-clip.ctsproj.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByText('プロジェクトを読み込みました。')).toBeVisible();

  const key = page.getByTestId('piano-key-108');
  await expect(key).toBeInViewport({ ratio: 1 });
  const view = await scroll.evaluate((el) => {
    const top = el.getBoundingClientRect().top + el.clientTop;
    return { top: top + 22, bottom: top + el.clientHeight };
  });
  const box = await key.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(view.top - 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(view.bottom + 0.5);
});

for (const size of [
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
]) {
  test(`piano keyboard is usable at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button', { name: /新規作成/ }).click();
    await page.getByRole('button', { name: 'はじめる' }).click();

    // The scroll area keeps room for the sticky ruler plus several rows.
    const scroll = page.locator('.pr__scroll');
    const clientHeight = await scroll.evaluate((el) => el.clientHeight);
    expect(clientHeight).toBeGreaterThanOrEqual(22 + 8 * 16);

    const key = page.getByTestId('piano-key-60');
    await key.scrollIntoViewIfNeeded();
    await key.click({ timeout: 5_000 });
  });
}

for (const size of [
  { width: 1920, height: 1200 },
  { width: 2560, height: 1440 },
]) {
  test(`an empty clip opens with C3 and C5 both in view at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button', { name: /新規作成/ }).click();
    await page.getByRole('button', { name: 'はじめる' }).click();
    await expect(page.locator('.pr__note')).toHaveCount(0);

    const scroll = page.locator('.pr__scroll');
    // Rows are visible below the 22px sticky ruler and above the scroll area's bottom edge.
    const view = await scroll.evaluate((el) => {
      const top = el.getBoundingClientRect().top + el.clientTop;
      return { top: top + 22, bottom: top + el.clientHeight };
    });
    for (const midi of [48, 72]) {
      const box = await page.getByTestId(`piano-key-${midi}`).boundingBox();
      expect(box, `piano-key-${midi} is rendered`).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(view.top - 0.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(view.bottom + 0.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    }
  });
}
