import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
test("pasted username spaces are normalized before Enter validation", async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  const username = page.getByLabel("Логин", { exact: true });
  await username.fill(`  ${state.admin_login}  `);
  await username.press("Enter");
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Мобильная навигация" });
  await expect(navigation.getByRole("button", { name: "Справочники", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Справочники", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Справочные данные" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.locator(".side-nav")).toBeHidden();
  await page.screenshot({ path: info.outputPath("catalog-mobile-360.png") });
});

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

test("master uses server-backed search across filtered pages", async ({ page, request }) => {
  const tokenResponse = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(tokenResponse.status()).toBe(200);
  const title = `Поиск по архиву ${crypto.randomUUID().slice(0, 8)}`;
  const created = await request.post("/api/v1/work-orders", {
    headers: {
      Authorization: `Bearer ${(await tokenResponse.json()).access_token as string}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      work_type: "unplanned",
      priority: "normal",
      description: title,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  await login(page, state.master_login);
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname.endsWith("/api/v1/work-orders") && url.searchParams.get("q") === title;
  });
  await page.getByLabel("Поиск наряда", { exact: true }).fill(title);
  expect((await response).status()).toBe(200);
  await expect(page.getByText(/Найдено:/)).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByLabel("Поиск наряда", { exact: true }).fill("");
  await expect(page.getByText(/В списке:/)).toBeVisible();
});
