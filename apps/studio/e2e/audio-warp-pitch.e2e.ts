import { expect, test, type Download, type Page } from '@playwright/test';
import { createAudioWarpPitchFixture } from './fixtures/audio-warp-fixture';

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function importFixture(page: Page): Promise<void> {
  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await dialog.getByRole('radio', { name: /オーディオトラック/ }).check();
  await dialog.getByLabel('名前', { exact: true }).fill('Elastic Voice');
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'elastic-voice.wav',
    mimeType: 'audio/wav',
    buffer: createAudioWarpPitchFixture(),
  });
  await expect(page.getByRole('button', {
    name: 'Elastic Voice トラックを選択',
    exact: true,
  })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#project-save-status')).toContainText('保存済み', {
    timeout: 20_000,
  });
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportWav(
  page: Page,
  buttonName: 'WAVエクスポート' | '選択トラックをWAV',
): Promise<Buffer> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: buttonName, exact: true }).click();
  const bytes = await readDownload(await downloadPromise);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(bytes.subarray(44).some((byte) => byte !== 0)).toBe(true);
  return bytes;
}

async function waitForSaved(page: Page): Promise<void> {
  await expect(page.locator('#project-save-status')).toContainText('保存済み', {
    timeout: 20_000,
  });
}

function expectPcm16WithinOneLsb(actual: Buffer, expected: Buffer): void {
  expect(actual.length).toBe(expected.length);
  expect(actual.subarray(0, 44)).toEqual(expected.subarray(0, 44));
  let maxDifference = 0;
  for (let offset = 44; offset + 1 < actual.length; offset += 2) {
    maxDifference = Math.max(
      maxDifference,
      Math.abs(actual.readInt16LE(offset) - expected.readInt16LE(offset)),
    );
  }
  expect(maxDifference).toBeLessThanOrEqual(1);
}

function dominantFrequencyHz(
  wav: Buffer,
  startSeconds: number,
  endSeconds: number,
): number {
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bytesPerFrame = channels * 2;
  const frameCount = Math.floor((wav.length - 44) / bytesPerFrame);
  const start = Math.max(1, Math.min(frameCount - 1, Math.round(startSeconds * sampleRate)));
  const end = Math.max(start + 1, Math.min(frameCount, Math.round(endSeconds * sampleRate)));
  let previous = wav.readInt16LE(44 + (start - 1) * bytesPerFrame);
  let crossings = 0;
  for (let frame = start; frame < end; frame += 1) {
    const sample = wav.readInt16LE(44 + frame * bytesPerFrame);
    if (previous <= 0 && sample > 0) crossings += 1;
    previous = sample;
  }
  return crossings / ((end - start) / sampleRate);
}

function quietestWindowFrame(
  wav: Buffer,
  searchStartSeconds: number,
  searchEndSeconds: number,
): number {
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bytesPerFrame = channels * 2;
  const frameCount = Math.floor((wav.length - 44) / bytesPerFrame);
  const windowFrames = Math.round(sampleRate * 0.02);
  const start = Math.max(0, Math.round(searchStartSeconds * sampleRate));
  const end = Math.min(
    frameCount - windowFrames,
    Math.round(searchEndSeconds * sampleRate),
  );
  let quietestStart = start;
  let quietestEnergy = Number.POSITIVE_INFINITY;
  for (let candidate = start; candidate <= end; candidate += windowFrames) {
    let energy = 0;
    for (let offset = 0; offset < windowFrames; offset += 1) {
      const sample = wav.readInt16LE(44 + (candidate + offset) * bytesPerFrame);
      energy += sample * sample;
    }
    if (energy < quietestEnergy) {
      quietestEnergy = energy;
      quietestStart = candidate;
    }
  }
  return quietestStart;
}

