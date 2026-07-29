import { readFile } from 'node:fs/promises';
import type { Project } from '@cts/project-model';
import { expect, test, type Page } from '@playwright/test';

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

async function installSyntheticRecordingInput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type SyntheticInputState = Readonly<{
      context: AudioContext;
      oscillator: OscillatorNode;
      gain: GainNode;
      stream: MediaStream;
    }>;

    let state: SyntheticInputState | null = null;
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => [],
    });
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        if (state?.stream.getAudioTracks().some((track) => track.readyState === 'live')) {
          return state.stream;
        }
        if (state) {
          state.oscillator.stop();
          await state.context.close().catch(() => undefined);
          state = null;
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
        state = { context, oscillator, gain, stream: destination.stream };
        await context.resume();
        return destination.stream;
      },
    });
  });
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

async function createAndArmPunchTarget(page: Page): Promise<void> {
  await page.getByRole('button', { name: '＋ 追加', exact: true }).click();
  const addDialog = page.getByRole('dialog', { name: 'トラックを追加' });
  await addDialog.getByRole('radio', { name: /オーディオトラック/ }).check();
  await addDialog.getByLabel('名前', { exact: true }).fill('Punch Vocal');
  await addDialog.locator('input[type="file"]').setInputFiles({
    name: 'punch-vocal.wav',
    mimeType: 'audio/wav',
    buffer: createTwoSecondMonoFixture(),
  });

  await expect(page.getByRole('button', {
    name: 'Punch Vocal トラックを選択',
    exact: true,
  })).toBeVisible({ timeout: 20_000 });
  const arm = page.locator('.track-list').getByRole('button', {
    name: 'Punch Vocal 録音待機',
    exact: true,
  });
  await arm.click();
  await expect(arm).toHaveAttribute('aria-pressed', 'true');
}

async function setPunchRange(page: Page): Promise<void> {
  await page.getByRole('button', { name: /パンチ範囲を編集/ }).click();
  const dialog = page.getByRole('dialog', { name: 'オートパンチ範囲' });
  await dialog.getByLabel('パンチイン拍', { exact: true }).fill('1');
  await dialog.getByLabel('パンチアウト拍', { exact: true }).fill('4');
  await dialog.getByLabel('プリロール（拍）', { exact: true }).fill('1');
  await dialog.getByLabel('ポストロール（拍）', { exact: true }).fill('1');
  await dialog.getByRole('button', {
    name: 'パンチ範囲を設定',
    exact: true,
  }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', {
    name: 'パンチ',
    exact: true,
  })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', {
    name: 'ループ',
    exact: true,
  })).toHaveAttribute('aria-pressed', 'false');
}

test('Auto Punch adopts the new take and one Undo restores the exact Project', async ({
  page,
}, testInfo) => {
  test.setTimeout(75_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installSyntheticRecordingInput(page);
  await page.goto('/');
  await dismissWelcome(page);
  await createAndArmPunchTarget(page);

  const trackCountBefore = await page.locator('.track-row').count();
  await expect(
    page.locator('.arranger__clip.is-audio:not(.is-take-folder)'),
  ).toHaveCount(1);
  await saveProject(page);
  const projectBefore = await exportProject(
    page,
    testInfo.outputPath('audio-punch-before.ctsproj.json'),
  );

  await setPunchRange(page);
  await page.getByRole('button', {
    name: /録音を開く。録音先: Punch Vocal/,
  }).click();
  const recordingDialog = page.getByRole('dialog', {
    name: 'マイクをオーディオトラックへ録音',
  });
  await expect(recordingDialog).toContainText('オートパンチ録音');
  await expect(recordingDialog).toContainText('1〜4拍');
  await expect(recordingDialog).toContainText(
    '既存素材は元テイクとして残し、新しい録音を採用します。',
  );
  await recordingDialog.getByRole('button', {
    name: 'オートパンチを開始',
    exact: true,
  }).click();
  await expect(recordingDialog.getByText(
    'プリロール開始まで3秒',
    { exact: true },
  )).toBeVisible();

  const inputMeter = recordingDialog.getByRole('meter', {
    name: 'マイク入力レベル',
  });
  await expect(inputMeter).toBeVisible({ timeout: 8_000 });
  await expect(recordingDialog.locator('.audio-track-recording__state')).toContainText(
    /パンチ録音中・伴奏再生中|パンチアウト済み・入力遅延の末尾を収録中/,
  );
  await expect.poll(
    async () => Number(await inputMeter.getAttribute('aria-valuenow')),
    { timeout: 8_000 },
  ).toBeGreaterThan(0);
  await expect(recordingDialog).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#transport-playback-status')).toHaveText(
    '再生は停止しています。',
  );
  await expect(page.locator('.track-row')).toHaveCount(trackCountBefore);

  const takeEditorTab = page.getByRole('tab', {
    name: 'テイク編集',
    exact: true,
  });
  await expect(takeEditorTab).toHaveAttribute('aria-selected', 'true');
  const takeEditor = page.locator('#editor-tabpanel-comping');
  await expect(takeEditor).toBeVisible();
  const takes = takeEditor.locator('[data-take-id]');
  await expect(takes).toHaveCount(2);
  await expect(takes.nth(0)).toHaveAttribute('data-comp-state', 'unused');
  await expect(takes.nth(1)).toHaveAttribute('data-comp-state', 'used');
  await expect(takeEditor.locator('[data-comp-segment-id]')).toHaveCount(1);

  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  const takeFolder = page.locator('.arranger__clip.is-take-folder');
  await expect(takeFolder).toHaveCount(1);
  await expect(takeFolder).toContainText('2テイク');

  await saveProject(page);
  const projectWithPunch = await exportProject(
    page,
    testInfo.outputPath('audio-punch-recorded.ctsproj.json'),
  );
  expect(projectWithPunch.audioTakeFolders).toHaveLength(1);
  expect(projectWithPunch.audioAssets).toHaveLength(
    projectBefore.audioAssets.length + 1,
  );
  const folder = projectWithPunch.audioTakeFolders[0]!;
  expect(folder).toMatchObject({
    startBeat: 1,
    lengthBeats: 3,
    takes: [
      expect.objectContaining({
        audioAssetId: projectBefore.audioAssets[0]?.id,
      }),
      expect.objectContaining({
        audioAssetId: projectWithPunch.audioAssets.at(-1)?.id,
      }),
    ],
    compSegments: [
      expect.objectContaining({
        offsetBeats: 0,
        lengthBeats: 3,
      }),
    ],
  });
  expect(folder.compSegments[0]?.takeId).toBe(folder.takes[1]?.id);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(takeFolder).toHaveCount(0);
  await expect(
    page.locator('.arranger__clip.is-audio:not(.is-take-folder)'),
  ).toHaveCount(1);
  await expect(page.locator('.track-row')).toHaveCount(trackCountBefore);

  await saveProject(page);
  const projectAfterUndo = await exportProject(
    page,
    testInfo.outputPath('audio-punch-after-undo.ctsproj.json'),
  );
  // Undo intentionally re-stamps its audit timestamp; every musical/project
  // field must otherwise be byte-for-byte equivalent to the pre-punch export.
  expect(projectAfterUndo).toEqual({
    ...projectBefore,
    updatedAt: projectAfterUndo.updatedAt,
  });
  expect(pageErrors).toEqual([]);
});
