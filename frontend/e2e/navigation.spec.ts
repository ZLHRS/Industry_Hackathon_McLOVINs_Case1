import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const state = JSON.parse(readFileSync(resolve("../tmp/e2e-server.json"), "utf8"));
async function login(page: Page, account: string, path = "/") {
  await page.goto(path);
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Выйти/ })).toBeVisible();
}

test("directory URLs preserve filters across back, forward, reload and page transitions", async ({
  page,
}, info) => {
  await login(page, state.admin_login);
  await expect(page).toHaveURL(/\/employees$/);
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  await expect(page).toHaveURL(/\/reference$/);
  await page.getByRole("button", { name: "Открыть раздел: Оборудование", exact: true }).click();
  const inventory = await page.locator(".reference-row strong").first().innerText();
  await page.getByRole("searchbox", { name: "Поиск по справочнику" }).fill(inventory);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(inventory);
  const filteredUrl = page.url();
  expect(new URL(filteredUrl).searchParams.get("q")).toBe(inventory);
  await page
    .getByRole("navigation", { name: "Основная навигация" })
    .getByRole("button", { name: "Сотрудники", exact: true })
    .click();
  await expect(page).toHaveURL(/\/employees$/);
  await page.goBack();
  await expect(page).toHaveURL(filteredUrl);
  await expect(page.getByRole("searchbox", { name: "Поиск по справочнику" })).toHaveValue(inventory);
  await page.reload();
  await expect(page).toHaveURL(filteredUrl);
  await expect(page.locator(".reference-row")).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/reference$/);
  await expect(page.getByRole("button", { name: "Открыть раздел: Оборудование", exact: true })).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(filteredUrl);
  await expect(page.getByRole("searchbox", { name: "Поиск по справочнику" })).toHaveValue(inventory);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("directory-page-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page
    .getByRole("navigation", { name: "Навигация страницы" })
    .getByRole("button", { name: /Назад/ })
    .click();
  await expect(page).toHaveURL(/\/reference$/);
});

test("direct section links survive login and cannot bypass role navigation", async ({ page }) => {
  await login(page, state.admin_login, "/reference/materials");
  await expect(page).toHaveURL(/\/reference\/materials$/);
  await expect(page.getByRole("heading", { name: "Материалы", exact: true })).toBeVisible();
  await page.goto("/reference/employees");
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await login(page, state.executor_login, "/employees");
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toHaveCount(0);
});

test("order card has a direct URL and back closes it while forward and reload restore it", async ({
  page,
}) => {
  await login(page, state.master_login);
  await page.locator(".order-hit").first().click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = page.url();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(orderUrl);
  await page.reload();
  await expect(page.getByRole("dialog").locator(".facts")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
});

test("a cached directory deep link reloads offline without caching private API responses", async ({
  page,
  context,
}) => {
  await login(page, state.master_login, "/reference/equipment");
  await expect(page.locator(".reference-row").first()).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Оборудование", exact: true })).toBeVisible();
  await expect(page.locator(".reference-row").first()).toBeVisible();
  const cachedUrls = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => request.url),
        ),
      )
    ).flat(),
  );
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith("/api"))).toBe(false);
  await context.setOffline(false);
});
