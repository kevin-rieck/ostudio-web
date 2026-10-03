import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "on-first-retry",
  },
  workers: 1,
  timeout: 90_000,
  webServer: {
    command: "npm run build && npm run start --workspace @ostudio/server",
    env: {
      OSTUDIO_INSECURE_DEV: "true",
      OSTUDIO_ADMIN_PASSWORD: "correct horse battery staple",
      OSTUDIO_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
    },
    url: "http://127.0.0.1:8080/health/live",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
