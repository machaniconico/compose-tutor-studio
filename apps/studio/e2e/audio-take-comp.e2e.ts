import { readFile } from 'node:fs/promises';
import type { Project } from '@cts/project-model';
import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

const SAMPLE_RATE = 48_000;

function createTwoSecondMonoFixture(): Buffer {
  const frames = SAMPLE_RATE * 2;
  const dataBytes = frames * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = 0.25 * Math.sin((2 * Math.PI * 220 * frame) / SAMPLE_RATE);
    bytes.writeInt16LE(Math.round(sample * 0x7fff), 44 + frame * 2);
  }
  return bytes;
}

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function saveProject(page: Page): Promise<void> {
  const save = page.locator('.transport-bar__save-button');
  if (await save.isEnabled()) await save.click();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
}

async function exportProject(
  page: Page,
  outputPath: string,
): Promise<Project> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const downloadPromise = page.waitForEvent('download');
  await dialog
    .getByRole('button', { name: 'プロジェクト書き出し', exact: true })
    .click();
  const download = await downloadPromise;
  await download.saveAs(outputPath);
  const project = JSON.parse(await readFile(outputPath, 'utf8')) as Project;
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return project;
}

async function exportWav(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const downloadPromise = page.waitForEvent('download');
  await dialog
    .getByRole('button', { name: 'WAVエクスポート', exact: true })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return Buffer.concat(chunks);
}

function selectedAudioClipEditor(page: Page): Locator {
  return page.getByRole('region', {
    name: '選択オーディオクリップの編集',
    exact: true,
  });
}

async function alignSelectedClipAtSongStart(page: Page): Promise<void> {
  const start = selectedAudioClipEditor(page).getByLabel(
    '配置開始（小節・0から）',
    { exact: true },
  );
  await start.fill('0');
  await start.press('Enter');
  await expect(start).toHaveValue('0');
}

