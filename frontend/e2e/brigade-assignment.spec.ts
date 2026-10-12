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
let brigadeId: string;
let participants: string[];
const accounts: { id: string; login: string; token: string }[] = [];
test.use({ hasTouch: true });

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

async function order(request: APIRequestContext, id: string, token = master) {
  const response = await request.get(`/api/v1/work-orders/${id}`, { headers: headers(token) });
  expect(response.status()).toBe(200);
  return response.json();
}

async function action(request: APIRequestContext, id: string, body: Record<string, unknown>, token = master) {
  const current = await order(request, id, token);
  return request.post(`/api/v1/work-orders/${id}/actions`, {
    headers: headers(token),
    data: { expected_version: current.version, ...body },
  });
}

async function create(request: APIRequestContext, title: string) {
  const response = await request.post("/api/v1/work-orders", {
    headers: headers(master),
    data: {
      work_type: "planned",
      priority: "normal",
      description: title,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: accounts[0].id,
      brigade_id: brigadeId,
      participant_ids: participants,
      deadline: new Date(Date.now() + 7200000).toISOString(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).order_id as string;
}

test.beforeAll(async ({ request }) => {
  master = await authenticate(request, state.master_login);
  const admin = await authenticate(request, state.admin_login);
  const me = await (await request.get("/api/v1/auth/me", { headers: headers(master) })).json();
  const brigade = await request.post("/api/v1/catalog/brigades", {
    headers: headers(admin),
    data: { code: `000-${9999999999999 - Date.now()}-${marker}`, name: "Бригада обслуживания привода" },
  });
  expect(brigade.status()).toBe(201);
  brigadeId = (await brigade.json()).id;
  for (let index = 0; index < 3; index++) {
    const account = `team.${marker}.${index}`;
    const response = await request.post("/api/v1/catalog/employees", {
      headers: headers(admin),
      data: {
        login: account,
        display_name: ["Алексей Петров", "Сергей Иванов", "Андрей Орлов"][index],
        role: "executor",
        specialty: "mechanic",
        grade: 6 - index,
        brigade_id: index < 2 ? brigadeId : null,
        area_ids: me.area_ids,
        secret: state.secret,
      },
    });
    expect(response.status()).toBe(201);
    accounts.push({
      id: (await response.json()).id,
      login: account,
      token: await authenticate(request, account),
    });
  }
  participants = accounts.slice(0, 2).map((account) => account.id);
});

for (const width of [390, 1440]) {
  test(`brigade issuance uses six interface taps at ${width}px`, async ({ page, request }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await login(page, state.master_login);
    await page.evaluate(() => {
      document.documentElement.dataset.issueTaps = "0";
      document.addEventListener("click", () => {
        document.documentElement.dataset.issueTaps = String(
          Number(document.documentElement.dataset.issueTaps) + 1,
        );
      });
    });
    const started = Date.now();
    await page.getByRole("button", { name: "Выдать наряд", exact: true }).tap();
    const dialog = page.getByRole("dialog");
    await dialog.locator('[data-testid^="quick-equipment-"]').first().tap();
    await dialog.getByLabel("Описание", { exact: true }).tap();
    await page.keyboard.insertText(`Проверить привод и затяжку креплений ${marker}`);
    const choice = dialog.getByTestId(`quick-brigade-${brigadeId}`);
    await expect(choice).toContainText("Бригада обслуживания привода");
    await expect(choice).toContainText("Алексей Петров");
    await choice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`brigade-choice-${width}.png`) });
    await choice.tap();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.locator('[data-testid^="quick-executor-"][aria-pressed="true"]')).toHaveCount(0);
    await dialog.getByTestId("quick-deadline-2h").tap();
    await page.screenshot({ path: info.outputPath(`brigade-ready-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const issued = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/work-orders") && response.request().method() === "POST",
    );
    await dialog.getByTestId("quick-submit-order").tap();
    const response = await issued;
    expect(response.status()).toBe(201);
    const taps = await page.evaluate(() => Number(document.documentElement.dataset.issueTaps));
    const elapsedMs = Date.now() - started;
    expect(taps).toBe(6);
    expect(elapsedMs).toBeLessThan(60000);
    const id = (await response.json()).order_id;
    const saved = await order(request, id);
    expect(saved.brigade.id).toBe(brigadeId);
    expect(saved.participants.map((person: { employee_id: string }) => person.employee_id).sort()).toEqual(
      [...participants].sort(),
    );
    expect(
      saved.participants.filter((person: { role: string }) => person.role === "responsible"),
    ).toHaveLength(1);
    await expect(dialog).toBeHidden();
    await info.attach("issuance-count.json", {
      body: JSON.stringify({
        taps,
        automationElapsedMs: elapsedMs,
        physicalPhoneMeasured: false,
        excludes: ["login", "text keystrokes", "keyboard dismissal", "scroll", "optional settings"],
      }),
      contentType: "application/json",
    });
    expect(
      (
        await action(request, id, { action: "cancel", reason: "Завершение проверки быстрой выдачи" })
      ).status(),
    ).toBe(200);
  });
}

test("shared assignment: participant sees work, responsible submits, master accepts once", async ({
  page,
  browser,
  request,
}, info) => {
  const title = `Совместный осмотр привода ${marker}`;
  const id = await create(request, title);
  await login(page, state.master_login, `/orders/${id}`);
  const masterDialog = page.getByRole("dialog");
  await expect(masterDialog).toContainText("Бригада обслуживания привода");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: info.project.use.baseURL,
  });
  const lead = await context.newPage();
  const peerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: info.project.use.baseURL,
  });
  const peer = await peerContext.newPage();
  try {
    await login(peer, accounts[1].login, `/orders/${id}`);
    const participantDialog = peer.getByRole("dialog");
    await expect(participantDialog).toContainText(title);
    await expect(participantDialog.getByRole("button", { name: "Принять", exact: true })).toHaveCount(0);
    await expect(participantDialog.getByRole("button", { name: "Начать работу", exact: true })).toHaveCount(
      0,
    );
    await expect(participantDialog).toContainText("Алексей Петров");
    expect([403, 404]).toContain(
      (await action(request, id, { action: "accept" }, accounts[1].token)).status(),
    );
    expect(
      (await request.get(`/api/v1/work-orders/${id}`, { headers: headers(accounts[2].token) })).status(),
    ).toBe(404);
    await peer.screenshot({ path: info.outputPath("participant-issued-390.png"), fullPage: true });
    await participantDialog
      .getByLabel("Текст комментария", { exact: true })
      .fill("Готов проверить ограждение вместе с ответственным.");
    const commented = peer.waitForResponse(
      (response) =>
        response.url().endsWith(`/work-orders/${id}/actions`) && response.request().method() === "POST",
    );
    await participantDialog.getByRole("button", { name: "Добавить комментарий", exact: true }).click();
    expect((await commented).status()).toBe(200);
    await login(lead, accounts[0].login, `/orders/${id}`);
    const leadDialog = lead.getByRole("dialog");
    await leadDialog.getByRole("button", { name: "Принять", exact: true }).click();
    await leadDialog.getByRole("button", { name: "Начать работу", exact: true }).click();
    await expect(participantDialog.getByRole("heading", { name: /· В работе$/ })).toBeVisible();
    await leadDialog.getByRole("button", { name: "Заполнить отчёт", exact: true }).click();
    await leadDialog
      .getByLabel("Что выполнено", { exact: true })
      .fill(
        "Вдвоём проверили ограждение, затянули крепления привода и выполнили контрольный пуск. Постороннего шума нет.",
      );
    await leadDialog
      .getByRole("combobox", { name: "Шифр неисправности", exact: true })
      .selectOption(state.fault_code_id);
    await leadDialog.getByRole("combobox", { name: "Материал", exact: true }).selectOption(state.material_id);
    await leadDialog.getByLabel("Количество", { exact: true }).fill("1");
    await lead.screenshot({ path: info.outputPath("responsible-report-390.png"), fullPage: true });
    await leadDialog.getByRole("button", { name: "Сдать наряд", exact: true }).click();
    await expect(masterDialog.getByRole("button", { name: "Закрыть вручную", exact: true })).toBeVisible({
      timeout: 20000,
    });
    await masterDialog
      .getByLabel("Причина решения", { exact: true })
      .fill("Совместный осмотр и контрольный пуск проверены мастером.");
    await masterDialog.getByLabel("Оценка мастера (необязательно)", { exact: true }).fill("4");
    await masterDialog.getByRole("button", { name: "Закрыть вручную", exact: true }).click();
    await expect(masterDialog.getByRole("heading", { name: /· Закрыт$/ })).toBeVisible();
    await expect(participantDialog.getByRole("heading", { name: /· Закрыт$/ })).toBeVisible();
    const saved = await order(request, id);
    expect(saved.materials).toHaveLength(1);
    expect(Number(saved.materials[0].quantity)).toBe(1);
    expect(saved.executor_id).toBe(accounts[0].id);
    expect(saved.participants).toHaveLength(2);
    await peer.screenshot({ path: info.outputPath("participant-closed-390.png"), fullPage: true });
    await page.screenshot({ path: info.outputPath("master-brigade-closed-1440.png"), fullPage: true });
  } finally {
    await context.close();
    await peerContext.close();
  }
});

test("reassignment revokes former participants and preserves the single-worker path", async ({
  request,
  page,
}) => {
  const id = await create(request, `Переназначение бригады ${marker}`);
  const proof = readFileSync(resolve(import.meta.dirname, "fixtures/repair-proof.png"));
  const deniedPhoto = await request.post(`/api/v1/work-orders/${id}/photos?kind=after&expected_version=1`, {
    headers: { ...headers(accounts[1].token), "Content-Type": "image/png" },
    data: proof,
  });
  expect([403, 404]).toContain(deniedPhoto.status());
  const photo = await request.post(`/api/v1/work-orders/${id}/photos?kind=before&expected_version=1`, {
    headers: { ...headers(master), "Content-Type": "image/png" },
    data: proof,
  });
  expect(photo.status()).toBe(201);
  const photoUrl = (await photo.json()).content_url;
  expect((await request.get(photoUrl, { headers: headers(accounts[1].token) })).status()).toBe(200);
  expect(
    (
      await action(request, id, {
        action: "reassign",
        executor_id: accounts[2].id,
        reason: "Работа передана другому исполнителю",
      })
    ).status(),
  ).toBe(200);
  const saved = await order(request, id);
  expect(saved.brigade).toBeNull();
  expect(saved.participants).toHaveLength(1);
  expect(
    (await request.get(`/api/v1/work-orders/${id}`, { headers: headers(accounts[1].token) })).status(),
  ).toBe(404);
  expect((await request.get(photoUrl, { headers: headers(accounts[1].token) })).status()).toBe(404);
  await login(page, accounts[2].login, `/orders/${id}`);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Принять", exact: true })).toBeVisible();
  expect(
    (await action(request, id, { action: "cancel", reason: "Проверка переназначения завершена" })).status(),
  ).toBe(200);
});

test("unavailable brigade options do not block individual issuance", async ({ page, request }) => {
  await login(page, state.master_login);
  await page.route("**/api/v1/work-orders/brigade-options?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "temporarily_unavailable" }),
    }),
  );
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[data-testid^="quick-equipment-"]').first().click();
  await dialog.getByLabel("Описание", { exact: true }).fill("Проверить исправность защитного ограждения");
  await dialog.locator('[data-testid^="quick-executor-"]:not(:disabled)').first().click();
  await dialog.getByTestId("quick-deadline-2h").click();
  const issued = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/work-orders") && response.request().method() === "POST",
  );
  await dialog.getByTestId("quick-submit-order").click();
  const response = await issued;
  expect(response.status()).toBe(201);
  const id = (await response.json()).order_id;
  expect((await order(request, id)).brigade).toBeNull();
  expect(
    (await action(request, id, { action: "cancel", reason: "Завершение проверки резервного пути" })).status(),
  ).toBe(200);
});

test("changed brigade roster requires an explicit new selection", async ({ page, request }) => {
  await login(page, state.master_login);
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[data-testid^="quick-equipment-"]').first().click();
  await dialog.getByLabel("Описание", { exact: true }).fill("Проверить привод после изменения состава смены");
  const choice = dialog.getByTestId(`quick-brigade-${brigadeId}`);
  await choice.click();
  await dialog.getByTestId("quick-deadline-2h").click();
  const admin = await authenticate(request, state.admin_login);
  const me = await (await request.get("/api/v1/auth/me", { headers: headers(master) })).json();
  const employee = await request.post("/api/v1/catalog/employees", {
    headers: headers(admin),
    data: {
      login: `team.${marker}.late`,
      display_name: "Новый участник смены",
      role: "executor",
      specialty: "mechanic",
      grade: 3,
      brigade_id: brigadeId,
      area_ids: me.area_ids,
      secret: state.secret,
    },
  });
  expect(employee.status()).toBe(201);
  const changed = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/work-orders") && response.request().method() === "POST",
  );
  await dialog.getByTestId("quick-submit-order").click();
  expect((await changed).status()).toBe(409);
  await expect(choice).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByLabel("Описание", { exact: true })).toHaveValue(
    "Проверить привод после изменения состава смены",
  );
  await choice.click();
  const issued = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/work-orders") && response.request().method() === "POST",
  );
  await dialog.getByTestId("quick-submit-order").click();
  const response = await issued;
  expect(response.status()).toBe(201);
  const id = (await response.json()).order_id;
  expect((await order(request, id)).participants).toHaveLength(3);
  expect(
    (await action(request, id, { action: "cancel", reason: "Проверка нового состава завершена" })).status(),
  ).toBe(200);
});
