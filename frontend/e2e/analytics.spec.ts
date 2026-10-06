import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = JSON.parse(readFileSync(resolve(project, "tmp/e2e-server.json"), "utf8")) as {
  secret: string;
  master_login: string;
  executor_login: string;
};
async function login(page: Page, account: string) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Выйти/ })).toBeVisible();
}
async function openReport(page: Page) {
  const report = page.getByRole("button", { name: "Отчёт", exact: true });
  await expect(report.first()).toBeVisible();
  await report.first().click();
  await expect(page.getByRole("heading", { name: /отчёт/i })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
test("master filters analytics and downloads authenticated XLSX without invoking AI", async ({
  page,
}, info) => {
  let summaryCalls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/analytics/summary")) summaryCalls += 1;
  });
  await login(page, state.master_login);
  const reportResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/analytics/report"),
  );
  await openReport(page);
  expect((await reportResponse).status()).toBe(200);
  await expect(page.getByText("Ключевые показатели", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Выдано", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Период", exact: true }).selectOption("shift");
  await page.getByRole("combobox", { name: "Смена", exact: true }).selectOption("night");
  const updated = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/analytics/report") && response.url().includes("period=shift"),
  );
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  expect((await updated).status()).toBe(200);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать XLSX", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.xlsx$/i);
  expect(summaryCalls).toBe(0);
  await page.screenshot({ path: info.outputPath("analytics-master-desktop.png"), fullPage: true });
  await noOverflow(page);
});
test("executor sees a private report and never receives peer controls", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, state.executor_login);
  await openReport(page);
  await expect(page.getByRole("heading", { name: "Мой отчёт", exact: true })).toBeVisible();
  await expect(page.getByLabel("Исполнитель", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Бригада", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Аномалии с доказательствами", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Сводка доступна мастеру/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("analytics-executor-mobile.png"), fullPage: true });
  await noOverflow(page);
});
test("summary is only requested by an explicit action and accepts a rules fallback", async ({ page }) => {
  await page.route("**/api/v1/analytics/summary**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        source: "rules",
        model: null,
        text: "Правила: просрочек не выявлено.",
        limitations: ["ИИ-провайдер недоступен"],
        evidence_ids: [],
      }),
    });
  });
  await login(page, state.master_login);
  await openReport(page);
  const summaryResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/analytics/summary"),
  );
  await page.getByRole("button", { name: "Сформировать ИИ-сводку", exact: true }).click();
  await summaryResponse;
  await expect(page.getByText("Правила: просрочек не выявлено.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Обзор показателей без ИИ-интерпретации/)).toBeVisible();
});

test("master records then voids downtime and downloads a private order report", async ({ page, request }) => {
  const tokenResponse = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(tokenResponse.status()).toBe(200);
  const token = (await tokenResponse.json()).access_token as string;
  const description = "Простой для аудита " + crypto.randomUUID().slice(0, 8);
  const created = await request.post("/api/v1/work-orders", {
    headers: { Authorization: "Bearer " + token, "Idempotency-Key": crypto.randomUUID() },
    data: {
      work_type: "unplanned",
      priority: "normal",
      description,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: "2026-10-08T12:00:00+05:00",
    },
  });
  expect(created.status()).toBe(201);
  await login(page, state.master_login);
  await page.getByText(description, { exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name: "Учёт простоя", exact: true })).toBeVisible();
  const startedAt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(Date.now() - 60_000))
    .replace(" ", "T");
  await detail.getByLabel("Начало простоя", { exact: true }).fill(startedAt);
  await detail
    .getByLabel("Причина записи или исправления", { exact: true })
    .fill("Проверка остановки конвейера");
  await detail.getByRole("button", { name: "Зафиксировать простой", exact: true }).click();
  await expect(detail.getByText(/Последняя запись:/)).toBeVisible();
  const report = page.waitForEvent("download");
  await detail.getByRole("button", { name: "Отчёт Excel", exact: true }).click();
  expect((await report).suggestedFilename()).toMatch(/\.xlsx$/i);
  await detail.getByLabel("Причина записи или исправления", { exact: true }).fill("Запись создана по ошибке");
  await detail.getByRole("button", { name: "Аннулировать последнюю запись", exact: true }).click();
  await expect(detail.getByText("Последняя запись простоя аннулирована.", { exact: true })).toBeVisible();
});

test("downtime KPI uses recorded equipment intervals instead of work-order pauses", async ({ page }) => {
  await page.route("**/api/v1/analytics/report**", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const report = await response.json();
    report.durations.pause_seconds = 7200;
    report.downtime.known_seconds = 3600;
    report.orders.rejected = 2;
    report.orders.closed = 3;
    report.orders.backlog = 4;
    await route.fulfill({ response, json: report });
  });
  await login(page, state.master_login);
  await openReport(page);
  const metric = (label: string) =>
    page
      .locator(".metric")
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator("strong");
  await expect(metric("Простой")).toHaveText("1 ч 0 мин");
  await expect(metric("Отказы")).toHaveText("2");
  await expect(metric("Закрыто")).toHaveText("3");
  await expect(metric("Незакрыто")).toHaveText("4");
  await expect(page.getByText(/Нарядов в расчёте:/)).toHaveCount(1);
});
