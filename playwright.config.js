// playwright.config.js
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './scripts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  timeout: 1200000,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'reports/test-results.json' }],
    ['list'],
    ['junit', { outputFile: 'reports/junit.xml' }]
  ],
  use: {
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
});

const CONFIG = {
  winscp: {
    // ... existing config
  },
  putty: {
    // ... existing config
  },
  batch: {
    // ... existing config
  },
  // POSTGRESQL DATABASE CONFIG
  database: {
    host: process.env.DB_HOST || '192.168.99.89',
    port: process.env.DB_PORT || '5432',  // PostgreSQL default port
    database: process.env.DB_NAME || 'your_database',
    username: process.env.DB_USERNAME || 'your_username',
    password: process.env.DB_PASSWORD || 'your_password',
    schema: process.env.DB_SCHEMA || 'public',  // PostgreSQL schema
  }
};