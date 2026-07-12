import { expect, test } from '@playwright/test';

test('scale snap lesson requires C major and advances without a second toggle', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  await page.getByRole('tab', { name: 'チュートリアル', exact: true }).click();
  await page
    .getByRole('button', { name: /コードに合うメロディを作る/ })
    .click();

  const snap = page.getByRole('button', { name: 'スケールスナップ', exact: true });
  await expect(page.getByText('スケールスナップをオンにしよう', { exact: true })).toBeVisible();
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await expect(snap).toHaveAttribute('aria-keyshortcuts', 'S');
  await page.getByLabel('キー', { exact: true }).selectOption('G');
  await page.getByLabel('スケール', { exact: true }).selectOption('naturalMinor');

  // The piano-roll shortcut must not steal the app-level save shortcut.
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press('Control+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.keyboard.press('Meta+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Shift+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Alt+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');

  const chordTone = page.getByRole('button', { name: 'コードトーン', exact: true });
  await expect(chordTone).toHaveAttribute('aria-keyshortcuts', 'C');
  await page.keyboard.press('c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'true');
  await chordTone.focus();
  await chordTone.press('Control+c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'true');
  await chordTone.press('Meta+c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'true');
  await chordTone.press('Shift+c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'true');
  await chordTone.press('Alt+c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'true');
  await chordTone.press('c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'false');
  await chordTone.press('c');
  await expect(chordTone).toHaveAttribute('aria-pressed', 'true');

  await snap.focus();
  await snap.press('Control+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await snap.press('Meta+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await snap.press('Shift+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await snap.press('Alt+s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  await snap.press('s');
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scale-snap-status')).toContainText('オンです');
  await expect(page.getByText('スケールスナップをオンにしよう', { exact: true })).toBeVisible();

  // Correcting the effective state while snap remains on must satisfy the
  // lesson; requiring off -> on again would make the instruction misleading.
  await page.getByLabel('キー', { exact: true }).selectOption('C');
  await expect(page.getByText('スケールスナップをオンにしよう', { exact: true })).toBeVisible();
  await page.getByLabel('スケール', { exact: true }).selectOption('major');
  await expect(page.getByText('メロディの最初の音を置こう', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('scale snap preserves existing notes and snaps Alt-drag copies', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();

  const grid = page.locator('.pr__grid');
  const gridBox = await grid.boundingBox();
  if (!gridBox) throw new Error('ピアノロールのグリッドがありません');

  // Row 2 is A# in the default C-major project, so it starts out of scale.
  await page.mouse.dblclick(gridBox.x + 24, gridBox.y + 2 * 16 + 8);
  const notes = page.locator('.pr__note');
  await expect(notes).toHaveCount(1);
  const source = notes.first();
  const sourceTop = await source.evaluate((element) => Number.parseFloat(element.style.top));

  const snap = page.getByRole('button', { name: 'スケールスナップ', exact: true });
  await snap.click();
  await expect(source).toHaveCSS('top', `${sourceTop}px`);

  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error('複製元ノートが表示されていません');
  await page.keyboard.down('Alt');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 80, sourceBox.y + sourceBox.height / 2, {
    steps: 3,
  });
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await expect(notes).toHaveCount(2);
  await expect(source).toHaveAccessibleName(/スケール外/);
  await expect(notes.nth(1)).toHaveAccessibleName(/スケール内/);
  const positions = await notes.evaluateAll((elements) =>
    elements.map((element) => ({
      left: Number.parseFloat((element as HTMLElement).style.left),
      top: Number.parseFloat((element as HTMLElement).style.top),
    })),
  );
  expect(positions.some(({ top }) => top === sourceTop)).toBe(true);
  expect(new Set(positions.map(({ top }) => top)).size).toBe(2);
  expect(new Set(positions.map(({ left }) => left)).size).toBe(2);

  // Q follows the same focus-only character-shortcut contract. Put the
  // selected copy off-grid first so successful quantization is observable.
  const copiedNote = notes.nth(1);
  const copiedBox = await copiedNote.boundingBox();
  if (!copiedBox) throw new Error('複製ノートが表示されていません');
  await page.keyboard.down('Shift');
  await page.mouse.move(copiedBox.x + copiedBox.width / 2, copiedBox.y + copiedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(copiedBox.x + copiedBox.width / 2 + 13, copiedBox.y + copiedBox.height / 2);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await copiedNote.click();

  const offGridLeft = await copiedNote.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.left),
  );
  const pixelsPerBeat = await page
    .locator('.pr__gridline:not(.is-bar)')
    .nth(1)
    .evaluate((element) => Number.parseFloat((element as HTMLElement).style.left));
  const expectedQuantizedLeft = Math.round(offGridLeft / pixelsPerBeat) * pixelsPerBeat;
  const quantize = page.getByRole('button', {
    name: '選択ノートをクオンタイズ',
    exact: true,
  });
  await expect(quantize).toBeEnabled();
  await expect(quantize).toHaveAttribute('aria-keyshortcuts', 'Q');
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press('q');
  await expect
    .poll(() => copiedNote.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)))
    .toBe(offGridLeft);
  await quantize.focus();
  for (const shortcut of ['Control+q', 'Meta+q', 'Shift+q', 'Alt+q']) {
    await quantize.press(shortcut);
    await expect
      .poll(() => copiedNote.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)))
      .toBe(offGridLeft);
  }
  await quantize.press('q');
  await expect
    .poll(() => copiedNote.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left)))
    .toBe(expectedQuantizedLeft);
  expect(pageErrors).toEqual([]);
});
