import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = JSON.parse(readFileSync(resolve(project, "tmp/e2e-server.json"), "utf8")) as {
  base_url: string;
  secret: string;
  master_login: string;
  executor_login: string;
  manager_login: string;
  admin_login: string;
  selected_executor_id: string;
  area_id: string;
  equipment_id: string;
  fault_code_id: string;
  material_id: string;
};
const proof = resolve(project, "frontend/e2e/fixtures/repair-proof.png");
const description = () => `Проверка гидросистемы ${crypto.randomUUID().slice(0, 8)}`;
async function login(page: Page, account: string) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Выйти/ })).toBeVisible();
}
async function token(request: APIRequestContext, account: string) {
  const response = await request.post("/api/v1/auth/login", {
    data: { login: account, secret: state.secret },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
async function create(request: APIRequestContext, auth: string, title: string) {
  const response = await request.post("/api/v1/work-orders", {
    headers: { Authorization: `Bearer ${auth}`, "Idempotency-Key": crypto.randomUUID() },
    data: {
      work_type: "unplanned",
      priority: "emergency",
      description: title,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).order_id as string;
}
async function readOrder(request: APIRequestContext, auth: string, id: string) {
  const response = await request.get(`/api/v1/work-orders/${id}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  expect(response.status()).toBe(200);
  return response.json();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("master issue, mobile photo/material completion", async ({ page, browser, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, state.master_login);
  await page.screenshot({ path: info.outputPath("master-desktop.png"), fullPage: true });
  await noOverflow(page);
  const title = description();
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Участок", exact: true }).selectOption(state.area_id);
  await dialog.getByRole("combobox", { name: "Оборудование", exact: true }).selectOption(state.equipment_id);
  await dialog
    .getByRole("combobox", { name: "Исполнитель", exact: true })
    .selectOption(state.selected_executor_id);
  await dialog.getByLabel("Описание", { exact: true }).fill(title);
  await dialog.getByRole("combobox", { name: "Приоритет", exact: true }).selectOption("emergency");
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/work-orders") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const id = (await response.json()).order_id as string;
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("master-created.png"), fullPage: true });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    baseURL: info.project.use.baseURL,
  });
  const worker = await mobile.newPage();
  worker.on("pageerror", (error) => errors.push(error.message));
  try {
    await login(worker, state.executor_login);
    await worker.getByText(title, { exact: true }).click();
    const detail = worker.getByRole("dialog");
    await detail.getByRole("button", { name: "Принять", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Начать работу", exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Начать работу", exact: true }).click();
    await expect(detail.getByText("Сдать работу", { exact: true })).toBeVisible();
    await detail.getByLabel("Причина паузы", { exact: true }).fill("Ожидание проверки давления");
    await detail.getByRole("button", { name: "Поставить на паузу", exact: true }).click();
    await detail.getByRole("button", { name: "Возобновить", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Поставить на паузу", exact: true })).toBeVisible();
    await detail.getByLabel("Фото после", { exact: false }).setInputFiles(proof);
    await expect(detail.locator("img")).toHaveCount(1);
    await expect
      .poll(() => detail.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await detail
      .getByLabel("Что выполнено", { exact: true })
      .fill("Заменено уплотнение. Гидросистема проверена под давлением, утечек нет.");
    await detail
      .getByRole("combobox", { name: "Шифр неисправности", exact: true })
      .selectOption(state.fault_code_id);
    await detail.getByRole("combobox", { name: "Материал", exact: true }).selectOption(state.material_id);
    await detail.getByLabel("Количество", { exact: true }).fill("0.125");
    await detail.getByRole("button", { name: "Добавить материал", exact: true }).click();
    const secondMaterial = detail.getByRole("combobox", { name: "Материал", exact: true }).nth(1);
    const secondId = await secondMaterial
      .locator("option")
      .evaluateAll(
        (options, firstId) =>
          options
            .map((option) => (option as HTMLOptionElement).value)
            .find((value) => value && value !== firstId),
        state.material_id,
      );
    expect(secondId).toBeTruthy();
    await secondMaterial.selectOption(secondId!);
    await detail.getByLabel("Количество", { exact: true }).nth(1).fill("2");
    await worker.screenshot({ path: info.outputPath("executor-mobile-completion.png"), fullPage: true });
    await noOverflow(worker);
    await detail.getByRole("button", { name: "Сдать наряд", exact: true }).click();
    const master = await token(request, state.master_login);
    await expect.poll(async () => (await readOrder(request, master, id)).status).toBe("completed");
    const saved = await readOrder(request, master, id);
    expect(saved.materials).toHaveLength(2);
    expect(
      saved.materials
        .map((line: { quantity: string }) => Number(line.quantity))
        .sort((a: number, b: number) => a - b),
    ).toEqual([0.125, 2]);
    expect(saved.photos).toHaveLength(1);
    expect((await request.get(saved.photos[0].content_url)).status()).toBe(401);
    await worker.screenshot({ path: info.outputPath("executor-mobile-completed.png"), fullPage: true });
    await expect(detail.getByRole("button", { name: "Сдать наряд", exact: true })).toHaveCount(0);
  } finally {
    await mobile.close();
  }
  expect(errors).toEqual([]);
});

test("offline reload/reconnect delivers once and leaves version conflict visible", async ({
  page,
  context,
  request,
}, info) => {
  const master = await token(request, state.master_login);
  const title = description();
  const id = await create(request, master, title);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, state.executor_login);
  await page.getByText(title, { exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Принять", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.getByRole("dialog").getByRole("button", { name: "Принять", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Закрыть/ })
    .click();
  await page.reload();
  await expect(
    page.getByText(/Ожидает отправки|Ожидают отправки|Без связи|Нет сети|Нет связи/).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Мои работы" })).toBeVisible();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  expect((await readOrder(request, master, id)).status).toBe("issued");
  await page.screenshot({ path: info.outputPath("offline-mobile.png"), fullPage: true });
  await context.setOffline(false);
  await expect.poll(async () => (await readOrder(request, master, id)).status).toBe("accepted");
  const events = await request.get(`/api/v1/work-orders/${id}/events`, {
    headers: { Authorization: `Bearer ${master}` },
  });
  expect(
    (await events.json()).items.filter((event: { action: string }) => event.action === "accept"),
  ).toHaveLength(1);
  const otherTitle = description();
  const other = await create(request, master, otherTitle);
  await page.reload();
  await page.getByText(otherTitle, { exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Принять", exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("dialog").getByRole("button", { name: "Принять", exact: true }).click();
  const changed = await request.post(`/api/v1/work-orders/${other}/actions`, {
    headers: { Authorization: `Bearer ${master}`, "Idempotency-Key": crypto.randomUUID() },
    data: {
      action: "change_priority",
      expected_version: 1,
      priority: "high",
      reason: "Изменение приоритета во время потери связи",
    },
  });
  expect(changed.status()).toBe(200);
  await context.setOffline(false);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Закрыть/ })
    .click();
  await expect(page.getByText(/Наряд изменился/).first()).toBeVisible();
  expect((await readOrder(request, master, other)).status).toBe("issued");
  await page.screenshot({ path: info.outputPath("version-conflict-mobile.png"), fullPage: true });
});

test("readonly roles, keyboard dialog, private cache and responsive layout", async ({
  page,
  request,
}, info) => {
  await login(page, state.manager_login);
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
  const open = page.getByRole("button", { name: /Открыть наряд/ }).first();
  await open.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Добавить комментарий" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(open).toBeFocused();
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`manager-${width}.png`), fullPage: true });
  }
  const cached = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      paths.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
    }
    return paths;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.some((path) => path.startsWith("/api/"))).toBe(false);
  await page.getByRole("button", { name: /Выйти/ }).click();
  await expect(page.getByRole("heading", { name: "Вход в смену" })).toBeVisible();
  await login(page, state.admin_login);
  await expect(page.getByRole("heading", { name: "Справочные данные" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
  expect((await request.get("/api/v1/work-orders")).status()).toBe(401);
});

test("revoked session clears the visible workspace and private local snapshots", async ({
  page,
  request,
}) => {
  await login(page, state.executor_login);
  await expect(page.getByRole("button", { name: /Открыть наряд/ }).first()).toBeVisible();
  const session = await page.evaluate(() => ({
    token: sessionStorage.getItem("naryadai.session.token"),
    actor: JSON.parse(sessionStorage.getItem("naryadai.session.user") ?? "null")?.id as string | undefined,
  }));
  expect(session.actor).toBeTruthy();
  const logout = await request.post("/api/v1/auth/logout", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  expect(logout.status()).toBe(204);
  // The active WebSocket detects revocation without another user action.
  await expect(page.getByRole("heading", { name: "Вход в смену" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("naryadai.session.token"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("naryadai.session.user"))).toBeNull();
  await expect
    .poll(() =>
      page.evaluate(async (actor) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("naryadai-private-v1", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const count = (store: string) =>
            new Promise<number>((resolve, reject) => {
              const request = db.transaction(store).objectStore(store).index("actor").count(actor);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
          return (await count("snapshots")) + (await count("pending"));
        } finally {
          db.close();
        }
      }, session.actor),
    )
    .toBe(0);
});

test("executor queues a job and refuses another with an explicit reason", async ({ page, request }) => {
  const master = await token(request, state.master_login);
  const queuedTitle = description();
  const queued = await create(request, master, queuedTitle);
  const refusedTitle = description();
  const refused = await create(request, master, refusedTitle);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, state.executor_login);
  await page.getByText(queuedTitle, { exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "В очередь", exact: true }).click();
  await expect.poll(async () => (await readOrder(request, master, queued)).status).toBe("queued");
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByText(refusedTitle, { exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("button", { name: "Отказаться", exact: true })).toBeDisabled();
  await detail.getByLabel("Причина отказа", { exact: true }).fill("Нет допуска к этой операции");
  await detail.getByRole("button", { name: "Отказаться", exact: true }).click();
  await expect.poll(async () => (await readOrder(request, master, refused)).status).toBe("rejected");
  const response = await request.get(`/api/v1/work-orders/${refused}/events`, {
    headers: { Authorization: `Bearer ${master}` },
  });
  expect(
    (await response.json()).items.find((event: { action: string }) => event.action === "reject").reason,
  ).toBe("Нет допуска к этой операции");
});
