import { expect, test, type Page } from '@playwright/test';
import { parseWav, readDownload, readStoredZip, startBlankProject } from './fixtures/journey-helpers';

// Journey: groove/swing (P21) -> instrument preset + macro (P22), one drag = one
// Undo step -> loop-range WAV (P53) and stem ZIP (P52) as browser downloads.
// The WAV exports also check the P51 loudness status and the 「音量をそろえる」 toggle.
const LOOP_START_BEAT = 4;
const LOOP_END_BEAT = 12;
const BPM = 120;

async function exportDownload(
  page: Page,
  button: string,
  range: '曲全体' | 'ループ範囲だけ',
  options: { normalize?: boolean; levelsStatus?: RegExp } = {},
) {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await dialog.getByLabel('書き出す範囲').selectOption({ label: range });
  const normalize = dialog.getByRole('checkbox', { name: '音量をそろえる(−14 LUFS)' });
  if (options.normalize === true) await normalize.check();
  else await expect(normalize).not.toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: button, exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readDownload(download);
  if (options.levelsStatus) await expect(dialog).toContainText(options.levelsStatus);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog).toBeHidden();
  return { bytes, fileName: download.suggestedFilename() };
}

test('journey: groove, preset and macro, then loop WAV and stem ZIP downloads', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await startBlankProject(page);

  // Give the song something to render: a chord progression and an accompaniment.
  await page.getByRole('button', { name: '進行テンプレート', exact: true }).click();
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: '王道進行 (I-V-vi-IV)' }).click();
  await page.getByRole('tab', { name: 'アシスタント', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'おまかせ伴奏', exact: true });
  await assistant.getByRole('button', { name: 'おまかせで伴奏を作る', exact: true }).click();
  await expect(assistant.getByRole('status')).toContainText('新しいトラック 3 本');

  // Groove (P21): song swing and hi-hat choke.
  await page.getByRole('tab', { name: 'インスペクター', exact: true }).click();
  await page.getByRole('button', { name: '伴奏 トラックを選択', exact: true }).click();
  await page.getByText('ノリ(スウィング・チョーク)', { exact: true }).click();
  const swing = page.getByRole('slider', { name: 'スウィング', exact: true });
  await swing.fill('40');
  await expect(swing).toHaveAttribute('aria-valuetext', '40%');
  const choke = page.getByRole('checkbox', { name: 'ハイハットのチョーク' });
  // Blank projects start with choke on, so toggle both ways. The checkbox is
  // controlled by the project, and Undo/Redo flipping it proves each change
  // reached the project as its own history step.
  await expect(choke).toBeChecked();
  await choke.uncheck();
  await expect(choke).not.toBeChecked();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(choke).toBeChecked();
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(choke).not.toBeChecked();
  await choke.check();
  await expect(choke).toBeChecked();

  // Preset (P22): switch the 伴奏 track to a different built-in sound.
  const preset = page.getByRole('combobox', { name: '伴奏 音色', exact: true });
  const options = await preset.locator('option').evaluateAll((list) =>
    list.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent ?? '' })));
  const current = await preset.inputValue();
  const next = options.find((option) => option.value !== current && option.value !== '');
  if (!next) throw new Error('no alternative preset to choose');
  await preset.selectOption(next.value);
  await expect(preset).toHaveValue(next.value);

  // Macro: one pointer drag across the slider is exactly one Undo step.
  await page.getByText('かんたん音色調整', { exact: true }).click();
  const brightness = page.getByRole('slider', { name: '明るさ', exact: true });
  const before = await brightness.getAttribute('aria-valuetext');
  const box = await brightness.boundingBox();
  if (!box) throw new Error('macro slider has no box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  for (const fraction of [0.6, 0.7, 0.8, 0.9, 0.95]) {
    await page.mouse.move(box.x + box.width * fraction, y);
  }
  await page.mouse.up();
  const after = await brightness.getAttribute('aria-valuetext');
  expect(after).not.toBe(before);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(brightness).toHaveAttribute('aria-valuetext', before!);
  // The earlier preset change is a separate step and survives the single Undo.
  await expect(preset).toHaveValue(next.value);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(brightness).toHaveAttribute('aria-valuetext', after!);

  // Loop range in beats: [4, 12) = 8 beats = 4 s at 120 BPM.
  await page.getByRole('button', { name: /^ループ範囲を編集/ }).click();
  const loopDialog = page.getByRole('dialog', { name: 'ループ範囲' });
  await loopDialog.getByLabel('開始拍').fill(String(LOOP_START_BEAT));
  await loopDialog.getByLabel('終了拍').fill(String(LOOP_END_BEAT));
  await loopDialog.getByRole('button', { name: '範囲を設定', exact: true }).click();
  await expect(loopDialog).toBeHidden();
  const loopToggle = page.getByRole('button', { name: 'ループ', exact: true });
  if ((await loopToggle.getAttribute('aria-pressed')) !== 'true') await loopToggle.click();
  await expect(loopToggle).toHaveAttribute('aria-pressed', 'true');

  // Loop-range WAV: valid RIFF, and the length follows the range, not the song.
  // Loudness (P51): off by default, so the status only reports a measured LUFS value.
  const loopExport = await exportDownload(page, 'WAVエクスポート', 'ループ範囲だけ', {
    levelsStatus: /音の大きさ: 約 -?\d+ LUFS。/,
  });
  // 「音量をそろえる」 on: the status reports the before and after LUFS values.
  const fullExport = await exportDownload(page, 'WAVエクスポート', '曲全体', {
    normalize: true,
    levelsStatus: /音の大きさ: 約 -?\d+ LUFS から約 -?\d+ LUFS にそろえました/,
  });
  const loopWav = parseWav(loopExport.bytes);
  const fullWav = parseWav(fullExport.bytes);
  expect(loopExport.bytes.readUInt32LE(4)).toBe(loopExport.bytes.length - 8);
  expect(loopWav.sampleRate).toBe(fullWav.sampleRate);
  const rangeSeconds = ((LOOP_END_BEAT - LOOP_START_BEAT) * 60) / BPM;
  const songSeconds = (32 * 60) / BPM;
  const loopSeconds = loopWav.frames / loopWav.sampleRate;
  const fullSeconds = fullWav.frames / fullWav.sampleRate;
  // The range plus a release/reverb tail, never anything near the whole song.
  expect(loopSeconds).toBeGreaterThanOrEqual(rangeSeconds);
  expect(loopSeconds).toBeLessThan(rangeSeconds + 2);
  expect(fullSeconds).toBeGreaterThanOrEqual(songSeconds);
  expect(fullSeconds - loopSeconds).toBeCloseTo(songSeconds - rangeSeconds, 1);
  expect(loopWav.data.some((byte) => byte !== 0)).toBe(true);

  // Stem ZIP: stored entries named 01_...wav, every CRC-32 valid, every stem a real WAV.
  const stems = await exportDownload(page, 'ステムZIP', '曲全体');
  expect(stems.fileName).toMatch(/\.zip$/);
  const entries = readStoredZip(stems.bytes);
  expect(entries.length).toBeGreaterThanOrEqual(2);
  entries.forEach((entry, index) => {
    expect(entry.name).toMatch(new RegExp(`^${String(index + 1).padStart(2, '0')}_.+\\.wav$`));
    expect(parseWav(entry.data).frames).toBeGreaterThan(0);
  });
  const lengths = new Set(entries.map((entry) => parseWav(entry.data).frames));
  expect(lengths.size, 'all stems share one length').toBe(1);

  expect(pageErrors).toEqual([]);
});
