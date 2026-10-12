import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.admin_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
}

for (const width of [1440, 900, 390]) {
  test(`admin forms, equipment filters and QR fit at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(page);
    await page.getByRole("button", { name: "Добавить сотрудника", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("ФИО сотрудника", { exact: true })).toBeVisible();
    const box = (await dialog.boundingBox())!;
    if (width === 1440) expect(box.width).toBeGreaterThanOrEqual(760);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`employee-create-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Добавить сотрудника", exact: true })).toBeFocused();

    await page.goto("/reference/equipment");
    const search = page.getByRole("searchbox", { name: "Поиск по справочнику", exact: true });
    const area = page.getByLabel("Участок оборудования", { exact: true });
    await expect(page.locator(".reference-row").first()).toBeVisible();
    if (width === 1440) {
      const fields = await Promise.all([
        search.boundingBox(),
        area.boundingBox(),
        page.locator(".equipment-controls .directory-tabs").boundingBox(),
      ]);
      const bottoms = fields.map((field) => field!.y + field!.height);
      expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(2);
    }
    await area.selectOption(state.area_id);
    await expect(area).toHaveValue(state.area_id);
    await search.fill("no-such-equipment-layout-check");
    await expect(page.locator(".reference-row")).toHaveCount(0);
    await search.clear();
    await expect(page.locator(".reference-row").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`equipment-filters-${width}.png`) });
    await page.locator(".reference-row").first().getByRole("button", { name: "QR-код", exact: true }).click();
    await expect(page.getByRole("img", { name: "QR-код оборудования", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Скачать QR-код", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/-qr\.svg$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`admin-qr-${width}.png`), fullPage: true });
    if (width === 1440) {
      await page.emulateMedia({ media: "print" });
      await expect(page.getByRole("img", { name: "QR-код оборудования", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Копировать ссылку", exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: "Печать наклейки", exact: true })).toBeHidden();
      await page.screenshot({ path: info.outputPath("admin-qr-print.png"), fullPage: true });
      await page.emulateMedia({ media: "screen" });
    }
    expect(errors).toEqual([]);
  });
}
