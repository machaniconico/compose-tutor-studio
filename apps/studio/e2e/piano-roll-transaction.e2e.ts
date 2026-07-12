import { expect, test, type Locator, type Page } from '@playwright/test';

type NoteGeometry = Readonly<{
  left: number;
  top: number;
  width: number;
}>;

async function openPianoRoll(page: Page): Promise<Locator> {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();
  const grid = page.locator('.pr__grid');
  await expect(grid).toBeVisible();
  return grid;
}

async function addNote(
  grid: Locator,
  position: Readonly<{ x: number; y: number }>,
  expectedCount: number,
): Promise<void> {
  await grid.dblclick({ position });
  await expect(grid.locator('.pr__note')).toHaveCount(expectedCount);
}

async function openPianoRollWithOneNote(page: Page) {
  const grid = await openPianoRoll(page);
  await addNote(grid, { x: 24, y: 2 * 16 + 8 }, 1);
  const note = grid.locator('.pr__note').first();
  await expect(note).toBeVisible();
  return { grid, note };
}

async function noteGeometries(notes: Locator): Promise<NoteGeometry[]> {
  return notes.evaluateAll((elements) =>
    elements.map((element) => {
      const style = (element as HTMLElement).style;
      return {
        left: Number.parseFloat(style.left),
        top: Number.parseFloat(style.top),
        width: Number.parseFloat(style.width),
      };
    }),
  );
}

async function noteWidth(note: Locator): Promise<number> {
  return note.evaluate((element) => Number.parseFloat((element as HTMLElement).style.width));
}

async function velocityHeight(velocityBar: Locator): Promise<number> {
  return velocityBar.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.height),
  );
}

async function visibleHitPoint(target: Locator): Promise<{ x: number; y: number }> {
  const point = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, Math.ceil(rect.left));
    const right = Math.min(window.innerWidth, Math.floor(rect.right));
    const top = Math.max(0, Math.ceil(rect.top));
    const bottom = Math.min(window.innerHeight, Math.floor(rect.bottom));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const hit = document.elementFromPoint(x + 0.5, y + 0.5);
        if (hit === element || (hit !== null && element.contains(hit))) {
          return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    return null;
  });
  if (!point) throw new Error('ドラッグ対象にpointerが届く可視座標がありません');
  return point;
}

const recordedPointerIdAttribute = 'data-e2e-pointer-id';

async function recordNextPointerId(target: Locator): Promise<void> {
  await target.evaluate((element, attribute) => {
    element.removeAttribute(attribute);
    element.addEventListener(
      'pointerdown',
      (event) => {
        element.setAttribute(attribute, String((event as PointerEvent).pointerId));
      },
      { capture: true, once: true },
    );
  }, recordedPointerIdAttribute);
}

async function recordedPointerId(target: Locator): Promise<number> {
  const value = await target.getAttribute(recordedPointerIdAttribute);
  const pointerId = Number(value);
  if (!value || !Number.isInteger(pointerId)) {
    throw new Error('実pointerdownのpointerIdを記録できませんでした');
  }
  return pointerId;
}

async function waitForTwoAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function drag(
  page: Page,
  target: Locator,
  delta: Readonly<{ x: number; y: number }>,
  steps = 12,
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('ドラッグ対象が表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + delta.x, startY + delta.y, { steps });
  await page.mouse.up();
}

test('one piano-roll drag is one undoable transaction', async ({ page }) => {
  const { note } = await openPianoRollWithOneNote(page);
  const before = (await noteGeometries(note))[0];
  if (!before) throw new Error('移動前のノート位置がありません');

  await drag(page, note, { x: 96, y: 0 });
  await expect
    .poll(async () => (await noteGeometries(note))[0]?.left)
    .not.toBe(before.left);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => noteGeometries(note)).toEqual([before]);
});

test('a double-click at the clip end creates a note at the latest valid grid position', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 1_000 });
  const grid = await openPianoRoll(page);
  const gridWidth = await grid.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.width),
  );

  await grid.dblclick({ position: { x: gridWidth - 1, y: 16 * 8 + 8 } });

  const note = grid.locator('.pr__note');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAccessibleName(/開始 32 拍目/);
  const geometry = (await noteGeometries(note))[0];
  expect(geometry).toBeDefined();
  expect((geometry?.left ?? 0) + (geometry?.width ?? 0)).toBeLessThanOrEqual(gridWidth);
});

