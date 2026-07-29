import { expect, test, type Page } from '@playwright/test';

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function installSyntheticRecordingInput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let stream: MediaStream | null = null;
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => [],
    });
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        if (stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
          return stream;
        }
        const context = new AudioContext({ sampleRate: 48_000 });
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 220;
        gain.gain.value = 0.2;
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        await context.resume();
        stream = destination.stream;
        return stream;
      },
    });
  });
}

async function setOneBeatLoop(page: Page): Promise<void> {
  await page.getByRole('button', { name: /ループ範囲を編集/ }).click();
  const loopDialog = page.getByRole('dialog', { name: 'ループ範囲' });
  await loopDialog.getByLabel('開始拍').fill('0');
  await loopDialog.getByLabel('終了拍').fill('1');
  await loopDialog.getByRole('button', { name: '範囲を設定' }).click();
  const loopToggle = page.getByRole('button', { name: 'ループ', exact: true });
  await expect(loopToggle).toHaveAttribute('aria-pressed', 'true');
}

async function openTwoPassRecording(page: Page) {
  await page.getByRole('button', { name: /録音を開く。録音先:/ }).click();
  const dialog = page.getByRole('dialog', {
    name: 'マイクをオーディオトラックへ録音',
  });
  await expect(dialog).toContainText('サイクル録音');
  await expect(dialog).toContainText('途中停止・キャンセルでは全テイクを破棄');
  const passCount = dialog.getByLabel('テイク数');
  await expect(passCount).toHaveAttribute('min', '2');
  await passCount.fill('2');
  await expect(dialog.getByRole('button', { name: '2テイクを録音' })).toBeEnabled();
  return dialog;
}

test('records an exact fixed-pass cycle atomically and discards a manually stopped cycle', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installSyntheticRecordingInput(page);
  await page.goto('/');
  await dismissWelcome(page);
  await setOneBeatLoop(page);

  const trackCountBefore = await page.locator('.track-row').count();
  const completeDialog = await openTwoPassRecording(page);
  await completeDialog.getByRole('button', { name: '2テイクを録音' }).click();
  await expect(completeDialog.getByText('録音開始まで3秒', { exact: true })).toBeVisible();
  await expect(completeDialog.getByRole('status')).toContainText(
    /サイクル録音中・テイク|最終テイクの入力遅延を収録中/,
    { timeout: 8_000 },
  );
  await expect(completeDialog).toBeHidden({ timeout: 20_000 });

  const takeFolder = page.locator('.arranger__clip.is-take-folder');
  await expect(takeFolder).toHaveCount(1);
  await expect(takeFolder).toContainText('2テイク');
  await expect(page.locator('.track-row')).toHaveCount(trackCountBefore + 1);
  await expect(page.getByRole('tab', { name: 'テイク編集', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(takeFolder).toHaveCount(0);
  await expect(page.locator('.track-row')).toHaveCount(trackCountBefore);

  const discardedDialog = await openTwoPassRecording(page);
  await discardedDialog.getByRole('button', { name: '2テイクを録音' }).click();
  await expect(discardedDialog.getByRole('button', {
    name: 'サイクル録音を中止して破棄',
  })).toBeVisible({ timeout: 8_000 });
  await discardedDialog.getByRole('button', {
    name: 'サイクル録音を中止して破棄',
  }).click();
  await expect(discardedDialog).toBeHidden();
  await expect(takeFolder).toHaveCount(0);
  await expect(page.locator('.track-row')).toHaveCount(trackCountBefore);
  expect(pageErrors).toEqual([]);
});
