import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectCompleteTabRelationships(
  page: Page,
  tablist: Locator,
): Promise<void> {
  const tabs = tablist.getByRole('tab');
  const count = await tabs.count();
  expect(count).toBeGreaterThan(1);

  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index);
    const tabId = await tab.getAttribute('id');
    const panelId = await tab.getAttribute('aria-controls');
    expect(tabId).toBeTruthy();
    expect(panelId).toBeTruthy();
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', tabId!);
  }
}

test('editor, inspector, and project tabs keep focus and ARIA targets in sync', async ({
  page,
}) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }

  const editorTabs = page.getByRole('tablist', { name: 'エディタ切替' });
  await expectCompleteTabRelationships(page, editorTabs);
  const pianoRollTab = editorTabs.getByRole('tab', { name: 'ピアノロール' });
  const drumTab = editorTabs.getByRole('tab', { name: 'ドラム' });
  await pianoRollTab.focus();
  await pianoRollTab.press('ArrowRight');
  await expect(drumTab).toBeFocused();
  await expect(drumTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#editor-tabpanel-drums')).toBeVisible();
  await expect(page.locator('#editor-tabpanel-pianoRoll')).toBeHidden();
  await drumTab.press('End');
  const automationTab = editorTabs.getByRole('tab', { name: 'オートメーション' });
  await expect(automationTab).toBeFocused();
  await expect(automationTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#editor-tabpanel-automation')).toBeVisible();
  await automationTab.press('Home');
  await expect(pianoRollTab).toBeFocused();
  await expect(pianoRollTab).toHaveAttribute('aria-selected', 'true');
  await pianoRollTab.press('ArrowRight');
  await expect(drumTab).toBeFocused();
  const barSelector = page.getByRole('group', { name: '小節切替', exact: true });
  const firstBar = barSelector.getByRole('button', { name: '1', exact: true });
  const secondBar = barSelector.getByRole('button', { name: '2', exact: true });
  await expect(firstBar).toHaveAttribute('aria-pressed', 'true');
  await expect(secondBar).toHaveAttribute('aria-pressed', 'false');
  await secondBar.click();
  await expect(firstBar).toHaveAttribute('aria-pressed', 'false');
  await expect(secondBar).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('grid', { name: /^ドラムステップ、小節 2 \/ / })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^小節 2、キック ステップ 1(?: |$)/ }),
  ).toHaveCount(1);

  const inspectorTabs = page.getByRole('tablist', { name: '右パネル切替' });
  await expectCompleteTabRelationships(page, inspectorTabs);
  const inspectorTab = inspectorTabs.getByRole('tab', { name: 'インスペクター' });
  const assistantTab = inspectorTabs.getByRole('tab', { name: 'アシスタント' });
  await inspectorTab.focus();
  await inspectorTab.press('ArrowRight');
  await expect(assistantTab).toBeFocused();
  await expect(assistantTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#right-tabpanel-assistant')).toBeVisible();
  await expect(page.locator('#right-tabpanel-inspector')).toBeHidden();
  const bassModes = page.getByRole('group', { name: 'ベース生成モード', exact: true });
  const rootOnly = bassModes.getByRole('button', { name: 'ルートのみ', exact: true });
  const octave = bassModes.getByRole('button', { name: 'オクターブ', exact: true });
  await expect(rootOnly).toHaveAttribute('aria-pressed', 'true');
  await expect(octave).toHaveAttribute('aria-pressed', 'false');
  await octave.click();
  await expect(rootOnly).toHaveAttribute('aria-pressed', 'false');
  await expect(octave).toHaveAttribute('aria-pressed', 'true');

  const save = page.locator('.transport-bar__save-button');
  if (await save.isEnabled()) await save.click();
  await expect(page.locator('#project-save-status')).toContainText('保存済み');

  await page.getByRole('button', { name: /プロジェクト/, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'プロジェクト', exact: true });
  const projectTabs = dialog.getByRole('tablist', { name: 'プロジェクト表示切替' });
  await expect(projectTabs).toBeVisible();
  await expectCompleteTabRelationships(page, projectTabs);
  const newTab = projectTabs.getByRole('tab', { name: '新規プロジェクト' });
  const savedTab = projectTabs.getByRole('tab', { name: '保存済み' });
  await newTab.focus();
  await newTab.press('ArrowRight');
  await expect(savedTab).toBeFocused();
  await expect(savedTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#project-menu-tabpanel-saved')).toBeVisible();
  await expect(page.locator('#project-menu-tabpanel-new')).toBeHidden();
  await expect(
    page.locator('#project-menu-tabpanel-saved .saved-item__main[aria-current="true"]'),
  ).toHaveCount(1);
});