test('pointer cancellation discards a piano-roll move preview', async ({ page }) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const before = (await noteGeometries(note))[0];
  const box = await note.boundingBox();
  if (!before || !box) throw new Error('移動前のノートが表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await recordNextPointerId(grid);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const pointerId = await recordedPointerId(grid);
  await page.mouse.move(startX + 64, startY, { steps: 4 });
  await expect
    .poll(async () => (await noteGeometries(note))[0]?.left)
    .not.toBe(before.left);
  await grid.dispatchEvent('pointercancel', { pointerId, bubbles: true });
  await page.mouse.up();

  await expect.poll(() => noteGeometries(note)).toEqual([before]);
});

test('lost pointer capture discards an Alt-copy preview without committing it', async ({
  page,
}) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const box = await note.boundingBox();
  if (!box) throw new Error('ノートが表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await recordNextPointerId(grid);
  await page.keyboard.down('Alt');
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const pointerId = await recordedPointerId(grid);
  await page.mouse.move(startX + 64, startY, { steps: 4 });
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(1);

  await grid.evaluate((element, activePointerId) => {
    if (!element.hasPointerCapture(activePointerId)) {
      throw new Error('ドラッグ中のpointer captureが見つかりません');
    }
    element.releasePointerCapture(activePointerId);
  }, pointerId);

  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(grid.locator('.pr__note')).toHaveCount(1);
});

test('move and up from a different pointerId cannot mutate or end the active drag', async ({
  page,
}) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const before = (await noteGeometries(note))[0];
  const box = await note.boundingBox();
  if (!before || !box) throw new Error('移動前のノートが表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await recordNextPointerId(grid);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const activePointerId = await recordedPointerId(grid);
  const otherPointerId = activePointerId + 1_000;

  await grid.dispatchEvent('pointermove', {
    pointerId: otherPointerId,
    pointerType: 'pen',
    clientX: startX + 96,
    clientY: startY,
    buttons: 1,
    bubbles: true,
  });
  await grid.dispatchEvent('pointerup', {
    pointerId: otherPointerId,
    pointerType: 'pen',
    clientX: startX + 96,
    clientY: startY,
    buttons: 0,
    bubbles: true,
  });
  await waitForTwoAnimationFrames(page);

  expect(await noteGeometries(note)).toEqual([before]);
  expect(
    await grid.evaluate(
      (element, pointerId) => element.hasPointerCapture(pointerId),
      activePointerId,
    ),
  ).toBe(true);

  await page.mouse.move(startX + 96, startY, { steps: 6 });
  await expect
    .poll(async () => (await noteGeometries(note))[0]?.left)
    .not.toBe(before.left);
  await page.mouse.up();

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => noteGeometries(note)).toEqual([before]);
});

test('Alt down and up without movement does not create a copy', async ({ page }) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const box = await note.boundingBox();
  if (!box) throw new Error('ノートが表示されていません');

  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await expect(grid.locator('.pr__note')).toHaveCount(1);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);
});

test('an Alt drag shorter than the 3px threshold creates neither preview nor copy', async ({
  page,
}) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const before = await noteGeometries(note);
  const box = await note.boundingBox();
  if (!box) throw new Error('ノートが表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.keyboard.down('Alt');
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 2, startY);
  await waitForTwoAnimationFrames(page);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await expect(grid.locator('.pr__note')).toHaveCount(1);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);
  expect(await noteGeometries(note)).toEqual(before);
});

test('two selected notes move as one undoable and redoable transaction', async ({ page }) => {
  const grid = await openPianoRoll(page);
  await addNote(grid, { x: 24, y: 2 * 16 + 8 }, 1);
  await addNote(grid, { x: 120, y: 5 * 16 + 8 }, 2);
  const notes = grid.locator('.pr__note');

  await notes.nth(0).click();
  await notes.nth(1).click({ modifiers: ['Shift'] });
  await expect(grid.locator('.pr__note.is-selected')).toHaveCount(2);

  const before = await noteGeometries(notes);
  // Cross the left project boundary. A per-note clamp would collapse both
  // notes at beat 0; a group transaction clamps one shared delta instead.
  await drag(page, notes.nth(0), { x: -160, y: 16 });
  await expect
    .poll(async () => (await noteGeometries(notes))[0]?.left)
    .not.toBe(before[0]?.left);
  const moved = await noteGeometries(notes);
  expect(moved).toHaveLength(2);
  expect(moved[1]!.left - moved[0]!.left).toBeCloseTo(before[1]!.left - before[0]!.left, 5);
  expect(moved[1]!.top - moved[0]!.top).toBeCloseTo(before[1]!.top - before[0]!.top, 5);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => noteGeometries(notes)).toEqual(before);

  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect.poll(() => noteGeometries(notes)).toEqual(moved);
});

