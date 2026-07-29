import { expect, test, type Page } from '@playwright/test';

async function openAutomation(page: Page): Promise<void> {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
  await page
    .getByRole('tablist', { name: 'エディタ切替' })
    .getByRole('tab', { name: 'オートメーション' })
    .click();
}

async function saveProject(page: Page): Promise<void> {
  const save = page.locator('.transport-bar__save-button');
  if (await save.isEnabled()) await save.click();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');
}

async function automationPointIds(page: Page): Promise<readonly string[]> {
  return page.locator('[data-automation-point-id]').evaluateAll((points) => (
    points.map((point) => point.getAttribute('data-automation-point-id') ?? '')
  ));
}

test('exposes independent Read gates, modes, and safe Write confirmation', async ({
  page,
}) => {
  await openAutomation(page);
  const panel = page.getByRole('tabpanel', { name: 'オートメーション' });
  const globalRead = panel.getByRole('button', { name: 'Global Read: オン' });
  const trackRead = panel.getByRole('button', { name: 'Track Read: オン' });
  const modes = panel.getByRole('radiogroup', { name: /記録モード$/ });

  await expect(globalRead).toHaveAttribute('aria-pressed', 'true');
  await expect(trackRead).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['Read', 'Touch', 'Latch', 'Write']) {
    await expect(modes.getByRole('radio', { name, exact: true })).toHaveCount(1);
  }
  await expect(panel.getByText('読み取り（Read）')).toBeVisible();

  await panel.getByRole('button', { name: '再生位置に点を追加' }).click();
  const laneBypass = panel.getByRole('button', { name: 'Lane Bypass: オフ' });
  await expect(laneBypass).toHaveAttribute('aria-pressed', 'false');
  await globalRead.click();
  await expect(panel.getByRole('button', { name: 'Global Read: オフ' }))
    .toHaveAttribute('aria-pressed', 'false');
  await expect(laneBypass).toHaveAttribute('aria-pressed', 'false');
  await panel.getByRole('button', { name: 'Global Read: オフ' }).click();

  await modes.getByRole('radio', { name: 'Touch', exact: true }).click();
  await expect(panel.getByText('待機中（Armed）')).toBeVisible();

  const write = modes.getByRole('radio', { name: 'Write', exact: true });
  await write.focus();
  await write.press('Enter');
  const confirmation = page.getByRole('dialog', {
    name: 'Writeモードを有効にしますか？',
  });
  await expect(confirmation).toContainText(
    '触れなくても再生位置の下にある音量とパンのオートメーションを両方とも置き換えます',
  );
  await expect(confirmation).toContainText('Touchモードへ自動的に戻ります');
  const cancel = confirmation.getByRole('button', { name: 'キャンセル' });
  await cancel.press('Enter');
  await expect(confirmation).toBeHidden();
  await expect(write).toBeFocused();
  await expect(modes.getByRole('radio', { name: 'Touch' }))
    .toHaveAttribute('aria-checked', 'true');

  await write.press('Enter');
  await confirmation
    .getByRole('button', { name: 'Writeを有効にする' })
    .press('Enter');
  await expect(write).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('待機中（Armed）')).toBeVisible();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  const pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pause).toBeVisible();
  await expect(panel.getByText('記録中（Writing）')).toBeVisible();
  await pause.click();
  await expect(modes.getByRole('radio', { name: 'Touch' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect(
    panel.locator('[data-automation-write-status="armed"]'),
  ).toContainText('Touch');
});

test('records one Touch gesture as one undoable pass and persists Read, Bypass, and the curve', async ({
  page,
}) => {
  await openAutomation(page);
  const panel = page.getByRole('tabpanel', { name: 'オートメーション' });
  const touch = panel.getByRole('radio', { name: 'Touch', exact: true });
  await touch.click();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true }))
    .toBeVisible();

  const mixer = page.getByRole('region', { name: 'ミキサー', exact: true });
  const volume = mixer.getByRole('slider', {
    name: 'Chords 音量',
    exact: true,
  });
  await volume.focus();
  await volume.press('ArrowDown');
  await page.waitForTimeout(180);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();

  const points = panel.locator('[data-automation-point-id]');
  await expect.poll(async () => points.count()).toBeGreaterThan(0);
  const recordedIds = await automationPointIds(page);
  expect(recordedIds.every((id) => id.length > 0)).toBe(true);

  const undo = page.getByRole('button', { name: '元に戻す', exact: true });
  const redo = page.getByRole('button', { name: 'やり直す', exact: true });
  await undo.click();
  await expect(points).toHaveCount(0);
  await redo.click();
  await expect.poll(() => automationPointIds(page)).toEqual(recordedIds);

  await panel.getByRole('button', { name: 'Track Read: オン' }).click();
  const bypass = panel.getByRole('button', { name: 'Lane Bypass: オフ' });
  await bypass.click();
  await expect(
    panel.getByRole('button', { name: 'Lane Bypass: オン' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await saveProject(page);

  await page.reload();
  await openAutomation(page);
  const reopened = page.getByRole('tabpanel', { name: 'オートメーション' });
  await expect(
    reopened.getByRole('button', { name: 'Track Read: オフ' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    reopened.getByRole('button', { name: 'Lane Bypass: オン' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => automationPointIds(page)).toEqual(recordedIds);
});

test('keeps 44px focusable controls and internal timeline scroll at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openAutomation(page);
  const panel = page.getByRole('tabpanel', { name: 'オートメーション' });
  const globalRead = panel.getByRole('button', { name: 'Global Read: オン' });
  const trackRead = panel.getByRole('button', { name: 'Track Read: オン' });
  const write = panel.getByRole('radio', { name: 'Write', exact: true });

  for (const control of [globalRead, trackRead, write]) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await control.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(control).toBeFocused();
    const outline = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThan(0);
  }

  const layout = await page.evaluate(() => {
    const global = document.querySelector<HTMLElement>(
      '.automation-lane__read-gates button:first-child',
    );
    const track = document.querySelector<HTMLElement>(
      '.automation-lane__read-gates button:nth-child(2)',
    );
    const timeline = document.querySelector<HTMLElement>(
      '.automation-lane__timeline-scroll',
    );
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      globalTop: global?.getBoundingClientRect().top ?? 0,
      trackTop: track?.getBoundingClientRect().top ?? 0,
      timelineClientWidth: timeline?.clientWidth ?? 0,
      timelineScrollWidth: timeline?.scrollWidth ?? 0,
    };
  });

  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.trackTop).toBeGreaterThan(layout.globalTop);
  expect(layout.timelineScrollWidth).toBeGreaterThan(layout.timelineClientWidth);
});
