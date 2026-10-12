import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
const marker = crypto.randomUUID().slice(0, 8);
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Idempotency-Key": crypto.randomUUID(),
});
let master: string;
let reporter: string;
let masterId: string;
let repairerId: string;

async function authenticate(request: APIRequestContext, login: string) {
  const response = await request.post("/api/v1/auth/login", { data: { login, secret: state.secret } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
async function login(page: Page, account: string, path = "/orders") {
  await page.goto(path);
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
}
async function report(request: APIRequestContext, id: string, token = reporter) {
  const response = await request.get(`/api/v1/fault-reports/${id}`, { headers: headers(token) });
  expect(response.status()).toBe(200);
  return response.json();
}
async function create(request: APIRequestContext, description: string) {
  const response = await request.post("/api/v1/fault-reports", {
    headers: headers(reporter),
    data: { equipment_id: state.equipment_id, master_id: masterId, description },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function fillReport(page: Page, description: string) {
  await page.getByTestId("fault-report-equipment").selectOption(state.equipment_id);
  await page.getByTestId("fault-report-description").fill(description);
  await expect(page.getByTestId("fault-report-master").locator(`option[value="${masterId}"]`)).toHaveCount(1);
  const masterSelect = page.getByTestId("fault-report-master");
  if (await masterSelect.isDisabled()) await expect(masterSelect).toHaveValue(masterId);
  else await masterSelect.selectOption(masterId);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test.beforeAll(async ({ request }) => {
  master = await authenticate(request, state.master_login);
  reporter = await authenticate(request, state.executor_login);
  const admin = await authenticate(request, state.admin_login);
  const me = await (await request.get("/api/v1/auth/me", { headers: headers(master) })).json();
  masterId = me.id;
  const created = await request.post("/api/v1/catalog/employees", {
    headers: headers(admin),
    data: {
      login: `fault.repairer.${marker}`,
      display_name: "Михаил Сергеев",
      role: "executor",
      specialty: "mechanic",
      grade: 6,
      area_ids: [state.area_id],
      secret: state.secret,
    },
  });
  expect(created.status()).toBe(201);
  repairerId = (await created.json()).id;
});

for (const width of [390, 1440]) {
  test(`worker message becomes one confirmed master order without granting repair access (${width}px)`, async ({
    page,
    browser,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, state.executor_login);
    await page.getByRole("button", { name: "Сообщить о поломке", exact: true }).click();
    const description = `Течь масла у привода после остановки ${marker}-${width}`;
    await fillReport(page, description);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`worker-report-${width}.png`) });
    const sent = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/fault-reports") && r.request().method() === "POST",
    );
    await page.getByTestId("fault-report-submit").click();
    const response = await sent;
    expect(response.status()).toBe(201);
    const fault = await response.json();
    expect(fault.status).toBe("open");
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width, height: 900 },
      locale: "ru-RU",
    });
    const supervisor = await context.newPage();
    try {
      const inbox = await request.get("/api/v1/notifications?limit=100", { headers: headers(master) });
      const notice = (await inbox.json()).items.find(
        (item: { fault_report_id?: string }) => item.fault_report_id === fault.id,
      );
      expect(notice).toBeTruthy();
      await login(supervisor, state.master_login, `/orders?notification=${notice.id}`);
      const row = supervisor.getByTestId(`fault-report-row-${fault.id}`);
      await expect(row).toContainText(description);
      await supervisor.screenshot({ path: info.outputPath(`master-report-${width}.png`) });
      await row.getByTestId(`fault-report-prepare-${fault.id}`).click();
      let form = supervisor.getByRole("dialog");
      await expect(form.getByLabel("Описание", { exact: true })).toHaveValue(description);
      await supervisor.keyboard.press("Escape");
      expect((await report(request, fault.id)).status).toBe("open");
      await supervisor.getByRole("button", { name: /^Сообщения о поломках/ }).click();
      await supervisor.getByTestId(`fault-report-prepare-${fault.id}`).click();
      form = supervisor.getByRole("dialog");
      await form.getByText("Дополнительные параметры", { exact: true }).click();
      await expect(form.getByRole("combobox", { name: "Оборудование", exact: true })).toHaveValue(
        state.equipment_id,
      );
      await expect(form.getByRole("combobox", { name: "Участок", exact: true })).toHaveValue(state.area_id);
      await form.getByRole("combobox", { name: "Исполнитель", exact: true }).selectOption(repairerId);
      await form.getByTestId("quick-deadline-2h").click();
      await noOverflow(supervisor);
      await supervisor.screenshot({ path: info.outputPath(`master-prefilled-${width}.png`) });
      const issued = supervisor.waitForResponse(
        (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
      );
      await form.getByTestId("quick-submit-order").click();
      const orderResponse = await issued;
      expect(orderResponse.status()).toBe(201);
      const orderId = (await orderResponse.json()).order_id;
      const saved = await report(request, fault.id);
      expect(saved.status).toBe("converted");
      expect(saved.work_order_number).toBeTruthy();
      await expect(page.getByTestId(`fault-report-row-${fault.id}`)).toContainText(saved.work_order_number);
      expect(saved).not.toHaveProperty("work_order_id");
      expect(
        (await request.get(`/api/v1/work-orders/${orderId}`, { headers: headers(reporter) })).status(),
      ).toBe(404);
      const replies = await request.get("/api/v1/notifications?limit=100", { headers: headers(reporter) });
      const reply = (await replies.json()).items.find(
        (item: { fault_report_id?: string }) => item.fault_report_id === fault.id,
      );
      expect(reply).toBeTruthy();
      await page.goto(`/orders?notification=${reply.id}`);
      await expect(page.getByTestId(`fault-report-row-${fault.id}`)).toContainText(saved.work_order_number);
      await expect(
        page.getByRole("dialog").getByRole("button", { name: "Открыть наряд", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`reporter-result-${width}.png`) });
      const current = await (
        await request.get(`/api/v1/work-orders/${orderId}`, { headers: headers(master) })
      ).json();
      expect(
        (
          await request.post(`/api/v1/work-orders/${orderId}/actions`, {
            headers: headers(master),
            data: {
              action: "cancel",
              expected_version: current.version,
              reason: "Проверка сценария завершена",
            },
          })
        ).status(),
      ).toBe(200);
    } finally {
      await context.close();
    }
  });
}

test("master dismissal explains the result and leaves repair counts unchanged", async ({
  page,
  request,
}, info) => {
  const fault = await create(request, `Повторное сообщение о приводе ${marker}`);
  const before = await (
    await request.get("/api/v1/work-orders?limit=1", { headers: headers(master) })
  ).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, state.master_login);
  await page.getByRole("button", { name: /^Сообщения о поломках/ }).click();
  await page.getByTestId(`fault-report-dismiss-${fault.id}`).click();
  const reportRow = page.getByTestId(`fault-report-row-${fault.id}`);
  const confirm = reportRow.getByTestId("fault-report-dismiss-confirm");
  await expect(confirm).toBeDisabled();
  await reportRow
    .getByTestId("fault-report-dismiss-reason")
    .fill("Повторное обращение: ремонт уже назначен в текущей смене.");
  await confirm.click();
  await expect.poll(async () => (await report(request, fault.id)).status).toBe("dismissed");
  const saved = await report(request, fault.id);
  expect(saved.dismissal_reason).toContain("ремонт уже назначен");
  const after = await (await request.get("/api/v1/work-orders?limit=1", { headers: headers(master) })).json();
  expect(after.total).toBe(before.total);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("dismissed-mobile.png") });
});