test('note resize commits once and pointer cancellation discards its preview', async ({ page }) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const resizeHandle = note.locator('.pr__note-resize');
  const before = await noteWidth(note);

  const cancelBox = await resizeHandle.boundingBox();
  if (!cancelBox) throw new Error('ノート長さ変更ハンドルが表示されていません');
  const cancelStartX = cancelBox.x + cancelBox.width / 2;
  const cancelStartY = cancelBox.y + cancelBox.height / 2;
  await recordNextPointerId(grid);
  await page.mouse.move(cancelStartX, cancelStartY);
  await page.mouse.down();
  const pointerId = await recordedPointerId(grid);
  await page.mouse.move(cancelStartX + 64, cancelStartY, { steps: 6 });
  await expect.poll(() => noteWidth(note)).not.toBe(before);
  await grid.dispatchEvent('pointercancel', { pointerId, bubbles: true });
  await page.mouse.up();
  await expect.poll(() => noteWidth(note)).toBe(before);

  await drag(page, resizeHandle, { x: 96, y: 0 });
  await expect.poll(() => noteWidth(note)).not.toBe(before);
  const resized = await noteWidth(note);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => noteWidth(note)).toBe(before);
  expect(resized).not.toBe(before);
});

test('velocity drag commits once and pointer cancellation discards its preview', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1_000 });
  await openPianoRollWithOneNote(page);
  const lane = page.locator('.pr__velocity-lane');
  const velocityBar = lane.locator('.pr__velbar').first();
  await velocityBar.scrollIntoViewIfNeeded();
  await expect(velocityBar).toBeVisible();
  const before = await velocityHeight(velocityBar);
  const laneBox = await lane.boundingBox();
  if (!laneBox) throw new Error('ベロシティレーンが表示されていません');

  // The editor can vertically clip a tall velocity bar. Find a point that
  // actually hit-tests to the bar instead of trusting its hidden layout box.
  const start = await visibleHitPoint(velocityBar);
  const laneTop = laneBox.y + 4;
  const laneBottom = laneBox.y + laneBox.height - 4;
  const previewY = Math.abs(start.y - laneTop) > 8 ? laneTop : laneBottom;
  await recordNextPointerId(lane);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const pointerId = await recordedPointerId(lane);
  await page.mouse.move(start.x, previewY, { steps: 10 });
  await expect.poll(() => velocityHeight(velocityBar)).not.toBe(before);
  await lane.dispatchEvent('pointercancel', { pointerId, bubbles: true });
  await page.mouse.up();
  await expect.poll(() => velocityHeight(velocityBar)).toBe(before);

  const commitStart = await visibleHitPoint(velocityBar);
  await page.mouse.move(commitStart.x, commitStart.y);
  await page.mouse.down();
  await page.mouse.move(commitStart.x, previewY, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => velocityHeight(velocityBar)).not.toBe(before);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => velocityHeight(velocityBar)).toBe(before);
});

test('Alt drag previews without a copy, commits atomically, and ignores an origin return', async ({
  page,
}) => {
  const { grid, note } = await openPianoRollWithOneNote(page);
  const notes = grid.locator('.pr__note');
  const box = await note.boundingBox();
  if (!box) throw new Error('ノートが表示されていません');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.keyboard.down('Alt');
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 96, startY, { steps: 8 });
  await expect(notes).toHaveCount(1);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(1);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(notes).toHaveCount(2);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(notes).toHaveCount(1);

  const restoredBox = await note.boundingBox();
  if (!restoredBox) throw new Error('複製取消後のノートが表示されていません');
  const restoredX = restoredBox.x + restoredBox.width / 2;
  const restoredY = restoredBox.y + restoredBox.height / 2;
  await page.keyboard.down('Alt');
  await page.mouse.move(restoredX, restoredY);
  await page.mouse.down();
  await page.mouse.move(restoredX + 96, restoredY, { steps: 4 });
  await expect(notes).toHaveCount(1);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(1);
  await page.mouse.move(restoredX, restoredY, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(notes).toHaveCount(1);
  await expect(grid.locator('.pr__note-preview-copy')).toHaveCount(0);
});
