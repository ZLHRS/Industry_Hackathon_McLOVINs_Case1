import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
for (const width of [390, 1440]) {
  test(`worker board keeps current job names readable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/workload");
    await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
    await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
    await page.goto("/workload");
    await expect(page.locator(".worker-card").first()).toBeVisible();
    const job = page.locator(".worker-current").first();
    await expect(job).toBeVisible();
    await expect(job.locator(".worker-current-title")).not.toHaveText("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`workers-${width}.png`) });
    await job.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}
