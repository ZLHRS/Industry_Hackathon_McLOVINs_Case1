import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

for (const role of ["executor", "master", "manager", "admin"] as const) {
  test(`${role}: only necessary navigation, data requests and order controls`, async ({ page }, info) => {
    const requests: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByLabel("Логин", { exact: true }).fill(state[`${role}_login`]);
    await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Мобильная навигация" });
    await expect(navigation).toBeVisible();
    const labels = {
      executor: ["Моя работа", "Мои результаты"],
      master: ["Наряды", "Загрузка", "Справочники", "Отчёт"],
      manager: ["Наряды", "Загрузка", "Отчёт"],
      admin: ["Сотрудники", "Справочники"],
    };
    const expectNavigationLabels = async (scope: typeof navigation) => {
      const buttons = scope.getByRole("button");
      await expect(buttons).toHaveCount(labels[role].length);
      for (const [index, label] of labels[role].entries()) {
        await expect(buttons.nth(index)).toHaveAccessibleName(label);
      }
    };
    await expectNavigationLabels(navigation);
    if (role === "admin") {
      await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
      await expect(page.locator(".live-bar")).toHaveCount(0);
      expect(requests).not.toContain("/api/v1/work-orders");
      expect(requests).not.toContain("/api/v1/workload");
      expect(requests).not.toContain("/api/v1/analytics/report");
    } else {
      await expect(page.locator(".order-row").first()).toBeVisible();
      if (role === "executor") await expect(page.locator(".history-button")).toHaveCount(0);
      if (role !== "master")
        await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "История", exact: true }).click();
      const row = page.locator(".order-row").filter({ hasText: "Закрыт" }).first();
      await row.locator(".order-hit").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Журнал", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Добавить комментарий", exact: true })).toHaveCount(0);
      if (role === "executor") {
        await expect(dialog.getByRole("region", { name: "Автоматическая проверка" })).toHaveCount(0);
        await expect(dialog.getByText("Предыдущие проверки", { exact: false })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "Отчёт Excel", exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("heading", { name: "Действия исполнителя" })).toHaveCount(0);
        expect(requests).not.toContain("/api/v1/workload");
        expect(requests).not.toContain("/api/v1/catalog/employees");
      } else {
        await expect(dialog.getByRole("button", { name: "Отчёт Excel", exact: true })).toBeVisible();
        await expect(dialog.getByRole("region", { name: "Автоматическая проверка" }).first()).toBeVisible();
      }
      if (role === "manager") {
        await expect(dialog.getByRole("heading", { name: "Управление мастера" })).toHaveCount(0);
        await expect(dialog.getByRole("heading", { name: "Учёт простоя" })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "Добавить комментарий" })).toHaveCount(0);
      }
      await page.screenshot({ path: info.outputPath(`${role}-order-mobile.png`) });
      await page.keyboard.press("Escape");
      await navigation
        .getByRole("button", { name: role === "executor" ? "Мои результаты" : "Отчёт", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: role === "executor" ? "Мой отчёт" : "Отчёты смены", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".metric-grid")).toBeVisible();
      if (role === "executor") {
        await expect(page.getByRole("heading", { name: "ИИ-сводка мастера" })).toHaveCount(0);
        await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveCount(0);
        await expect(page.getByLabel("Бригада", { exact: true })).toHaveCount(0);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${role}-home-mobile.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNavigationLabels(page.getByRole("navigation", { name: "Основная навигация" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${role}-home-desktop.png`) });
    expect(errors).toEqual([]);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
  });
}
