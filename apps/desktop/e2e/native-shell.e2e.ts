import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';

const PROJECT_TITLE = 'Native WebView Smoke';
const NATIVE_RESULTS_DIR = path.resolve('test-results/native');
const E2E_PHASE = process.env.CTS_NATIVE_E2E_PHASE ?? 'write';
const NORMAL_CLOSE_PROJECT_TITLE = process.env.CTS_NATIVE_E2E_NORMAL_CLOSE_TITLE;
const ERASE_CONFIRMATION_PHRASE = 'すべて消去';
const LOCAL_STORAGE_SENTINELS = [
  'cts.native-e2e.erase.local',
  'cts.tutorial.native-e2e',
  'cts.native-recovery.v1.native-e2e.activation',
  'cts.onboarded',
] as const;
const SESSION_STORAGE_SENTINEL = 'cts.native-e2e.erase.session';
const CLOSE_PROOF_PATH = process.env.CTS_NATIVE_E2E_CLOSE_PROOF_PATH;
const CLOSE_PROOF_TOKEN = process.env.CTS_NATIVE_E2E_CLOSE_PROOF_TOKEN;
const NORMAL_CLOSE_REQUEST_PATH = process.env.CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_PATH;
const NORMAL_CLOSE_REQUEST_TOKEN = process.env.CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_TOKEN;
const SIGKILL_BASELINE_TITLE = process.env.CTS_NATIVE_E2E_SIGKILL_BASELINE_TITLE;
const SIGKILL_PENDING_TITLE = process.env.CTS_NATIVE_E2E_SIGKILL_PENDING_TITLE;
const SIGKILL_WRITABLE_TITLE = process.env.CTS_NATIVE_E2E_SIGKILL_WRITABLE_TITLE;

if (
  ![
    'write',
    'restore',
    'normal-close',
    'normal-close-restart',
    'sigkill-restart',
    'sigkill-second-restart',
    'erase',
    'blank-restart',
  ].includes(E2E_PHASE)
) {
  throw new Error(`Unsupported CTS_NATIVE_E2E_PHASE: ${E2E_PHASE}`);
}

async function waitForStudio(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const shell = await $('.app-shell');
      return (await shell.isExisting()) && (await shell.isDisplayed());
    },
    { timeout: 30_000, timeoutMsg: 'Studio shell did not render in the native WebView' },
  );
}

async function waitForEmbeddedDriverShutdown(): Promise<void> {
  const port = Number(process.env.TAURI_WEBDRIVER_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TAURI_WEBDRIVER_PORT is unavailable for close-handoff verification');
  }

  const deadline = Date.now() + 15_000;
  let observedAvailable = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) observedAvailable = true;
    } catch {
      if (observedAvailable) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    observedAvailable
      ? 'Native close handoff did not stop the embedded WebDriver server'
      : 'Embedded WebDriver server was never observable during close verification',
  );
}

