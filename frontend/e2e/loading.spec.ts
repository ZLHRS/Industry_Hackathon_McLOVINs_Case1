import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve("../tmp/e2e-server.json"), "utf8"));
async function login(page: Page, admin = false) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(admin ? state.admin_login : state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const orderList = /\/api\/v1\/work-orders\?/;

for (const width of [390, 768, 1440]) {
  test(`orders wait for data without flashing empty states at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const initial = gate();
    await page.route(orderList, async (route) => {
      await initial.promise;
      await route.continue();
    });
    await login(page);
    const skeleton = page.locator(".orders-workspace .loading-skeleton");
    await expect(skeleton).toBeVisible();
    await expect(page.locator(".orders-empty")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`orders-loading-${width}.png`) });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await skeleton
        .locator(".loading-skeleton-block")
        .first()
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
    initial.release();
    await expect(page.locator(".order-row").first()).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    await page.unroute(orderList);
    const filtered = gate();
    await page.route(orderList, async (route) => {
      await filtered.promise;
      await route.fulfill({
        json: { items: [], total: 0, counts: {}, attention_count: 0, limit: 50, offset: 0 },
      });
    });
    await page.getByRole("searchbox", { name: "Поиск наряда" }).fill("нет-такого-наряда");
    await expect(skeleton).toBeVisible();
    await expect(page.locator(".orders-empty")).toHaveCount(0);
    filtered.release();
    await expect(page.getByRole("heading", { name: "По выбранным условиям нарядов нет" })).toBeVisible();
    await expect(skeleton).toHaveCount(0);
  });
}

test("notifications filter and order detail have loading states, with real empty and error outcomes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await login(page);
  await expect(page.locator(".order-row").first()).toBeVisible();
  const notifications = /\/api\/v1\/notifications\?/;
  let held = gate();
  let fail = false;
  await page.route(notifications, async (route) => {
    await held.promise;
    await route.fulfill(
      fail
        ? { status: 503, json: { detail: "unavailable" } }
        : { json: { items: [], total: 0, unread_count: 0 } },
    );
  });
  await page.getByRole("button", { name: /Уведомления: непрочитанных/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".loading-skeleton")).toBeVisible();
  await expect(dialog.getByText("Уведомлений нет.", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("inbox-loading-mobile.png") });
  held.release();
  await expect(dialog.getByText("Уведомлений нет.", { exact: true })).toBeVisible();
  held = gate();
  await dialog.getByLabel("Только непрочитанные", { exact: true }).check();
  await expect(dialog.locator(".loading-skeleton")).toBeVisible();
  await expect(dialog.getByText("Уведомлений нет.", { exact: true })).toHaveCount(0);
  fail = true;
  held.release();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.locator(".loading-skeleton")).toHaveCount(0);
  held = gate();
  fail = false;
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.locator(".loading-skeleton")).toBeVisible();
  held.release();
  await expect(dialog.getByText("Уведомлений нет.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const detail = gate();
  await page.route(/\/api\/v1\/work-orders\/[^/?]+$/, async (route) => {
    await detail.promise;
    await route.continue();
  });
  await page.locator(".order-hit").first().click();
  await expect(dialog.locator(".loading-skeleton--detail")).toBeVisible();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("detail-loading-mobile.png") });
  detail.release();
  await expect(dialog.locator(".order-detail")).toBeVisible();
  await expect(dialog.locator(".loading-skeleton")).toHaveCount(0);
});

test("catalog and employees loading avoid fake totals; loaded staff stay visible on refresh", async ({
  page,
}, info) => {
  const catalog = gate();
  await page.route(/\/api\/v1\/catalog$/, async (route) => {
    await catalog.promise;
    await route.continue();
  });
  await login(page, true);
  await expect(page.locator(".loading-skeleton")).toBeVisible();
  catalog.release();
  await expect(page.locator(".employee-row").first()).toBeVisible();
  const staff = gate();
  await page.route(/\/api\/v1\/employees$/, async (route) => {
    await staff.promise;
    await route.continue();
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Обновляем…", exact: true })).toBeDisabled();
  await expect(page.locator(".employee-row").first()).toBeVisible();
  await expect(page.locator(".loading-skeleton")).toHaveCount(0);
  staff.release();
  await expect(page.getByRole("button", { name: "Обновить", exact: true })).toBeEnabled();
  const fresh = gate();
  await page.route(/\/api\/v1\/catalog$/, async (route) => {
    await fresh.promise;
    await route.continue();
  });
  await page.goto("/reference");
  await expect(page.locator(".loading-skeleton--cards")).toBeVisible();
  await page.screenshot({ path: info.outputPath("catalog-loading-desktop.png") });
  fresh.release();
  await expect(page.locator(".loading-skeleton")).toHaveCount(0);
});

test("analytics skeleton ends on error and retry; refresh keeps report visible", async ({ page }, info) => {
  await login(page);
  await expect(page.locator(".order-row").first()).toBeVisible();
  let held = gate();
  let fail = true;
  await page.route(/\/api\/v1\/analytics\/report\?/, async (route: Route) => {
    await held.promise;
    if (fail) await route.fulfill({ status: 503, json: { detail: "unavailable" } });
    else await route.continue();
  });
  await page.goto("/analytics");
  await expect(page.locator(".loading-skeleton--report")).toBeVisible();
  await page.screenshot({ path: info.outputPath("analytics-loading-desktop.png") });
  held.release();
  await expect(page.getByRole("alert")).toContainText("Не удалось сформировать отчёт");
  await expect(page.locator(".loading-skeleton")).toHaveCount(0);
  held = gate();
  fail = false;
  await page.getByRole("button", { name: "Обновить отчёт", exact: true }).click();
  await expect(page.locator(".loading-skeleton--report")).toBeVisible();
  held.release();
  await expect(page.locator(".metric-grid")).toBeVisible();
  held = gate();
  await page.getByRole("button", { name: "Обновить отчёт", exact: true }).click();
  await expect(page.getByRole("button", { name: "Считаем…", exact: true })).toBeDisabled();
  await expect(page.locator(".metric-grid")).toBeVisible();
  await expect(page.locator(".loading-skeleton")).toHaveCount(0);
  held.release();
  await expect(page.getByRole("button", { name: "Обновить отчёт", exact: true })).toBeEnabled();
});
