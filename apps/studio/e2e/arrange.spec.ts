import { expect, test, type Page } from '@playwright/test';
import { createDefaultProject, type Project } from '@cts/project-model';

async function openArrangement(page: Page, clips: Array<[id: string, start: number, length: number]>) {
  const base = createDefaultProject({ title: '配置テスト' });
  const track = base.tracks.find((track) => track.type === 'instrument')!;
  const project: Project = {
    ...base,
    lengthBars: 8,
    tracks: base.tracks.map((item) => ({
      ...item,
      clips: item.id === track.id
        ? clips.map(([id, startBeat, lengthBeats]) => ({
            id, trackId: track.id, type: 'midi', startBeat, lengthBeats, loop: false, notes: [],
          }))
        : [],
    })),
  };
  await page.goto('/');
  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('button', { name: '書き出し' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'プロジェクト読み込み' }).click();
  await (await chooser).setFiles({
    name: 'arrange.ctsproj.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByText('プロジェクトを読み込みました。')).toBeVisible();
  await page.getByRole('tab', { name: '曲全体' }).click();
}

test('a one-pixel click jitter selects an off-grid clip without moving it or adding Undo history', async ({ page }) => {
  await openArrangement(page, [['off-grid', 1, 4]]);
  const clip = page.getByTestId('clip-off-grid');
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  await expect(undo).toBeDisabled();
  await clip.scrollIntoViewIfNeeded();
  const box = (await clip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
  await page.mouse.up();

  await expect(clip).toHaveAttribute('aria-pressed', 'true');
  expect((await clip.boundingBox())!.x).toBe(box.x);
  await expect(undo).toBeDisabled();
});

test('adjacent short clips can each be hit at the center of their own beat range', async ({ page }) => {
  // Render the earlier clip last to expose an overflow into the later clip.
  await openArrangement(page, [['right', 0.25, 0.25], ['left', 0, 0.25]]);
  const left = page.getByTestId('clip-left');
  const right = page.getByTestId('clip-right');
  await left.scrollIntoViewIfNeeded();
  const { x, y, height } = (await left.boundingBox())!;
  const width = await left.evaluate((el) => parseFloat(el.style.width));
  await page.mouse.click(x + width / 2, y + height / 2);
  await expect(left).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(x + width * 1.5, y + height / 2);
  await expect(right).toHaveAttribute('aria-pressed', 'true');
});

test('a saved clip beyond the song limit does not block copying a clip inside the song', async ({ page }) => {
  await openArrangement(page, [['inside', 0, 4], ['beyond', 260, 4]]);
  await page.getByTestId('clip-inside').click();
  await page.getByRole('button', { name: '複製(コピー)', exact: true }).click();

  await expect(page.getByRole('button', { name: /2小節目から1小節$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('clip-beyond')).toHaveAttribute('aria-label', /66小節目から1小節/);
  await expect(page.getByLabel('小節数')).toHaveValue('8');
});

test('a linked MIDI clip explains how to open the original for editing', async ({ page }) => {
  await openArrangement(page, [['original', 0, 4]]);
  const original = page.getByTestId('clip-original');
  await original.click();
  const link = page.getByRole('button', { name: '複製(リンク)', exact: true });
  await expect(link).toHaveAttribute('title', /「元のクリップを開く」/);
  await link.click();
  await page.getByRole('button', { name: /クリップ\(リンク\)/ }).dblclick();
  await page.getByRole('button', { name: '元のクリップを開く', exact: true }).click();
  await page.getByRole('tab', { name: '曲全体' }).click();
  await expect(original).toHaveAttribute('aria-pressed', 'true');
});

test('a 1-bar drum clip duplicated 4 times extends a 4-bar song to 5 bars', async ({ page }) => {
  // Shortening the new song may ask before cutting notes off: accept.
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  const lengthInput = page.getByLabel('小節数');
  await lengthInput.fill('4');
  await lengthInput.press('Enter');
  await expect(lengthInput).toHaveValue('4');

  await page.getByRole('tab', { name: '曲全体' }).click();
  const drumClips = page.locator('.arrange__clip.is-drum');
  await expect(drumClips).toHaveCount(1);

  // Clear the drum lane, then put a 1-bar clip at the song start.
  const laneId = await page
    .locator('.arrange__lane', { has: page.locator('.arrange__clip.is-drum') })
    .getAttribute('data-testid');
  if (!laneId) throw new Error('drum lane not found');
  await drumClips.first().click();
  await page.keyboard.press('Delete');
  await expect(drumClips).toHaveCount(0);

  await page.getByTestId(laneId).dblclick({ position: { x: 10, y: 16 } });
  await expect(drumClips).toHaveCount(1);
  await expect(drumClips.first()).toHaveAttribute('aria-label', /1小節目から1小節/);

  // Give the clip a kick on its first step in the drum grid.
  await drumClips.first().dblclick();
  await expect(page.getByRole('tab', { name: 'ドラム' })).toHaveAttribute('aria-selected', 'true');
  const kickOn = page.getByRole('button', { name: /^キック ステップ 1 強さ/ });
  await page.getByRole('button', { name: 'キック ステップ 1', exact: true }).click();
  await expect(kickOn).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: '曲全体' }).click();
  await expect(drumClips.first()).toHaveAttribute('aria-pressed', 'true');
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('ControlOrMeta+d');
  }
  await expect(drumClips).toHaveCount(5);
  const lastClip = page.getByRole('button', { name: /5小節目から1小節/ });
  await expect(lastClip).toBeVisible();
  await expect(lengthInput).toHaveValue('5');

  // The last copy carries the kick too.
  await lastClip.dblclick();
  await expect(page.getByRole('tab', { name: 'ドラム' })).toHaveAttribute('aria-selected', 'true');
  await expect(kickOn).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
});
