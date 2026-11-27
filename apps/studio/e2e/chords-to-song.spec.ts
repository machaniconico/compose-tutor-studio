import { expect, test } from '@playwright/test';
import { expectValidMidiFile, expectValidWavFile } from './exportAssertions';

test('a chord progression becomes playable accompaniment and exports to WAV and MIDI', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByRole('navigation', { name: 'トラック一覧' })
    .getByText('Chords', { exact: true }).click();

  const chords = page.getByRole('region', { name: 'コードトラック' });
  await chords.getByRole('button', { name: '進行テンプレート' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await chords.getByRole('menuitem', { name: /ツーファイブワン/ }).click();
  await expect(chords.locator('.chord-chip__symbol')).toHaveText(['Dm', 'G', 'C', 'Dm', 'G', 'C', 'Dm', 'G']);

  const notes = page.locator('.pr__note');
  const writeNotes = chords.getByRole('button', { name: 'コードをノートにする' });
  await expect(notes).toHaveCount(0);
  await writeNotes.click();
  await expect(notes.first()).toBeVisible();

  // A half-beat is 14 px at the initial zoom. Whole notes start on bar lines.
  const offbeatNotes = notes.and(page.locator('[style*="left: 14px;"]'));
  await expect(offbeatNotes).toHaveCount(0);
  await chords.getByLabel('伴奏パターン').selectOption({ label: '8分刻み' });
  page.once('dialog', (dialog) => dialog.accept());
  await writeNotes.click();
  await expect(offbeatNotes.first()).toBeAttached();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  const pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pause).toBeVisible();
  await expect(page.getByLabel('再生位置(小節.拍)', { exact: true })).not.toHaveText('1.1');
  await pause.click();

  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const exportMenu = page.getByRole('dialog', { name: '書き出し / 読み込み' });
  await exportMenu.getByRole('button', { name: 'WAVエクスポート' }).click();
  const wavChecklist = page.getByRole('dialog', { name: '書き出し前チェック（WAV）' });
  const wavPending = page.waitForEvent('download');
  await wavChecklist.getByRole('button', { name: /WAVを書き出す|このまま書き出す/ }).click();
  const wav = await wavPending;
  expect(wav.suggestedFilename()).toMatch(/\.wav$/);
  await expectValidWavFile(await wav.path(), 44100);

  await exportMenu.getByRole('button', { name: 'MIDIエクスポート' }).click();
  const midiChecklist = page.getByRole('dialog', { name: '書き出し前チェック（MIDI）' });
  const midiPending = page.waitForEvent('download');
  await midiChecklist.getByRole('button', { name: /MIDIを書き出す|このまま書き出す/ }).click();
  const midi = await midiPending;
  expect(midi.suggestedFilename()).toMatch(/\.mid$/);
  await expectValidMidiFile(await midi.path());
});
