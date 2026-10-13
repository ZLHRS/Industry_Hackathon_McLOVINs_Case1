import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

async function openMonthlyReport(page: Page, login = state.master_login) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
  await page
    .getByRole("button", { name: /^(Отчёт|Мои результаты)$/ })
    .first()
    .click();
  await page.getByRole("combobox", { name: "Период", exact: true }).selectOption("month");
  const response = page.waitForResponse(
    (r) => r.url().includes("/analytics/report") && r.url().includes("period=month"),
  );
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  const report = await response;
  expect(report.status()).toBe(200);
  return report.json();
}

for (const width of [1440, 390]) {
  test(`master confirms a traceable preventive order, cancel is read-only (${width}px)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let mutations = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/work-orders") && request.method() === "POST") mutations++;
    });
    const report = await openMonthlyReport(page);
    const action = page.getByRole("button", { name: "Подготовить наряд", exact: true }).first();
    await expect(action).toBeVisible();
    await action.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`anomaly-${width}.png`) });

    // Unapplied controls must not change the provenance of the displayed report.
    await page.getByRole("combobox", { name: "Период", exact: true }).selectOption("day");
    const prepared = page.waitForResponse((r) => r.url().endsWith("/analytics/preventive-draft"));
    await action.click();
    const preparedResponse = await prepared;
    expect(preparedResponse.status()).toBe(200);
    const draft = await preparedResponse.json();
    expect(draft.source.query.from).toBe(report.period.from);
    expect(draft.source.query.to).toBe(report.period.to);
    const dialog = page.getByRole("dialog").first();
    await expect(dialog.getByTestId("prevention-origin")).toBeVisible();
    await expect(dialog.getByLabel("Описание", { exact: true })).toHaveValue(draft.description);
    await expect(dialog.getByRole("combobox", { name: "Тип", exact: true })).toHaveValue("planned");
    await expect(dialog.getByRole("combobox", { name: "Тип", exact: true })).toBeDisabled();
    expect(mutations).toBe(0);
    await dialog.getByTestId("prevention-origin").locator("summary").click();
    const related = dialog.getByTestId("prevention-origin").getByRole("button", {
      name: new RegExp(draft.evidence_orders[0].number),
      exact: true,
    });
    await related.click();
    await expect(dialog.getByTestId("prevention-evidence-preview")).toContainText(
      draft.evidence_orders[0].number,
    );
    await page.screenshot({ path: info.outputPath(`evidence-${width}.png`) });
    await dialog.getByTestId("prevention-origin").locator("summary").click();
    await expect(dialog.getByLabel("Описание", { exact: true })).toHaveValue(draft.description);
    await page.screenshot({ path: info.outputPath(`draft-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(mutations).toBe(0);

    await action.click();
    await expect(dialog.getByTestId("prevention-origin")).toBeVisible();
    await dialog.locator('[data-testid^="quick-executor-"]:not(:disabled)').first().click();
    await dialog.getByTestId("quick-deadline-2h").click();
    await dialog.getByRole("combobox", { name: "Приоритет", exact: true }).selectOption("planned");
    const createdPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
    );
    await dialog.getByTestId("quick-submit-order").click();
    const created = await createdPromise;
    expect(created.status()).toBe(201);
    expect(mutations).toBe(1);
    const input = created.request().postDataJSON();
    expect(input.prevention_source).toEqual(draft.source);
    expect(input.equipment_id).toBe(draft.equipment_id);
    expect(input.work_type).toBe("planned");
    const id = (await created.json()).order_id;
    const stored = await page.request.get(`/api/v1/work-orders/${id}`, {
      headers: { Authorization: created.request().headers()["authorization"] },
    });
    expect(stored.status()).toBe(200);
    const order = await stored.json();
    expect(order.equipment_id).toBe(draft.equipment_id);
    const eventsResponse = await page.request.get(`/api/v1/work-orders/${id}/events`, {
      headers: { Authorization: created.request().headers()["authorization"] },
    });
    expect(eventsResponse.status()).toBe(200);
    const events = (await eventsResponse.json()).items;
    const origin = events.find((event: { action: string }) => event.action === "issue").details
      .prevention_source;
    expect(origin).toBeTruthy();
    expect(JSON.stringify(origin)).toContain(draft.source.order_ids[0]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Наряд выдан", { exact: true })).toBeVisible();
    await page.goto(`/orders/${id}`);
    await page.getByText("Показать историю действий", { exact: true }).click();
    await expect(page.getByTestId("prevention-origin")).toBeVisible();
    await page.getByTestId("prevention-origin").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`issued-origin-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByTestId("prevention-origin").locator("summary").click();
    const historyRelated = page.getByTestId("prevention-origin").getByRole("link").first();
    await expect(historyRelated).toHaveAttribute("href", `/orders/${draft.evidence_orders[0].id}`);
    await historyRelated.click();
    await expect(page.getByRole("dialog").locator(".dialog-head small")).toContainText(
      draft.evidence_orders[0].number,
    );
    expect(errors).toEqual([]);
  });
}

test("manager sees anomaly evidence but cannot prepare or issue preventive work", async ({ page }) => {
  const report = await openMonthlyReport(page, state.manager_login);
  expect(report.anomalies.length).toBeGreaterThan(0);
  await expect(page.locator(".anomaly").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Подготовить наряд", exact: true })).toHaveCount(0);
});

test("failed preparation keeps the report usable and creates no order", async ({ page }) => {
  await openMonthlyReport(page);
  let mutations = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/v1/work-orders") && r.method() === "POST") mutations++;
  });
  await page.route("**/analytics/preventive-draft", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"detail":"prevention_source_stale"}',
    }),
  );
  await page.getByRole("button", { name: "Подготовить наряд", exact: true }).first().click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations).toBe(0);
  await page.unroute("**/analytics/preventive-draft");
  await page.getByRole("button", { name: "Подготовить наряд", exact: true }).first().click();
  await expect(page.getByTestId("prevention-origin")).toBeVisible();
  expect(mutations).toBe(0);
});
