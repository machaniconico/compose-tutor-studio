import { expect, test, type Locator, type Page } from '@playwright/test';

type NoteGeometry = Readonly<{
  left: number;
  top: number;
  width: number;
}>;

async function openPianoRollWithTwoNotes(page: Page): Promise<{
  grid: Locator;
  notes: Locator;
}> {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();

  const grid = page.locator('.pr__grid');
  const notes = grid.locator('.pr__note');
  await expect(grid).toBeVisible();
  await grid.dblclick({ position: { x: 64, y: 2 * 16 + 8 } });
  await expect(notes).toHaveCount(1);
  await grid.dblclick({ position: { x: 160, y: 5 * 16 + 8 } });
  await expect(notes).toHaveCount(2);
  return { grid, notes };
}

async function openEmptyPianoRoll(page: Page): Promise<{
  grid: Locator;
  notes: Locator;
}> {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();
  const grid = page.locator('.pr__grid');
  const notes = grid.locator('.pr__note');
  await expect(grid).toBeVisible();
  await expect(notes).toHaveCount(0);
  return { grid, notes };
}

async function geometry(note: Locator): Promise<NoteGeometry> {
  return note.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return {
      left: Number.parseFloat(style.left),
      top: Number.parseFloat(style.top),
      width: Number.parseFloat(style.width),
    };
  });
}

async function openScaleSnappedClipEndNote(page: Page): Promise<{
  grid: Locator;
  notes: Locator;
  note: Locator;
  before: NoteGeometry;
  beforeLabel: string;
}> {
  const { grid, notes } = await openEmptyPianoRoll(page);
  await grid.focus();
  await grid.press('End');
  await grid.press('ArrowUp');
  await grid.press('Enter');

  const note = notes.first();
  await expect(note).toBeFocused();
  await expect(note).toHaveAccessibleName(/C#4。開始 32 拍目.*スケール外/);
  const before = await geometry(note);
  const beforeLabel = (await note.getAttribute('aria-label')) ?? '';

  await page.getByRole('button', { name: 'スケールスナップ', exact: true }).click();
  await note.focus();
  return { grid, notes, note, before, beforeLabel };
}

test('one semantic piano-roll note participates in the tab order', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  await notes.first().click();

  await expect
    .poll(() => notes.evaluateAll((elements) => elements.filter((element) => element.tabIndex === 0).length))
    .toBe(1);
  await expect
    .poll(() => notes.evaluateAll((elements) => elements.filter((element) => element.tabIndex === -1).length))
    .toBe(1);

  const activeNote = page.locator('.pr__note[tabindex="0"]');
  await expect(activeNote).toHaveCount(1);
  await expect(activeNote).toHaveJSProperty('tagName', 'BUTTON');
  await expect(activeNote).toHaveAttribute('type', 'button');
  await expect(activeNote).toHaveAccessibleName(/.+/);

  const quantize = page.getByRole('button', {
    name: '選択ノートをクオンタイズ',
    exact: true,
  });
  await expect(quantize).toBeEnabled();
  await quantize.focus();
  await page.keyboard.press('Tab');
  await expect(activeNote).toBeFocused();
  await expect(activeNote).toHaveCSS('outline-style', 'solid');
  await expect(activeNote).not.toHaveCSS('box-shadow', 'none');
});

test('ArrowRight moves one focused note as one Undo and Redo transaction', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  const note = notes.first();
  await note.click();
  const before = await geometry(note);

  await note.press('ArrowRight');
  await expect.poll(async () => (await geometry(note)).left).toBeGreaterThan(before.left);
  const moved = await geometry(note);
  expect(moved.top).toBe(before.top);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => geometry(note)).toEqual(before);

  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect.poll(() => geometry(note)).toEqual(moved);

  await note.dispatchEvent('keydown', {
    key: 'ArrowRight',
    code: 'ArrowRight',
    repeat: true,
    bubbles: true,
  });
  await expect.poll(() => geometry(note)).toEqual(moved);
});

