import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { parseMidiFile } from '@cts/midi-io';
import { CURRENT_SCHEMA_VERSION, type Project } from '@cts/project-model';
import { planWavRender } from '../src/audio/wav';

// Browser-level release gate; kept outside Vitest's *.test/*.spec discovery.

type ProjectFile = {
  [key: string]: unknown;
  id: string;
  schemaVersion: number;
  title: string;
  bpm: number;
  lengthBars: number;
  timeSignature: [number, number];
  key: string;
  scale: string;
  updatedAt: string;
  chordTrack: Array<{ symbol: string }>;
  tracks: Array<{
    name: string;
    clips: Array<{
      notes?: unknown[];
      drumEvents?: Array<{ lane: string; stepIndex: number; velocity: number }>;
    }>;
  }>;
};

type ProjectSnapshot = {
  id: string;
  title: string;
  bpm: number;
  lengthBars: number;
  beatsPerBar: number;
  chordSymbols: string[];
  trackNames: string[];
  noteCounts: Record<string, number>;
  drumEvents: Array<{ lane: string; stepIndex: number; velocity: number }>;
};

type CreatedSong = {
  project: ProjectFile;
  snapshot: ProjectSnapshot;
};

const FIRST_SONG_TITLE = 'E2E First Song';

function summarizeProject(project: ProjectFile): ProjectSnapshot {
  const noteCounts = Object.fromEntries(
    project.tracks.map((track) => [
      track.name,
      track.clips.reduce((sum, clip) => sum + (clip.notes?.length ?? 0), 0),
    ]),
  );
  return {
    id: project.id,
    title: project.title,
    bpm: project.bpm,
    lengthBars: project.lengthBars,
    beatsPerBar: project.timeSignature[0],
    chordSymbols: project.chordTrack.map((chord) => chord.symbol),
    trackNames: project.tracks.map((track) => track.name),
    noteCounts,
    drumEvents: project.tracks
      .flatMap((track) => track.clips.flatMap((clip) => clip.drumEvents ?? []))
      .map((event) => ({
        lane: event.lane,
        stepIndex: event.stepIndex,
        velocity: event.velocity,
      }))
      .sort(
        (a, b) =>
          a.stepIndex - b.stepIndex || a.lane.localeCompare(b.lane) || a.velocity - b.velocity,
      ),
  };
}

function withoutUpdatedAt(project: ProjectFile): Omit<ProjectFile, 'updatedAt'> {
  const { updatedAt: _updatedAt, ...content } = project;
  return content;
}

function withoutImportedIdentity(
  project: ProjectFile,
): Omit<ProjectFile, 'id' | 'updatedAt'> {
  const { id: _id, updatedAt: _updatedAt, ...content } = project;
  return content;
}

function inspectPcmWav(wav: Buffer): {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataSize: number;
  durationSeconds: number;
  peakSample: number;
} {
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');

  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let blockAlign: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;

  for (let offset = 12; offset + 8 <= wav.length; ) {
    const chunkId = wav.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = wav.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > wav.length) {
      throw new Error(`WAV chunk ${chunkId} exceeds the downloaded file`);
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = wav.readUInt16LE(payloadOffset);
      channels = wav.readUInt16LE(payloadOffset + 2);
      sampleRate = wav.readUInt32LE(payloadOffset + 4);
      blockAlign = wav.readUInt16LE(payloadOffset + 12);
      bitsPerSample = wav.readUInt16LE(payloadOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataSize = chunkSize;
    }
    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat === null ||
    channels === null ||
    sampleRate === null ||
    blockAlign === null ||
    bitsPerSample === null ||
    dataOffset === null ||
    dataSize === null
  ) {
    throw new Error('WAV is missing a required fmt or data chunk');
  }

  let peakSample = 0;
  for (let offset = dataOffset; offset + 2 <= dataOffset + dataSize; offset += 2) {
    peakSample = Math.max(peakSample, Math.abs(wav.readInt16LE(offset)));
  }
  const frames = dataSize / blockAlign;
  return {
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    dataSize,
    durationSeconds: frames / sampleRate,
    peakSample,
  };
}

