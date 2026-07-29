import { expect, test } from '@playwright/test';

test('keeps a usable dialog when a deferred feature chunk cannot load', async ({ page }) => {
  const chunkPattern = '**/assets/ProjectMenuContent-*.js';
  let releaseChunk: (() => void) | undefined;
  let requestWasBlocked = false;
  const chunkGate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });

  await page.route(chunkPattern, async (route) => {
    requestWasBlocked = true;
    await chunkGate;
    await route.abort('failed');
  });

  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }

  await page.getByRole('button', { name: '☰ プロジェクト', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'プロジェクト', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText(
    'プロジェクトメニューを読み込んでいます',
  );
  expect(requestWasBlocked).toBe(true);

  releaseChunk?.();
  await expect(dialog.getByRole('alert')).toContainText(
    'プロジェクトメニューを読み込めませんでした',
  );
  const reload = dialog.getByRole('button', { name: 'アプリを再読み込み' });
  await expect(reload).toBeVisible();
  await expect(dialog.getByRole('button', { name: '閉じる' })).toBeFocused();

  await page.unroute(chunkPattern);
  await reload.click();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: '☰ プロジェクト', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'プロジェクト', exact: true })
      .getByLabel('プロジェクト名を変更'),
  ).toBeVisible();
});

test('keeps the export lock while its deferred dialog is closed and reopened', async ({
  page,
}) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }

  await page.evaluate(() => {
    type WavGate = {
      starts: number;
      release: (() => void) | null;
    };
    const gate: WavGate = { starts: 0, release: null };
    const originalStartRendering = OfflineAudioContext.prototype.startRendering;
    const pageWindow = window as unknown as { __ctsWavGate: WavGate };
    pageWindow.__ctsWavGate = gate;

    OfflineAudioContext.prototype.startRendering = function startRenderingWithGate() {
      gate.starts += 1;
      const context = this;
      return new Promise<AudioBuffer>((resolve, reject) => {
        gate.release = () => {
          gate.release = null;
          void originalStartRendering.call(context).then(resolve, reject);
        };
      });
    };
  });

  const openExport = page.getByRole('button', { name: '書き出し', exact: true });
  await openExport.click();
  let exportDialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  await exportDialog.getByRole('button', { name: 'WAVエクスポート' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ctsWavGate: { starts: number } }).__ctsWavGate
            .starts,
      ),
    )
    .toBe(1);
  await expect(exportDialog.getByRole('button', { name: '書き出し中…' })).toBeDisabled();

  await exportDialog.getByRole('button', { name: '閉じる' }).click();
  await expect(exportDialog).toBeHidden();
  await openExport.click();
  exportDialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const pendingWav = exportDialog.getByRole('button', { name: '書き出し中…' });
  await expect(pendingWav).toBeDisabled();
  await expect(exportDialog.getByRole('button', { name: 'MIDIエクスポート' })).toBeDisabled();

  // A programmatic click bypasses Playwright's enabled-state guard, but the
  // native disabled control must still suppress the second React handler.
  await pendingWav.evaluate((button: HTMLButtonElement) => button.click());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ctsWavGate: { starts: number } }).__ctsWavGate
            .starts,
      ),
    )
    .toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __ctsWavGate: { release: (() => void) | null } })
      .__ctsWavGate.release?.();
  });
  await expect(exportDialog.getByRole('button', { name: 'WAVエクスポート' })).toBeEnabled();

  await exportDialog.getByRole('button', { name: '選択トラックをWAV' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ctsWavGate: { starts: number } }).__ctsWavGate
            .starts,
      ),
    )
    .toBe(2);
  await expect(
    exportDialog.getByRole('button', { name: '選択トラックを書き出し中…' }),
  ).toBeDisabled();
  await expect(exportDialog.getByRole('button', { name: 'WAVエクスポート' })).toBeDisabled();

  await exportDialog.getByRole('button', { name: '閉じる' }).click();
  await expect(exportDialog).toBeHidden();
  await openExport.click();
  exportDialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const pendingTrackWav = exportDialog.getByRole('button', {
    name: '選択トラックを書き出し中…',
  });
  await expect(pendingTrackWav).toBeDisabled();
  const lockedMixWav = exportDialog.getByRole('button', { name: 'WAVエクスポート' });
  await expect(lockedMixWav).toBeDisabled();

  await lockedMixWav.evaluate((button: HTMLButtonElement) => button.click());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ctsWavGate: { starts: number } }).__ctsWavGate
            .starts,
      ),
    )
    .toBe(2);

  await page.evaluate(() => {
    (window as unknown as { __ctsWavGate: { release: (() => void) | null } })
      .__ctsWavGate.release?.();
  });
  await expect(
    exportDialog.getByRole('button', { name: '選択トラックをWAV' }),
  ).toBeEnabled();
});
