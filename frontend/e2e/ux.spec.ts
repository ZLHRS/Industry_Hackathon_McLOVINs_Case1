import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
async function login(page: Page, account: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}
test("worker resets hidden filters without leaving archive and reads next step", async ({ page }, info) => {
  await login(page, state.executor_login);
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  await page.getByRole("button", { name: "Фильтры", exact: true }).click();
  await page.getByLabel("Приоритет", { exact: true }).selectOption("high");
  const toggle = page.getByRole("button", { name: "Фильтры: выбрано 1", exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByLabel("Приоритет", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Сбросить фильтры", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Архив", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Фильтры", exact: true })).toBeVisible();
  await page.locator(".order-row").first().locator(".order-hit").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".order-next-step")).toBeVisible();
  await expect(dialog.locator(".timeline")).toBeHidden();
  await dialog.getByText("Показать историю действий", { exact: true }).click();
  await expect(dialog.locator(".timeline")).toBeVisible();
  await page.screenshot({ path: info.outputPath("worker-detail-mobile.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Активные", exact: true }).click();
  await page.screenshot({ path: info.outputPath("worker-orders-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
test("administrator keeps search visible and can reveal and reset extra filters", async ({ page }, info) => {
  await login(page, state.admin_login);
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
  await expect(page.getByLabel("Поиск", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Роль", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Фильтры", exact: true }).click();
  await page.getByLabel("Роль", { exact: true }).selectOption("executor");
  await page.getByRole("button", { name: "Фильтры · 1", exact: true }).click();
  await page.getByRole("button", { name: "Сбросить поиск и фильтры", exact: true }).click();
  await expect(page.getByRole("button", { name: "Фильтры", exact: true })).toBeVisible();
  await expect(page.getByLabel("Роль", { exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath("admin-mobile.png") });
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.getByLabel("Роль", { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("admin-desktop.png") });
});
