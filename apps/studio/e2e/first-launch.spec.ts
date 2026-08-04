import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const LOCAL_NETWORK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function ascii(bytes: Uint8Array, offset: number, length = 4): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

async function expectValidMidiFile(path: string): Promise<void> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  expect(bytes.byteLength).toBeGreaterThan(22);
  expect(ascii(bytes, 0)).toBe('MThd');
  expect(view.getUint32(4, false)).toBe(6);
  expect(view.getUint16(10, false)).toBeGreaterThan(0);
  expect(ascii(bytes, 14)).toBe('MTrk');
}

async function expectValidWavFile(path: string): Promise<void> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  expect(bytes.byteLength).toBeGreaterThan(44);
  expect(ascii(bytes, 0)).toBe('RIFF');
  expect(ascii(bytes, 8)).toBe('WAVE');
  expect(ascii(bytes, 12)).toBe('fmt ');
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBeGreaterThan(0);
  expect(view.getUint32(24, true)).toBeGreaterThan(0);
  expect(ascii(bytes, 36)).toBe('data');
  expect(view.getUint32(4, true) + 8).toBe(bytes.byteLength);
  expect(view.getUint32(40, true)).toBeGreaterThan(0);
}

function isUnexpectedNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
    return !LOCAL_NETWORK_HOSTS.has(url.hostname);
  } catch {
    return true;
  }
}

function collectUnexpectedNetwork(page: Page): string[] {
  const unexpected: string[] = [];

  page.on('request', (request) => {
    const url = request.url();
    if (isUnexpectedNetworkUrl(url)) unexpected.push(`${request.method()} ${url}`);
  });

  page.on('websocket', (webSocket) => {
    const url = webSocket.url();
    if (isUnexpectedNetworkUrl(url)) unexpected.push(`WEBSOCKET ${url}`);
  });

  return unexpected;
}

test('sample song can be heard, saved, and prepared for MIDI export', async ({ page }, testInfo) => {
  await page.goto('/');

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: /サンプルプロジェクトを聴く/ }).click();

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();
  await expect(page.getByLabel('プロジェクト名')).toHaveValue('サンプル曲：はじめてのポップス');

  await expect(page.getByRole('button', { name: '一時停止' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByRole('button', { name: '一時停止' }).click();
  await expect(page.getByRole('button', { name: '再生' })).toBeVisible();

  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(/保存済み/)).toBeVisible();

  await page.getByRole('button', { name: '書き出し' }).click();
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeVisible();

  await page.getByRole('button', { name: 'MIDIエクスポート' }).click();
  await expect(page.getByRole('dialog', { name: '書き出し前チェック（MIDI）' })).toBeVisible();
  await expect(page.getByText('チェックはすべてOKです。このまま書き出せます。')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'MIDIを書き出す' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.mid$/);
  const midiPath = testInfo.outputPath('sample-song.mid');
  await download.saveAs(midiPath);
  await expectValidMidiFile(midiPath);
  await expect(page.getByText('MIDIファイルを書き出しました。')).toBeVisible();
});

