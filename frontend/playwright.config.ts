import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results",
  use: {
    baseURL: process.env.NARYADAI_E2E_BASE_URL ?? "http://127.0.0.1:5173",
    browserName: "chromium",
    channel: process.env.NARYADAI_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "off",
  },
});