async function loadCanonicalStoredProjects(page: Page): Promise<ProjectFile[]> {
  return page.evaluate(() => {
    const projects: ProjectFile[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith('cts.persistence.v1.project.') || !key.endsWith('.head')) continue;
      const headRaw = localStorage.getItem(key);
      if (!headRaw) throw new Error(`Canonical head disappeared: ${key}`);
      const head = JSON.parse(headRaw) as {
        storageVersion?: unknown;
        state?: unknown;
        projectId?: unknown;
        ordinal?: unknown;
        generationKey?: unknown;
        operationId?: unknown;
      };
      if (head.state === 'deleted') continue;
      if (
        head.storageVersion !== 1 ||
        head.state !== 'active' ||
        typeof head.projectId !== 'string' ||
        !Number.isSafeInteger(head.ordinal) ||
        typeof head.generationKey !== 'string' ||
        typeof head.operationId !== 'string'
      ) {
        throw new Error(`Invalid canonical head: ${key}`);
      }
      const generationRaw = localStorage.getItem(head.generationKey);
      if (!generationRaw) throw new Error(`Canonical generation is missing: ${head.generationKey}`);
      const generation = JSON.parse(generationRaw) as {
        storageVersion?: unknown;
        kind?: unknown;
        projectId?: unknown;
        ordinal?: unknown;
        writeId?: unknown;
        projectJson?: unknown;
      };
      if (
        generation.storageVersion !== 1 ||
        generation.kind !== 'project' ||
        generation.projectId !== head.projectId ||
        generation.ordinal !== head.ordinal ||
        generation.writeId !== head.operationId ||
        typeof generation.projectJson !== 'string'
      ) {
        throw new Error(`Invalid canonical generation: ${head.generationKey}`);
      }
      const project = JSON.parse(generation.projectJson) as ProjectFile;
      if (project.id !== head.projectId) {
        throw new Error(`Canonical project id mismatch: ${head.generationKey}`);
      }
      projects.push(project);
    }
    return projects;
  });
}

async function loadNewestCanonicalStoredProject(page: Page): Promise<ProjectFile> {
  const projects = await loadCanonicalStoredProjects(page);
  projects.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const project = projects[0];
  if (!project) throw new Error('Expected a canonical saved project in localStorage');
  return project;
}

async function loadCanonicalStoredProjectById(page: Page, id: string): Promise<ProjectFile | null> {
  const projects = await loadCanonicalStoredProjects(page);
  return projects.find((project) => project.id === id) ?? null;
}

async function exportActiveProject(
  page: Page,
  outputPath: string,
): Promise<{ project: ProjectFile; suggestedFilename: string }> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const exportDialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'プロジェクト書き出し', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(outputPath);
  const project = JSON.parse(await readFile(outputPath, 'utf8')) as ProjectFile;
  await exportDialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return { project, suggestedFilename: download.suggestedFilename() };
}

function observeRuntimeErrors(page: Page, errors: string[] = []): string[] {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

const TABBABLE = [
  'a[href]:visible',
  'button:not([disabled]):visible',
  'input:not([disabled]):not([type="hidden"]):visible',
  'select:not([disabled]):visible',
  'textarea:not([disabled]):visible',
  '[tabindex]:not([tabindex="-1"]):visible',
].join(', ');

async function expectModalFocusLoop(page: Page, dialog: Locator): Promise<void> {
  const tabbable = dialog.locator(TABBABLE);
  await expect(tabbable.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(tabbable.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tabbable.first()).toBeFocused();
}

async function createFirstSong(page: Page, title = FIRST_SONG_TITLE): Promise<CreatedSong> {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: 'あとで', exact: true }).click();

  await page.getByRole('button', { name: '☰ プロジェクト', exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: 'プロジェクト', exact: true });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole('button', { name: 'BGMループ' }).click();
  await expect(projectDialog).toBeHidden();

  const titleInput = page.getByRole('textbox', { name: 'プロジェクト名', exact: true });
  await titleInput.fill(title);

  await page.getByRole('button', { name: '進行テンプレート', exact: true }).click();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: '王道進行 (I-V-vi-IV)' }).click();

  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await page.getByRole('button', { name: 'スケールメロディを生成', exact: true }).click();

  await page.getByRole('tab', { name: 'ドラム', exact: true }).click();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'ヒップホップ', exact: true }).click();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  const pauseButton = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pauseButton).toBeVisible();
  await expect(page.getByLabel('再生位置')).not.toHaveText('1.1', { timeout: 3_000 });
  await pauseButton.click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  const project = await loadNewestCanonicalStoredProject(page);
  const snapshot = summarizeProject(project);
  expect(snapshot.title).toBe(title);
  expect(snapshot.lengthBars).toBe(8);
  expect(snapshot.chordSymbols).toEqual(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F']);
  expect(snapshot.noteCounts.Bass).toBeGreaterThan(0);
  expect(snapshot.noteCounts.Melody).toBeGreaterThan(0);
  expect(snapshot.drumEvents).toHaveLength(112);
  expect(snapshot.drumEvents).toEqual(
    expect.arrayContaining([
      { lane: 'kick', stepIndex: 0, velocity: 100 },
      { lane: 'snare', stepIndex: 4, velocity: 100 },
      { lane: 'openHat', stepIndex: 14, velocity: 100 },
      { lane: 'kick', stepIndex: 16, velocity: 100 },
    ]),
  );
  return { project, snapshot };
}

