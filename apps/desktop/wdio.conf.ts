import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { browser } from '@wdio/globals';
import type { WdioTauriConfig } from '@wdio/native-types';

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const executable =
  process.platform === 'win32'
    ? 'compose-tutor-studio-desktop.exe'
    : 'compose-tutor-studio-desktop';
const appBinaryPath = path.join(
  desktopDir,
  'src-tauri',
  'target',
  'native-test',
  'release',
  executable,
);

export const config: WdioTauriConfig = {
  runner: 'local',
  specs: ['./e2e/**/*.e2e.ts'],
  outputDir: path.join(desktopDir, 'test-results', 'native'),
  maxInstances: 1,
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath,
        driverProvider: 'embedded',
        startTimeout: 60_000,
        statusPollTimeout: 5_000,
        captureBackendLogs: false,
        captureFrontendLogs: false,
      },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: appBinaryPath,
      },
    },
  ],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },
  afterTest: async (_test, _context, { passed }) => {
    if (passed) return;
    const resultsDir = path.join(desktopDir, 'test-results', 'native');
    try {
      await mkdir(resultsDir, { recursive: true });
      await browser.saveScreenshot(path.join(resultsDir, `failure-${Date.now()}.png`));
    } catch (error) {
      console.warn('Could not capture the native failure screenshot:', error);
    }
  },
};
