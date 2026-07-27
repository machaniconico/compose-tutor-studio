import { expect, test, type Page } from '@playwright/test';
import { createTwoNoteHummingFixture } from './fixtures/humming-audio';

type SyntheticMicrophoneWindow = Window &
  typeof globalThis & {
    __ctsPlaySyntheticHumming?: () => Promise<void>;
    __ctsSyntheticHummingFinished?: boolean;
  };

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function installSyntheticMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type SyntheticState = Readonly<{
      context: AudioContext;
      oscillator: OscillatorNode;
      gain: GainNode;
      stream: MediaStream;
    }>;

    const testWindow = window as SyntheticMicrophoneWindow;
    testWindow.__ctsSyntheticHummingFinished = false;
    let state: SyntheticState | null = null;

    const getUserMedia = async (): Promise<MediaStream> => {
      if (state) return state.stream;
      const context = new AudioContext({ sampleRate: 48_000 });
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      state = { context, oscillator, gain, stream: destination.stream };
      await context.resume();
      return destination.stream;
    };

    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: getUserMedia,
    });

    testWindow.__ctsPlaySyntheticHumming = async () => {
      const current = state;
      if (!current) throw new Error('Synthetic microphone has not been requested.');
      await current.context.resume();
      const start = current.context.currentTime + 0.05;
      const firstEnd = start + 0.62;
      const secondStart = firstEnd + 0.14;
      const secondEnd = secondStart + 0.62;
      const parameter = current.gain.gain;
      parameter.cancelScheduledValues(start);
      parameter.setValueAtTime(0, start);
      current.oscillator.frequency.setValueAtTime(440, start);
      parameter.linearRampToValueAtTime(0.55, start + 0.02);
      parameter.setValueAtTime(0.55, firstEnd - 0.02);
      parameter.linearRampToValueAtTime(0, firstEnd);
      current.oscillator.frequency.setValueAtTime(523.251, secondStart);
      parameter.setValueAtTime(0, secondStart);
      parameter.linearRampToValueAtTime(0.55, secondStart + 0.02);
      parameter.setValueAtTime(0.55, secondEnd - 0.02);
      parameter.linearRampToValueAtTime(0, secondEnd);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, Math.ceil((secondEnd - current.context.currentTime + 0.1) * 1_000));
      });
      testWindow.__ctsSyntheticHummingFinished = true;
    };
  });
}

async function installDeniedMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('Microphone permission denied for E2E.', 'NotAllowedError');
      },
    });
  });
}

async function openHummingAssistant(page: Page) {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  return page.getByRole('region', { name: '鼻歌からメロディ' });
}

test('records synthetic microphone humming and applies two editable notes atomically', async ({
  page,
}) => {
  await installSyntheticMicrophone(page);
  const section = await openHummingAssistant(page);

  await section.getByRole('button', { name: 'マイクで鼻歌を録音' }).click();
  const dialog = page.getByRole('dialog', { name: '鼻歌をマイクで録音' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '録音を開始' })).toBeFocused();
  await dialog.getByRole('button', { name: '録音を開始' }).click();
  await expect(dialog.getByText('カウントのあとに歌い始めてください。')).toBeVisible();
  await expect(dialog.getByText('録音開始まで3秒', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('録音中', { timeout: 6_000 });
  await expect(dialog.getByRole('meter', { name: 'マイク入力レベル' })).toBeVisible();

  await page.evaluate(() => {
    const play = (window as SyntheticMicrophoneWindow).__ctsPlaySyntheticHumming;
    if (!play) throw new Error('Synthetic microphone controller is missing.');
    void play();
  });
  await expect(dialog.getByRole('meter', { name: 'マイク入力レベル' })).not.toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  await page.waitForFunction(
    () => (window as SyntheticMicrophoneWindow).__ctsSyntheticHummingFinished === true,
  );
  await dialog.getByRole('button', { name: '録音を終了して解析' }).click();

  await expect(dialog).toBeHidden();
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符候補', {
    timeout: 15_000,
  });
  await expect(section.getByText(/音を検出 — マイク録音/)).toBeVisible();
  await section.getByRole('button', { name: 'メロディクリップへ反映' }).click();
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符を反映');

  await expect(page.getByRole('tab', { name: 'ピアノロール' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: /^A4。開始/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^C5。開始/ })).toHaveCount(1);

  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByRole('button', { name: /^A4。開始/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^C5。開始/ })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'メロディクリップへ反映' })).toBeEnabled();
});

test('recovers from denied microphone permission through the file fallback', async ({ page }) => {
  await installDeniedMicrophone(page);
  const section = await openHummingAssistant(page);

  await section.getByRole('button', { name: 'マイクで鼻歌を録音' }).click();
  const dialog = page.getByRole('dialog', { name: '鼻歌をマイクで録音' });
  await dialog.getByRole('button', { name: '録音を開始' }).click();
  await expect(dialog.getByRole('alert')).toContainText('マイクの使用が許可されませんでした');
  await expect(dialog.getByRole('button', { name: 'マイクを再試行' })).toBeEnabled();

  const chooserPromise = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: '音声ファイルを使う' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'permission-fallback.wav',
    mimeType: 'audio/wav',
    buffer: createTwoNoteHummingFixture(),
  });

  await expect(dialog).toBeHidden();
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符候補', {
    timeout: 15_000,
  });
  await expect(section.getByText(/permission-fallback\.wav/)).toBeVisible();
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();
});
