import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workload, OrderPage } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Выйти/ })).toBeVisible();
}

test("overdue board partitions real API orders without duplicates and history stays a grid", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = page.waitForResponse(
    (r) => r.url().includes("/api/v1/work-orders?") && r.request().method() === "GET",
  );
  await login(page);
  const orders: OrderPage = await (await response).json();
  const activeOverdue = orders.items.filter(
    (order) => order.overdue && !["closed", "cancelled"].includes(order.status),
  );
  expect(activeOverdue.length).toBeGreaterThan(0);
  const board = page.getByLabel("Доска нарядов", { exact: true });
  const overdue = board.locator(".kanban-column-overdue");
  await expect(overdue.getByRole("heading", { name: /Просроченные/ })).toBeVisible();
  await expect(overdue.locator(".order-row")).toHaveCount(activeOverdue.length);
  await expect(board.locator(".order-row")).toHaveCount(orders.items.length);
  for (const order of activeOverdue) {
    await expect(overdue.locator(".order-number").filter({ hasText: order.number })).toHaveCount(1);
    await expect(board.locator(".order-number").filter({ hasText: order.number })).toHaveCount(1);
  }
  await overdue.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("overdue-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await overdue.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("overdue-390.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.getByLabel("История нарядов", { exact: true })).toBeVisible();
  await expect(page.locator(".kanban-column-overdue")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("busy current number appears in both assignment controls and availability colors match the case", async ({
  page,
}, info) => {
  const response = page.waitForResponse((r) => r.url().endsWith("/api/v1/workload"));
  await login(page);
  const people: Workload[] = await (await response).json();
  const busy = people.find(
    (person) =>
      person.availability === "busy" &&
      person.current_order_number &&
      person.area_ids.includes(state.area_id),
  );
  expect(busy).toBeTruthy();
  if (!busy) throw new Error("Isolated fixture needs an accessible busy executor");
  // Only recommendation ordering is controlled here. Workload, scoped order number,
  // catalog, authentication and rendered form use the real isolated API.
  await page.route("**/api/v1/work-orders/suggestions", (route) =>
    route.fulfill({
      json: {
        faults: [],
        selected_norm_minutes: null,
        required_specialty: null,
        notes: [],
        executors: [{ ...busy, reasons: [], score: 0 }],
      },
    }),
  );
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId(`quick-equipment-${state.equipment_id}`).click();
  await dialog.getByLabel("Описание", { exact: true }).fill("Проверить крепление привода");
  const candidate = dialog.getByTestId(`quick-executor-${busy.employee_id}`);
  await expect(candidate).toContainText(busy.current_order_number!);
  await expect(candidate).toContainText("текущий наряд:");
  await candidate.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("busy-number-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await candidate.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("busy-number-390.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await dialog.getByText("Дополнительные параметры", { exact: true }).click();
  await expect(
    dialog
      .getByRole("combobox", { name: "Исполнитель", exact: true })
      .locator(`option[value="${busy.employee_id}"]`),
  ).toContainText(busy.current_order_number!);
  await page.keyboard.press("Escape");
  await page.goto("/workload");
  await expect(page.getByRole("heading", { name: "Загрузка исполнителей" })).toBeVisible();
  const colors = {
    free: "rgb(35, 134, 70)",
    busy: "rgb(197, 138, 16)",
    queued: "rgb(29, 108, 145)",
    off_shift: "rgb(133, 138, 139)",
  };
  // Some fixtures have no off-shift employee: apply each class to an existing dot
  // solely to verify the browser's final CSS cascade, then restore it.
  const computed = await page
    .locator(".availability")
    .first()
    .evaluate((element) => {
      const original = element.className;
      const result: Record<string, string> = {};
      for (const status of ["free", "busy", "queued", "off_shift"]) {
        element.className = `availability ${status}`;
        result[status] = getComputedStyle(element).backgroundColor;
      }
      element.className = original;
      return result;
    });
  expect(computed).toEqual(colors);
  await page.screenshot({ path: info.outputPath("workload-390.png") });
});