test('project can be saved, resumed after reload, exported, and imported', async ({ page }, testInfo) => {
  const projectTitle = 'E2E 往復テスト';
  const temporaryTitle = '読み込み前の一時タイトル';

  await page.goto('/');

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: '新規作成' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByLabel('プロジェクト名').fill(projectTitle);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(/保存済み/)).toBeVisible();

  await page.reload();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: '前回の続き' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();
  await expect(page.getByLabel('プロジェクト名')).toHaveValue(projectTitle);

  await page.getByRole('button', { name: '書き出し' }).click();
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクト書き出し' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('E2E_往復テスト.ctsproj.json');

  const exportedPath = testInfo.outputPath('round-trip.ctsproj.json');
  await download.saveAs(exportedPath);
  const exportedProject = JSON.parse(await readFile(exportedPath, 'utf8')) as { title?: string };
  expect(exportedProject.title).toBe(projectTitle);
  await expect(page.getByText('プロジェクトを書き出しました。')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeHidden();

  await page.getByLabel('プロジェクト名').fill(temporaryTitle);
  await expect(page.getByLabel('プロジェクト名')).toHaveValue(temporaryTitle);

  await page.getByRole('button', { name: '書き出し' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'プロジェクト読み込み' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(exportedPath);

  await expect(page.getByText('プロジェクトを読み込みました。')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeHidden();
  await expect(page.getByLabel('プロジェクト名')).toHaveValue(projectTitle);
});

test('unsafe project titles are exported with safe filenames without changing the title', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: '新規作成' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByLabel('プロジェクト名').fill('CON');
  await expect(page.getByLabel('プロジェクト名')).toHaveValue('CON');

  await page.getByRole('button', { name: '書き出し' }).click();
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeVisible();

  const projectDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクト書き出し' }).click();
  const projectDownload = await projectDownloadPromise;
  expect(projectDownload.suggestedFilename()).toBe('project_CON.ctsproj.json');

  const exportedProjectPath = testInfo.outputPath('reserved-name.ctsproj.json');
  await projectDownload.saveAs(exportedProjectPath);
  const exportedProject = JSON.parse(await readFile(exportedProjectPath, 'utf8')) as {
    title?: string;
  };
  expect(exportedProject.title).toBe('CON');
  await expect(page.getByText('プロジェクトを書き出しました。')).toBeVisible();

  await page.getByRole('button', { name: 'MIDIエクスポート' }).click();
  await expect(page.getByRole('dialog', { name: '書き出し前チェック（MIDI）' })).toBeVisible();

  const midiDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /MIDIを書き出す|このまま書き出す/ }).click();
  const midiDownload = await midiDownloadPromise;
  expect(midiDownload.suggestedFilename()).toBe('project_CON.mid');

  const midiPath = testInfo.outputPath('reserved-name.mid');
  await midiDownload.saveAs(midiPath);
  await expectValidMidiFile(midiPath);
  await expect(page.getByText('MIDIファイルを書き出しました。')).toBeVisible();
});

test('invalid project import is rejected without replacing the current project', async ({
  page,
}, testInfo) => {
  const invalidProjectPath = testInfo.outputPath('invalid-project.ctsproj.json');
  await writeFile(invalidProjectPath, '{not a compose tutor project', 'utf8');

  await page.goto('/');

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: '新規作成' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByLabel('プロジェクト名').fill('読み込み拒否テスト');
  await expect(page.getByLabel('プロジェクト名')).toHaveValue('読み込み拒否テスト');

  await page.getByRole('button', { name: '書き出し' }).click();
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'プロジェクト読み込み' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(invalidProjectPath);

  await expect(
    page.getByText('プロジェクトファイルを読み込めませんでした。'),
  ).toBeVisible();
  await expect(page.getByLabel('プロジェクト名')).toHaveValue('読み込み拒否テスト');
  await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeVisible();

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const clipboardTarget = window as typeof window & { __ctsCopiedDiagnostic?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string): Promise<void> => {
          clipboardTarget.__ctsCopiedDiagnostic = text;
        },
      },
    });
  });
  await page.getByRole('button', { name: 'サポート' }).click();
  const supportDialog = page.getByRole('dialog', { name: 'サポート' });
  await expect(supportDialog).toBeVisible();

  await supportDialog.getByRole('button', { name: '診断情報をコピー' }).click();
  const copiedReport = await page.evaluate(() => {
    return (window as typeof window & { __ctsCopiedDiagnostic?: string }).__ctsCopiedDiagnostic ?? '';
  });
  expect(copiedReport).toContain('project-import');
  expect(copiedReport).toContain('invalid-json');
});

