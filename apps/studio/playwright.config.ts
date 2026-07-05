import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = 43173;
const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: E2E_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${E2E_PORT}`,
    url: E2E_URL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
