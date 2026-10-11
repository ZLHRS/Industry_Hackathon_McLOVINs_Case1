import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
const endpoint = "/api/v1/master-assistant/answer";

async function login(page: Page, role = "master") {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state[`${role}_login`]);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  const catalog = page.waitForResponse((r) => r.url().endsWith("/api/v1/catalog"));
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const response = await catalog;
  return { Authorization: response.request().headers()["authorization"] };
}

async function open(page: Page) {
  await page.getByRole("button", { name: "Помощник", exact: true }).click();
  const panel = page.getByTestId("master-assistant");
  await expect(panel).toBeVisible();
  return panel;
}

for (const width of [1440, 390]) {
  test(`grounded history opens a real source and survives reopening (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith(endpoint)) requests++;
    });
    const headers = await login(page);
    const panel = await open(page);
    expect(requests).toBe(0);
    await page.screenshot({ path: info.outputPath(`assistant-open-${width}.png`) });
    await panel
      .getByRole("combobox", { name: "Оборудование для ответа", exact: true })
      .selectOption(state.equipment_id);
    await panel.getByRole("button", { name: "Как ремонтировали раньше?", exact: true }).click();
    const pending = page.waitForResponse((r) => r.url().endsWith(endpoint));
    await panel.getByRole("button", { name: "Спросить", exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.answer_source).toBe("data");
    expect(data.citations.length).toBeGreaterThan(0);
    expect(data.citations.length).toBeLessThanOrEqual(5);
    await expect(panel.getByTestId("assistant-answer")).toContainText(data.answer);
    const source = data.citations[0];
    const stored = await page.request.get(`/api/v1/work-orders/${source.order_id}`, { headers });
    expect(stored.status()).toBe(200);
    expect(await stored.json()).toMatchObject({ number: source.number, status: "closed" });
    await panel.getByTestId("assistant-answer").evaluate((answer) => {
      const dialog = answer.closest("dialog");
      if (dialog) dialog.scrollTop = (answer as HTMLElement).offsetTop - 90;
    });
    await page.screenshot({ path: info.outputPath(`assistant-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await panel.getByRole("button", { name: `Открыть наряд ${source.number}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(source.number);
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("Escape");
    await open(page);
    await expect(panel.getByTestId("assistant-answer")).toContainText(data.answer);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  });
}

test("typed attention query and unsupported time filter are distinguished", async ({ page }) => {
  await login(page);
  const panel = await open(page);
  await panel.getByLabel("Вопрос помощнику").fill("Что сейчас требует внимания?");
  let pending = page.waitForResponse((r) => r.url().endsWith(endpoint));
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  expect((await response.json()).topic).toBe("attention");
  await panel.getByLabel("Вопрос помощнику").fill("Какие неисправности повторились вчера?");
  pending = page.waitForResponse((r) => r.url().endsWith(endpoint));
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  const clarification = await (await pending).json();
  expect(clarification.answer_source).toBe("clarification");
  expect(clarification.citations).toEqual([]);
  await expect(panel.getByTestId("assistant-answer")).toContainText(clarification.answer);
});

test("repeated faults cite actual scoped orders within the declared period", async ({ page }) => {
  const headers = await login(page);
  const panel = await open(page);
  await panel.getByRole("button", { name: "Повторные неисправности", exact: true }).click();
  const pending = page.waitForResponse((r) => r.url().endsWith(endpoint));
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  const data = await response.json();
  expect(data.topic).toBe("repeated_faults");
  expect(data.matching_orders).toBeGreaterThan(0);
  for (const citation of data.citations) {
    expect(Date.parse(citation.issued_at)).toBeGreaterThanOrEqual(Date.parse(data.period.from));
    expect(Date.parse(citation.issued_at)).toBeLessThanOrEqual(Date.parse(data.period.to));
    const stored = await page.request.get(`/api/v1/work-orders/${citation.order_id}`, { headers });
    expect(stored.status()).toBe(200);
    expect(await stored.json()).toMatchObject({ number: citation.number, work_type: "unplanned" });
  }
});

test("late answers are discarded and errors do not block order creation", async ({ page }) => {
  await login(page);
  const panel = await open(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${endpoint}`, async (route) => {
    await gate;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"unavailable"}' });
  });
  await panel.getByRole("button", { name: "Что требует внимания?", exact: true }).click();
  const requested = page.waitForRequest((r) => r.url().endsWith(endpoint));
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  await requested;
  await panel.getByLabel("Вопрос помощнику").fill("Другой вопрос");
  const completed = page.waitForResponse((r) => r.url().endsWith(endpoint));
  release();
  await completed;
  await expect(panel.getByRole("alert")).toHaveCount(0);
  const retry = page.waitForResponse((r) => r.url().endsWith(endpoint));
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  await retry;
  await expect(panel.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  await expect(page.getByTestId("quick-submit-order")).toBeVisible();
});

for (const role of ["executor", "manager", "admin"]) {
  test(`${role} cannot access the master assistant`, async ({ page }) => {
    const headers = await login(page, role);
    await expect(page.getByRole("button", { name: "Помощник", exact: true })).toHaveCount(0);
    const response = await page.request.post(endpoint, {
      headers,
      data: { question: "Что требует внимания?", topic: "attention", language: "ru" },
    });
    expect(response.status()).toBe(403);
  });
}

const clarification = {
  answer: "Уточните оборудование для ответа.",
  topic: null,
  answer_source: "clarification",
  scope: { area_id: null, equipment_id: null },
  period: { from: null, to: "2026-10-11T10:00:00+05:00" },
  matching_orders: 0,
  citations: [],
  no_data: false,
  truncated: false,
  limitations: [],
  measured_at: "2026-10-11T10:00:00+05:00",
};

test("assistant rate limit shows a retryable message", async ({ page }) => {
  let attempts = 0;
  await page.route(`**${endpoint}`, async (route) => {
    attempts += 1;
    await route.fulfill(
      attempts === 1
        ? { status: 429, contentType: "application/json", body: '{"detail":"assistant_busy"}' }
        : { contentType: "application/json", body: JSON.stringify(clarification) },
    );
  });
  await login(page);
  const panel = await open(page);
  await panel.getByRole("button", { name: "Что требует внимания?", exact: true }).click();
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Помощник занят");
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(panel.getByTestId("assistant-answer")).toContainText(clarification.answer);
  expect(attempts).toBe(2);
});

test("assistant does not send a request while offline", async ({ page }) => {
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(endpoint)) requests += 1;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  });
  await login(page);
  const panel = await open(page);
  await panel.getByRole("button", { name: "Что требует внимания?", exact: true }).click();
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("подключении к сети");
  expect(requests).toBe(0);
});

test("language changes discard an in-flight assistant answer", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${endpoint}`, async (route) => {
    await gate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(clarification) });
  });
  await login(page);
  const panel = await open(page);
  await panel.getByRole("button", { name: "Что требует внимания?", exact: true }).click();
  const pending = page.waitForRequest((request) => request.url().endsWith(endpoint));
  await panel.getByRole("button", { name: "Спросить", exact: true }).click();
  await pending;
  await page.evaluate(() => {
    localStorage.setItem("technaryad.language", "en");
    window.dispatchEvent(new StorageEvent("storage", { key: "technaryad.language", newValue: "en" }));
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const completed = page.waitForResponse((response) => response.url().endsWith(endpoint));
  release();
  await completed;
  await expect(page.getByTestId("assistant-answer")).toHaveCount(0);
});
