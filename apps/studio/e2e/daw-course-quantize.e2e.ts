import { expect, test, type Locator, type Page } from '@playwright/test';

// DAW 操作コース「音のタイミングを整える」の手順を、書いてある通りに実行する。
// 手順: 音を置く -> 音をクリックして選ぶ -> Shift を押しながら少し横へドラッグ(自由位置)
//       -> 「クオンタイズ」。 Shift なしのドラッグは格子に吸い付くので、ずれは作れない。

async function leftOf(note: Locator): Promise<number> {
  return note.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left));
}

async function dragBy(page: Page, note: Locator, dx: number): Promise<void> {
  const box = await note.boundingBox();
  if (!box) throw new Error('ドラッグ対象が表示されていません');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test('lesson steps: Shift-drag makes an off-grid note and Quantize moves it back', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();
  const grid = page.locator('.pr__grid');
  await expect(grid).toBeVisible();

  await grid.dblclick({ position: { x: 24, y: 2 * 16 + 8 } });
  const note = grid.locator('.pr__note').first();
  await expect(note).toBeVisible();
  const onGrid = await leftOf(note);
  const quantize = page.getByRole('button', { name: '選択ノートをクオンタイズ' });

  // 普通のドラッグは格子に吸い付くので、小さく動かしても位置は変わらない。
  await note.click();
  await dragBy(page, note, 13);
  expect(await leftOf(note)).toBe(onGrid);

  // Shift を押しながらのドラッグなら、格子の間に置ける。
  await note.click();
  await page.keyboard.down('Shift');
  await dragBy(page, note, 13);
  await page.keyboard.up('Shift');
  await expect.poll(() => leftOf(note)).not.toBe(onGrid);

  await expect(quantize).toBeEnabled();
  await quantize.click();
  await expect.poll(() => leftOf(note)).toBe(onGrid);
});
