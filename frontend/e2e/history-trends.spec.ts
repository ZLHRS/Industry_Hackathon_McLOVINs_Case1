import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

for (const width of [390, 1440]) {
  test(`history trends and printable report remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
    await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
    await page.goto("/insights");
    await expect(page.getByRole("heading", { name: "Прогноз отказов", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Поломки по сменам и времени суток", exact: true }),
    ).toBeVisible();
    await page.locator(".history-trends").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`trends-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto("/analytics");
    const exportTrigger = page.getByRole("button", { name: "Экспорт", exact: true });
    await expect(exportTrigger).toBeEnabled();
    await exportTrigger.click();
    await expect(exportTrigger).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: info.outputPath(`export-menu-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(exportTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(exportTrigger).toBeFocused();
    await exportTrigger.click();
    await page.getByRole("heading", { name: /отчёт/i }).click();
    await expect(exportTrigger).toHaveAttribute("aria-expanded", "false");
    await exportTrigger.click();
    const pdf = page.getByRole("button", { name: /PDF/ });
    await expect(pdf).toBeEnabled();
    await page.evaluate(() => {
      window.print = () => {
        document.documentElement.dataset.printCalled = "yes";
      };
    });
    await pdf.click();
    expect(await page.evaluate(() => document.documentElement.dataset.printCalled)).toBe("yes");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".analytics-filters")).toBeHidden();
    await expect(pdf).toBeHidden();
    await expect(page.locator(".topbar")).toBeHidden();
    await expect(page.locator(".side-nav")).toBeHidden();
    await expect(page.locator(".analytics h1")).toBeVisible();
    const widths = await page
      .locator(".analytics .table-row > strong:first-child")
      .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
    expect(widths.every((value) => value >= 100)).toBe(true);
    await page.screenshot({ path: info.outputPath(`print-${width}.png`), fullPage: true });
    const document = await page.pdf({
      path: info.outputPath(`report-${width}.pdf`),
      preferCSSPageSize: true,
    });
    expect(document.length).toBeGreaterThan(1000);
  });
}
