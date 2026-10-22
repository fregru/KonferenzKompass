// Browser tests for the offline app (service worker), in Chromium and Firefox: `bun run e2e`.
// Files end in .e2e.ts so `bun test` leaves them alone.
import { defineConfig, devices } from "@playwright/test";

const PORT = 3999;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  workers: 1, // in parallel, Firefox's service worker gets slow enough to time out (and headless Firefox crashed)
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "bun run e2e/server.ts",
    url: `http://localhost:${PORT}/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
