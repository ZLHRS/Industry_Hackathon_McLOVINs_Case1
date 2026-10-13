import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
const title = `Проверить крепление защитного кожуха ${crypto.randomUUID().slice(0, 6)}`;
const description = `${title}. Выполнить осмотр креплений и контрольный пуск после остановки оборудования. ${"ДлиннаяМаркировка".repeat(8)}. Результат записать в отчёте.`;
const orders: Array<{ id: string; number: string }> = [];
let master: string;
const headers = () => ({ Authorization: `Bearer ${master}`, "Idempotency-Key": crypto.randomUUID() });
async function login(page: Page, role: string) {
  await page.goto("/orders");
  await page.getByLabel("Логин", { exact: true }).fill(state[`${role}_login`]);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
}
async function cancel(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/v1/work-orders/${id}`, { headers: headers() });
  const order = await response.json();
  expect(
    (
      await request.post(`/api/v1/work-orders/${id}/actions`, {
        headers: headers(),
        data: { action: "cancel", expected_version: order.version, reason: "Завершение проверки названий" },
      })
    ).status(),
  ).toBe(200);
}
test.beforeAll(async ({ request }) => {
  const auth = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(auth.status()).toBe(200);
  master = (await auth.json()).access_token;
  for (let index = 0; index < 2; index++) {
    const response = await request.post("/api/v1/work-orders", {
      headers: headers(),
      data: {
        work_type: "planned",
        description,
        priority: "normal",
        area_id: state.area_id,
        equipment_id: state.equipment_id,
        executor_id: state.selected_executor_id,
        deadline: new Date(Date.now() + 7200000).toISOString(),
      },
    });
    expect(response.status()).toBe(201);
    const id = (await response.json()).order_id;
    const detail = await request.get(`/api/v1/work-orders/${id}`, { headers: headers() });
    orders.push({ id, number: (await detail.json()).number });
  }
});
test.afterAll(async ({ request }) => {
  for (const order of orders) await cancel(request, order.id);
});
for (const width of [390, 1440]) {
  for (const role of ["master", "executor"]) {
    test(`descriptions lead while duplicate titles remain distinct for ${role} at ${width}px`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await login(page, role);
      const card = page.locator(".order-row").filter({ hasText: orders[0].number });
      await expect(card.locator(".order-reference-title")).toContainText(title);
      await expect(card.locator(".order-reference-number")).toContainText(orders[0].number);
      await expect(page.locator(".order-row").filter({ hasText: orders[1].number })).toContainText(title);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`order-titles-${role}-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await card.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator(".dialog-head h2")).toContainText(title);
      await expect(dialog.locator(".dialog-head small")).toContainText(orders[0].number);
      await expect(dialog).toContainText(description);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`order-detail-${role}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await page.locator(".order-row").filter({ hasText: orders[1].number }).click();
      await expect(page.getByRole("dialog").locator(".dialog-head small")).toContainText(orders[1].number);
      expect(errors).toEqual([]);
    });
  }
}