test('Shift+ArrowRight resizes one focused note as one Undo transaction', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  const note = notes.first();
  await note.click();
  const before = await geometry(note);

  await note.press('Shift+ArrowRight');
  await expect.poll(async () => (await geometry(note)).width).toBeGreaterThan(before.width);
  const resized = await geometry(note);
  expect(resized.left).toBe(before.left);
  expect(resized.top).toBe(before.top);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => geometry(note)).toEqual(before);
});

test('Delete removes the focused note and restores focus inside the piano roll', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  await notes.first().click();
  await notes.first().press('Delete');
  await expect(notes).toHaveCount(1);
  await expect(notes.first()).toBeFocused();
  await expect.poll(() => notes.first().evaluate((element) => element.tabIndex)).toBe(0);

  await notes.first().press('Delete');
  await expect(notes).toHaveCount(0);
  await expect(page.locator('.pr__grid')).toBeFocused();
});

test('deleting the final note focuses the previous surviving note', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  await notes.nth(1).click();
  await notes.nth(1).press('Delete');

  await expect(notes).toHaveCount(1);
  await expect(notes.first()).toBeFocused();
  await expect(notes.first()).toHaveAttribute('tabindex', '0');
});

test('an empty piano roll can add and focus a note using only the keyboard', async ({ page }) => {
  const { grid, notes } = await openEmptyPianoRoll(page);
  await expect(grid).toHaveAttribute('role', 'group');
  await expect(grid).toHaveAttribute('tabindex', '0');
  await grid.focus();
  await grid.press('End');
  await expect(grid).toHaveAccessibleName(/32拍目/);
  await grid.press('Home');
  await expect(grid).toHaveAccessibleName(/1拍目/);
  await grid.press('ArrowRight');
  await grid.press('ArrowUp');
  await grid.press('Enter');

  await expect(notes).toHaveCount(1);
  await expect(notes.first()).toBeFocused();
  await expect(notes.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(notes.first()).toHaveAccessibleName(/C#4。開始 2 拍目.*スケール外/);
  await expect.poll(async () => (await geometry(notes.first())).left).toBe(28);
});

test('selection, note navigation, and velocity editing stay local and undoable', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  const first = notes.first();
  const second = notes.nth(1);
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');

  await first.press('Space');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#transport-playback-status')).toHaveText('再生は停止しています。');
  await first.press('Space');
  await expect(first).toHaveAttribute('aria-pressed', 'true');

  await first.press('Shift+PageDown');
  await expect(second).toBeFocused();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  await second.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(second).toHaveAttribute('aria-pressed', 'true');

  const beforeLabel = await second.getAttribute('aria-label');
  await second.press('PageUp');
  await expect(second).not.toHaveAttribute('aria-label', beforeLabel ?? '');
  const changedLabel = await second.getAttribute('aria-label');
  expect(changedLabel).toContain('強さ 105');

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(second).toHaveAttribute('aria-label', beforeLabel ?? '');
  await second.focus();
  await second.press('Control+s');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
});

test('keyboard select-all and duplicate create one focused atomic copy batch', async ({ page }) => {
  const { grid, notes } = await openPianoRollWithTwoNotes(page);
  const first = notes.first();
  await first.click();
  await first.press('Control+a');
  await expect(grid.locator('.pr__note[aria-pressed="true"]')).toHaveCount(2);

  await first.press('Control+d');
  await expect(notes).toHaveCount(4);
  await expect(grid.locator('.pr__note[aria-pressed="true"]')).toHaveCount(2);
  await expect(grid.locator('.pr__note:focus')).toHaveCount(1);
  await expect(grid.locator('.pr__note:focus')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(notes).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: '選択ノートをクオンタイズ', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => notes.evaluateAll((elements) => elements.filter((element) => element.tabIndex === 0).length))
    .toBe(1);
});

test('a selected note group moves as one keyboard transaction', async ({ page }) => {
  const { notes } = await openPianoRollWithTwoNotes(page);
  const first = notes.first();
  await first.click();
  await first.press('Control+a');
  const before = await notes.evaluateAll((elements) =>
    elements.map((element) => Number.parseFloat((element as HTMLElement).style.left)),
  );

  await first.press('ArrowRight');
  const moved = await notes.evaluateAll((elements) =>
    elements.map((element) => Number.parseFloat((element as HTMLElement).style.left)),
  );
  expect(moved[0]).toBeGreaterThan(before[0] ?? Number.POSITIVE_INFINITY);
  expect(moved[1]).toBeGreaterThan(before[1] ?? Number.POSITIVE_INFINITY);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect
    .poll(() =>
      notes.evaluateAll((elements) =>
        elements.map((element) => Number.parseFloat((element as HTMLElement).style.left)),
      ),
    )
    .toEqual(before);
});

test('scale-snapped ArrowDown prefers the next lower scale pitch', async ({ page }) => {
  const { grid, notes } = await openEmptyPianoRoll(page);
  await grid.focus();
  await grid.press('ArrowUp');
  await grid.press('ArrowUp');
  await grid.press('Enter');
  const note = notes.first();
  const before = await geometry(note);

  await page.getByRole('button', { name: 'スケールスナップ', exact: true }).click();
  await note.focus();
  await note.press('ArrowDown');
  await expect.poll(async () => (await geometry(note)).top).toBe(before.top + 2 * 16);
  await expect(note).toHaveAccessibleName(/C4.*スケール内/);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => geometry(note)).toEqual(before);
});