async function installLiveAudioCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Capture = Readonly<{
      length: number;
      sampleRate: number;
      hash: number;
      frequencyHz: number;
    }>;
    type CaptureWindow = Window & {
      __elasticAudioCaptures?: Capture[];
    };
    const captureWindow = window as CaptureWindow;
    captureWindow.__elasticAudioCaptures = [];
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function start(
      when?: number,
      offset?: number,
      duration?: number,
    ): void {
      const buffer = this.buffer;
      if (buffer && buffer.length >= buffer.sampleRate) {
        const channel = buffer.getChannelData(0);
        const startFrame = Math.min(
          channel.length - 1,
          Math.max(1, Math.round(buffer.sampleRate * 0.35)),
        );
        const endFrame = Math.min(
          channel.length,
          Math.max(startFrame + 1, Math.round(buffer.sampleRate * 1.25)),
        );
        let previous = channel[startFrame - 1] ?? 0;
        let crossings = 0;
        let hash = 2_166_136_261;
        for (let frame = startFrame; frame < endFrame; frame += 1) {
          const sample = channel[frame] ?? 0;
          if (previous <= 0 && sample > 0) crossings += 1;
          previous = sample;
          if ((frame - startFrame) % 97 === 0) {
            hash ^= Math.round((sample + 1) * 32_767);
            hash = Math.imul(hash, 16_777_619) >>> 0;
          }
        }
        captureWindow.__elasticAudioCaptures?.push({
          length: buffer.length,
          sampleRate: buffer.sampleRate,
          hash,
          frequencyHz: crossings / ((endFrame - startFrame) / buffer.sampleRate),
        });
      }
      if (duration !== undefined) {
        originalStart.call(this, when, offset, duration);
      } else if (offset !== undefined) {
        originalStart.call(this, when, offset);
      } else {
        originalStart.call(this, when);
      }
    };
  });
}

async function visibleTimelineTargetMinimum(
  page: Page,
  selector: string,
): Promise<number> {
  return page.evaluate((targetSelector) => {
    const panel = document.querySelector<HTMLElement>(
      '.audio-warp-editor [role="tabpanel"]:not([hidden])',
    );
    const timeline = panel?.querySelector<HTMLElement>('.audio-warp-editor__timeline');
    if (!panel || !timeline) throw new Error('Visible Elastic Audio timeline missing');
    const clip = timeline.getBoundingClientRect();
    const sizes = [...panel.querySelectorAll<HTMLElement>(targetSelector)]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const target = element.getBoundingClientRect();
        const width = Math.max(
          0,
          Math.min(target.right, clip.right) - Math.max(target.left, clip.left),
        );
        const height = Math.max(
          0,
          Math.min(target.bottom, clip.bottom) - Math.max(target.top, clip.top),
        );
        return Math.min(width, height);
      });
    return sizes.length > 0 ? Math.min(...sizes) : 0;
  }, selector);
}

