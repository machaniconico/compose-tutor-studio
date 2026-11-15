import { expect, test, type Page } from '@playwright/test';

async function openSampleProject(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /サンプルプロジェクトを聴く/ }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('button', { name: '一時停止' }).click();
}

test('the tooltip stays open while the pointer crosses onto it', async ({ page }) => {
  await openSampleProject(page);

  const term = page.locator('.term').first();
  await term.scrollIntoViewIfNeeded();
  await term.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();

  const box = await tip.boundingBox();
  if (!box) throw new Error('tooltip has no position');
  const x = box.x + 4;
  await page.mouse.move(x, box.y - 2);
  await expect(tip).toBeVisible();
  await page.mouse.move(x, box.y + box.height / 2);
  await expect(tip).toBeVisible();
});

test('every lesson tooltip stays inside the window, even for terms at the panel edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSampleProject(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');

  // The lesson runner sits in the 280px right-hand panel, so a 240px tooltip
  // anchored at any term more than a few px into the panel would run off-screen.
  await page.getByRole('tab', { name: 'チュートリアル' }).click();
  await page.getByRole('button', { name: /8小節に展開する/ }).click();
  const runner = page.locator('.inspector-panel');
  const terms = runner.locator('.term');
  await expect(terms.first()).toBeVisible();
  const count = await terms.count();
  expect(count).toBeGreaterThan(0);

  let wouldHaveOverflowed = 0;
  for (let i = 0; i < count; i += 1) {
    const term = terms.nth(i);
    await term.scrollIntoViewIfNeeded();
    await term.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    const termBox = await term.boundingBox();
    const tipBox = await tip.boundingBox();
    if (!termBox || !tipBox) throw new Error(`term ${i} or its tooltip has no position`);
    if (termBox.x + tipBox.width > viewport.width) wouldHaveOverflowed += 1;
    expect(tipBox.x, `term ${i}: left edge`).toBeGreaterThanOrEqual(0);
    expect(tipBox.x + tipBox.width, `term ${i}: right edge`).toBeLessThanOrEqual(viewport.width);
    expect(tipBox.y, `term ${i}: top edge`).toBeGreaterThanOrEqual(0);
    expect(tipBox.y + tipBox.height, `term ${i}: bottom edge`).toBeLessThanOrEqual(viewport.height);
    await page.mouse.move(5, 5);
    await expect(tip).toBeHidden();
  }
  // Guard against a vacuous pass: at least one term must have needed clamping.
  expect(wouldHaveOverflowed).toBeGreaterThan(0);
});

test('Escape closes a hover-only tooltip while another control has focus', async ({ page }) => {
  await openSampleProject(page);

  const keySelect = page.getByLabel('キー', { exact: true });
  await keySelect.focus();
  await expect(keySelect).toBeFocused();
  const term = page.locator('.term').first();
  await term.scrollIntoViewIfNeeded();
  await term.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});
