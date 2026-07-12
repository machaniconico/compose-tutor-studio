import { expect, test } from '@playwright/test';

test('a linked MIDI clip loop toggle is instance-local and undoable', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
  await page.getByRole('tab', { name: 'アレンジ', exact: true }).click();

  const sourceClip = page.getByRole('button', { name: /^Chords、クリップ1、/ });
  await sourceClip.click();
  const lengthInput = page.getByLabel('長さ（小節）', { exact: true });
  await lengthInput.fill('1');
  await lengthInput.press('Enter');
  await expect(lengthInput).toHaveValue('1');

  const linkedCopyAction = page.getByRole('button', {
    name: '連動コピーを右へ',
    exact: true,
  });
  await linkedCopyAction.focus();
  await linkedCopyAction.press('Enter');
  const linkedClip = page.getByRole('button', {
    name: /^Chords、クリップ2、.*連動コピー$/,
  });
  await expect(linkedClip).toBeFocused();

  const loopToggle = page.getByRole('checkbox', {
    name: '素材をクリップ末尾まで繰り返す',
    exact: true,
  });
  await expect(loopToggle).not.toBeChecked();
  await loopToggle.focus();
  await loopToggle.press('Space');
  await expect(loopToggle).toBeChecked();
  await expect(loopToggle).toBeFocused();
  await expect(
    page.getByText('このクリップだけ、素材を末尾まで繰り返します。', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(loopToggle).not.toBeChecked();
  await expect(
    page.getByText('このクリップだけ、素材を末尾まで繰り返します。', { exact: true }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(loopToggle).toBeChecked();
  await expect(
    page.getByText('このクリップだけ、素材を末尾まで繰り返します。', { exact: true }),
  ).not.toBeVisible();

  // Loop is placement metadata: the canonical source remains off.
  await sourceClip.click();
  await expect(loopToggle).not.toBeChecked();
  await linkedClip.click();
  await expect(loopToggle).toBeChecked();

  const unlinkAction = page.getByRole('button', { name: '連動を解除', exact: true });
  await unlinkAction.focus();
  await unlinkAction.press('Enter');
  const independentClip = page.getByRole('button', {
    name: /^Chords、クリップ2、(?!.*連動コピー).*$/,
  });
  await expect(independentClip).toBeFocused();
  await expect(
    page.getByText('連動を解除しました。このクリップだけを変えられます。', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(linkedClip).toBeVisible();
  await expect(
    page.getByText('連動を解除しました。このクリップだけを変えられます。', { exact: true }),
  ).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});
