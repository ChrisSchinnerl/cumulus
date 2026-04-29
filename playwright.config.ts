import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'bun run preview --port 4173',
    port: 4173,
    reuseExistingServer: false,
  },
  use: {
    baseURL: 'http://localhost:4173',
  },
})
