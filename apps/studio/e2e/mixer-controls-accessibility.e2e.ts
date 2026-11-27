import { expect, test } from '@playwright/test';

test('mute and solo controls expose their track and action names', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  const trackList = page.getByRole('navigation', { name: 'トラック一覧', exact: true });
  await expect(trackList.getByRole('button', { name: 'Chords ミュート', exact: true }))
    .toHaveCount(1);
  await expect(trackList.getByRole('button', { name: 'Chords ソロ', exact: true }))
    .toHaveCount(1);
  const bassTrack = trackList.getByRole('button', {
    name: 'Bass トラックを選択',
    exact: true,
  });
  await bassTrack.click();
  await expect(bassTrack).toHaveAttribute('aria-pressed', 'true');
  await expect(
    trackList.getByRole('button', { name: 'Chords トラックを選択', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');

  await expect(page.getByRole('main')).toHaveCount(1);
  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  const mute = mixer.getByRole('button', { name: 'Chords ミュート', exact: true });
  const solo = mixer.getByRole('button', { name: 'Chords ソロ', exact: true });
  await expect(mute).toHaveCount(1);
  await expect(solo).toHaveCount(1);

  await mute.focus();
  await mute.press('Space');
  await expect(mute).toBeFocused();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect(
    trackList.getByRole('button', { name: 'Chords ミュート', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(pageErrors).toEqual([]);
});

test('repeated effects expose stable unique names for every editor control', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  const addEffect = mixer.getByRole('combobox', {
    name: 'Chords エフェクト追加',
    exact: true,
  });
  await addEffect.selectOption('filter');
  const first = mixer.getByRole('group', { name: 'Chords フィルター 1', exact: true });
  await expect(first).toBeVisible();

  await addEffect.selectOption('filter');
  const second = mixer.getByRole('group', { name: 'Chords フィルター 2', exact: true });
  await expect(second).toBeVisible();
  await expect(
    first.getByRole('slider', { name: 'Chords フィルター 1 明るさ', exact: true }),
  ).toHaveCount(1);
  await expect(
    second.getByRole('slider', { name: 'Chords フィルター 2 明るさ', exact: true }),
  ).toHaveCount(1);

  await second
    .getByRole('button', { name: 'Chords フィルター 2を削除', exact: true })
    .press('Enter');
  await expect(second).toHaveCount(0);
  await expect(first).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('TrackList and Mixer volume/pan controls share accessible gesture descriptions', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  const trackList = page.getByRole('navigation', { name: 'トラック一覧' });
  const mixer = page.getByRole('region', { name: 'ミキサー' });
  const controls = [
    trackList.getByRole('slider', { name: 'Chords 音量', exact: true }),
    trackList.getByRole('slider', { name: 'Chords パン', exact: true }),
    mixer.getByRole('slider', { name: 'Chords 音量', exact: true }),
    mixer.getByRole('slider', { name: 'Chords パン', exact: true }),
  ];

  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const description = await control.evaluate((element) => {
      const id = element.getAttribute('aria-describedby');
      return id ? document.getElementById(id)?.textContent ?? '' : '';
    });
    expect(description).toContain('Chords');
    expect(description).toContain('トラックID');
    expect(description).toContain('Touch、Latch、Write');
  }

  const trackVolume = controls[0]!;
  const mixerVolume = controls[2]!;
  const initialValue = Number(await mixerVolume.inputValue());
  await trackVolume.focus();
  await trackVolume.press('ArrowUp');
  await expect(mixerVolume).toHaveValue(String(initialValue + 0.01));

  const trackPan = controls[1]!;
  const mixerPan = controls[3]!;
  await trackPan.focus();
  await trackPan.press('ArrowRight');
  await expect(mixerPan).toHaveValue('0.01');
});

test('commits a native fader drag on window blur and accepts the next keyboard edit', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  const fader = mixer.getByRole('slider', { name: 'Chords 音量', exact: true });
  const mirroredFader = page.getByRole('navigation', { name: 'トラック一覧' })
    .getByRole('slider', { name: 'Chords 音量', exact: true });
  const initial = await fader.inputValue();
  await fader.scrollIntoViewIfNeeded();
  const box = await fader.boundingBox();
  if (box === null) throw new Error('Expected a visible volume fader');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, y, { steps: 5 });
  await expect(mirroredFader).not.toHaveValue(initial);
  const dragged = await mirroredFader.inputValue();

  // End the browser session while the native drag is still active.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await fader.focus();
  await fader.press('ArrowRight');
  await expect(mirroredFader).toHaveValue(String(Math.round((Number(dragged) + 0.01) * 100) / 100));
  await page.mouse.up();

  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  await undo.click();
  await expect(mirroredFader).toHaveValue(dragged);
  await undo.click();
  await expect(mirroredFader).toHaveValue(initial);
});