test('edits and persists local accessible timing and monophonic pitch correction', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const runtimeNetwork: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (['fetch', 'xhr', 'websocket'].includes(request.resourceType())) {
      runtimeNetwork.push(request.url());
    }
  });
  await installLiveAudioCapture(page);
  await page.goto('/');
  await dismissWelcome(page);
  await importFixture(page);
  const originalSelected = await exportWav(page, '選択トラックをWAV');

  const editor = page.getByRole('region', { name: '選択オーディオクリップの編集' });
  const disclosure = editor.locator('.audio-warp-editor summary');
  await expect(disclosure).toContainText('音声を整える');
  await expect(disclosure).toHaveAttribute('aria-disabled', 'false');
  await disclosure.click();

  const timingTab = editor.getByRole('tab', { name: 'タイミング', exact: true });
  const pitchTab = editor.getByRole('tab', { name: '単音ピッチ', exact: true });
  await expect(timingTab).toHaveAttribute('aria-selected', 'true');
  await timingTab.press('ArrowRight');
  await expect(pitchTab).toBeFocused();
  await expect(pitchTab).toHaveAttribute('aria-selected', 'true');
  await pitchTab.press('Home');
  await expect(timingTab).toBeFocused();
  const addTimingPoint = editor.getByRole('button', { name: '点を追加', exact: true });
  await addTimingPoint.click();
  const middleTimingPoint = editor.getByRole('button', { name: /^タイミング点 2、/ });
  const warpBody = editor.locator('.audio-warp-editor__body');
  await expect(warpBody).toHaveAttribute('aria-disabled', 'true');
  await expect(addTimingPoint).toBeDisabled();
  await expect(middleTimingPoint).toBeDisabled();
  await waitForSaved(page);
  await expect(warpBody).not.toHaveAttribute('aria-disabled');
  await expect(addTimingPoint).toBeEnabled();
  await expect(middleTimingPoint).toBeEnabled();
  await expect(middleTimingPoint).toBeFocused();
  await expect(
    editor.locator('[aria-label^="タイミング点 "][tabindex="0"]'),
  ).toHaveCount(1);

  const originalTimingLabel = await middleTimingPoint.getAttribute('aria-label');
  const pointBox = await middleTimingPoint.boundingBox();
  if (!originalTimingLabel || !pointBox) throw new Error('Timing point is not measurable');
  const pointCenter = {
    x: pointBox.x + pointBox.width / 2,
    y: pointBox.y + pointBox.height / 2,
  };
  await page.mouse.move(pointCenter.x, pointCenter.y);
  await page.mouse.down();
  await page.mouse.move(pointCenter.x + 24, pointCenter.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(middleTimingPoint).toHaveAttribute('aria-label', originalTimingLabel);

  await page.mouse.move(pointCenter.x, pointCenter.y);
  await page.mouse.down();
  await page.mouse.move(pointCenter.x + 24, pointCenter.y);
  await page.mouse.up();
  await expect(middleTimingPoint).not.toHaveAttribute('aria-label', originalTimingLabel);
  const draggedTimingLabel = await middleTimingPoint.getAttribute('aria-label');
  if (!draggedTimingLabel) throw new Error('Dragged timing point lost its accessible name');
  await waitForSaved(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(middleTimingPoint).toHaveAttribute('aria-label', originalTimingLabel);
  await waitForSaved(page);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(middleTimingPoint).toHaveAttribute('aria-label', draggedTimingLabel);
  await waitForSaved(page);

  await middleTimingPoint.press('ArrowRight');
  await waitForSaved(page);
  await middleTimingPoint.press('Alt+ArrowRight');
  await waitForSaved(page);
  await middleTimingPoint.press('PageDown');
  await expect(editor.getByRole('button', { name: /^タイミング点 3、/ })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(editor.getByRole('button', { name: /^タイミング点 1、/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(editor.getByRole('button', { name: /^タイミング点 3、/ })).toBeFocused();
  await middleTimingPoint.focus();
  await middleTimingPoint.press('Delete');
  await expect(editor.getByRole('button', { name: /^タイミング点 / })).toHaveCount(2);
  await waitForSaved(page);
  await expect(editor.getByRole('button', { name: /^タイミング点 2、/ })).toBeFocused();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(editor.getByRole('button', { name: /^タイミング点 / })).toHaveCount(3);
  await waitForSaved(page);
  const timingOnlySelected = await exportWav(page, '選択トラックをWAV');
  const originalSilenceFrame = quietestWindowFrame(originalSelected, 1.5, 2.7);
  const timingSilenceFrame = quietestWindowFrame(timingOnlySelected, 1.5, 2.7);
  const timingSampleRate = timingOnlySelected.readUInt32LE(24);
  // The fixture's 80 ms silent seam starts at 2.0 s. Moving its midpoint
  // marker to the right must delay that seam by an observable amount in the
  // public WAV export, not merely change internal project metadata.
  expect(timingSilenceFrame).toBeGreaterThan(originalSilenceFrame);
  expect(timingSilenceFrame - originalSilenceFrame)
    .toBeGreaterThanOrEqual(Math.round(timingSampleRate * 0.04));
  await timingTab.focus();
  await timingTab.press('End');
  await expect(pitchTab).toBeFocused();
  await expect(pitchTab).toHaveAttribute('aria-selected', 'true');

  await editor.getByRole('button', { name: '音程をローカル解析', exact: true }).click();
  const cancelAnalysis = editor.getByRole('button', {
    name: '解析をキャンセル',
    exact: true,
  });
  await expect(editor.locator('.audio-pitch-editor__progress')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(cancelAnalysis).toBeEnabled();
  await cancelAnalysis.click();
  await expect(editor).toContainText('音程解析をキャンセルしました');
  await expect(editor.getByRole('button', {
    name: '音程をローカル解析',
    exact: true,
  })).toBeFocused();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  const analyze = editor.getByRole('button', { name: '音程をローカル解析', exact: true });
  await analyze.click();
  await expect(editor.locator('.audio-pitch-editor__progress')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(editor.getByRole('button', { name: /音程区間 1/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(editor).toContainText('まだプロジェクトは変更していません');
  await expect(editor.locator('[data-analysis-waveform] line').first()).toBeVisible();
  await expect(editor.locator('[data-analysis-pitch-trace] path')).toHaveAttribute('d', /M /);
  await expect(editor.locator('[data-analysis-cursor]')).toBeVisible();
  await expect(
    editor.locator('[aria-label^="音程区間 "][tabindex="0"]'),
  ).toHaveCount(1);
  const firstPitchRegion = editor.getByRole('button', { name: /^音程区間 1、/ });
  const secondPitchRegion = editor.getByRole('button', { name: /^音程区間 2、/ });
  await firstPitchRegion.click();
  await editor.getByRole('button', { name: '次と結合', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText(
    '隣り合い、音程と補正量が同じ区間だけを結合できます。',
  );
  await expect(firstPitchRegion).toBeFocused();
  await firstPitchRegion.press('ArrowUp');
  await waitForSaved(page);
  await editor.getByRole('button', { name: '区間を分割', exact: true }).click();
  await expect(editor.getByRole('button', { name: /^音程区間 / })).toHaveCount(3);
  await waitForSaved(page);
  await expect(editor.getByRole('button', { name: /^音程区間 2、/ })).toBeFocused();
  await firstPitchRegion.click();
  await editor.getByRole('button', { name: '次と結合', exact: true }).click();
  await expect(editor.getByRole('button', { name: /^音程区間 / })).toHaveCount(2);
  await waitForSaved(page);
  await expect(firstPitchRegion).toBeFocused();
  await firstPitchRegion.press('PageDown');
  await expect(secondPitchRegion).toBeFocused();
  await secondPitchRegion.press('Home');
  await expect(firstPitchRegion).toBeFocused();
  await firstPitchRegion.press('End');
  await expect(secondPitchRegion).toBeFocused();
  await secondPitchRegion.press('Delete');
  await expect(editor.getByRole('button', { name: /^音程区間 / })).toHaveCount(1);
  await waitForSaved(page);
  await expect(firstPitchRegion).toBeFocused();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(editor.getByRole('button', { name: /^音程区間 / })).toHaveCount(2);
  await waitForSaved(page);
  await firstPitchRegion.click();

  const correction = editor.getByLabel('補正量（0〜100%）', { exact: true });
  const fixtureSolo = page.getByRole('button', {
    name: 'Elastic Voice ソロ',
    exact: true,
  }).first();
  await fixtureSolo.click();
  await expect(fixtureSolo).toHaveAttribute('aria-pressed', 'true');
  await waitForSaved(page);
  await correction.focus();
  await correction.fill('100');
  await waitForSaved(page);
  const pitchCorrectedSelected = await exportWav(page, '選択トラックをWAV');
  const pitchCorrectedFullBeforeReload = await exportWav(page, 'WAVエクスポート');
  expectPcm16WithinOneLsb(
    pitchCorrectedFullBeforeReload,
    pitchCorrectedSelected,
  );
  const timingFrequency = dominantFrequencyHz(timingOnlySelected, 0.35, 1.25);
  const correctedFrequency = dominantFrequencyHz(pitchCorrectedSelected, 0.35, 1.25);
  expect(Math.abs(timingFrequency - 440)).toBeLessThan(8);
  expect(Math.abs(correctedFrequency - 466.164)).toBeLessThan(8);
  expect(correctedFrequency - timingFrequency).toBeGreaterThan(15);
  expect(Math.abs(
    quietestWindowFrame(timingOnlySelected, 1.5, 2.7)
      - quietestWindowFrame(pitchCorrectedSelected, 1.5, 2.7),
  )).toBeLessThanOrEqual(Math.round(48_000 * 0.05));

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(editor.getByLabel('補正量（0〜100%）', { exact: true })).toHaveValue('0');
  await waitForSaved(page);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(editor.getByLabel('補正量（0〜100%）', { exact: true })).toHaveValue('100');
  await waitForSaved(page);
  await editor.getByRole('button', { name: '音程補正をリセット', exact: true }).click();
  await waitForSaved(page);
  await expect(analyze).toBeFocused();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(editor.getByLabel('補正量（0〜100%）', { exact: true })).toHaveValue('100');
  await waitForSaved(page);

  await page.keyboard.press('Control+S');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.reload();
  await dismissWelcome(page);
  await page.getByRole('button', {
    name: 'Elastic Voice トラックを選択',
    exact: true,
  }).click();
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  const reloaded = page.getByRole('region', { name: '選択オーディオクリップの編集' });
  await reloaded.locator('.audio-warp-editor summary').click();
  const reloadedTimingTab = reloaded.getByRole('tab', {
    name: 'タイミング',
    exact: true,
  });
  const reloadedPitchTab = reloaded.getByRole('tab', {
    name: '単音ピッチ',
    exact: true,
  });
  await reloadedPitchTab.click();
  await expect(reloaded.getByLabel('補正量（0〜100%）', { exact: true })).toHaveValue('100');

  const beforePitch = reloaded.getByRole('button', {
    name: 'ピッチ補正前',
    exact: true,
  });
  const correctedPitch = reloaded.getByRole('button', { name: '補正後', exact: true });
  const solo = page.getByRole('button', { name: 'Elastic Voice ソロ', exact: true }).first();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  await beforePitch.click();
  await expect(beforePitch).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
  await page.evaluate(() => {
    (window as Window & { __elasticAudioCaptures?: unknown[] })
      .__elasticAudioCaptures = [];
  });
  await page.getByRole('button', { name: '再生', exact: true }).click();
  let pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pause).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __elasticAudioCaptures?: unknown[] })
      .__elasticAudioCaptures?.length ?? 0), {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  const beforeLive = await page.evaluate(() => {
    const captures = (window as Window & {
      __elasticAudioCaptures?: Array<{
        length: number;
        sampleRate: number;
        hash: number;
        frequencyHz: number;
      }>;
    }).__elasticAudioCaptures ?? [];
    return captures.at(-1);
  });
  await page.evaluate(() => {
    (window as Window & { __elasticAudioCaptures?: unknown[] })
      .__elasticAudioCaptures = [];
  });
  await correctedPitch.click();
  await expect(correctedPitch).toHaveAttribute('aria-pressed', 'true');
  pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pause).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __elasticAudioCaptures?: unknown[] })
      .__elasticAudioCaptures?.length ?? 0), {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  const correctedLive = await page.evaluate(() => {
    const captures = (window as Window & {
      __elasticAudioCaptures?: Array<{
        length: number;
        sampleRate: number;
        hash: number;
        frequencyHz: number;
      }>;
    }).__elasticAudioCaptures ?? [];
    return captures.at(-1);
  });
  expect(beforeLive).toBeDefined();
  expect(correctedLive).toBeDefined();
  expect(correctedLive?.length).toBe(beforeLive?.length);
  expect(correctedLive?.sampleRate).toBe(beforeLive?.sampleRate);
  expect(correctedLive?.hash).not.toBe(beforeLive?.hash);
  expect((correctedLive?.frequencyHz ?? 0) - (beforeLive?.frequencyHz ?? 0))
    .toBeGreaterThan(15);
  await pause.click();

  const fullFirst = await exportWav(page, 'WAVエクスポート');
  const fullSecond = await exportWav(page, 'WAVエクスポート');
  expectPcm16WithinOneLsb(fullSecond, fullFirst);
  expectPcm16WithinOneLsb(fullFirst, pitchCorrectedFullBeforeReload);
  const selectedFirst = await exportWav(page, '選択トラックをWAV');
  const selectedSecond = await exportWav(page, '選択トラックをWAV');
  expectPcm16WithinOneLsb(selectedSecond, selectedFirst);
  expectPcm16WithinOneLsb(selectedFirst, fullFirst);
  expectPcm16WithinOneLsb(selectedFirst, pitchCorrectedSelected);
  expect(selectedFirst.equals(originalSelected)).toBe(false);

  for (const viewport of [
    { width: 1_024, height: 640 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await reloadedTimingTab.click();
    await expect(
      reloaded.locator('[aria-label^="タイミング点 "][tabindex="0"]'),
    ).toHaveCount(1);
    expect(await visibleTimelineTargetMinimum(
      page,
      '.audio-timing-editor__point',
    )).toBeGreaterThanOrEqual(44);
    await reloadedPitchTab.click();
    await expect(
      reloaded.locator('[aria-label^="音程区間 "][tabindex="0"]'),
    ).toHaveCount(1);
    expect(await visibleTimelineTargetMinimum(
      page,
      '.audio-pitch-editor__region',
    )).toBeGreaterThanOrEqual(44);
    const layout = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.audio-warp-editor__body');
      const timelineScroll = document.querySelector<HTMLElement>(
        '.audio-warp-editor [role="tabpanel"]:not([hidden]) .audio-warp-editor__timeline-scroll',
      );
      const timeline = timelineScroll?.querySelector<HTMLElement>(
        '.audio-warp-editor__timeline',
      );
      if (!body || !timelineScroll || !timeline) {
        throw new Error('Elastic Audio layout missing');
      }
      const horizontalScrollers = [...body.querySelectorAll<HTMLElement>('*')]
        .filter((element) => {
          const overflow = getComputedStyle(element).overflowX;
          return element.scrollWidth > element.clientWidth + 1
            && (overflow === 'auto' || overflow === 'scroll');
        });
      const interactive = [...body.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      )].filter((element) => element.getClientRects().length > 0);
      const targetSizes = interactive.map((element) => {
        const rect = element.getBoundingClientRect();
        return Math.min(rect.width, rect.height);
      });
      const inspector = body.querySelector<HTMLElement>(
        '.audio-warp-editor__inspector',
      );
      const toolbars = [...body.querySelectorAll<HTMLElement>(
        '[role="tabpanel"]:not([hidden]) .audio-warp-editor__toolbar',
      )];
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: body.getBoundingClientRect().width,
        timelineHeight: timeline.getBoundingClientRect().height,
        timelineClientWidth: timelineScroll.clientWidth,
        timelineScrollWidth: timelineScroll.scrollWidth,
        timelineOverflow: getComputedStyle(timelineScroll).overflowX,
        horizontalScrollerCount: horizontalScrollers.length,
        horizontalScrollersAreTimelines: horizontalScrollers.every((element) =>
          element.classList.contains('audio-warp-editor__timeline-scroll')),
        minimumTargetSize: targetSizes.length > 0 ? Math.min(...targetSizes) : 0,
        inspectorDirection: inspector ? getComputedStyle(inspector).flexDirection : null,
        toolbarsStacked: toolbars.every(
          (toolbar) => getComputedStyle(toolbar).flexDirection === 'column',
        ),
      };
    });
    expect(layout.documentWidth - layout.viewportWidth).toBeLessThanOrEqual(1);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.timelineHeight).toBeGreaterThanOrEqual(180);
    expect(layout.timelineScrollWidth).toBeGreaterThanOrEqual(
      layout.timelineClientWidth,
    );
    expect(layout.timelineOverflow).toBe('auto');
    expect(layout.horizontalScrollersAreTimelines).toBe(true);
    expect(layout.minimumTargetSize).toBeGreaterThanOrEqual(44);
    if (viewport.width === 320) {
      expect(layout.horizontalScrollerCount).toBeGreaterThanOrEqual(1);
      expect(layout.inspectorDirection).toBe('column');
      expect(layout.toolbarsStacked).toBe(true);
    }
  }

  expect(runtimeNetwork).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
