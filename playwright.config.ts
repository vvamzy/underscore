import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const venvPython = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const python = process.env.UNDERSCORE_TEST_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python');
const baseURL = 'http://127.0.0.1:8765';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `"${python}" tests/serve.py`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