test('invalid MIDI import is rejected without changing the current project and records diagnostics', async ({
  page,
}, testInfo) => {
  const invalidMidiPath = testInfo.outputPath('invalid-midi.mid');
  await writeFile(invalidMidiPath, 'not a standard midi file', 'utf8');

  await page.goto('/');

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: '新規作成' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByLabel('プロジェクト名').fill('MIDI読み込み拒否テスト');
  await expect(page.getByLabel('プロジェクト名')).toHaveValue('MIDI読み込み拒否テスト');

  await page.getByRole('button', { name: /プロジェクト/ }).click();
  const projectDialog = page.getByRole('dialog', { name: 'プロジェクト' });
  await expect(projectDialog).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'MIDIを読み込む' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(invalidMidiPath);

  await expect(projectDialog.getByText('MIDIファイルの読み込みに失敗しました。')).toBeVisible();
  await expect(projectDialog.getByText(/サポートから診断情報をコピーしてください。/)).toBeVisible();
  await expect(projectDialog.getByLabel('プロジェクト名を変更')).toHaveValue('MIDI読み込み拒否テスト');
  await expect(projectDialog).toBeVisible();

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const clipboardTarget = window as typeof window & { __ctsCopiedDiagnostic?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboardTarget.__ctsCopiedDiagnostic = text;
        },
      },
    });
  });

  await page.getByRole('button', { name: 'サポート' }).click();
  const supportDialog = page.getByRole('dialog', { name: 'サポート' });
  await expect(supportDialog).toBeVisible();
  await supportDialog.getByRole('button', { name: '診断情報をコピー' }).click();
  await expect(supportDialog.getByText('診断情報をコピーしました。')).toBeVisible();

  const copiedReport = await page.evaluate(() => {
    return (window as typeof window & { __ctsCopiedDiagnostic?: string }).__ctsCopiedDiagnostic ?? '';
  });
  expect(copiedReport).toContain('import-midi');
  expect(copiedReport).toContain('message: MIDI');
});

test('support dialog exposes local diagnostics from the workspace', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const clipboardTarget = window as typeof window & { __ctsCopiedDiagnostic?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string): Promise<void> => {
          clipboardTarget.__ctsCopiedDiagnostic = text;
        },
      },
    });
    localStorage.setItem(
      'cts.diagnostics.v1',
      JSON.stringify([
        {
          id: 'diag_e2e_support',
          kind: 'window-error',
          message: 'Failed at C:\\Users\\tester\\song.ctsproj.json',
          stack: 'Error: Failed at C:\\Users\\tester\\song.ctsproj.json',
          componentStack: null,
          occurredAt: '2026-06-23T00:00:00.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_save',
          kind: 'storage-save',
          message:
            'Project save failed. key=cts.project.e2e; payloadBytes=1234; detail=QuotaExceededError',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:01:00.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_export',
          kind: 'export-wav',
          message: 'Write failed at C:\\Users\\tester\\song.wav',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:02:00.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_midi_import',
          kind: 'import-midi',
          message: 'MIDI parser rejected track data',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:02:30.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_project_load',
          kind: 'project-load',
          message: 'Saved project load failed. id=e2eProject',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:02:45.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_audio',
          kind: 'audio-playback',
          message: 'AudioContext resume failed',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:03:00.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_template',
          kind: 'template-load',
          message: 'Template load failed. id=8bar-pop; detail=missing track',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:04:00.000Z',
          userAgent: 'playwright-user-agent',
        },
        {
          id: 'diag_e2e_backup_recovery',
          kind: 'storage-recovery',
          message:
            'Saved project recovered from backup. key=cts.project.e2eRecovered; reason=invalid-json; detail=broken json',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:05:00.000Z',
          userAgent: 'playwright-user-agent',
        },
      ]),
    );
  });

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await page.getByRole('button', { name: '新規作成' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByRole('button', { name: 'サポート' }).click();
  const dialog = page.getByRole('dialog', { name: 'サポート' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('バージョン', { exact: true })).toBeVisible();
  await expect(dialog.getByText('診断ログ', { exact: true })).toBeVisible();
  await expect(dialog.getByText('8 件', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'バックアップから復元した記録' })).toBeVisible();
  await expect(dialog.getByText(/1\s*件の保存データを直前の正常なバックアップから読み込みました。/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '保存に失敗した記録' })).toBeVisible();
  await expect(dialog.getByText(/1\s*件の保存失敗が記録されています。/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '読み込み/書き出しに失敗した記録' })).toBeVisible();
  await expect(dialog.getByText(/2\s*件の読み込み\/書き出し失敗が記録されています。/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '保存済みプロジェクトを開けなかった記録' })).toBeVisible();
  await expect(dialog.getByText(/1\s*件の保存済みプロジェクト読み込み失敗が記録されています。/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '音声の開始に失敗した記録' })).toBeVisible();
  await expect(dialog.getByText(/1\s*件の音声開始失敗が記録されています。/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '作成/起動に失敗した記録' })).toBeVisible();
  await expect(dialog.getByText(/1\s*件の作成\/起動失敗が記録されています。/)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '最近の診断' })).toBeVisible();
  await expect(dialog.getByText('アプリエラー', { exact: true })).toBeVisible();
  await expect(dialog.getByText('保存', { exact: true })).toBeVisible();
  await expect(dialog.getByText('WAV書き出し', { exact: true })).toBeVisible();
  await expect(dialog.getByText('MIDI読み込み', { exact: true })).toBeVisible();
  await expect(dialog.getByText('保存済み読み込み', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('C:\\Users\\tester');

  await dialog.getByRole('button', { name: '診断情報をコピー' }).click();
  await expect(dialog.getByText('診断情報をコピーしました。')).toBeVisible();

  const copiedReport = await page.evaluate(() => {
    return (window as typeof window & { __ctsCopiedDiagnostic?: string }).__ctsCopiedDiagnostic ?? '';
  });
  expect(copiedReport).toContain('Compose Tutor Studio diagnostics');
  expect(copiedReport).toContain('version: 0.1.0');
  expect(copiedReport).toContain('user agent: playwright-user-agent');
  expect(copiedReport).toContain('id: diag_e2e_support');
  expect(copiedReport).toContain('id: diag_e2e_save');
  expect(copiedReport).toContain('id: diag_e2e_export');
  expect(copiedReport).toContain('id: diag_e2e_midi_import');
  expect(copiedReport).toContain('id: diag_e2e_project_load');
  expect(copiedReport).toContain('id: diag_e2e_audio');
  expect(copiedReport).toContain('id: diag_e2e_template');
  expect(copiedReport).toContain('id: diag_e2e_backup_recovery');
  expect(copiedReport).toContain('storage-save');
  expect(copiedReport).toContain('storage-recovery');
  expect(copiedReport).toContain('export-wav');
  expect(copiedReport).toContain('import-midi');
  expect(copiedReport).toContain('project-load');
  expect(copiedReport).toContain('audio-playback');
  expect(copiedReport).toContain('template-load');
  expect(copiedReport).toContain('[local-path]');
  expect(copiedReport).not.toContain('C:\\Users\\tester');

  await dialog.getByRole('button', { name: '診断ログを消去' }).click();
  await expect(dialog.getByText('診断ログを消去しました。')).toBeVisible();
  await expect(dialog.locator('.support-menu__summary dd').nth(1)).toHaveText('0 件');
  await expect(dialog.getByRole('heading', { name: 'バックアップから復元した記録' })).toBeHidden();
  await expect(dialog.getByRole('heading', { name: '最近の診断' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: '診断ログを消去' })).toBeDisabled();
});

