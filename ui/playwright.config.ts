import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // The isolated analysis server has one shared store.
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: 'http://127.0.0.1:14042',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --dir .. build && pnpm build && node ../scripts/start-e2e-server.mjs',
    url: 'http://127.0.0.1:14042/api/requests',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    timeout: 120000,
  },
})
