import { defineConfig, devices } from '@playwright/test';

const configuredPort = Number(process.env.PLAYWRIGHT_FATAL_PORT);
const port =
  Number.isSafeInteger(configuredPort) && configuredPort >= 1_024 && configuredPort <= 65_535
    ? configuredPort
    : 20_000 + (process.pid % 9_000);
process.env.PLAYWRIGHT_FATAL_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;
const runId = process.env.CI
  ? 'ci'
  : (process.env.PLAYWRIGHT_FATAL_RUN_ID?.trim() || String(process.pid));
process.env.PLAYWRIGHT_FATAL_RUN_ID = runId;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/fatal-boundary.e2e.ts',
  outputDir: `test-results/fatal-boundary-${runId}`,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [[process.env.CI ? 'line' : 'list']],
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
      name: 'chromium-fatal-boundary',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command:
      `pnpm exec vite preview --outDir test-results/e2e-build --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/e2e/fixtures/fatal-boundary.html`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1_000 },
  },
});