test('support dialog shows a manual diagnostic report when clipboard copy fails', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (): Promise<void> => {
          throw new Error('NotAllowedError');
        },
      },
    });
    localStorage.setItem(
      'cts.diagnostics.v1',
      JSON.stringify([
        {
          id: 'diag_e2e_clipboard_denied',
          kind: 'window-error',
          message: 'Failed at C:\\Users\\tester\\blocked.ctsproj.json',
          stack: null,
          componentStack: null,
          occurredAt: '2026-06-23T00:02:00.000Z',
          userAgent: 'playwright-user-agent',
        },
      ]),
    );
  });

  await page.getByRole('button', { name: '新規作成' }).click();
  await page.getByRole('button', { name: 'はじめる' }).click();

  await page.getByRole('button', { name: 'サポート' }).click();
  const dialog = page.getByRole('dialog', { name: 'サポート' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: '診断情報をコピー' }).click();
  await expect(dialog.getByText('クリップボードへコピーできませんでした。')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '手動コピー用診断情報' })).toBeVisible();

  const manualReport = dialog.getByRole('textbox', { name: '手動コピー用診断情報' });
  await expect(manualReport).toBeVisible();
  await expect(manualReport).toHaveValue(/id: diag_e2e_clipboard_denied/);
  await expect(manualReport).toHaveValue(/\[local-path\]/);
  await expect(manualReport).not.toHaveValue(/C:\\Users\\tester/);
});

