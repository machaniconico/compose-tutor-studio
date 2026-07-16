import { expect, test, type Page } from '@playwright/test';

type LayoutSnapshot = {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  centerHeight: number;
  editorHeight: number;
  pianoRollHeight: number;
  mixerHeight: number;
  shellBottom: number;
};

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function readLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const rect = (selector: string): DOMRect => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout target: ${selector}`);
      return element.getBoundingClientRect();
    };
    const shell = rect('.app-shell');

    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      documentWidth: document.documentElement.scrollWidth,
      centerHeight: rect('.center-pane').height,
      editorHeight: rect('.editor-body:not([hidden])').height,
      pianoRollHeight: rect('.pr__scroll').height,
      mixerHeight: rect('.mixer-strip').height,
      shellBottom: shell.bottom,
    };
  });
}

test('keeps the primary editor usable at the Tauri minimum window size', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto('/');
  await dismissWelcome(page);

  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  const collapse = mixer.getByRole('button', { name: 'ミキサーをたたむ', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(mixer.locator('.mixer-strip__content')).toBeVisible();

  const regular = await readLayout(page);
  expect(regular.viewportWidth).toBe(1_440);
  expect(regular.viewportHeight).toBe(900);
  expect(regular.documentWidth).toBe(regular.viewportWidth);
  expect(regular.pianoRollHeight).toBeGreaterThanOrEqual(150);
  expect(regular.shellBottom).toBeLessThanOrEqual(regular.viewportHeight);

  await mixer.getByRole('slider', { name: 'Chords 音量', exact: true }).focus();
  await page.setViewportSize({ width: 1_024, height: 640 });
  await expect(page.getByRole('button', { name: 'カラオケ用音源を作る' })).toBeVisible();
  const expand = mixer.getByRole('button', { name: 'ミキサーを開く', exact: true });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(mixer.locator('.mixer-strip__content')).toBeHidden();

  const compact = await readLayout(page);
  expect(compact.viewportWidth).toBe(1_024);
  expect(compact.viewportHeight).toBe(640);
  expect(compact.documentWidth).toBe(compact.viewportWidth);
  expect(compact.centerHeight).toBeGreaterThanOrEqual(500);
  expect(compact.editorHeight).toBeGreaterThanOrEqual(260);
  expect(compact.pianoRollHeight).toBeGreaterThanOrEqual(96);
  expect(compact.mixerHeight).toBeLessThanOrEqual(56);
  expect(compact.shellBottom).toBeLessThanOrEqual(compact.viewportHeight);

  await expand.focus();
  await expand.press('Enter');
  const collapseCompact = mixer.getByRole('button', {
    name: 'ミキサーをたたむ',
    exact: true,
  });
  await expect(collapseCompact).toBeFocused();
  await expect(collapseCompact).toHaveAttribute('aria-expanded', 'true');
  await expect(mixer.locator('.mixer-strip__content')).toBeVisible();

  for (let index = 0; index < 5; index += 1) await page.keyboard.press('Tab');
  const chordRouting = mixer.locator('.mix-ch').filter({ hasText: 'Chords' }).first().locator('summary');
  await expect(chordRouting).toBeFocused();
  await page.keyboard.press('Tab');
  const addChordEffect = mixer.getByRole('combobox', {
    name: 'Chords エフェクト追加',
    exact: true,
  });
  await expect(addChordEffect).toBeFocused();
  await expect(addChordEffect).toBeInViewport();

  const mixerScroll = await mixer.locator('.mixer-strip__content').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(mixerScroll.scrollHeight).toBeGreaterThan(mixerScroll.clientHeight);
  expect(mixerScroll.scrollTop).toBeGreaterThan(0);
  expect(mixerScroll.overflowY).toBe('auto');

  // Once the user chooses a state, viewport changes must not override it.
  await page.setViewportSize({ width: 1_440, height: 900 });
  await expect(collapseCompact).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 1_024, height: 640 });
  await expect(collapseCompact).toHaveAttribute('aria-expanded', 'true');

  const compactExpanded = await readLayout(page);
  expect(compactExpanded.documentWidth).toBe(compactExpanded.viewportWidth);
  expect(compactExpanded.pianoRollHeight).toBeGreaterThanOrEqual(80);
  expect(compactExpanded.mixerHeight).toBeLessThanOrEqual(160);
  expect(compactExpanded.shellBottom).toBeLessThanOrEqual(compactExpanded.viewportHeight);
  expect(pageErrors).toEqual([]);
});
