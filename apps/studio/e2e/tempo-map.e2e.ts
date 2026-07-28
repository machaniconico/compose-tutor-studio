import { readFile } from 'node:fs/promises';
import type { Project } from '@cts/project-model';
import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

type ControlledAudioClockWindow = Window & typeof globalThis & {
  __ctsSetAudioClockSeconds?: (seconds: number) => void;
};

async function installControlledAudioClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let controlledSeconds = 0;
    let prototype: object | null = window.AudioContext.prototype;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, 'currentTime');
      if (descriptor === undefined) prototype = Object.getPrototypeOf(prototype);
    }
    if (prototype === null || descriptor?.get === undefined) {
      throw new Error('AudioContext.currentTime getter is unavailable');
    }
    Object.defineProperty(prototype, 'currentTime', {
      ...descriptor,
      get: () => controlledSeconds,
    });
    (window as ControlledAudioClockWindow).__ctsSetAudioClockSeconds = (
      seconds,
    ) => {
      if (!Number.isFinite(seconds) || seconds < controlledSeconds) {
        throw new Error('Controlled audio time must move forward finitely');
      }
      controlledSeconds = seconds;
    };
  });
}

async function setControlledAudioClock(
  page: Page,
  seconds: number,
): Promise<void> {
  await page.evaluate((nextSeconds) => {
    const setClock = (window as ControlledAudioClockWindow)
      .__ctsSetAudioClockSeconds;
    if (!setClock) throw new Error('Controlled audio clock is unavailable');
    setClock(nextSeconds);
  }, seconds);
}

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function openTempoMapEditor(page: Page): Promise<Locator> {
  await page
    .getByRole('tablist', { name: 'エディタ切替' })
    .getByRole('tab', { name: 'テンポ / 拍子', exact: true })
    .click();
  const panel = page.locator('#editor-tabpanel-tempoMap');
  await expect(panel).toBeVisible();
  return panel;
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

function mapSnapshot(project: Project) {
  return {
    bpm: project.bpm,
    tempoMap: project.tempoMap,
    timeSignature: project.timeSignature,
    timeSignatureMap: project.timeSignatureMap,
    lengthBars: project.lengthBars,
    lengthBeats: project.lengthBeats,
  };
}

test('edits, persists, exports, and responsively renders both musical maps', async ({
  page,
}, testInfo) => {
  await installControlledAudioClock(page);
  await page.goto('/');
  await dismissWelcome(page);

  const panel = await openTempoMapEditor(page);
  const timeline = panel.getByLabel('テンポと拍子のタイムライン', {
    exact: true,
  });
  await expect(timeline).toHaveAttribute(
    'data-horizontal-scroll',
    'timeline-only',
  );
  await expect(
    panel.getByRole('group', { name: 'テンポレーン', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('group', { name: '拍子レーン', exact: true }),
  ).toBeVisible();

  const addTempo = panel.getByRole('button', {
    name: '再生位置にテンポを追加',
    exact: true,
  });
  const addSignature = panel.getByRole('button', {
    name: '再生位置に拍子を追加',
    exact: true,
  });
  await expect(addTempo).toBeVisible();
  await expect(addSignature).toBeVisible();

  const tempoMarkers = panel.locator('[data-tempo-map-kind="tempo"]');
  const signatureMarkers = panel.locator(
    '[data-tempo-map-kind="time-signature"]',
  );
  await expect(tempoMarkers).toHaveCount(1);
  await expect(signatureMarkers).toHaveCount(1);

  const playhead = panel.locator('[data-tempo-map-playhead-beat]');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生中です。',
    { timeout: 10_000 },
  );
  await setControlledAudioClock(page, 0.25);
  await expect.poll(async () => Number(
    await playhead.getAttribute('data-tempo-map-playhead-beat'),
  ), { timeout: 10_000 }).toBeCloseTo(0.5, 4);

  await addTempo.click();
  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生は停止しています。',
  );
  await expect(panel.locator('.tempo-map-editor__notice')).toContainText(
    '再生位置は保持しました',
  );
  await expect(tempoMarkers).toHaveCount(2);
  const selectedTempoMarker = panel.locator(
    '[data-tempo-map-kind="tempo"][aria-pressed="true"]',
  );
  await expect(selectedTempoMarker).toHaveCount(1);
  const addedTempoId = await selectedTempoMarker.getAttribute(
    'data-tempo-map-event-id',
  );
  expect(addedTempoId).toBeTruthy();
  if (!addedTempoId) throw new Error('Expected a stable added tempo id');
  const editedTempo = panel.locator(
    `[data-tempo-map-kind="tempo"][data-tempo-map-event-id="${addedTempoId}"]`,
  );
  const stoppedBeat = Number(
    await playhead.getAttribute('data-tempo-map-playhead-beat'),
  );
  expect(stoppedBeat).toBeGreaterThan(0);
  const stoppedPosition = await page
    .getByLabel('再生位置', { exact: true })
    .textContent();
  await page.waitForTimeout(150);
  await expect(playhead).toHaveAttribute(
    'data-tempo-map-playhead-beat',
    String(stoppedBeat),
  );
  await expect(
    page.getByLabel('再生位置', { exact: true }),
  ).toHaveText(stoppedPosition ?? '');

  const tempoInspector = panel.getByRole('group', {
    name: 'テンポ編集',
    exact: true,
  });
  await expect(tempoInspector).toBeVisible();
  await tempoInspector
    .getByLabel('位置（四分音符の拍）', { exact: true })
    .fill('8');
  await tempoInspector
    .getByLabel('テンポ（BPM）', { exact: true })
    .fill('96');
  await tempoInspector
    .getByRole('button', { name: '変更を反映', exact: true })
    .click();
  await expect(editedTempo).toHaveAttribute(
    'aria-label',
    'テンポ 2件目、3小節 1拍、96 BPM',
  );

  await tempoInspector
    .getByRole('button', { name: 'このテンポを削除', exact: true })
    .click();
  await expect(tempoMarkers).toHaveCount(1);
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await undo.click();
  await expect(editedTempo).toBeVisible();
  await redo.click();
  await expect(tempoMarkers).toHaveCount(1);
  await undo.click();
  await expect(editedTempo).toBeVisible();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生中です。',
    { timeout: 10_000 },
  );
  await setControlledAudioClock(page, 2.5);
  await expect.poll(async () => Number(
    await playhead.getAttribute('data-tempo-map-playhead-beat'),
  ), { timeout: 10_000 }).toBeCloseTo(5, 4);

  await addSignature.click();
  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生は停止しています。',
  );
  await expect(panel.locator('.tempo-map-editor__notice')).toContainText(
    '再生位置を含む小節の先頭',
  );
  await expect(signatureMarkers).toHaveCount(2);
  const selectedSignatureMarker = panel.locator(
    '[data-tempo-map-kind="time-signature"][aria-pressed="true"]',
  );
  await expect(selectedSignatureMarker).toHaveCount(1);
  const addedSignatureId = await selectedSignatureMarker.getAttribute(
    'data-tempo-map-event-id',
  );
  expect(addedSignatureId).toBeTruthy();
  if (!addedSignatureId) {
    throw new Error('Expected a stable added time-signature id');
  }
  const editedSignature = panel.locator(
    `[data-tempo-map-kind="time-signature"][data-tempo-map-event-id="${addedSignatureId}"]`,
  );
  await expect(editedSignature).toHaveAttribute(
    'aria-label',
    '拍子 2件目、2小節 1拍、4分の4',
  );
  const signatureInspector = panel.getByRole('group', {
    name: '拍子編集',
    exact: true,
  });
  await expect(signatureInspector).toBeVisible();
  const signatureBeatInput = signatureInspector.getByLabel(
    '位置（四分音符の拍）',
    { exact: true },
  );
  await signatureBeatInput.fill('5');
  await signatureBeatInput.press('Enter');
  await expect(panel.locator('.tempo-map-editor__notice')).toHaveClass(
    /is-error/,
  );
  await expect(panel.locator('.tempo-map-editor__notice')).toContainText(
    '拍子は小節の先頭に置いてください',
  );
  await expect(editedSignature).toHaveAttribute(
    'aria-label',
    '拍子 2件目、2小節 1拍、4分の4',
  );

  await signatureBeatInput.fill('8');
  await signatureInspector.getByLabel('分子', { exact: true }).fill('3');
  await signatureInspector.getByLabel('分母', { exact: true }).selectOption('4');
  await signatureInspector
    .getByRole('button', { name: '変更を反映', exact: true })
    .click();
  await expect(editedSignature).toHaveAttribute(
    'aria-label',
    '拍子 2件目、3小節 1拍、4分の3',
  );
  await signatureInspector
    .getByRole('button', { name: 'この拍子を削除', exact: true })
    .click();
  await expect(signatureMarkers).toHaveCount(1);
  await undo.click();
  await expect(editedSignature).toBeVisible();
  await redo.click();
  await expect(signatureMarkers).toHaveCount(1);
  await undo.click();
  await expect(editedSignature).toBeVisible();

  const tempoAnchor = panel.locator(
    '[data-tempo-map-kind="tempo"][data-tempo-map-anchor="true"]',
  );
  await tempoAnchor.click();
  await tempoInspector
    .getByLabel('テンポ（BPM）', { exact: true })
    .fill('90');
  await tempoInspector
    .getByRole('button', { name: '変更を反映', exact: true })
    .click();
  await expect(tempoAnchor).toHaveAttribute(
    'aria-label',
    /90 BPM、曲の先頭に固定$/,
  );
  await expect(page.getByLabel('BPM', { exact: true })).toHaveValue('90');
  await expect(
    tempoInspector.getByRole('button', {
      name: 'このテンポを削除',
      exact: true,
    }),
  ).toBeDisabled();

  const signatureAnchor = panel.locator(
    '[data-tempo-map-kind="time-signature"][data-tempo-map-anchor="true"]',
  );
  await signatureAnchor.click();
  await expect(signatureInspector).toBeVisible();
  await signatureInspector.getByLabel('分子', { exact: true }).fill('2');
  await signatureInspector.getByLabel('分母', { exact: true }).selectOption('4');
  await signatureInspector
    .getByRole('button', { name: '変更を反映', exact: true })
    .click();
  await expect(signatureAnchor).toHaveAttribute(
    'aria-label',
    /4分の2、曲の先頭に固定$/,
  );
  await expect(
    signatureInspector.getByRole('button', {
      name: 'この拍子を削除',
      exact: true,
    }),
  ).toBeDisabled();

  await undo.click();
  await expect(signatureAnchor).toHaveAttribute(
    'aria-label',
    /4分の4、曲の先頭に固定$/,
  );
  await redo.click();
  await expect(signatureAnchor).toHaveAttribute(
    'aria-label',
    /4分の2、曲の先頭に固定$/,
  );

  await saveProject(page);
  const beforeReload = await exportProject(
    page,
    testInfo.outputPath('tempo-map-before-reload.ctsproj.json'),
  );
  expect(beforeReload.bpm).toBe(90);
  expect(beforeReload.tempoMap).toHaveLength(2);
  expect(beforeReload.tempoMap[0]).toMatchObject({ beat: 0, bpm: 90 });
  expect(beforeReload.tempoMap[1]).toMatchObject({ beat: 8, bpm: 96 });
  expect(beforeReload.timeSignature).toEqual([2, 4]);
  expect(beforeReload.timeSignatureMap).toHaveLength(2);
  expect(beforeReload.timeSignatureMap[0]).toMatchObject({
    beat: 0,
    numerator: 2,
    denominator: 4,
  });
  expect(beforeReload.timeSignatureMap[1]).toMatchObject({
    beat: 8,
    numerator: 3,
    denominator: 4,
  });
  expect(beforeReload.lengthBeats).toBe(32);
  expect(beforeReload.lengthBars).toBe(12);

  await page.reload();
  await dismissWelcome(page);
  await openTempoMapEditor(page);
  await expect(tempoMarkers).toHaveCount(2);
  await expect(signatureMarkers).toHaveCount(2);
  await expect(editedTempo).toBeVisible();
  await expect(editedSignature).toBeVisible();
  await expect(tempoAnchor).toHaveAttribute('aria-label', /90 BPM/);
  await expect(signatureAnchor).toHaveAttribute('aria-label', /4分の2/);
  const afterReload = await exportProject(
    page,
    testInfo.outputPath('tempo-map-after-reload.ctsproj.json'),
  );
  expect(mapSnapshot(afterReload)).toEqual(mapSnapshot(beforeReload));

  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel).toBeVisible();
  await expect(addTempo).toBeVisible();
  await expect(addSignature).toBeVisible();
  const responsive = await timeline.evaluate((element) => {
    const marker = element.querySelector<HTMLElement>(
      '[data-tempo-map-kind="tempo"]',
    );
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      timelineClientWidth: element.clientWidth,
      timelineScrollWidth: element.scrollWidth,
      markerWidth: marker?.getBoundingClientRect().width ?? 0,
      markerHeight: marker?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(responsive.documentWidth).toBeLessThanOrEqual(
    responsive.viewportWidth + 1,
  );
  expect(responsive.timelineScrollWidth).toBeGreaterThan(
    responsive.timelineClientWidth,
  );
  expect(responsive.markerWidth).toBeGreaterThanOrEqual(44);
  expect(responsive.markerHeight).toBeGreaterThanOrEqual(44);
  const internalScrollLeft = await timeline.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event('scroll'));
    return element.scrollLeft;
  });
  expect(internalScrollLeft).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(321);
});
