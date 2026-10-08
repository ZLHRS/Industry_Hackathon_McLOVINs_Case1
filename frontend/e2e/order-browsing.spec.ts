import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
const marker = `Навигация ${crypto.randomUUID().slice(0, 8)}`;
let masterId: string;
let otherId: string;
let masterName: string;
let workerName: string;
const titles = [marker + " ранний", marker + " срочный", marker + " новый"];
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Idempotency-Key": crypto.randomUUID(),
});
async function auth(request: APIRequestContext, login: string) {
  const r = await request.post("/api/v1/auth/login", { data: { login, secret: state.secret } });
  expect(r.status()).toBe(200);
  return (await r.json()).access_token as string;
}
async function login(page: Page, role: string, path = "/orders") {
  await page.goto(path);
  await page.getByLabel("Логин", { exact: true }).fill(state[`${role}_login`]);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: role === "executor" ? "Мои наряды" : "Наряды участка", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Выйти/ }).first()).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  const master = await auth(request, state.master_login);
  const me = await (await request.get("/api/v1/auth/me", { headers: headers(master) })).json();
  masterId = me.id;
  masterName = me.display_name;
  const executor = await auth(request, state.executor_login);
  workerName = (await (await request.get("/api/v1/auth/me", { headers: headers(executor) })).json())
    .display_name;
  const admin = await auth(request, state.admin_login);
  const otherLogin = `browse.${crypto.randomUUID().slice(0, 8)}`;
  const created = await request.post("/api/v1/catalog/employees", {
    headers: headers(admin),
    data: {
      login: otherLogin,
      display_name: "Мастер навигации",
      role: "master",
      specialty: "mechanic",
      area_ids: [state.area_id],
      secret: state.secret,
    },
  });
  expect(created.status()).toBe(201);
  otherId = (await created.json()).id;
  const other = await auth(request, otherLogin);
  const create = async (token: string, description: string, priority: string, hours: number) => {
    const r = await request.post("/api/v1/work-orders", {
      headers: headers(token),
      data: {
        work_type: "unplanned",
        description,
        priority,
        area_id: state.area_id,
        equipment_id: state.equipment_id,
        executor_id: state.selected_executor_id,
        deadline: new Date(Date.now() + hours * 3600000).toISOString(),
      },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).order_id as string;
  };
  for (let i = 0; i < 27; i++) {
    const id = await create(master, `${marker} история ${String(i + 1).padStart(2, "0")}`, "normal", 24);
    const r = await request.post(`/api/v1/work-orders/${id}/actions`, {
      headers: headers(master),
      data: {
        action: "cancel",
        expected_version: 1,
        reason: "Проверка постраничной истории",
      },
    });
    expect(r.status()).toBe(200);
  }
  await create(master, titles[0], "planned", 1);
  await create(other, titles[1], "emergency", 8);
  await create(master, titles[2], "normal", 4);
});

for (const role of ["master", "manager", "executor"] as const) {
  test(`${role}: history is a paginated responsive grid`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, role, `/orders?status=history&q=${encodeURIComponent(marker)}`);
    const cards = page.locator(".order-history-grid .order-row");
    await expect(cards).toHaveCount(24);
    await expect(page.locator(".kanban-column")).toHaveCount(0);
    const firstTitles = await cards.locator(".order-main strong").allTextContents();
    const positions = await cards.evaluateAll((nodes) =>
      nodes
        .slice(0, 2)
        .map((node) => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })),
    );
    expect(positions[1].x).toBeGreaterThan(positions[0].x);
    expect(positions[1].y).toBe(positions[0].y);
    const pages = page.getByRole("navigation", { name: "Страницы нарядов", exact: true });
    await pages.getByRole("button", { name: "Страница 2", exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(page).toHaveURL(/offset=24/);
    const lastTitles = await cards.locator(".order-main strong").allTextContents();
    expect(new Set([...firstTitles, ...lastTitles]).size).toBe(27);
    await page.reload();
    await expect(cards).toHaveCount(3);
    await pages.getByRole("button", { name: "Назад", exact: true }).click();
    await expect(cards).toHaveCount(24);
    await page.getByLabel("Сортировка", { exact: true }).selectOption("oldest");
    await expect(page).toHaveURL(/sort=oldest/);
    await expect(cards).toHaveCount(24);
    await expect(cards.first()).toContainText(marker + " история 01");
    if (role === "master") {
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`history-${width}.png`) });
        await cards.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`history-cards-${width}.png`) });
        await pages.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`history-pages-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/orders?status=history&q=${encodeURIComponent(marker)}&offset=99984`);
      await expect(cards).toHaveCount(3);
      await expect(page).toHaveURL(/offset=24/);
    }
    expect(errors).toEqual([]);
  });
}

test("executor sorts the full selection and filters issuers; own name clears conflicting filters", async ({
  page,
}, info) => {
  await login(page, "executor", `/orders?q=${encodeURIComponent(marker)}`);
  const rows = page.locator(".worker-queue .order-main strong");
  await expect(rows).toHaveText([titles[1], titles[2], titles[0]]);
  await page.getByLabel("Сортировка", { exact: true }).selectOption("deadline");
  await expect(rows).toHaveText([titles[0], titles[2], titles[1]]);
  await page.getByLabel("Сортировка", { exact: true }).selectOption("newest");
  await expect(rows).toHaveText([titles[2], titles[1], titles[0]]);
  await page.getByLabel("Мастер", { exact: true }).selectOption(otherId);
  await expect(rows).toHaveText([titles[1]]);
  await page.reload();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue(otherId);
  await expect(page.getByLabel("Сортировка", { exact: true })).toHaveValue("newest");
  await expect(rows).toHaveText([titles[1]]);
  await page.getByRole("button", { name: workerName, exact: true }).filter({ visible: true }).click();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Поиск наряда", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "В работе", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Поиск наряда", { exact: true }).fill(marker);
  await expect(rows).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Фильтры/ }).click();
  await expect(page.getByLabel("Мастер", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("executor-filters-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator(".mobile-current-orders").click();
  await expect(page.getByLabel("Поиск наряда", { exact: true })).toHaveValue("");
});

test("master name returns to own active orders from a conflicting history selection", async ({ page }) => {
  await login(
    page,
    "master",
    `/orders?status=history&master_id=${otherId}&executor_id=${state.selected_executor_id}&q=${encodeURIComponent(marker)}`,
  );
  await page.getByRole("button", { name: masterName, exact: true }).filter({ visible: true }).click();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue(masterId);
  await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Поиск наряда", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "В работе", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Поиск наряда", { exact: true }).fill(marker);
  await expect(page.getByText(titles[0], { exact: true })).toBeVisible();
  await expect(page.getByText(titles[2], { exact: true })).toBeVisible();
  await expect(page.getByText(titles[1], { exact: true })).toHaveCount(0);
});
