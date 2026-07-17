import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173' },
  webServer: { command: 'pnpm build && pnpm vite preview --host 127.0.0.1', port: 4173, reuseExistingServer: false },
});