async function writeCloseHandoffProof(): Promise<void> {
  if (
    !CLOSE_PROOF_PATH ||
    !path.isAbsolute(CLOSE_PROOF_PATH) ||
    !CLOSE_PROOF_TOKEN ||
    !/^[a-f0-9]{64}$/.test(CLOSE_PROOF_TOKEN)
  ) {
    throw new Error('Fresh close-handoff proof configuration is unavailable');
  }
  const temporaryPath = `${CLOSE_PROOF_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, CLOSE_PROOF_TOKEN, { flag: 'wx' });
  await rename(temporaryPath, CLOSE_PROOF_PATH);
}

function requireNormalCloseProjectTitle(): string {
  if (
    !NORMAL_CLOSE_PROJECT_TITLE ||
    !/^Native Close [a-f0-9]{24}$/.test(NORMAL_CLOSE_PROJECT_TITLE)
  ) {
    throw new Error('Fresh normal-close project title is unavailable');
  }
  return NORMAL_CLOSE_PROJECT_TITLE;
}

function requireSigkillProjectTitles(): {
  baseline: string;
  pending: string;
  writable: string;
} {
  const baselineMatch = SIGKILL_BASELINE_TITLE?.match(
    /^Native SIGKILL Baseline ([a-f0-9]{24})$/,
  );
  const pendingMatch = SIGKILL_PENDING_TITLE?.match(
    /^Native SIGKILL Pending ([a-f0-9]{24})$/,
  );
  const writableMatch = SIGKILL_WRITABLE_TITLE?.match(
    /^Native SIGKILL Writable ([a-f0-9]{24})$/,
  );
  if (
    !baselineMatch ||
    !pendingMatch ||
    !writableMatch ||
    baselineMatch[1] !== pendingMatch[1] ||
    baselineMatch[1] !== writableMatch[1]
  ) {
    throw new Error('Fresh, matching native SIGKILL project titles are unavailable');
  }
  return {
    baseline: baselineMatch[0],
    pending: pendingMatch[0],
    writable: writableMatch[0],
  };
}

async function writeNormalCloseRequest(): Promise<void> {
  if (
    !NORMAL_CLOSE_REQUEST_PATH ||
    !path.isAbsolute(NORMAL_CLOSE_REQUEST_PATH) ||
    !NORMAL_CLOSE_REQUEST_TOKEN ||
    !/^[a-f0-9]{64}$/.test(NORMAL_CLOSE_REQUEST_TOKEN)
  ) {
    throw new Error('Fresh external normal-close request is unavailable');
  }
  const temporaryPath = `${NORMAL_CLOSE_REQUEST_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, NORMAL_CLOSE_REQUEST_TOKEN, { flag: 'wx' });
  await rename(temporaryPath, NORMAL_CLOSE_REQUEST_PATH);
}

