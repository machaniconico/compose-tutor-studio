import { expect, test, type Page } from '@playwright/test';
import { createTwoNoteHummingFixture } from './fixtures/humming-audio';

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
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
    buffer: createTwoNoteHummingFixture(),
  });

  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符候補', {
    timeout: 15_000,
  });
  await expect(section.getByText(/two-note-humming\.wav/)).toBeVisible();
  await section.getByRole('button', { name: 'メロディクリップへ反映' }).click();
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符を反映');
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
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('反映後にプロジェクトが変更');
});

test('edits and removes candidates before one atomic apply', async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const section = page.getByRole('region', { name: '鼻歌からメロディ' });
  await section.locator('input[type="file"]').setInputFiles({
    name: 'editable-humming.wav',
    mimeType: 'audio/wav',
    buffer: createTwoNoteHummingFixture(),
  });
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符候補', {
    timeout: 15_000,
  });

  await section.getByLabel('1音目のMIDIノート').fill('69');
  await section.getByRole('button', { name: '2音目を候補から外す' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    section.locator('button[data-humming-segment-id]').first(),
  ).toBeFocused();
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('1個の音符候補');
  await section.getByLabel('リズム補正').selectOption('off');
  await section.getByRole('button', { name: 'メロディクリップへ反映' }).dblclick();
  await expect(section.getByRole('button', { name: 'メロディクリップへ反映済み' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^A4。開始/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^C5。開始/ })).toHaveCount(0);

  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page.getByRole('button', { name: /^A4。開始/ })).toHaveCount(0);
});

test('edits pitch and timing with local history without overflowing a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await dismissOnboarding(page);
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const section = page.getByRole('region', { name: '鼻歌からメロディ' });
  await section.locator('input[type="file"]').setInputFiles({
    name: 'keyboard-edit-humming.wav',
    mimeType: 'audio/wav',
    buffer: createTwoNoteHummingFixture(),
  });
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符候補', {
    timeout: 15_000,
  });

  const firstSegment = section.locator('button[data-humming-segment-id]').first();
  const midiInput = section.getByLabel('1音目のMIDIノート');
  const endInput = section.getByLabel('1音目の終了秒');
  const localUndo = section.getByRole('button', {
    name: '候補の編集を元に戻す',
  });
  const localRedo = section.getByRole('button', {
    name: '候補の編集をやり直す',
  });
  const projectUndo = page.getByRole('button', { name: '元に戻す', exact: true });
  const initialEnd = Number(await endInput.inputValue());

  await firstSegment.focus();
  await page.keyboard.press('ArrowUp');
  await expect(midiInput).toHaveValue('70');
  await expect(localUndo).toBeEnabled();
  await expect(projectUndo).toBeDisabled();

  await page.keyboard.press('Shift+ArrowRight');
  const extendedEnd = Number(await endInput.inputValue());
  expect(extendedEnd).toBeGreaterThan(initialEnd + 0.04);
  await expect(firstSegment).toBeFocused();

  await page.keyboard.press('Control+z');
  expect(Number(await endInput.inputValue())).toBeCloseTo(initialEnd, 4);
  await expect(firstSegment).toBeFocused();
  await page.keyboard.press('Control+Shift+z');
  expect(Number(await endInput.inputValue())).toBeCloseTo(extendedEnd, 4);
  await expect(firstSegment).toBeFocused();
  await expect(localRedo).toBeDisabled();
  await expect(projectUndo).toBeDisabled();

  const layout = await page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>(
      '.humming-pitch-editor__timeline-scroll',
    );
    return {
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      timelineScrolls: Boolean(
        timeline && timeline.scrollWidth > timeline.clientWidth,
      ),
    };
  });
  expect(layout.documentOverflow).toBeLessThanOrEqual(1);
  expect(layout.timelineScrolls).toBe(true);

  await section.getByRole('button', { name: 'メロディクリップへ反映' }).click();
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('2個の音符を反映');
  await expect(page.getByRole('button', { name: /^A#4。開始/ })).toHaveCount(1);
  await expect(projectUndo).toBeEnabled();
  await projectUndo.click();
  await expect(page.getByRole('button', { name: /^A#4。開始/ })).toHaveCount(0);
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
    buffer: createTwoNoteHummingFixture(),
  });
  await section.getByRole('button', { name: '解析を中止' }).dispatchEvent('click');
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('中止');
  await expect(section.getByRole('button', { name: /メロディクリップへ反映/ })).toHaveCount(0);
  await expect(undo).toBeDisabled();

  await page.evaluate(() => (
    window as typeof window & { __releaseHummingDecode?: () => void }
  ).__releaseHummingDecode?.());
  await expect(section.getByRole('button', { name: '録音済みファイルを選ぶ' })).toBeEnabled();
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
    buffer: createTwoNoteHummingFixture(),
  });
  await section.getByRole('button', { name: '解析を中止' }).dispatchEvent('click');
  await expect(section.getByRole('status', { name: '鼻歌変換の状態' })).toContainText('中止', { timeout: 1_000 });
  await expect(section.getByRole('button', { name: '録音済みファイルを選ぶ' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();

  await page.evaluate(() => (
    window as typeof window & { __restoreAudioConstructor?: () => void }
  ).__restoreAudioConstructor?.());
});