async function dragTakeLane(
  page: Page,
  lane: Locator,
  startFraction: number,
  endFraction: number,
  cancel: boolean,
): Promise<void> {
  await expect(lane).toBeEnabled();
  await lane.scrollIntoViewIfNeeded();
  const box = await lane.boundingBox();
  if (!box) throw new Error('Take lane has no pointer geometry');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * startFraction, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * endFraction, y, { steps: 4 });
  await expect(lane).toBeFocused();
  await expect(page.locator('.take-comp__drag-preview')).toHaveCount(1);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test('groups existing clips and persists one non-destructive Audio comp', async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await dismissWelcome(page);

  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const addDialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await addDialog.getByRole('radio', { name: /オーディオトラック/ }).check();
  await addDialog.getByLabel('名前', { exact: true }).fill('Comp Vocal');
  await addDialog.locator('input[type="file"]').setInputFiles({
    name: 'comp-vocal.wav',
    mimeType: 'audio/wav',
    buffer: createTwoSecondMonoFixture(),
  });

  await expect(page.getByRole('button', {
    name: 'Comp Vocal トラックを選択',
    exact: true,
  })).toBeVisible({ timeout: 20_000 });
  const rawClips = page.locator(
    '.arranger__clip.is-audio:not(.is-take-folder)',
  );
  await expect(rawClips).toHaveCount(1);

  await selectedAudioClipEditor(page)
    .getByRole('button', { name: '独立コピーを右へ', exact: true })
    .click();
  await expect(rawClips).toHaveCount(2);
  await rawClips.nth(1).click();
  await alignSelectedClipAtSongStart(page);

  await selectedAudioClipEditor(page)
    .getByRole('button', { name: '独立コピーを右へ', exact: true })
    .click();
  await expect(rawClips).toHaveCount(3);
  await rawClips.nth(2).click();
  await alignSelectedClipAtSongStart(page);
  await saveProject(page);

  const groupButton = selectedAudioClipEditor(page).getByRole('button', {
    name: '同じ区間をテイク化',
    exact: true,
  });
  await expect(groupButton).toBeEnabled();
  await groupButton.click();

  const folder = page.locator('[data-take-folder-id]');
  await expect(
    page.getByRole('tab', { name: 'テイク編集', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');

  const panel = page.locator('#editor-tabpanel-comping');
  await expect(panel).toBeVisible();
  const timeline = panel.locator('[data-horizontal-scroll="timeline-only"]');
  await expect(timeline).toBeVisible();
  const takeLanes = panel.locator('[data-take-id]');
  await expect(takeLanes).toHaveCount(3);
  await expect(panel.locator('[data-comp-segment-id]')).toHaveCount(1);
  await expect(panel).not.toContainText('サイクル録音');
  await saveProject(page);

  await dragTakeLane(page, takeLanes.nth(2), 0.1, 0.25, true);
  await expect(panel.locator('.take-comp__drag-preview')).toHaveCount(0);
  await expect(panel.locator('[data-comp-segment-id]')).toHaveCount(1);
  await expect(panel.locator('.take-comp__status')).toContainText(
    '範囲選択をキャンセルしました',
  );

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生中です。',
    { timeout: 10_000 },
  );

  const exactRange = panel.getByRole('group', {
    name: '範囲を数値で指定',
    exact: true,
  });
  await exactRange.getByLabel('採用するテイク', { exact: true })
    .selectOption({ index: 1 });
  await exactRange.getByLabel('開始（拍）', { exact: true }).fill('1');
  await exactRange.getByLabel('終了（拍）', { exact: true }).fill('2');
  await exactRange.getByRole('button', {
    name: 'この範囲を採用',
    exact: true,
  }).click();

  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生は停止しています。',
  );
  await expect(panel.locator('.take-comp__status')).toContainText(
    '再生位置は保持しました',
  );
  await expect(panel.locator('[data-comp-segment-id]')).toHaveCount(3);
  await saveProject(page);

  await dragTakeLane(page, takeLanes.nth(2), 0.5, 0.75, false);
  await expect(panel.locator('[data-comp-segment-id]')).toHaveCount(4);
  await saveProject(page);

  const firstBoundary = panel.locator('[data-boundary-after]').first();
  await firstBoundary.fill('0.5');
  await panel.getByRole('button', {
    name: 'つなぎ目を反映',
    exact: true,
  }).first().click();
  await expect(firstBoundary).toHaveValue('0.5');
  await saveProject(page);

  await exactRange.getByLabel('採用するテイク', { exact: true })
    .selectOption({ index: 2 });
  await exactRange.getByLabel('開始（拍）', { exact: true }).fill('0.5');
  await exactRange.getByLabel('終了（拍）', { exact: true }).fill('2');
  await exactRange.getByRole('button', {
    name: 'この範囲を採用',
    exact: true,
  }).click();
  await expect(panel.locator('[data-comp-segment-id]')).toHaveCount(3);
  await saveProject(page);

  const deletableTake = panel.locator('.take-comp__delete:not(:disabled)');
  await expect(deletableTake).toHaveCount(1);
  await deletableTake.click();
  await expect(takeLanes).toHaveCount(2);
  await expect(takeLanes.nth(1)).toBeFocused();

  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await undo.click();
  await expect(takeLanes).toHaveCount(3);
  await redo.click();
  await expect(takeLanes).toHaveCount(2);

  await saveProject(page);
  const wav = await exportWav(page);
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  const exported = await exportProject(
    page,
    testInfo.outputPath('audio-take-comp.ctsproj.json'),
  );
  expect(exported.schemaVersion).toBe(6);
  expect(exported.audioTakeFolders).toHaveLength(1);
  expect(
    exported.tracks.find((track) => track.name === 'Comp Vocal')?.clips,
  ).toHaveLength(0);
  expect(exported.audioTakeFolders[0]).toMatchObject({
    startBeat: 0,
    lengthBeats: 4,
    crossfadeMs: 5,
    takes: expect.arrayContaining([
      expect.objectContaining({
        audioAssetId: exported.audioAssets[0]?.id,
        sourceStartFrame: 0,
        sourceFrameCount: 96_000,
      }),
    ]),
    compSegments: [
      expect.objectContaining({ offsetBeats: 0, lengthBeats: 0.5 }),
      expect.objectContaining({ offsetBeats: 0.5, lengthBeats: 2.5 }),
      expect.objectContaining({ offsetBeats: 3, lengthBeats: 1 }),
    ],
  });

  await page.reload();
  await dismissWelcome(page);
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  await expect(folder).toHaveCount(1);
  await folder.focus();
  await page.keyboard.press('Enter');
  const openTakeEditor = page.getByRole('button', {
    name: 'テイク編集を開く',
    exact: true,
  });
  await openTakeEditor.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-take-id]')).toHaveCount(2);
  await expect(panel.locator('[data-comp-segment-id]')).toHaveCount(3);

  const keyboardRange = panel.getByRole('group', {
    name: '範囲を数値で指定',
    exact: true,
  });
  const keyboardTake = keyboardRange.getByLabel('採用するテイク', {
    exact: true,
  });
  await keyboardTake.focus();
  await page.keyboard.press('End');
  const keyboardStart = keyboardRange.getByLabel('開始（拍）', {
    exact: true,
  });
  const selectAllShortcut = process.platform === 'darwin'
    ? 'Meta+A'
    : 'Control+A';
  await keyboardStart.focus();
  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.type('0.5');
  const keyboardEnd = keyboardRange.getByLabel('終了（拍）', {
    exact: true,
  });
  await keyboardEnd.focus();
  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.type('3');
  const keyboardCommit = keyboardRange.getByRole('button', {
    name: 'この範囲を採用',
    exact: true,
  });
  await keyboardCommit.focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('.take-comp__status')).toContainText(
    'すでにこの内容',
  );
  await saveProject(page);
  const reloadedExport = await exportProject(
    page,
    testInfo.outputPath('audio-take-comp-reloaded.ctsproj.json'),
  );
  expect(reloadedExport.audioTakeFolders).toEqual(exported.audioTakeFolders);

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(timeline).toHaveAttribute(
    'data-horizontal-scroll',
    'timeline-only',
  );
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);
  const laneBox = await panel.locator('[data-take-id]').first().boundingBox();
  expect(laneBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(pageErrors).toEqual([]);
});