test.describe.configure({ mode: 'serial' });

test('modal dialogs contain focus, isolate the background, and restore their trigger', async ({
  page,
}) => {
  const runtimeErrors = observeRuntimeErrors(page);
  await page.goto('/');

  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  const startFirstSong = welcome.getByRole('button', {
    name: '最初の1曲を作る',
    exact: true,
  });
  const later = welcome.getByRole('button', { name: 'あとで', exact: true });
  const playButton = page.getByRole('button', { name: '再生', exact: true });

  await expect(welcome).toBeVisible();
  await expect(startFirstSong).toBeFocused();
  await expectModalFocusLoop(page, welcome);
  expect(await playButton.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
  const dynamicBackgroundIsInert = await page.evaluate(async () => {
    const button = document.createElement('button');
    button.textContent = 'late background action';
    document.querySelector('.app-shell')?.append(button);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const inert = button.closest('[inert]') !== null;
    button.remove();
    return inert;
  });
  expect(dynamicBackgroundIsInert).toBe(true);

  await later.click();
  const guideTrigger = page.getByRole('button', {
    name: 'はじめてガイドを開く',
    exact: true,
  });
  await expect(welcome).toBeHidden();
  await expect(guideTrigger).toBeFocused();
  expect(await playButton.evaluate((element) => element.closest('[inert]') !== null)).toBe(false);

  await guideTrigger.press('Enter');
  await expect(welcome).toBeVisible();
  await expect(startFirstSong).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(welcome).toBeHidden();
  await expect(guideTrigger).toBeFocused();

  const exportTrigger = page.getByRole('button', { name: '書き出し', exact: true });
  const playBox = await playButton.boundingBox();
  if (!playBox) throw new Error('再生ボタンの座標を取得できませんでした');

  await exportTrigger.focus();
  await exportTrigger.press('Enter');
  const exportDialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  await expect(exportDialog).toBeVisible();
  await expectModalFocusLoop(page, exportDialog);
  expect(await playButton.evaluate((element) => element.closest('[inert]') !== null)).toBe(true);

  // A real pointer click at the covered transport location reaches only the
  // backdrop. It may dismiss the modal, but must never start playback.
  await page.mouse.click(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2);
  await expect(exportDialog).toBeHidden();
  await expect(playButton).toBeVisible();
  await expect(exportTrigger).toBeFocused();

  // Global shortcuts also stay suppressed if focus is programmatically lost.
  await exportTrigger.press('Enter');
  await expect(exportDialog).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await expect(exportDialog).toBeVisible();
  await expect(playButton).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(exportDialog).toBeHidden();
  await expect(exportTrigger).toBeFocused();

  expect(runtimeErrors).toEqual([]);
});

test('chord editing is reachable and safe with keyboard and pointer input', async ({ page }) => {
  const runtimeErrors = observeRuntimeErrors(page);
  await page.goto('/');

  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  await welcome.getByRole('button', { name: '最初の1曲を作る', exact: true }).click();
  await expect(welcome).toBeHidden();

  const lane = page.getByRole('region', { name: 'コードトラック', exact: true });
  const grid = lane.getByRole('group', { name: /コードグリッド/ });
  const playButton = page.getByRole('button', { name: '再生', exact: true });

  // A native transport button owns its Space activation. The global shortcut
  // must not toggle the same state a second time while the button is focused.
  await playButton.focus();
  await playButton.press('Space');
  const pauseButton = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pauseButton).toBeVisible();
  await pauseButton.press('Space');
  await expect(playButton).toBeVisible();

  // The focused bar cursor makes any bar reachable without a pointer. Local
  // Space adds the chord and must not also trigger the global transport action.
  await page.getByRole('button', { name: 'ズームイン', exact: true }).click();
  await grid.focus();
  await grid.press('End');
  await expect
    .poll(() => lane.locator('.chord-lane__scroll').evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await grid.press('Home');
  await grid.press('ArrowRight');
  await expect(grid).toHaveAttribute('aria-label', /第2小節/);
  const scaleDisplay = page.getByRole('button', { name: 'スケールスナップ', exact: true });
  const chordToneDisplay = page.getByRole('button', { name: 'コードトーン', exact: true });
  await grid.press('s');
  await grid.press('c');
  await expect(scaleDisplay).toHaveAttribute('aria-pressed', 'false');
  await expect(chordToneDisplay).toHaveAttribute('aria-pressed', 'true');
  await grid.press('Space');
  await expect(playButton).toBeVisible();

  const firstTrigger = lane.getByRole('button', {
    name: /^C コードを編集。第2小節、長さ1小節/,
  });
  await expect(firstTrigger).toBeVisible();

  // Secondary pointer activation never starts a drag. A primary drag previews
  // many pointer moves but commits one undoable project change on release.
  await firstTrigger.click({ button: 'right' });
  await expect(firstTrigger).toBeVisible();
  await expect(page.getByRole('dialog', { name: /コードを編集:/ })).toHaveCount(0);
  const firstBox = await firstTrigger.boundingBox();
  const gridBox = await grid.boundingBox();
  if (!firstBox || !gridBox) throw new Error('コードのドラッグ領域がありません');
  const dragStart = {
    x: firstBox.x + firstBox.width / 2,
    y: firstBox.y + firstBox.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + gridBox.width / 8, dragStart.y, { steps: 12 });
  await page.mouse.up();
  await expect(
    lane.getByRole('button', { name: /^C コードを編集。第3小節、長さ1小節/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(firstTrigger).toBeVisible();

  await expect(firstTrigger).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(firstTrigger).toHaveAttribute('aria-pressed', 'false');
  const controlledId = await firstTrigger.getAttribute('aria-controls');
  if (!controlledId) throw new Error('コード編集のaria-controlsがありません');

  await firstTrigger.focus();
  await firstTrigger.press('Enter');
  const popover = page.getByRole('dialog', { name: /コードを編集:/ });
  const symbolInput = popover.getByRole('textbox', { name: 'コード名', exact: true });
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAccessibleName('コードを編集: C');
  await expect(popover).toHaveAttribute('id', controlledId);
  await expect(popover).toHaveAttribute('aria-modal', 'false');
  await expect(firstTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(firstTrigger).toHaveAttribute('aria-pressed', 'true');
  await expect(symbolInput).toBeFocused();
  const popoverLayout = await popover.evaluate((element) => {
    const centerPane = document.querySelector('.center-pane');
    if (!centerPane) throw new Error('コード編集の表示領域がありません');
    const popoverRect = element.getBoundingClientRect();
    const centerRect = centerPane.getBoundingClientRect();
    return {
      bottom: popoverRect.bottom,
      right: popoverRect.right,
      centerBottom: centerRect.bottom,
      centerRight: centerRect.right,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  });
  expect(popoverLayout.bottom).toBeLessThanOrEqual(popoverLayout.centerBottom);
  expect(popoverLayout.right).toBeLessThanOrEqual(popoverLayout.centerRight + 1);
  expect(popoverLayout.scrollHeight).toBeGreaterThan(popoverLayout.clientHeight);
  await page.setViewportSize({ width: 1280, height: 360 });
  await expect
    .poll(() =>
      popover.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <= document.documentElement.clientHeight &&
          element.clientHeight >= 100
        );
      }),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(
    await symbolInput.evaluate((input) => ({
      start: (input as HTMLInputElement).selectionStart,
      end: (input as HTMLInputElement).selectionEnd,
    })),
  ).toEqual({ start: 0, end: 1 });

  await symbolInput.fill('not-a-chord');
  await expect(symbolInput).toHaveAttribute('aria-invalid', 'true');
  await expect(popover.getByRole('status')).toHaveText(
    'このコード名は読み取れませんでした。綴りを確認してください。',
  );
  await expect(popover.getByRole('button', { name: '適用', exact: true })).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(firstTrigger).toBeFocused();
  await expect(firstTrigger).toHaveAttribute('aria-expanded', 'false');

  // Space opens the editor but remains owned by the focused chord/button. It
  // must not start playback, including when used on a nested popover button.
  await firstTrigger.press('Space');
  await expect(symbolInput).toBeFocused();
  await expect(playButton).toBeVisible();
  const closeButton = popover.getByRole('button', {
    name: 'コード編集を閉じる',
    exact: true,
  });
  await closeButton.focus();
  await closeButton.press('Space');
  await expect(popover).toBeHidden();
  await expect(firstTrigger).toBeFocused();
  await expect(playButton).toBeVisible();

  // Pointer activation is a primary path; an outside pointer dismisses the
  // non-modal editor without stealing focus from the clicked destination.
  await firstTrigger.click();
  await expect(symbolInput).toBeFocused();
  const projectTitle = page.getByRole('textbox', {
    name: 'プロジェクト名',
    exact: true,
  });
  await projectTitle.click();
  await expect(popover).toBeHidden();
  await expect(projectTitle).toBeFocused();

  // Switching directly between chord triggers must remount the editor and
  // never leak the first chord's unsaved text into the second chord.
  await grid.focus();
  await grid.press('ArrowRight');
  await grid.press('Enter');
  const secondTrigger = lane.getByRole('button', { name: /コードを編集。第3小節/ });
  const secondSymbol = await secondTrigger.locator('.chord-chip__symbol').textContent();
  if (!secondSymbol) throw new Error('追加したコード記号を読み取れません');

  await firstTrigger.click();
  await symbolInput.fill('Fmaj7');
  await secondTrigger.click();
  await expect(symbolInput).toHaveValue(secondSymbol);
  await page.keyboard.press('Escape');
  await expect(secondTrigger).toBeFocused();

  // Number fields provide a keyboard alternative to dragging and resizing.
  await firstTrigger.press('F2');
  await popover.getByRole('spinbutton', { name: '開始小節', exact: true }).fill('7');
  await popover.getByRole('spinbutton', { name: '長さ（小節）', exact: true }).fill('2');
  await symbolInput.fill('Dm');
  await expect(symbolInput).toHaveAttribute('aria-invalid', 'false');
  await symbolInput.press('Enter');

  const movedTrigger = lane.getByRole('button', {
    name: /^Dm コードを編集。第7小節、長さ2小節/,
  });
  await expect(movedTrigger).toBeFocused();
  await expect
    .poll(() => lane.locator('.chord-lane__scroll').evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);

  // Deletion moves selection/focus to the next logical chord, then to the grid
  // when no chord remains, so keyboard users never fall back to document.body.
  await page.setViewportSize({ width: 375, height: 812 });
  await movedTrigger.press('Enter');
  const narrowLayout = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(0);
  expect(narrowLayout.right).toBeLessThanOrEqual(narrowLayout.viewportWidth);
  expect(narrowLayout.top).toBeGreaterThanOrEqual(0);
  expect(narrowLayout.bottom).toBeLessThanOrEqual(narrowLayout.viewportHeight);
  expect(narrowLayout.documentWidth).toBe(narrowLayout.viewportWidth);
  await popover.getByRole('button', { name: 'このコードを削除', exact: true }).press('Enter');
  await expect(secondTrigger).toBeFocused();
  await expect(secondTrigger).toHaveAttribute('aria-pressed', 'true');

  await secondTrigger.press('Enter');
  await popover.getByRole('button', { name: 'このコードを削除', exact: true }).press('Enter');
  await expect(grid).toBeFocused();
  await expect(lane.getByRole('button', { name: /コードを編集/ })).toHaveCount(0);
  await expect(playButton).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('first-song setup returns control when a cross-tab save lock stalls', async ({ page }) => {
  await page.addInitScript(() => {
    let requests = 0;
    const stalledLocks = {
      request: (
        _name: string,
        options: { signal?: AbortSignal },
        callback: () => unknown,
      ): Promise<unknown> => {
        requests += 1;
        if (requests > 1) return Promise.resolve(callback());
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('Lock wait aborted', 'AbortError'));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    };
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: stalledLocks,
    });
  });
  const runtimeErrors = observeRuntimeErrors(page);
  await page.goto('/');

  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  const start = welcome.getByRole('button', { name: '最初の1曲を作る', exact: true });
  await start.click();
  const pending = welcome.getByRole('button', { name: '最初の1曲を準備中…' });
  await expect(pending).toHaveAttribute('aria-disabled', 'true');
  await expect(pending).toBeFocused();

  await expect(welcome.getByRole('alert')).toContainText('レッスンを始められませんでした', {
    timeout: 7_000,
  });
  await expect(start).toHaveAttribute('aria-disabled', 'false');
  await expect(start).toBeFocused();
  await expect(welcome.getByRole('button', { name: 'あとで', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'チュートリアル', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
  expect(await page.evaluate(() => localStorage.getItem('cts.onboarded'))).toBeNull();

  await expect(page.locator('#project-save-status')).toContainText('保存済み', {
    timeout: 3_000,
  });
  await start.click();
  await expect(welcome).toBeHidden();
  await expect(page.getByRole('tab', { name: 'チュートリアル', exact: true })).toBeFocused();
  const firstSongProjects = (await loadCanonicalStoredProjects(page)).filter(
    (project) => project.title === '最初の1曲',
  );
  expect(firstSongProjects).toHaveLength(1);
  expect(runtimeErrors).toEqual([]);
});

test('first-launch guide starts a blank first-song project in the composition course', async ({
  page,
}) => {
  const runtimeErrors = observeRuntimeErrors(page);
  await page.goto('/');

  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  await expect(welcome).toBeVisible();
  await expectModalFocusLoop(page, welcome);
  await welcome.getByRole('button', { name: '最初の1曲を作る', exact: true }).click();

  await expect(welcome).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true })).toHaveValue(
    '最初の1曲',
  );
  await expect(page.getByRole('tab', { name: 'チュートリアル', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'チュートリアル', exact: true })).toBeFocused();
  await expect(
    page.getByRole('heading', { name: '8小節のコード進行を作る', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('最初のコードを置こう', { exact: true })).toBeVisible();

  const storedProjects = await loadCanonicalStoredProjects(page);
  const firstSong = storedProjects.find((project) => project.title === '最初の1曲');
  expect(firstSong).toBeDefined();
  expect(firstSong?.chordTrack).toEqual([]);
  expect(
    firstSong?.tracks.flatMap((track) =>
      track.clips.flatMap((clip) => [...(clip.notes ?? []), ...(clip.drumEvents ?? [])]),
    ),
  ).toEqual([]);

  // The guided lesson must be live, not merely selected in the UI. Adding the
  // first smart-default chord through the keyboard advances compose-1 step 1.
  await page.getByRole('group', { name: /コードグリッド/ }).press('Enter');
  await expect(page.getByText('4コード進行を完成させよう', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^C コードを編集/ })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('first song survives UI restart and exports valid MIDI and WAV files', async ({ page, context }, testInfo) => {
  const runtimeErrors = observeRuntimeErrors(page);
  const created = await createFirstSong(page);
  const beforeRestart = created.snapshot;

  await page.close();
  const restartedPage = await context.newPage();
  observeRuntimeErrors(restartedPage, runtimeErrors);
  await restartedPage.goto('/');
  await expect(
    restartedPage.getByRole('textbox', { name: 'プロジェクト名', exact: true }),
  ).toHaveValue(
    FIRST_SONG_TITLE,
  );
  await expect(restartedPage.locator('#project-save-status')).toContainText('保存済み');
  const restartedExport = await exportActiveProject(
    restartedPage,
    testInfo.outputPath('first-song-after-restart.ctsproj.json'),
  );
  expect(withoutUpdatedAt(restartedExport.project)).toEqual(withoutUpdatedAt(created.project));
  expect(summarizeProject(restartedExport.project)).toEqual(beforeRestart);

  await restartedPage.getByRole('button', { name: '書き出し', exact: true }).click();
  const exportDialog = restartedPage.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });

  const midiDownloadPromise = restartedPage.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'MIDIエクスポート', exact: true }).click();
  const midiDownload = await midiDownloadPromise;
  const midiPath = testInfo.outputPath('first-song.mid');
  await midiDownload.saveAs(midiPath);
  const midi = await readFile(midiPath);
  expect(midiDownload.suggestedFilename()).toBe('E2E_First_Song.mid');
  expect(midi.subarray(0, 4).toString('ascii')).toBe('MThd');
  expect(midi.length).toBeGreaterThan(100);
  const parsedMidi = parseMidiFile(new Uint8Array(midi));
  const midiNotes = parsedMidi.tracks.flatMap((track) => track.notes);
  expect(parsedMidi.ppq).toBeGreaterThan(0);
  expect(parsedMidi.tempoBpm).toBeCloseTo(beforeRestart.bpm, 4);
  expect(midiNotes.length).toBeGreaterThan(0);
  expect(midiNotes.every((note) => note.durationTick > 0 && note.velocity > 0)).toBe(true);

  const wavDownloadPromise = restartedPage.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'WAVエクスポート', exact: true }).click();
  const wavDownload = await wavDownloadPromise;
  const wavPath = testInfo.outputPath('first-song.wav');
  await wavDownload.saveAs(wavPath);
  const wav = await readFile(wavPath);
  expect(wavDownload.suggestedFilename()).toBe('E2E_First_Song.wav');
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(wav.readUInt32LE(4) + 8).toBe(wav.length);
  expect(wav.length).toBeGreaterThan(44);
  const wavInfo = inspectPcmWav(wav);
  expect(wavInfo).toMatchObject({
    audioFormat: 1,
    channels: 2,
    sampleRate: 44_100,
    bitsPerSample: 16,
  });
  expect(wavInfo.dataSize).toBeGreaterThan(0);
  expect(wavInfo.peakSample).toBeGreaterThan(0);
  const wavPlan = planWavRender(restartedExport.project as unknown as Project);
  expect(wavInfo.durationSeconds).toBeCloseTo(
    wavPlan.frames / wavInfo.sampleRate,
    5,
  );

  expect(runtimeErrors).toEqual([]);
});

test('project file import creates a durable copy without overwriting the source', async ({
  page,
  context,
}, testInfo) => {
  const runtimeErrors = observeRuntimeErrors(page);
  const original = await createFirstSong(page, 'E2E Project Roundtrip');

  const projectPath = testInfo.outputPath('roundtrip.ctsproj.json');
  const exportedDownload = await exportActiveProject(page, projectPath);
  const exported = exportedDownload.project;
  expect(exportedDownload.suggestedFilename).toBe('E2E_Project_Roundtrip.ctsproj.json');
  expect(exported.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(withoutUpdatedAt(exported)).toEqual(withoutUpdatedAt(original.project));
  expect(summarizeProject(exported)).toEqual(original.snapshot);

  await page.getByRole('button', { name: '☰ プロジェクト', exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: 'プロジェクト', exact: true });
  await projectDialog.locator('button.template-card--blank').click();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true })).toHaveValue(
    '新しい曲',
  );

  // Keep the source saved under its original id. Importing the downloaded file
  // must create a separate project rather than replacing this source head.
  await page.waitForTimeout(5);
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await exportDialog.locator('input[type="file"][accept*=".json"]').setInputFiles(projectPath);
  await expect(exportDialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true })).toHaveValue(
    'E2E Project Roundtrip',
  );
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  const importedDownload = await exportActiveProject(
    page,
    testInfo.outputPath('roundtrip-imported-ui.ctsproj.json'),
  );
  const imported = importedDownload.project;
  expect(imported.id).not.toBe(exported.id);
  expect(withoutImportedIdentity(imported)).toEqual(withoutImportedIdentity(exported));
  expect(summarizeProject(imported)).toEqual({ ...original.snapshot, id: imported.id });
  const canonicalImported = await loadCanonicalStoredProjectById(page, imported.id);
  expect(canonicalImported).not.toBeNull();
  expect(withoutUpdatedAt(canonicalImported as ProjectFile)).toEqual(withoutUpdatedAt(imported));
  const canonicalSource = await loadCanonicalStoredProjectById(page, exported.id);
  expect(canonicalSource).not.toBeNull();
  expect(withoutUpdatedAt(canonicalSource as ProjectFile)).toEqual(withoutUpdatedAt(exported));

  await page.close();
  const restartedPage = await context.newPage();
  observeRuntimeErrors(restartedPage, runtimeErrors);
  await restartedPage.goto('/');
  await expect(
    restartedPage.getByRole('textbox', { name: 'プロジェクト名', exact: true }),
  ).toHaveValue('E2E Project Roundtrip');
  await expect(restartedPage.locator('#project-save-status')).toContainText('保存済み');
  const restartedImport = await exportActiveProject(
    restartedPage,
    testInfo.outputPath('roundtrip-imported-after-restart.ctsproj.json'),
  );
  expect(withoutUpdatedAt(restartedImport.project)).toEqual(withoutUpdatedAt(imported));

  expect(runtimeErrors).toEqual([]);
});

