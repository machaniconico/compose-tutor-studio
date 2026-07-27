import { readFile } from 'node:fs/promises';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_AUTOMATION_POINTS_PER_LANE,
  validateProject,
  type Project,
} from '@cts/project-model';
import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

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

async function requiredBox(
  locator: Locator,
): Promise<Readonly<{ x: number; y: number; width: number; height: number }>> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error('Expected a visible automation control');
  return box;
}

async function pointLabels(points: Locator): Promise<readonly string[]> {
  return points.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label') ?? ''),
  );
}

async function importProject(
  page: Page,
  project: Project,
  fileName: string,
): Promise<void> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  await dialog.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(dialog).toBeHidden();
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

function maximumAutomationLaneProject(): Project {
  const timestamp = '2026-07-28T00:00:00.000Z';
  const trackId = 'automation-stress-track';
  const lengthBeats = 8_192;
  return {
    id: 'automation-stress-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Automation 20k Load',
    bpm: 300,
    timeSignature: [32, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 256,
    lengthBeats,
    tempoMap: [{ id: 'automation-stress-tempo', beat: 0, bpm: 300 }],
    timeSignatureMap: [{
      id: 'automation-stress-signature',
      beat: 0,
      numerator: 32,
      denominator: 4,
    }],
    audioAssets: [],
    automationLanes: [{
      id: 'automation-stress-lane',
      target: { type: 'track-volume', trackId },
      points: Array.from(
        { length: MAX_AUTOMATION_POINTS_PER_LANE },
        (_, index) => ({
          id: `automation-stress-point-${index}`,
          beat: index * lengthBeats / MAX_AUTOMATION_POINTS_PER_LANE,
          value: 0.5 + (index % 100) / 100,
          interpolation: index % 2 === 0 ? 'linear' as const : 'hold' as const,
        }),
      ),
    }],
    audioRouting: {
      outputs: [{ sourceTrackId: trackId, destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [
      {
        id: trackId,
        name: 'Automation Stress',
        type: 'instrument',
        role: 'general',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'softKeys' },
        effects: [],
      },
      {
        id: 'automation-stress-master',
        name: 'Master',
        type: 'master',
        role: 'general',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function offGridAutomationProject(): Project {
  const base = maximumAutomationLaneProject();
  return {
    ...base,
    id: 'automation-off-grid-project',
    title: 'Automation Off-grid Precision',
    bpm: 120,
    timeSignature: [4, 4],
    lengthBars: 8,
    lengthBeats: 32,
    tempoMap: [{ id: 'automation-off-grid-tempo', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'automation-off-grid-signature',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    automationLanes: [{
      id: 'automation-off-grid-lane',
      target: {
        type: 'track-volume',
        trackId: 'automation-stress-track',
      },
      points: [{
        id: 'automation-off-grid-point',
        beat: 1.234567,
        value: 0.75,
        interpolation: 'linear',
      }],
    }],
  };
}

function offGridBeat(project: Project): number {
  const point = project.automationLanes
    .find((lane) => lane.id === 'automation-off-grid-lane')
    ?.points.find((candidate) => candidate.id === 'automation-off-grid-point');
  if (!point) throw new Error('Expected the off-grid automation point');
  return point.beat;
}

test('edits independent volume and pan automation with accessible responsive controls', async ({
  page,
}) => {
  await page.goto('/');
  await dismissWelcome(page);

  const editorTabs = page.getByRole('tablist', { name: 'エディタ切替' });
  await editorTabs.getByRole('tab', { name: 'オートメーション' }).click();
  const panel = page.locator('#editor-tabpanel-automation');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: /のオートメーション$/ })).toBeVisible();
  const notice = panel.locator('.automation-lane__notice');

  const target = panel.getByRole('group', { name: 'オートメーション対象' });
  const volumeTarget = target.getByRole('button', { name: '音量', exact: true });
  const panTarget = target.getByRole('button', { name: 'パン', exact: true });
  await expect(volumeTarget).toHaveAttribute('aria-pressed', 'true');
  await expect(panTarget).toHaveAttribute('aria-pressed', 'false');
  await panel.getByLabel('オートメーショングリッド').selectOption('0.25');

  const addAtPlayhead = panel.getByRole('button', {
    name: '再生位置に点を追加',
  });
  await addAtPlayhead.click();
  let points = panel.locator('[data-automation-point-id]');
  await expect(points).toHaveCount(1);
  await expect(points.first()).toHaveAttribute(
    'aria-label',
    /音量 1点目、拍 0、値 \d+%、次の点まで直線/,
  );

  await addAtPlayhead.click();
  await expect(points).toHaveCount(1);
  await expect(notice).toContainText('既存の点を選択しました');

  const timeline = panel.getByRole('group', {
    name: 'トラック音量オートメーションレーン',
  });
  await expect(timeline).toBeVisible();
  const timelineViewport = panel.locator('.automation-lane__timeline-scroll');
  const timelineViewportBox = await requiredBox(timelineViewport);
  await page.mouse.click(
    timelineViewportBox.x + Math.min(360, timelineViewportBox.width - 24),
    timelineViewportBox.y + Math.min(70, timelineViewportBox.height - 24),
  );
  await expect(points).toHaveCount(2);

  await points.nth(1).focus();
  await points.nth(1).press('Enter');
  const inspector = panel.getByRole('group', { name: '選択中の点' });
  await expect(inspector).toBeVisible();
  await inspector.getByLabel('次の点まで').selectOption('hold');
  await expect(notice).toContainText('補間');
  const beatInput = inspector.getByLabel('拍', { exact: true });
  await beatInput.fill('2');
  await beatInput.press('Enter');
  await expect(points.nth(1)).toHaveAttribute('aria-label', /拍 2/);
  const volumeInput = inspector.getByLabel('音量（%）', { exact: true });
  await expect(volumeInput).toHaveAttribute('min', '0');
  await expect(volumeInput).toHaveAttribute('max', '200');
  await volumeInput.fill('110');
  await volumeInput.press('Enter');
  await expect(points.nth(1)).toHaveAttribute('aria-label', /値 110%/);

  await panTarget.click();
  await expect(panTarget).toHaveAttribute('aria-pressed', 'true');
  await expect(
    panel.getByRole('group', { name: 'パンオートメーションレーン' }),
  ).toBeVisible();
  await expect(panel.locator('[data-automation-point-id]')).toHaveCount(0);
  await addAtPlayhead.click();
  await expect(panel.locator('[data-automation-point-id]')).toHaveCount(1);
  await expect(panel.locator('[data-automation-point-id]').first()).toHaveAttribute(
    'aria-label',
    /パン 1点目、拍 0、値 中央、次の点まで直線/,
  );

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(panel.locator('[data-automation-point-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(panel.locator('[data-automation-point-id]')).toHaveCount(1);

  await saveProject(page);
  await page.reload();
  await dismissWelcome(page);
  await page
    .getByRole('tablist', { name: 'エディタ切替' })
    .getByRole('tab', { name: 'オートメーション' })
    .click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-automation-point-id]')).toHaveCount(2);
  await expect(panel.locator('[data-automation-point-id]').nth(1)).toHaveAttribute(
    'aria-label',
    /拍 2、値 110%、次の点まで保持/,
  );
  await panTarget.click();
  await expect(panel.locator('[data-automation-point-id]')).toHaveCount(1);
  await expect(panel.locator('[data-automation-point-id]').first()).toHaveAttribute(
    'aria-label',
    /パン 1点目、拍 0、値 中央/,
  );
  await panel.locator('[data-automation-point-id]').first().focus();
  await panel.locator('[data-automation-point-id]').first().press('Enter');
  const panInput = panel
    .getByRole('group', { name: '選択中の点' })
    .getByLabel('パン（-100〜100）', { exact: true });
  await expect(panInput).toHaveAttribute('min', '-100');
  await expect(panInput).toHaveAttribute('max', '100');

  await volumeTarget.click();
  points = panel.locator('[data-automation-point-id]');
  await expect(points).toHaveCount(2);
  const firstPointId = await points.first().getAttribute('data-automation-point-id');
  const dragPointId = await points.nth(1).getAttribute('data-automation-point-id');
  expect(firstPointId).toBeTruthy();
  expect(dragPointId).toBeTruthy();
  if (!firstPointId || !dragPointId) {
    throw new Error('Expected stable automation point ids');
  }
  const firstPoint = panel.locator(
    `[data-automation-point-id="${firstPointId}"]`,
  );
  const dragPoint = panel.locator(
    `[data-automation-point-id="${dragPointId}"]`,
  );
  const originalDragLabel = await dragPoint.getAttribute('aria-label');
  expect(originalDragLabel).toBeTruthy();
  if (!originalDragLabel) throw new Error('Expected a labelled drag point');

  // Pointer movement is a local preview: it may update the point's accessible
  // presentation, but it must not dirty the saved Project before pointerup.
  await saveProject(page);
  const dragStart = await requiredBox(dragPoint);
  await page.mouse.move(
    dragStart.x + dragStart.width / 2,
    dragStart.y + dragStart.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dragStart.x + dragStart.width / 2 + 96,
    dragStart.y + dragStart.height / 2 + 32,
    { steps: 4 },
  );
  await expect(dragPoint).not.toHaveAttribute('aria-label', originalDragLabel);
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.mouse.up();
  await expect(dragPoint).not.toHaveAttribute('aria-label', originalDragLabel);
  const committedDragLabel = await dragPoint.getAttribute('aria-label');
  expect(committedDragLabel).toBeTruthy();
  if (!committedDragLabel) throw new Error('Expected a committed drag label');

  // One Undo returning to the exact starting point proves pointermove did not
  // create hidden history entries and pointerup committed exactly once.
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await undo.click();
  await expect(dragPoint).toHaveAttribute('aria-label', originalDragLabel);
  await redo.click();
  await expect(dragPoint).toHaveAttribute('aria-label', committedDragLabel);

  // A cancelled pointer gesture must discard its preview and remain identical
  // after a durable save/reload boundary.
  await saveProject(page);
  const cancelStart = await requiredBox(dragPoint);
  await page.mouse.move(
    cancelStart.x + cancelStart.width / 2,
    cancelStart.y + cancelStart.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cancelStart.x + cancelStart.width / 2 + 64,
    cancelStart.y + cancelStart.height / 2 - 24,
    { steps: 3 },
  );
  await expect(dragPoint).not.toHaveAttribute('aria-label', committedDragLabel);
  await dragPoint.dispatchEvent('pointercancel', {
    pointerId: 1,
    pointerType: 'mouse',
  });
  await expect(dragPoint).toHaveAttribute('aria-label', committedDragLabel);
  await page.mouse.up();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  await page.reload();
  await dismissWelcome(page);
  await page
    .getByRole('tablist', { name: 'エディタ切替' })
    .getByRole('tab', { name: 'オートメーション' })
    .click();
  await expect(dragPoint).toHaveAttribute('aria-label', committedDragLabel);
  points = panel.locator('[data-automation-point-id]');
  await expect(points).toHaveCount(2);

  // Dragging onto the other point's exact beat is rejected atomically and the
  // preview rolls back without dirtying the saved Project.
  const collisionStart = await requiredBox(dragPoint);
  const collisionTarget = await requiredBox(firstPoint);
  const labelsBeforeCollision = await pointLabels(points);
  await page.mouse.move(
    collisionStart.x + collisionStart.width / 2,
    collisionStart.y + collisionStart.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    collisionTarget.x + collisionTarget.width / 2,
    collisionTarget.y + collisionTarget.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(panel.getByRole('alert')).toContainText('同じ位置');
  expect(await pointLabels(points)).toEqual(labelsBeforeCollision);
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  // Delete chooses the next point; Backspace on the final point chooses the
  // previous point. Undo restores the exact stable ids in both cases.
  await firstPoint.focus();
  await firstPoint.press('Delete');
  await expect(points).toHaveCount(1);
  await expect(dragPoint).toBeFocused();
  await undo.click();
  await expect(points).toHaveCount(2);
  expect(await pointLabels(points)).toEqual(labelsBeforeCollision);

  await dragPoint.focus();
  await dragPoint.press('Backspace');
  await expect(points).toHaveCount(1);
  await expect(firstPoint).toBeFocused();
  await undo.click();
  await expect(points).toHaveCount(2);
  expect(await pointLabels(points)).toEqual(labelsBeforeCollision);

  // Clearing is a two-step inline destructive action. Merely opening or
  // cancelling confirmation cannot mutate or dirty the Project.
  await saveProject(page);
  const labelsBeforeClear = await pointLabels(points);
  const clearLane = panel.getByRole('button', {
    name: 'レーンをクリア',
    exact: true,
  });
  await clearLane.click();
  const clearConfirmation = panel.getByRole('group', {
    name: 'レーン消去の確認',
    exact: true,
  });
  await expect(clearConfirmation).toBeVisible();
  await expect(points).toHaveCount(2);
  expect(await pointLabels(points)).toEqual(labelsBeforeClear);
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await clearConfirmation
    .getByRole('button', { name: 'キャンセル', exact: true })
    .click();
  await expect(clearConfirmation).toBeHidden();
  await expect(clearLane).toBeFocused();
  expect(await pointLabels(points)).toEqual(labelsBeforeClear);

  await clearLane.click();
  await expect(clearConfirmation).toBeVisible();
  expect(await pointLabels(points)).toEqual(labelsBeforeClear);
  await clearConfirmation
    .getByRole('button', { name: 'クリアを確定', exact: true })
    .click();
  await expect(points).toHaveCount(0);
  await expect(addAtPlayhead).toBeFocused();
  await undo.click();
  await expect(points).toHaveCount(2);
  expect(await pointLabels(points)).toEqual(labelsBeforeClear);

  // Keep the inspector deletion path covered independently of keyboard delete.
  await firstPoint.focus();
  await firstPoint.press('Enter');
  await panel.getByRole('button', { name: 'この点を削除' }).click();
  await expect(points).toHaveCount(1);
  await expect(dragPoint).toBeFocused();
  await undo.click();
  await expect(points).toHaveCount(2);

  const keyboardPoint = firstPoint;
  const beforeKeyboardLabel = await keyboardPoint.getAttribute('aria-label');
  await keyboardPoint.focus();
  await keyboardPoint.press('ArrowRight');
  await expect(keyboardPoint).not.toHaveAttribute(
    'aria-label',
    beforeKeyboardLabel ?? '',
  );

  const pointBox = await keyboardPoint.boundingBox();
  expect(pointBox?.width).toBeGreaterThanOrEqual(44);
  expect(pointBox?.height).toBeGreaterThanOrEqual(44);

  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel).toBeVisible();
  const responsive = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(
      '.automation-lane__timeline-scroll',
    );
    const point = document.querySelector<HTMLElement>(
      '[data-automation-point-id]',
    );
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      timelineClientWidth: scroll?.clientWidth ?? 0,
      timelineScrollWidth: scroll?.scrollWidth ?? 0,
      pointWidth: point?.getBoundingClientRect().width ?? 0,
      pointHeight: point?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(responsive.documentWidth).toBeLessThanOrEqual(
    responsive.viewportWidth + 1,
  );
  expect(responsive.timelineScrollWidth).toBeGreaterThan(
    responsive.timelineClientWidth,
  );
  expect(responsive.pointWidth).toBeGreaterThanOrEqual(44);
  expect(responsive.pointHeight).toBeGreaterThanOrEqual(44);
});

test('value-only edits preserve a high-precision off-grid beat', async ({
  page,
}, testInfo) => {
  const project = offGridAutomationProject();
  expect(validateProject(project).ok).toBe(true);

  await page.goto('/');
  await dismissWelcome(page);
  await importProject(page, project, 'automation-off-grid.ctsproj.json');
  await page
    .getByRole('tablist', { name: 'エディタ切替' })
    .getByRole('tab', { name: 'オートメーション' })
    .click();

  const panel = page.locator('#editor-tabpanel-automation');
  const point = panel.locator(
    '[data-automation-point-id="automation-off-grid-point"]',
  );
  await point.focus();
  await point.press('Enter');
  const inspector = panel.getByRole('group', { name: '選択中の点' });
  const beat = inspector.getByLabel('拍', { exact: true });
  const value = inspector.getByLabel('音量（%）', { exact: true });
  const snap = panel.getByLabel('オートメーショングリッド');

  // The inspector carries the exact persisted draft. Merely focusing and
  // blurring it must remain a semantic no-op.
  await saveProject(page);
  await expect(beat).toHaveValue('1.234567');
  await beat.focus();
  await beat.press('Tab');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  expect(offGridBeat(await exportProject(
    page,
    testInfo.outputPath('off-grid-after-clean-blur.ctsproj.json'),
  ))).toBe(1.234567);

  // With snapping enabled, changing only the value must not quantize beat.
  await expect(snap).toHaveValue('0.25');
  await value.fill('80');
  await value.press('Enter');
  await saveProject(page);
  expect(offGridBeat(await exportProject(
    page,
    testInfo.outputPath('off-grid-after-snapped-value-edit.ctsproj.json'),
  ))).toBe(1.234567);

  // The same invariant must hold when snapping is disabled.
  await snap.selectOption('0');
  await value.fill('85');
  await value.press('Enter');
  await saveProject(page);
  expect(offGridBeat(await exportProject(
    page,
    testInfo.outputPath('off-grid-after-unsnapped-value-edit.ctsproj.json'),
  ))).toBe(1.234567);
});

test('keeps a valid 20,000-point automation lane bounded and responsive', async ({
  page,
}) => {
  const project = maximumAutomationLaneProject();
  expect(validateProject(project).ok).toBe(true);

  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto('/');
  await dismissWelcome(page);
  await importProject(page, project, 'automation-20k-load.ctsproj.json');
  await expect(page.getByRole('textbox', {
    name: 'プロジェクト名',
    exact: true,
  })).toHaveValue(project.title);
  await page
    .getByRole('tablist', { name: 'エディタ切替' })
    .getByRole('tab', { name: 'オートメーション' })
    .click();

  const panel = page.locator('#editor-tabpanel-automation');
  const scroll = panel.locator('.automation-lane__timeline-scroll');
  const renderedPoints = panel.locator('[data-automation-point-id]');
  const curvePaths = panel.locator('.automation-lane__curve path');
  await expect(scroll).toHaveAttribute(
    'data-automation-total-points',
    String(MAX_AUTOMATION_POINTS_PER_LANE),
  );
  await expect(scroll).toHaveAttribute(
    'data-automation-rendered-points',
    /^\d+$/,
  );
  const renderedPointCount = Number(
    await scroll.getAttribute('data-automation-rendered-points'),
  );
  expect(renderedPointCount).toBeGreaterThan(0);
  expect(renderedPointCount).toBeLessThanOrEqual(400);
  await expect(renderedPoints).toHaveCount(renderedPointCount);
  expect(await curvePaths.count()).toBeGreaterThan(0);
  expect(await curvePaths.count()).toBeLessThanOrEqual(3);

  const playhead = panel.locator('[data-automation-playhead-beat]');
  const observedPlayheadBeats = new Set<string>();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', {
    name: '一時停止',
    exact: true,
  })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    observedPlayheadBeats.add(
      (await playhead.getAttribute('data-automation-playhead-beat')) ?? '',
    );
    return observedPlayheadBeats.size;
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect(page.locator('#transport-playback-status'))
    .toHaveText('再生は停止しています。');

  const firstRenderedPoint = renderedPoints.first();
  const beforeEdit = await firstRenderedPoint.getAttribute('aria-label');
  expect(beforeEdit).toBeTruthy();
  if (!beforeEdit) throw new Error('Expected a rendered stress point label');
  await firstRenderedPoint.focus();
  await firstRenderedPoint.press('ArrowRight');
  await expect(firstRenderedPoint).not.toHaveAttribute(
    'aria-label',
    beforeEdit,
    { timeout: 5_000 },
  );
  await expect(scroll).toHaveAttribute(
    'data-automation-total-points',
    String(MAX_AUTOMATION_POINTS_PER_LANE),
  );
  expect(Number(
    await scroll.getAttribute('data-automation-rendered-points'),
  )).toBeLessThanOrEqual(400);
  expect(await curvePaths.count()).toBeLessThanOrEqual(3);
  expect(runtimeErrors).toEqual([]);
});