test('unrecoverable saved projects are surfaced and removable from support', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      `cts.project.C:\\Users\\tester\\e2eBroken.ctsproj.json
      ${'x'.repeat(180)}`,
      '{ this is not valid project json',
    );
  });

  await page.goto('/');

  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();
  await expect(page.getByText('一部の保存プロジェクトを復元できませんでした。')).toBeVisible();

  await page.getByRole('button', { name: '新規作成' }).click();
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

  await page.getByRole('button', { name: 'サポート' }).click();
  const dialog = page.getByRole('dialog', { name: 'サポート' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '復元できない保存データ' })).toBeVisible();
  await expect(dialog.getByText(/cts\.project\.\[local-path\].*\.\.\./)).toBeVisible();
  await expect(dialog).not.toContainText('C:\\Users\\tester');
  await expect(dialog.getByText('JSONが壊れています')).toBeVisible();

  page.once('dialog', async (confirmDialog) => {
    expect(confirmDialog.message()).toContain('復元できない保存データを削除します');
    await confirmDialog.accept();
  });
  await dialog.getByRole('button', { name: '復元できない保存データを削除' }).click();
  await expect(dialog.getByText('復元できない保存データを削除しました。')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '復元できない保存データ' })).toBeHidden();

  const remaining = await page.evaluate(() =>
    localStorage.getItem(
      `cts.project.C:\\Users\\tester\\e2eBroken.ctsproj.json
      ${'x'.repeat(180)}`,
    ),
  );
  expect(remaining).toBeNull();
});

test('offline core workflow does not make external network requests', async ({ page }, testInfo) => {
  const unexpectedNetwork = collectUnexpectedNetwork(page);

  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeVisible();

  await page.context().setOffline(true);

  try {
    await page.getByRole('button', { name: '新規作成' }).click();
    await expect(page.getByRole('dialog', { name: 'スタート画面' })).toBeHidden();

    await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeVisible();
    await page.getByRole('button', { name: 'はじめる' }).click();
    await expect(page.getByRole('dialog', { name: 'ようこそ' })).toBeHidden();

    await page.getByLabel('プロジェクト名').fill('オフラインE2E');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(/保存済み/)).toBeVisible();

    await page.getByRole('button', { name: 'サポート' }).click();
    const supportDialog = page.getByRole('dialog', { name: 'サポート' });
    await expect(supportDialog).toBeVisible();
    await expect(supportDialog.getByText('診断ログ', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(supportDialog).toBeHidden();

    await page.getByRole('button', { name: '書き出し' }).click();
    await expect(page.getByRole('dialog', { name: '書き出し / 読み込み' })).toBeVisible();

    const projectDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'プロジェクト書き出し' }).click();
    const projectDownload = await projectDownloadPromise;
    expect(projectDownload.suggestedFilename()).toBe('オフラインE2E.ctsproj.json');
    await expect(page.getByText('プロジェクトを書き出しました。')).toBeVisible();

    await page.getByRole('button', { name: 'MIDIエクスポート' }).click();
    await expect(page.getByRole('dialog', { name: '書き出し前チェック（MIDI）' })).toBeVisible();
    const midiDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /MIDIを書き出す|このまま書き出す/ }).click();
    const midiDownload = await midiDownloadPromise;
    expect(midiDownload.suggestedFilename()).toBe('オフラインE2E.mid');
    const midiPath = testInfo.outputPath('offline-core.mid');
    await midiDownload.saveAs(midiPath);
    await expectValidMidiFile(midiPath);
    await expect(page.getByText('MIDIファイルを書き出しました。')).toBeVisible();

    await page.getByRole('button', { name: 'WAVエクスポート' }).click();
    await expect(page.getByRole('dialog', { name: '書き出し前チェック（WAV）' })).toBeVisible();
    const wavDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /WAVを書き出す|このまま書き出す/ }).click();
    const wavDownload = await wavDownloadPromise;
    expect(wavDownload.suggestedFilename()).toBe('オフラインE2E.wav');
    const wavPath = testInfo.outputPath('offline-core.wav');
    await wavDownload.saveAs(wavPath);
    await expectValidWavFile(wavPath);
    await expect(page.getByText('WAVファイルを書き出しました。')).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }

  expect(unexpectedNetwork).toEqual([]);
});