test('scale-snapped ArrowRight at the clip end is a history-free no-op', async ({ page }) => {
  const { notes, note, before, beforeLabel } = await openScaleSnappedClipEndNote(page);

  await note.press('ArrowRight');
  await expect(notes).toHaveCount(1);
  await expect.poll(() => geometry(note)).toEqual(before);
  await expect(note).toHaveAttribute('aria-label', beforeLabel);

  // A true no-op adds no history entry, so one Undo reaches the source add.
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(notes).toHaveCount(0);
});

test('scale-snapped Ctrl/Cmd+D at the clip end cannot create a same-position copy', async ({
  page,
}) => {
  const { notes, note, before, beforeLabel } = await openScaleSnappedClipEndNote(page);

  for (const shortcut of ['Control+d', 'Meta+d']) {
    await note.press(shortcut);
    await expect(notes).toHaveCount(1);
    await expect.poll(() => geometry(note)).toEqual(before);
    await expect(note).toHaveAttribute('aria-label', beforeLabel);
  }

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(notes).toHaveCount(0);
});

test('scale-snapped Alt drag at the clip end cannot create a same-position copy', async ({
  page,
}) => {
  const { grid, notes, note, before, beforeLabel } = await openScaleSnappedClipEndNote(page);
  const box = await note.boundingBox();
  if (!box) throw new Error('末尾ノートが表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.keyboard.down('Alt');
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 96, startY, { steps: 8 });
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);
  await expect(notes).toHaveCount(1);
  await expect.poll(() => geometry(note)).toEqual(before);
  await expect(note).toHaveAttribute('aria-label', beforeLabel);
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await expect(notes).toHaveCount(1);
  await expect.poll(() => geometry(note)).toEqual(before);
  await expect(note).toHaveAttribute('aria-label', beforeLabel);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(notes).toHaveCount(0);
});

test('focused Q announces the exact committed quantize result', async ({ page }) => {
  const { grid, notes } = await openEmptyPianoRoll(page);
  await grid.dblclick({ position: { x: 64, y: 2 * 16 + 8 } });
  const note = notes.first();
  await expect(note).toBeFocused();
  const box = await note.boundingBox();
  if (!box) throw new Error('クオンタイズ対象ノートが表示されていません');

  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 13, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const offGrid = await geometry(note);

  const quantize = page.getByRole('button', {
    name: '選択ノートをクオンタイズ',
    exact: true,
  });
  const liveStatus = page.locator('.pr [aria-live="polite"][aria-atomic="true"]');
  await expect(quantize).toBeEnabled();
  await quantize.focus();
  await quantize.press('q');

  await expect.poll(async () => (await geometry(note)).left).not.toBe(offGrid.left);
  await expect(liveStatus).toHaveText('1個のノートをクオンタイズしました。');
});