test("a lost send response can retry the same message without duplication", async ({ page, request }) => {
  await login(page, state.executor_login);
  await page.getByRole("button", { name: "Сообщить о поломке", exact: true }).click();
  const description = `Нестабильная работа привода ${marker}`;
  await fillReport(page, description);
  let intercepted = false;
  const keys: string[] = [];
  await page.route("**/api/v1/fault-reports", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (!intercepted) {
      intercepted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.getByTestId("fault-report-submit").click();
  await expect(page.getByTestId("fault-report-submit")).toBeEnabled();
  await expect(page.getByTestId("fault-report-description")).toHaveValue(description);
  const retry = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/fault-reports") && r.request().method() === "POST",
  );
  await page.getByTestId("fault-report-submit").click();
  expect((await retry).status()).toBe(201);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const all = await (
    await request.get("/api/v1/fault-reports?status=all&limit=100", { headers: headers(reporter) })
  ).json();
  expect(all.items.filter((item: { description: string }) => item.description === description)).toHaveLength(
    1,
  );
});

test("QR preselects equipment; manager and administrator have no reporting controls", async ({
  page,
  request,
}, info) => {
  await login(page, state.executor_login, `/equipment/${state.equipment_id}`);
  await page.getByRole("button", { name: "Сообщить о поломке", exact: true }).click();
  await expect(page.getByTestId("fault-report-equipment")).toHaveValue(state.equipment_id);
  await expect(page.getByTestId("fault-report-description")).toHaveValue("");
  await page.screenshot({ path: info.outputPath("qr-prefilled-report.png") });
  for (const account of [state.manager_login, state.admin_login]) {
    const context = await page.context().browser()!.newContext({ baseURL: info.project.use.baseURL });
    const other = await context.newPage();
    try {
      await login(other, account);
      await expect(other.getByRole("button", { name: "Сообщить о поломке", exact: true })).toHaveCount(0);
      await expect(other.getByRole("button", { name: /^Сообщения о поломках/ })).toHaveCount(0);
      const token = await authenticate(request, account);
      expect((await request.get("/api/v1/fault-reports", { headers: headers(token) })).status()).toBe(403);
    } finally {
      await context.close();
    }
  }
});

test("master lookup failure can retry and offline sending preserves the description", async ({ page }) => {
  await login(page, state.executor_login);
  let fail = true;
  await page.route("**/api/v1/fault-reports/masters?*", async (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "temporarily_unavailable" }),
      });
    return route.continue();
  });
  await page.getByRole("button", { name: "Сообщить о поломке", exact: true }).click();
  await page.getByTestId("fault-report-equipment").selectOption(state.equipment_id);
  const description = "Слышен посторонний шум в приводе";
  await page.getByTestId("fault-report-description").fill(description);
  await expect(page.getByTestId("fault-report-submit")).toBeDisabled();
  fail = false;
  await page.getByRole("dialog").getByRole("button", { name: "Повторить", exact: true }).click();
  const masterSelect = page.getByTestId("fault-report-master");
  await expect(masterSelect.locator(`option[value="${masterId}"]`)).toHaveCount(1);
  if (await masterSelect.isDisabled()) await expect(masterSelect).toHaveValue(masterId);
  else await masterSelect.selectOption(masterId);
  await page.context().setOffline(true);
  await page.getByTestId("fault-report-submit").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Нет соединения");
  await expect(page.getByTestId("fault-report-description")).toHaveValue(description);
  await page.context().setOffline(false);
});
