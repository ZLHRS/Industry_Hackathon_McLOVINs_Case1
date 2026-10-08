import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
async function auth(request: APIRequestContext, login: string) {
  const response = await request.post("/api/v1/auth/login", { data: { login, secret: state.secret } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Idempotency-Key": crypto.randomUUID(),
});
async function login(page: Page, account: string) {
  await page.goto("/orders");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Наряды участка", exact: true })).toBeVisible();
}

test("master defaults to own orders, work/history stay distinct, worker link shows both masters", async ({
  page,
  request,
}, info) => {
  const admin = await auth(request, state.admin_login);
  const master = await auth(request, state.master_login);
  const who = await request.get("/api/v1/auth/me", { headers: headers(master) });
  const masterId = (await who.json()).id;
  const suffix = crypto.randomUUID().slice(0, 8);
  const otherLogin = `scope.${suffix}`;
  const otherCreated = await request.post("/api/v1/catalog/employees", {
    headers: headers(admin),
    data: {
      login: otherLogin,
      display_name: `Мастер проверки ${suffix}`,
      role: "master",
      specialty: "mechanic",
      area_ids: [state.area_id],
      secret: state.secret,
    },
  });
  expect(otherCreated.status()).toBe(201);
  const otherId = (await otherCreated.json()).id;
  const other = await auth(request, otherLogin);
  const create = async (token: string, description: string) => {
    const result = await request.post("/api/v1/work-orders", {
      headers: headers(token),
      data: {
        work_type: "unplanned",
        description,
        priority: "normal",
        area_id: state.area_id,
        equipment_id: state.equipment_id,
        executor_id: state.selected_executor_id,
        deadline: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    expect(result.status()).toBe(201);
    return (await result.json()).order_id as string;
  };
  const ownTitle = `Свой активный ${suffix}`;
  const otherTitle = `Другой мастер ${suffix}`;
  const archivedTitle = `Отменённый ${suffix}`;
  await create(master, ownTitle);
  await create(other, otherTitle);
  const archivedId = await create(master, archivedTitle);
  const cancelled = await request.post(`/api/v1/work-orders/${archivedId}/actions`, {
    headers: headers(master),
    data: {
      action: "cancel",
      expected_version: 1,
      reason: "Проверка архивного списка",
    },
  });
  expect(cancelled.status()).toBe(200);

  const executor = await auth(request, state.executor_login);
  const rejectedTitle = `Отказ ${suffix}`;
  const rejectedId = await create(master, rejectedTitle);
  const rejected = await request.post(`/api/v1/work-orders/${rejectedId}/actions`, {
    headers: headers(executor),
    data: { action: "reject", expected_version: 1, reason: "Нужен другой допуск" },
  });
  expect(rejected.status()).toBe(200);
  const reworkTitle = `Повторный ремонт ${suffix}`;
  const reworkId = await create(master, reworkTitle);
  const prepareReview = async (id: string) => {
    let version = 1;
    for (const action of ["accept", "start", "complete"]) {
      const payload =
        action === "complete"
          ? {
              completion: {
                work_description: "Проверен узел, выполнена регулировка и проверка работы",
                fault_code_id: state.fault_code_id,
                materials: [],
                no_materials_reason: "Регулировка без замены",
              },
            }
          : {};
      const response = await request.post(`/api/v1/work-orders/${id}/actions`, {
        headers: headers(executor),
        data: { action, expected_version: version, ...payload },
      });
      expect(response.status()).toBe(200);
      version = (await response.json()).version;
    }
    const read = async () =>
      (await request.get(`/api/v1/work-orders/${id}`, { headers: headers(master) })).json();
    await expect.poll(async () => (await read()).status).toBe("ai_review");
    return read();
  };
  const rework = await prepareReview(reworkId);
  const returned = await request.post(`/api/v1/work-orders/${reworkId}/actions`, {
    headers: headers(master),
    data: {
      action: "request_rework",
      expected_version: rework.version,
      reason: "Нужно проверить под нагрузкой",
    },
  });
  expect(returned.status()).toBe(200);
  const closedTitle = `Принятый ремонт ${suffix}`;
  const closedId = await create(master, closedTitle);
  const readyToClose = await prepareReview(closedId);
  const closed = await request.post(`/api/v1/work-orders/${closedId}/actions`, {
    headers: headers(master),
    data: {
      action: "override_close",
      expected_version: readyToClose.version,
      master_score: 4,
      reason: "Результат проверен мастером, оборудование исправно",
    },
  });
  expect(closed.status()).toBe(200);
  await login(page, state.master_login);
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue(masterId);
  await page.getByLabel("Поиск наряда", { exact: true }).fill(suffix);
  await expect(page.getByText(ownTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(otherTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(archivedTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(closedTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Завершено/ })).toHaveCount(0);
  await expect(page.getByText(rejectedTitle, { exact: true })).toBeVisible();
  const reworkColumn = page
    .locator(".kanban-column")
    .filter({ has: page.getByRole("heading", { name: /^Доработка/ }) });
  await expect(reworkColumn.getByText(reworkTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.getByText(archivedTitle, { exact: true })).toBeVisible();
  await expect(
    page
      .locator(".kanban-column")
      .filter({ has: page.getByRole("heading", { name: /^Закрытые/ }) })
      .getByText(closedTitle, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(ownTitle, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "В работе", exact: true }).click();
  await expect(page.getByText(ownTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(archivedTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(closedTitle, { exact: true })).toHaveCount(0);
  await expect(page.locator(".status-tabs button")).toHaveCount(2);
  await page.getByLabel("Мастер", { exact: true }).selectOption(otherId);
  await expect(page.getByText(otherTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(ownTitle, { exact: true })).toHaveCount(0);
  await page.getByLabel("Мастер", { exact: true }).selectOption("");
  await expect(page.getByText(ownTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(otherTitle, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue("");
  await expect(page.getByText(otherTitle, { exact: true })).toBeVisible();

  await page.getByRole("navigation").first().getByRole("button", { name: "Загрузка", exact: true }).click();
  // Resolve the worker name through the existing scoped workload API, not a fixture-specific label.
  const load = await request.get("/api/v1/workload", { headers: headers(master) });
  const workerName = (await load.json()).find(
    (item: { employee_id: string }) => item.employee_id === state.selected_executor_id,
  ).display_name;
  await page.getByRole("button", { name: workerName, exact: true }).click();
  await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveValue(state.selected_executor_id);
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Поиск наряда", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "В работе", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Поиск наряда", { exact: true }).fill(suffix);
  await expect(page.getByText(ownTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(otherTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(archivedTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(closedTitle, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveValue(state.selected_executor_id);
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue("");
  await expect(page.getByText(ownTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(archivedTitle, { exact: true })).toBeVisible();
  await expect(
    page
      .locator(".kanban-column")
      .filter({ has: page.getByRole("heading", { name: /^Закрытые/ }) })
      .getByText(closedTitle, { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "История", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveValue(state.selected_executor_id);
  await expect(page.getByText(closedTitle, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Поиск наряда", { exact: true })).toHaveValue(suffix);
  await expect(page.locator(".order-row")).toHaveCount(2);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`worker-orders-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/reference/employees");
  await page.getByRole("button", { name: workerName, exact: true }).click();
  await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveValue(state.selected_executor_id);
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "В работе", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("manager can filter masters while executor ignores privileged copied filters", async ({
  page,
  request,
}) => {
  const master = await auth(request, state.master_login);
  const masterId = (await (await request.get("/api/v1/auth/me", { headers: headers(master) })).json()).id;
  await login(page, state.manager_login);
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue("");
  await page.getByLabel("Мастер", { exact: true }).selectOption(masterId);
  await page.reload();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue(masterId);
  await page.getByRole("button", { name: /Выйти/ }).click();
  await expect(page.getByLabel("Логин", { exact: true })).toBeVisible();
  await page.goto(`/orders?master_id=${masterId}`);
  const invalidRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/v1/work-orders" && url.searchParams.has("master_id"))
      invalidRequests.push(url.pathname);
    if (url.pathname === "/api/v1/work-orders/masters") invalidRequests.push(url.pathname);
  });
  await page.getByLabel("Логин", { exact: true }).fill(state.executor_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Мои наряды", exact: true })).toBeVisible();
  await expect(page.locator(".order-row").first()).toBeVisible();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveCount(0);
  expect(invalidRequests).toEqual([]);
});

test("offline snapshot never appears under a different master filter", async ({ page, context }) => {
  await login(page, state.master_login);
  const ownId = await page.getByLabel("Мастер", { exact: true }).inputValue();
  await expect(page.locator(".order-row").first()).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByLabel("Мастер", { exact: true }).selectOption("");
  await expect(
    page.getByText(/^Для выбранных фильтров нет сохранённых нарядов\./, { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".order-row")).toHaveCount(0);
  await page.getByLabel("Мастер", { exact: true }).selectOption(ownId);
  await expect(page.locator(".order-row").first()).toBeVisible();
  await page.reload();
  await expect(page.locator(".order-row").first()).toBeVisible();
  await expect(page.getByLabel("Мастер", { exact: true })).toHaveValue(ownId);
  await context.setOffline(false);
});