test('corrupt current generation recovers the previous verified generation', async ({
  page,
  context,
}, testInfo) => {
  const runtimeErrors = observeRuntimeErrors(page);
  const created = await createFirstSong(page, 'E2E Generation Recovery');
  const expected = created.snapshot;

  // Save the same confirmed revision once more so the immediately previous
  // generation contains the exact same composition.
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  const stored = await loadNewestCanonicalStoredProject(page);
  const generationCount = await page.evaluate((projectId) => {
    const encodedId = encodeURIComponent(projectId).replaceAll('.', '%2E');
    const prefix = `cts.persistence.v1.project.${encodedId}.gen.`;
    return Object.keys(localStorage).filter((key) => key.startsWith(prefix)).length;
  }, stored.id);
  expect(generationCount).toBeGreaterThanOrEqual(2);

  const corrupted = await page.evaluate((projectId) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.endsWith('.head')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const head = JSON.parse(raw) as { projectId?: string; generationKey?: string };
        if (head.projectId !== projectId || !head.generationKey) continue;
        localStorage.setItem(head.generationKey, '{"corrupt":true}');
        return head.generationKey;
      } catch {
        continue;
      }
    }
    return null;
  }, stored.id);
  expect(corrupted).not.toBeNull();

  await page.close();
  const restartedPage = await context.newPage();
  observeRuntimeErrors(restartedPage, runtimeErrors);
  await restartedPage.goto('/');
  await expect(
    restartedPage.getByText('検証済みの保存世代から復元しました。', { exact: false }),
  ).toBeVisible();
  await expect(
    restartedPage.getByRole('textbox', { name: 'プロジェクト名', exact: true }),
  ).toHaveValue('E2E Generation Recovery');
  await expect(restartedPage.locator('#project-save-status')).toContainText('保存済み');
  const recoveredExport = await exportActiveProject(
    restartedPage,
    testInfo.outputPath('generation-recovered.ctsproj.json'),
  );
  expect(withoutUpdatedAt(recoveredExport.project)).toEqual(withoutUpdatedAt(created.project));
  expect(summarizeProject(recoveredExport.project)).toEqual(expected);

  // Recovery must repair the canonical head, not merely recover again on every
  // launch from the same older generation.
  await restartedPage.close();
  const verifiedPage = await context.newPage();
  observeRuntimeErrors(verifiedPage, runtimeErrors);
  await verifiedPage.goto('/');
  await expect(
    verifiedPage.getByText('検証済みの保存世代から復元しました。', { exact: false }),
  ).toHaveCount(0);
  await expect(
    verifiedPage.getByRole('textbox', { name: 'プロジェクト名', exact: true }),
  ).toHaveValue('E2E Generation Recovery');
  await expect(verifiedPage.locator('#project-save-status')).toContainText('保存済み');
  const verifiedExport = await exportActiveProject(
    verifiedPage,
    testInfo.outputPath('generation-after-second-restart.ctsproj.json'),
  );
  expect(withoutUpdatedAt(verifiedExport.project)).toEqual(
    withoutUpdatedAt(recoveredExport.project),
  );
  expect(runtimeErrors).toEqual([]);
});
