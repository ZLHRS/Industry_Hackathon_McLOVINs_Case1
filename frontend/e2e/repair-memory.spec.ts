import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
const endpoint = "/api/v1/work-orders/similar-repairs";

async function openForm(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  const catalogPromise = page.waitForResponse((r) => r.url().endsWith("/api/v1/catalog"));
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const catalog = await catalogPromise;
  const headers = { Authorization: catalog.request().headers()["authorization"] };
  const history = await page.request.get(
    `/api/v1/work-orders?status=closed&equipment_id=${state.equipment_id}&limit=20`,
    { headers },
  );
  expect(history.status()).toBe(200);
  const candidate = (await history.json()).items[0];
  expect(candidate).toBeTruthy();
  const detail = await page.request.get(`/api/v1/work-orders/${candidate.id}`, { headers });
  expect(detail.status()).toBe(200);
  const source = await detail.json();
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId(`quick-equipment-${state.equipment_id}`).click();
  await dialog.getByText("Дополнительные параметры", { exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Шифр неисправности", exact: true })
    .selectOption(source.fault_code_id);
  const suggestions = page.waitForResponse((r) => r.url().endsWith("/work-orders/suggestions"));
  await dialog.getByLabel("Описание", { exact: true }).fill(source.description);
  expect((await suggestions).status()).toBe(200);
  return { dialog, source, headers };
}

for (const width of [1440, 390]) {
  test(`similar repairs show real evidence without changing the draft (${width}px)`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let searches = 0;
    let creations = 0;
    page.on("request", (request) => {
      if (request.url().endsWith(endpoint)) searches++;
      if (request.url().endsWith("/api/v1/work-orders") && request.method() === "POST") creations++;
    });
    const { dialog, source } = await openForm(page);
    const memory = dialog.getByTestId("similar-repairs");
    await expect(memory).toBeVisible();
    expect(searches).toBe(0);
    await memory.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`collapsed-${width}.png`) });
    const response = page.waitForResponse((r) => r.url().endsWith(endpoint));
    await memory.locator(":scope > summary").click();
    const result = await response;
    expect(result.status()).toBe(200);
    const data = await result.json();
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.length).toBeLessThanOrEqual(3);
    const first = data.items[0];
    const card = memory.getByTestId(`similar-repair-${first.order_id}`);
    await expect(card).toContainText(first.number);
    await expect(card.locator(".order-reference-title").first()).toContainText(first.description);
    await card.locator("summary").click();
    await expect(card).toContainText(first.work_description);
    await expect(card).toContainText(first.materials[0].name);
    await card.getByRole("button", { name: new RegExp(`Открыть наряд ${first.number}$`) }).click();
    await expect(card.getByTestId("similar-repair-source")).toContainText(first.number);
    await expect(card.getByTestId("similar-repair-source")).toContainText(first.description);
    await expect(dialog.getByLabel("Описание", { exact: true })).toHaveValue(source.description);
    await expect(dialog.getByRole("combobox", { name: "Исполнитель", exact: true })).toHaveValue("");
    await expect(dialog.getByRole("combobox", { name: "Шифр неисправности", exact: true })).toHaveValue(
      source.fault_code_id,
    );
    await memory.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`expanded-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(creations).toBe(0);
    expect(errors).toEqual([]);
  });
}

test("unavailable repair memory can retry and does not prevent issuance", async ({ page }) => {
  const { dialog, source } = await openForm(page);
  let fail = true;
  await page.route(`**${endpoint}`, async (route) => {
    if (fail)
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"unavailable"}' });
    else await route.continue();
  });
  const memory = dialog.getByTestId("similar-repairs");
  await memory.locator(":scope > summary").click();
  await expect(memory.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Описание", { exact: true })).toHaveValue(source.description);
  fail = false;
  const retry = page.waitForResponse((r) => r.url().endsWith(endpoint));
  await memory.getByRole("button", { name: /Повторить/ }).click();
  expect((await retry).status()).toBe(200);
  await expect(memory.locator('[data-testid^="similar-repair-"]').first()).toBeVisible();
  fail = true;
  const revised = `${source.description} — проверить повторно`;
  await dialog.getByLabel("Описание", { exact: true }).fill(revised);
  await expect(memory.getByRole("alert")).toBeVisible();
  await dialog.locator('[data-testid^="quick-executor-"]:not(:disabled)').first().click();
  await dialog.getByTestId("quick-deadline-2h").click();
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
  );
  await dialog.getByTestId("quick-submit-order").click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().description).toBe(revised);
});

test("late history response cannot replace results for a changed description", async ({ page }) => {
  const { dialog } = await openForm(page);
  const memory = dialog.getByTestId("similar-repairs");
  const firstResponse = page.waitForResponse((r) => r.url().endsWith(endpoint));
  await memory.locator(":scope > summary").click();
  const firstResult = await (await firstResponse).json();
  expect(firstResult.items.length).toBeGreaterThan(0);
  await dialog.getByRole("combobox", { name: "Шифр неисправности", exact: true }).selectOption("");
  const oldDescription = "Перегрев электродвигателя старый запрос";
  const newDescription = "цщйфхзщ эюъщфзц";
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().postDataJSON().description === oldDescription) {
      await delayed;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(firstResult),
      });
    } else await route.continue();
  });
  const oldRequest = page.waitForRequest(
    (r) => r.url().endsWith(endpoint) && r.postDataJSON().description === oldDescription,
  );
  await dialog.getByLabel("Описание", { exact: true }).fill(oldDescription);
  await oldRequest;
  const current = page.waitForResponse(
    (r) => r.url().endsWith(endpoint) && r.request().postDataJSON().description === newDescription,
  );
  await dialog.getByLabel("Описание", { exact: true }).fill(newDescription);
  const empty = await current;
  expect(empty.status()).toBe(200);
  expect((await empty.json()).items).toEqual([]);
  const stale = page.waitForResponse(
    (r) => r.url().endsWith(endpoint) && r.request().postDataJSON().description === oldDescription,
  );
  release();
  await stale;
  await expect(memory.locator('[data-testid^="similar-repair-"]')).toHaveCount(0);
  await expect(memory.getByText(/не найден/i)).toBeVisible();
  await expect(dialog.getByLabel("Описание", { exact: true })).toHaveValue(newDescription);
  await dialog.getByLabel("Описание", { exact: true }).fill("");
  await expect(
    memory.getByText("Выберите оборудование и заполните описание.", { exact: true }),
  ).toBeVisible();
  await expect(memory.locator('[data-testid^="similar-repair-"]')).toHaveCount(0);
});
