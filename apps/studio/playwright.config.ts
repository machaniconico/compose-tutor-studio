import { defineConfig, devices } from '@playwright/test';

const configuredPort = Number(process.env.PLAYWRIGHT_PORT);
const port =
  Number.isSafeInteger(configuredPort) && configuredPort >= 1_024 && configuredPort <= 65_535
    ? configuredPort
    : 30_000 + (process.pid % 30_000);
// Playwright evaluates config in worker processes too. Persist generated values
// into the inherited environment so every worker targets the same web server.
process.env.PLAYWRIGHT_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;
const configuredRunId = process.env.PLAYWRIGHT_RUN_ID?.trim();
const normalizedRunId = configuredRunId
  ?.replace(/[^a-zA-Z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);
const runId = process.env.CI ? 'ci' : (normalizedRunId || String(process.pid));
process.env.PLAYWRIGHT_RUN_ID = runId;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  testIgnore: '**/fatal-boundary.e2e.ts',
  outputDir: `test-results/${runId}`,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [
    [process.env.CI ? 'line' : 'list'],
    ['html', { open: 'never', outputFolder: `playwright-report/${runId}` }],
  ],
  use: {
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command:
      `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1_000 },
  },
});