describe('Compose Tutor Studio native shell', () => {
  before(async () => {
    await mkdir(NATIVE_RESULTS_DIR, { recursive: true });
    // The embedded provider can target the main webview directly. Marking the
    // window explicit also disables the service's optional IPC-based
    // multi-window focus discovery, which this zero-IPC production shell does
    // not install.
    await browser.tauri.switchWindow('main');
    await waitForStudio();
    if (E2E_PHASE !== 'sigkill-restart') {
      await browser.execute(
        (skipOnboarding) => {
          // The native-test WebView uses a nonpersistent store. Reset the current
          // in-memory fixture as well so multiple specs in one process stay deterministic.
          // The final restart deliberately performs no renderer cleanup itself;
          // that phase is limited to proving the copied SQLite project stays gone.
          if (skipOnboarding) {
            localStorage.clear();
            localStorage.setItem('cts.onboarded', '1');
          }
        },
        E2E_PHASE !== 'blank-restart',
      );
      await browser.refresh();
      await waitForStudio();
    } else {
      // Do not refresh before inspecting crash recovery: pagehide could create a
      // renderer recovery record and turn the hard-kill assertion into a
      // lifecycle-flush assertion. Dismiss onboarding through its normal UI.
      const onboarding = await $('.onboarding-overlay');
      if ((await onboarding.isExisting()) && (await onboarding.isDisplayed())) {
        await (await $('button=あとで')).click();
      }
    }
    if (E2E_PHASE !== 'blank-restart') {
      await browser.waitUntil(async () => !(await (await $('.onboarding-overlay')).isExisting()), {
        timeoutMsg: 'Onboarding overlay did not close for the native smoke fixture',
      });
    }
  });

  if (E2E_PHASE === 'write') it('loads only the bundled app with no global Tauri API exposure', async () => {
    const runtime = await browser.execute(() => ({
      href: location.href,
      readyState: document.readyState,
      hasTauriGlobal: '__TAURI__' in window,
      hasWebLocks: typeof navigator.locks?.request === 'function',
      policy:
        document
          .querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')
          ?.content ?? '',
    }));

    expect(runtime.readyState).toBe('complete');
    expect(runtime.href).toMatch(/^(tauri:\/\/localhost|https:\/\/tauri\.localhost)(?:\/|$)/);
    expect(runtime.hasTauriGlobal).toBe(false);
    expect(runtime.hasWebLocks).toBe(true);
    expect(runtime.policy).toContain('ipc:');
    expect(runtime.policy).toContain('http://ipc.localhost');
    expect(runtime.policy).toContain('https://ipc.localhost');
    expect(runtime.policy).not.toContain('ws://localhost');
    expect(runtime.policy).not.toContain('ws://127.0.0.1');
    await browser.saveScreenshot(path.join(NATIVE_RESULTS_DIR, 'native-shell.png'));
  });

  if (E2E_PHASE === 'write') it('loads deferred feature chunks from the bundled origin', async () => {
    await (await $('button=☰ プロジェクト')).click();
    await browser.waitUntil(
      async () => (await $('input[aria-label="プロジェクト名を変更"]')).isDisplayed(),
      { timeout: 10_000, timeoutMsg: 'Bundled project-menu chunk did not load' },
    );
    await (await $('button[aria-label="閉じる"]')).click();

    await (await $('button=書き出し')).click();
    await browser.waitUntil(async () => (await $('button=MIDIエクスポート')).isDisplayed(), {
      timeout: 10_000,
      timeoutMsg: 'Bundled export-menu chunk did not load',
    });
    await (await $('button[aria-label="閉じる"]')).click();

    await (await $('button=アシスタント')).click();
    await browser.waitUntil(async () => (await $('.assistant')).isDisplayed(), {
      timeout: 10_000,
      timeoutMsg: 'Bundled assistant chunk did not load',
    });
    await (await $('button=チュートリアル')).click();
    await browser.waitUntil(async () => (await $('.tutorial-panel')).isDisplayed(), {
      timeout: 10_000,
      timeoutMsg: 'Bundled tutorial chunk did not load',
    });
  });

  if (E2E_PHASE === 'write') it('plays, stops, and commits through the SQLite repository', async () => {
    const title = await $('input[aria-label="プロジェクト名"]');
    await title.setValue(PROJECT_TITLE);

    await (await $('button=再生')).click();
    await browser.waitUntil(async () => (await $('button=一時停止')).isExisting(), {
      timeoutMsg: 'Transport did not enter the playing state',
    });
    await browser.waitUntil(
      async () => (await (await $('[aria-label="再生位置"]')).getText()) !== '1.1',
      { timeout: 5_000, timeoutMsg: 'Native Web Audio transport did not advance' },
    );
    await (await $('button=一時停止')).click();

    await (await $('button=保存')).click();
    await browser.waitUntil(
      async () => (await (await $('#project-save-status')).getText()).includes('保存済み'),
      { timeout: 10_000, timeoutMsg: 'Project did not reach the saved state' },
    );

    const legacyProjectRecords = await browser.execute(() =>
      Object.keys(localStorage).filter(
        (key) => key.startsWith('cts.project.') || key.startsWith('cts.persistence.v1.'),
      ),
    );
    expect(legacyProjectRecords).toEqual([]);
  });

  if (E2E_PHASE === 'restore') it('restores the committed project after a native process restart', async () => {
    await expect(await $('input[aria-label="プロジェクト名"]')).toHaveValue(PROJECT_TITLE);
  });

  if (E2E_PHASE === 'normal-close') it('flushes the latest edit through an authorized real window close', async () => {
    await expect(await $('input[aria-label="プロジェクト名"]')).toHaveValue(PROJECT_TITLE);
    const latestTitle = requireNormalCloseProjectTitle();
    await (await $('input[aria-label="プロジェクト名"]')).setValue(latestTitle);
    await browser.waitUntil(
      async () => (await (await $('#project-save-status')).getText()).includes('未保存'),
      {
        timeout: 1_000,
        interval: 20,
        timeoutMsg: 'Latest normal-close edit was not observably pending before the close request',
      },
    );

    // WebDriver closeWindow() calls Tauri destroy() directly and would bypass
    // CloseRequested. This fresh external request makes the native-test-only
    // watcher call window.close(), exercising the production authorization path.
    await writeNormalCloseRequest();
    await browser.waitUntil(
      async () => (await (await $('#project-save-status')).getText()).includes('保存済み'),
      {
        timeout: 8_000,
        interval: 20,
        timeoutMsg: 'Normal close did not visibly flush the latest edit before shutdown',
      },
    );
    await waitForEmbeddedDriverShutdown();
    await writeCloseHandoffProof();
  });

  if (E2E_PHASE === 'normal-close-restart') it('reopens SQLite with the edit flushed by normal close', async () => {
    const title = await $('input[aria-label="プロジェクト名"]');
    await expect(title).toHaveValue(requireNormalCloseProjectTitle());

    // A write after restart proves app_finish_close released the repository
    // and that the same SQLite database reopened writable, not just readable.
    await title.setValue(PROJECT_TITLE);
    await (await $('button=保存')).click();
    await browser.waitUntil(
      async () => (await (await $('#project-save-status')).getText()).includes('保存済み'),
      { timeout: 10_000, timeoutMsg: 'Reopened SQLite repository was not writable' },
    );
  });

  if (E2E_PHASE === 'sigkill-restart') {
    it('restores the accepted edit after a real SIGKILL and remains writable', async () => {
      const titles = requireSigkillProjectTitles();
      const title = await $('input[aria-label="プロジェクト名"]');
      await expect(title).toHaveValue(titles.pending);
      await expect(title).not.toHaveValue(titles.baseline);
      await browser.waitUntil(
        async () =>
          (await (await $('#project-save-status')).getText()).includes('保存済み'),
        {
          timeout: 10_000,
          interval: 20,
          timeoutMsg:
            'SIGKILL recovery did not promote the exact accepted edit to a saved state',
        },
      );

      // A fresh commit proves the killed process released its lock and restart
      // recovery left the same SQLite repository writable, not merely readable.
      await title.setValue(titles.writable);
      await (await $('button=保存')).click();
      await browser.waitUntil(
        async () =>
          (await title.getValue()) === titles.writable &&
          (await (await $('#project-save-status')).getText()).includes('保存済み'),
        {
          timeout: 10_000,
          interval: 20,
          timeoutMsg: 'SIGKILL-recovered repository was not writable after restart',
        },
      );
    });
  }

  if (E2E_PHASE === 'sigkill-second-restart') {
    it('keeps the post-recovery commit authoritative on another restart', async () => {
      const titles = requireSigkillProjectTitles();
      const title = await $('input[aria-label="プロジェクト名"]');
      await expect(title).toHaveValue(titles.writable);
      await browser.waitUntil(
        async () =>
          (await (await $('#project-save-status')).getText()).includes('保存済み'),
        {
          timeout: 10_000,
          interval: 20,
          timeoutMsg: 'Post-recovery commit did not survive a second native restart',
        },
      );

      await (await $('button=☰ プロジェクト')).click();
      const savedTab = await $('button=保存済み');
      await savedTab.waitForDisplayed({
        timeout: 10_000,
        timeoutMsg: 'Saved-project tab did not become ready after opening the deferred menu',
      });
      await savedTab.click();
      await browser.waitUntil(
        async () => {
          const savedTitles = await browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>(
                '.saved-list > .saved-item .saved-item__title',
              ),
              (element) => element.innerText,
            ),
          );
          return (
            savedTitles.length === 1 &&
            savedTitles[0] === titles.writable
          );
        },
        {
          timeout: 10_000,
          interval: 20,
          timeoutMsg:
            'SIGKILL recovery left duplicate projects or restored stale content',
        },
      );
      await expect(await $('.saved-item__branches')).not.toExist();
    });
  }

  if (E2E_PHASE === 'erase') it('erases native and current-WebView data through the typed UI confirmation, then closes', async () => {
    await expect(await $('input[aria-label="プロジェクト名"]')).toHaveValue(PROJECT_TITLE);
    await browser.execute(
      (keys) => {
        for (const key of keys.local) localStorage.setItem(key, 'must disappear');
        sessionStorage.setItem(keys.session, 'must disappear');
      },
      { local: LOCAL_STORAGE_SENTINELS, session: SESSION_STORAGE_SENTINEL },
    );

    await (await $('button=☰ プロジェクト')).click();
    const eraseEntry = await $('button=この端末のデータをすべて消去');
    await eraseEntry.waitForDisplayed({ timeout: 10_000 });
    await eraseEntry.click();

    const confirmation = await $('.local-data-erase-dialog__confirmation input');
    await confirmation.waitForDisplayed();
    await confirmation.setValue(ERASE_CONFIRMATION_PHRASE);
    const confirmErase = await $('button=すべて消去して終了');
    await expect(confirmErase).toBeEnabled();
    await confirmErase.click();

    await browser.waitUntil(
      async () => {
        try {
          return await browser.execute(
            (keys) =>
              localStorage.length === 0 &&
              sessionStorage.length === 0 &&
              keys.local.every((key) => localStorage.getItem(key) === null) &&
              sessionStorage.getItem(keys.session) === null,
            { local: LOCAL_STORAGE_SENTINELS, session: SESSION_STORAGE_SENTINEL },
          );
        } catch {
          return false;
        }
      },
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: 'Current WebView local/session storage was not cleared before close',
      },
    );
    const clearedStorage = await browser.execute(
      (keys) => ({
        localLength: localStorage.length,
        sessionLength: sessionStorage.length,
        localSentinels: keys.local.map((key) => localStorage.getItem(key)),
        sessionSentinel: sessionStorage.getItem(keys.session),
      }),
      { local: LOCAL_STORAGE_SENTINELS, session: SESSION_STORAGE_SENTINEL },
    );
    expect(clearedStorage).toEqual({
      localLength: 0,
      sessionLength: 0,
      localSentinels: [null, null, null, null],
      sessionSentinel: null,
    });

    const acceptedClose = await $('.local-data-erase-dialog__progress[role="status"]');
    await browser.waitUntil(
      async () =>
        (await acceptedClose.getText()).includes(
          '終了要求を受け付けました。アプリを終了しています…',
        ),
      {
        timeout: 5_000,
        timeoutMsg: 'UI did not enter the accepted, non-retryable close handoff state',
      },
    );
    await expect(await $('button=消去を再試行')).not.toExist();
    await expect(await $('button=終了を再試行')).not.toExist();

    // The test-only response grace leaves enough time for the storage proof
    // above. The server becoming unreachable proves Rust then owned and
    // completed the actual window-destruction handoff, rather than WDIO merely
    // killing the application during suite cleanup.
    await waitForEmbeddedDriverShutdown();
    // Write a fresh, unpredictable proof only after every UI/storage/close
    // assertion passed. The parent harness can then distinguish WDIO's expected
    // teardown ECONNREFUSED from an earlier test failure without accepting an
    // arbitrary non-zero runner exit.
    await writeCloseHandoffProof();
  });

  if (E2E_PHASE === 'blank-restart') it('does not recreate the erased project after another native restart', async () => {
    const onboarding = await $('.onboarding-overlay');
    if ((await onboarding.isExisting()) && (await onboarding.isDisplayed())) {
      await (await $('button=あとで')).click();
      await browser.waitUntil(async () => !(await (await $('.onboarding-overlay')).isExisting()), {
        timeoutMsg: 'First-launch overlay did not dismiss in the blank restart fixture',
      });
    }

    await expect(await $('input[aria-label="プロジェクト名"]')).not.toHaveValue(PROJECT_TITLE);
    await (await $('button=☰ プロジェクト')).click();
    const savedTab = await $('button=保存済み');
    await savedTab.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'Saved-project tab did not become ready on the blank restart',
    });
    await savedTab.click();
    await expect(await $('.project-menu__empty')).toHaveText(
      '保存済みのプロジェクトはまだありません。',
    );
    const rendererRecords = await browser.execute(() => ({
      projectKeys: Object.keys(localStorage).filter(
        (key) => key.startsWith('cts.project.') || key.startsWith('cts.persistence.v1.'),
      ),
      sessionKeys: Object.keys(sessionStorage),
    }));
    expect(rendererRecords).toEqual({ projectKeys: [], sessionKeys: [] });
  });
});
