import { expect, test, type Page } from '@playwright/test';

const SAMPLE_RATE = 44_100;

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

function createHummingFixture(): Buffer {
  const firstFrames = Math.round(SAMPLE_RATE * 0.55);
  const silenceFrames = Math.round(SAMPLE_RATE * 0.1);
  const secondFrames = Math.round(SAMPLE_RATE * 0.55);
  const frames = firstFrames + silenceFrames + secondFrames;
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
    const frequency =
      frame < firstFrames
        ? 440
        : frame >= firstFrames + silenceFrames
          ? 523.251
          : 0;
    const sample =
      frequency === 0
        ? 0
        : 0.55 * Math.sin((2 * Math.PI * frequency * frame) / SAMPLE_RATE);
    bytes.writeInt16LE(Math.round(sample * 0x7fff), 44 + frame * 2);
  }
  return bytes;
}

test('converts a local monophonic humming file into editable melody notes', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();

  const section = page.getByRole('region', { name: '鼻歌からメロディ' });
  await expect(section).toContainText('録音済みファイル');
  await section.locator('input[type="file"]').setInputFiles({
    name: 'two-note-humming.wav',
    mimeType: 'audio/wav',
    buffer: createHummingFixture(),
  });

  await expect(section.getByRole('status')).toContainText('2個の音符候補', {
    timeout: 15_000,
  });
  await expect(section.getByText(/two-note-humming\.wav/)).toBeVisible();
  await section.getByRole('button', { name: 'メロディクリップへ反映' }).click();
  await expect(section.getByRole('status')).toContainText('2個の音符を反映');
  await expect(section.getByRole('button', { name: 'メロディクリップへ反映済み' })).toBeDisabled();

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
  await expect(section.getByRole('status')).toContainText('反映後にプロジェクトが変更');
});

test('edits and removes candidates before one atomic apply', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const section = page.getByRole('region', { name: '鼻歌からメロディ' });
  await section.locator('input[type="file"]').setInputFiles({
    name: 'editable-humming.wav',
    mimeType: 'audio/wav',
    buffer: createHummingFixture(),
  });
  await expect(section.getByRole('status')).toContainText('2個の音符候補', {
    timeout: 15_000,
  });

  await section.getByLabel('1音目のMIDIノート').fill('69');
  await section.getByRole('button', { name: '2音目を候補から外す' }).focus();
  await page.keyboard.press('Enter');
  await expect(section.getByRole('button', { name: '1音目を候補から外す' })).toBeFocused();
  await expect(section.getByRole('status')).toContainText('1個の音符候補');
  await section.getByLabel('リズム補正').selectOption('off');
  await section.getByRole('button', { name: 'メロディクリップへ反映' }).dblclick();
  await expect(section.getByRole('button', { name: 'メロディクリップへ反映済み' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^A4。開始/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^C5。開始/ })).toHaveCount(0);

  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByRole('button', { name: /^A4。開始/ })).toHaveCount(0);
});

test('cancels a pending decode without changing the project', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const section = page.getByRole('region', { name: '鼻歌からメロディ' });
  const undo = page.getByRole('button', { name: '元に戻す' });
  await expect(undo).toBeDisabled();

  await page.evaluate(() => {
    const original = AudioContext.prototype.decodeAudioData;
    const testWindow = window as typeof window & { __releaseHummingDecode?: () => void };
    let pending: {
      context: AudioContext;
      args: Parameters<AudioContext['decodeAudioData']>;
      resolve: (value: AudioBuffer) => void;
      reject: (reason?: unknown) => void;
    } | null = null;
    testWindow.__releaseHummingDecode = () => {
      if (!pending) return;
      const current = pending;
      pending = null;
      original.apply(current.context, current.args).then(current.resolve, current.reject);
    };
    AudioContext.prototype.decodeAudioData = function heldDecode(...args) {
      return new Promise((resolve, reject) => {
        pending = { context: this, args, resolve, reject };
      });
    };
  });

  await section.locator('input[type="file"]').setInputFiles({
    name: 'cancelled-humming.wav',
    mimeType: 'audio/wav',
    buffer: createHummingFixture(),
  });
  await section.getByRole('button', { name: '解析を中止' }).dispatchEvent('click');
  await expect(section.getByRole('status')).toContainText('中止');
  await expect(section.getByRole('button', { name: /メロディクリップへ反映/ })).toHaveCount(0);
  await expect(undo).toBeDisabled();

  await page.evaluate(() => (
    window as typeof window & { __releaseHummingDecode?: () => void }
  ).__releaseHummingDecode?.());
  await expect(section.getByRole('button', { name: '鼻歌ファイルを選ぶ' })).toBeEnabled();
  await expect(undo).toBeDisabled();
});

test('cancels browser metadata loading immediately', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const section = page.getByRole('region', { name: '鼻歌からメロディ' });

  await page.evaluate(() => {
    const OriginalAudio = window.Audio;
    const testWindow = window as typeof window & { __restoreAudioConstructor?: () => void };
    class HeldAudio extends EventTarget {
      duration = Number.NaN;
      preload = '';
      src = '';

      pause(): void {}

      load(): void {}

      removeAttribute(name: string): void {
        if (name === 'src') this.src = '';
      }
    }
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      writable: true,
      value: HeldAudio,
    });
    testWindow.__restoreAudioConstructor = () => {
      Object.defineProperty(window, 'Audio', {
        configurable: true,
        writable: true,
        value: OriginalAudio,
      });
    };
  });

  await section.locator('input[type="file"]').setInputFiles({
    name: 'metadata-cancel.wav',
    mimeType: 'audio/wav',
    buffer: createHummingFixture(),
  });
  await section.getByRole('button', { name: '解析を中止' }).dispatchEvent('click');
  await expect(section.getByRole('status')).toContainText('中止', { timeout: 1_000 });
  await expect(section.getByRole('button', { name: '鼻歌ファイルを選ぶ' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();

  await page.evaluate(() => (
    window as typeof window & { __restoreAudioConstructor?: () => void }
  ).__restoreAudioConstructor?.());
});
