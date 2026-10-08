import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

async function openForm(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Дополнительные параметры", { exact: true }).click();
  await dialog.getByRole("combobox", { name: "Участок", exact: true }).selectOption(state.area_id);
  await dialog.getByRole("combobox", { name: "Оборудование", exact: true }).selectOption(state.equipment_id);
  return dialog;
}

const emptySuggestions = {
  faults: [],
  selected_norm_minutes: null,
  required_specialty: null,
  executors: [],
  notes: [],
};

test("issuance suggestions require confirmation and persist the selected fault", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dialog = await openForm(page);
  const worker = dialog.getByRole("combobox", { name: "Исполнитель", exact: true });
  const fault = dialog.getByRole("combobox", { name: "Шифр неисправности", exact: true });
  await expect(worker).toHaveValue("");
  await expect(fault).toHaveValue("");
  const description = `Перегрев двигателя, требуется проверка ${crypto.randomUUID().slice(0, 8)}`;
  const responsePromise = page.waitForResponse((r) => r.url().endsWith("/work-orders/suggestions"));
  await dialog.getByRole("textbox", { name: "Описание", exact: true }).fill(description);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.faults.length).toBeGreaterThan(0);
  const suggested = result.faults[0];
  const suggestedFault = dialog
    .locator(".advanced-fault-suggestions")
    .getByRole("button", { name: `${suggested.code} · ${suggested.name}` });
  await expect(suggestedFault).toBeVisible();
  await expect(fault).toHaveValue("");
  await expect(worker).toHaveValue("");
  await page.screenshot({ path: info.outputPath("suggestions-desktop.png") });
  const executorResponse = page.waitForResponse((r) => r.url().endsWith("/work-orders/suggestions"));
  await suggestedFault.click();
  await expect(fault).toHaveValue(suggested.fault_code_id);
  await expect(worker).toHaveValue("");
  await expect(dialog.getByLabel("Срок (Asia/Almaty)", { exact: true })).toHaveValue("");
  const confirmed = await (await executorResponse).json();
  expect(confirmed.required_specialty).toBe(suggested.specialty);
  expect(confirmed.selected_norm_minutes).toBe(suggested.norm_minutes);
  expect(confirmed.executors.length).toBeGreaterThan(0);
  const suggestedExecutor = dialog.getByTestId(`quick-executor-${confirmed.executors[0].employee_id}`);
  await expect(suggestedExecutor).toBeVisible();
  await expect(worker).toHaveValue("");
  await suggestedExecutor.click();
  await expect(worker).toHaveValue(confirmed.executors[0].employee_id);
  await dialog
    .locator(".order-suggestions")
    .screenshot({ path: info.outputPath("executor-reasons-desktop.png") });
  await dialog.getByRole("button", { name: "Через 2 часа", exact: true }).click();
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await dialog.getByRole("textbox", { name: "Описание", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`suggestions-${width}.png`) });
    if (width === 390) {
      await suggestedExecutor.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("executor-reasons-mobile.png") });
    }
  }
  const createdPromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const created = await createdPromise;
  expect(created.status()).toBe(201);
  expect(created.request().postDataJSON().fault_code_id).toBe(suggested.fault_code_id);
  const orderId = (await created.json()).order_id;
  const stored = await page.request.get(`/api/v1/work-orders/${orderId}`, {
    headers: { Authorization: created.request().headers()["authorization"] },
  });
  expect(stored.status()).toBe(200);
  const persisted = await stored.json();
  expect(persisted.fault_code_id).toBe(suggested.fault_code_id);
  expect(persisted.executor_id).toBe(confirmed.executors[0].employee_id);
  await expect(page.getByText(description, { exact: true }).first()).toBeVisible();
  await page.getByText(description, { exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors).toEqual([]);
});

test("unavailable suggestions preserve manual choices and allow issuing", async ({ page }) => {
  const dialog = await openForm(page);
  await page.route("**/api/v1/work-orders/suggestions", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Подсказки временно недоступны" }),
    }),
  );
  const unavailable = page.waitForResponse((r) => r.url().endsWith("/work-orders/suggestions"));
  await dialog.getByRole("textbox", { name: "Описание", exact: true }).fill("Проверка привода вручную");
  expect((await unavailable).status()).toBe(503);
  await expect(dialog.getByText(/Подбор недоступен/)).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Шифр неисправности", exact: true })
    .selectOption(state.fault_code_id);
  await dialog
    .getByRole("combobox", { name: "Исполнитель", exact: true })
    .selectOption(state.selected_executor_id);
  await expect(dialog.getByRole("combobox", { name: "Исполнитель", exact: true })).toHaveValue(
    state.selected_executor_id,
  );
  await dialog.getByRole("button", { name: "Через 2 часа", exact: true }).click();
  const createdPromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  expect((await createdPromise).status()).toBe(201);
});

test("late suggestion response cannot overwrite a newer description or selection", async ({ page }) => {
  const dialog = await openForm(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const received = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let requests = 0;
  await page.route("**/api/v1/work-orders/suggestions", async (route) => {
    requests += 1;
    if (requests !== 1) return route.continue();
    requested();
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...emptySuggestions,
        faults: [
          {
            fault_code_id: state.fault_code_id,
            code: "STALE",
            name: "Устаревшее предложение",
            specialty: "электрик",
            reasons: ["Старое описание"],
            norm_minutes: 100,
          },
        ],
      }),
    });
  });
  await dialog.getByRole("textbox", { name: "Описание", exact: true }).fill("Первое описание");
  await received;
  const newer = page.waitForResponse(
    (response) =>
      response.url().endsWith("/work-orders/suggestions") &&
      response.request().postDataJSON().description === "Новое описание",
  );
  await dialog.getByRole("textbox", { name: "Описание", exact: true }).fill("Новое описание");
  await dialog
    .getByRole("combobox", { name: "Исполнитель", exact: true })
    .selectOption(state.selected_executor_id);
  await newer;
  const settled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/work-orders/suggestions") &&
      response.request().postDataJSON().description === "Первое описание",
  );
  release();
  await settled;
  await expect(dialog.getByRole("textbox", { name: "Описание", exact: true })).toHaveValue("Новое описание");
  await expect(dialog.getByRole("combobox", { name: "Исполнитель", exact: true })).toHaveValue(
    state.selected_executor_id,
  );
  await expect(dialog.getByText("Устаревшее предложение", { exact: false })).toHaveCount(0);
});
