import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PLAYWRIGHT_CHROME_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH }
          : {}
      }
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: [
    {
      command: 'npm run dev:server',
      url: 'http://127.0.0.1:8080/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: '8080',
        ROOM_RESUME_GRACE_MS: '6000'
      }
    },
    {
      command: 'npm run dev:client',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        VITE_E2E: '1'
      }
    }
  ]
});
