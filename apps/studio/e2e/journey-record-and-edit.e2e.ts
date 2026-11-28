import { expect, test, type Page } from '@playwright/test';
import { startBlankProject } from './fixtures/journey-helpers';

// Journey: instrument clip -> PC keyboard mode (P40) -> MIDI recording (P42,
// count-in off) -> stop -> Undo/Redo the take as one step -> quantize (P33)
// -> copy/paste (P33 clipboard).
//
// The recorder stamps notes with the AudioContext clock, so positions are only
// asserted after quantizing. The project runs at 60 BPM and keys are tapped one
// beat (1000 ms) apart; the 1-beat grid then leaves 500 ms of slack per note.
// Before quantizing only the note count and pitch order are checked.
const KEY_PITCHES = [
  { key: 'a', pitch: 'C4' },
  { key: 's', pitch: 'D4' },
  { key: 'd', pitch: 'E4' },
] as const;

async function tap(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(200);
  await page.keyboard.up(key);
  // Real time must pass between keys (the recorder reads the audio clock);
  // two short waits make one beat at 60 BPM.
  await page.waitForTimeout(500);
  await page.waitForTimeout(300);
}

test('journey: record a PC keyboard take, undo/redo it, quantize and copy/paste', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await startBlankProject(page);

  // Select the Melody instrument clip.
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();
  const clip = page.getByRole('button', { name: /^Melody、クリップ1/ });
  await clip.click();
  await expect(clip).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'ピアノロール', exact: true }).click();
  const notes = page.locator('.pr__note');
  await expect(notes).toHaveCount(0);

  // 60 BPM: one beat is one second.
  const bpm = page.locator('#bpm-input');
  await bpm.fill('60');
  await expect(bpm).toHaveValue('60');

  // PC keyboard mode with the count-in off.
  const toggle = page.getByRole('button', { name: 'PC鍵盤で弾く', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('group', { name: 'PC鍵盤で弾く' });
  await expect(panel.getByRole('checkbox', { name: '１小節カウント' })).not.toBeChecked();

  // Record three keys, then stop.
  await panel.getByRole('button', { name: 'MIDI 録音', exact: true }).click();
  const stop = panel.getByRole('button', { name: 'MIDI 録音を停止', exact: true });
  await expect(stop).toBeEnabled();
  await expect(panel.getByRole('status')).toContainText('録音中');
  for (const { key } of KEY_PITCHES) await tap(page, key);
  await stop.click();
  await expect(panel.getByText('録音を反映しました。 入らなかった音は 0 音です。')).toBeVisible();

  // Structure only: three notes, pitches mapped from the keys, in key order.
  await expect(notes).toHaveCount(3);
  for (const [index, { pitch }] of KEY_PITCHES.entries()) {
    await expect(notes.nth(index)).toHaveAttribute('aria-label', new RegExp(`^${pitch}。`));
  }

  // Leave PC keyboard mode, then one Undo removes the whole take; Redo restores it.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  await undo.click();
  await expect(notes).toHaveCount(0);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(notes).toHaveCount(3);

  // Quantize to the 1-beat grid: every selected note lands on a whole beat.
  await page.getByLabel('グリッド分解能').selectOption({ label: '1/4' });
  await notes.nth(0).click();
  await notes.nth(1).click({ modifiers: ['Shift'] });
  await notes.nth(2).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: '選択ノートをクオンタイズ', exact: true }).click();
  for (const [index, { pitch }] of KEY_PITCHES.entries()) {
    await expect(notes.nth(index)).toHaveAttribute(
      'aria-label',
      new RegExp(`^${pitch}。開始 ${index + 1} 拍目、`),
    );
  }

  // Copy the three notes and paste them at the playhead (moved to bar 5 = beat 17).
  const readNotes = async () => (await notes.evaluateAll((list) =>
    list.map((node) => node.getAttribute('aria-label') ?? ''))).map((label) => {
    const match = /^([A-G]#?\d)。開始 ([\d.]+) 拍目、長さ ([\d.]+) 拍、/.exec(label);
    if (!match) throw new Error(`unexpected note label: ${label}`);
    return { pitch: match[1]!, start: Number(match[2]), length: Number(match[3]) };
  });
  const original = await readNotes();
  expect(original.map((note) => note.start)).toEqual([1, 2, 3]);
  await page.getByRole('group', { name: 'クリップボード' }).getByRole('button', { name: 'コピー', exact: true }).click();
  const ruler = page.getByTestId('timeline-ruler');
  const box = await ruler.boundingBox();
  if (!box) throw new Error('timeline ruler has no box');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(page.getByLabel('再生位置')).toHaveText('5.1');
  await page.getByRole('button', { name: '貼り付け', exact: true }).click();
  await expect(notes).toHaveCount(6);
  const pasted = (await readNotes()).slice(3);
  // All three pasted notes: same pitches and lengths, first at the playhead, spacing kept.
  expect(pasted.map((note) => note.pitch)).toEqual(original.map((note) => note.pitch));
  expect(pasted.map((note) => note.length)).toEqual(original.map((note) => note.length));
  expect(pasted.map((note) => note.start)).toEqual([17, 18, 19]);
  // Pasting is one undo step too.
  await undo.click();
  await expect(notes).toHaveCount(3);

  // Step input (P43) at the playhead (beat 17, 1-based): quarter notes G4, A4,
  // then a rest, then Backspace gives the rest's step back, so B4 lands right after A4.
  await page.getByRole('button', { name: /ゆらぎ/ }).click();
  await page.getByRole('combobox', { name: 'ステップ入力の音符の長さ' }).selectOption({ label: '4分音符' });
  await page.getByRole('button', { name: 'ステップ入力を始める', exact: true }).click();
  const stepKey = (midi: number) => page.locator(`.pr__key[data-midi="${midi}"]`);
  const cursor = page.getByTestId('step-cursor');
  const x = async (locator: typeof cursor) => (await locator.boundingBox())!.x;
  const noteByPitch = (pitch: string) => page.locator(`.pr__note[aria-label^="${pitch}。"]`).last();
  await stepKey(67).click();
  await stepKey(69).click();
  await expect(notes).toHaveCount(5);
  const g4 = noteByPitch('G4');
  const a4 = noteByPitch('A4');
  const beatPx = (await x(a4)) - (await x(g4));
  expect(beatPx).toBeGreaterThan(0);
  const a4x = await x(a4);
  // The cursor sits one step after the last note; the helper polls its pixel position.
  const expectCursorAt = async (steps: number) => {
    await expect.poll(async () => Math.abs((await x(cursor)) - (a4x + steps * beatPx)) < 1.5).toBe(true);
  };
  await expectCursorAt(1);
  await page.keyboard.press('Enter');
  await expect(notes).toHaveCount(5);
  await expectCursorAt(2); // the rest moved the cursor one step and added no note
  await page.keyboard.press('Backspace');
  await expect(notes).toHaveCount(5);
  await expectCursorAt(1); // Backspace on the rest only gave the step back
  await stepKey(71).click();
  await expect(notes).toHaveCount(6);
  await expectCursorAt(2);
  const stepLabels = (await notes.evaluateAll((list) => list.map((node) => node.getAttribute('aria-label') ?? '')))
    .filter((label) => /^[GAB]4。/.test(label));
  expect(stepLabels).toHaveLength(3);
  expect(stepLabels[0]).toMatch(/^G4。開始 17 拍目、長さ 1 拍、/);
  expect(stepLabels[1]).toMatch(/^A4。開始 18 拍目、長さ 1 拍、/);
  expect(stepLabels[2]).toMatch(/^B4。開始 19 拍目、長さ 1 拍、/);
  // Backspace removes the last entered note and steps back.
  await page.keyboard.press('Backspace');
  await expect(notes).toHaveCount(5);
  await expectCursorAt(1);

  expect(pageErrors).toEqual([]);
});
