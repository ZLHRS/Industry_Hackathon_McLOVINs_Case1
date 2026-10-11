import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
const fixtures = resolve(root, "tmp/excel-import-fixtures");
const manifest = JSON.parse(readFileSync(resolve(fixtures, "manifest.json"), "utf8"));
const previewUrl = "/api/v1/catalog/import/preview";
const applyUrl = "/api/v1/catalog/import/apply";
const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function openDirectory(page: Page, section = "Оборудование", account = state.admin_login) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  const catalog = page.waitForResponse((r) => r.url().endsWith("/api/v1/catalog"));
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const initial = await catalog;
  expect(initial.status()).toBe(200);
  const headers = { Authorization: initial.request().headers()["authorization"] };
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  await page.getByRole("button", { name: `Открыть раздел: ${section}`, exact: true }).click();
  return headers;
}

async function openImport(page: Page, filename: string) {
  await page.getByRole("button", { name: "Импорт Excel", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Файл Excel", { exact: true }).setInputFiles(resolve(fixtures, filename));
  await expect(dialog.getByRole("button", { name: "Проверить файл", exact: true })).toBeEnabled();
  return dialog;
}

async function check(page: Page) {
  const result = page.waitForResponse((r) => r.url().endsWith(previewUrl));
  await page.getByRole("dialog").getByRole("button", { name: "Проверить файл", exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  return response.json();
}

for (const width of [1440, 390]) {
  test(`admin previews, cancels and imports XLSX without duplicates (${width}px)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const headers = await openDirectory(page);
    const keys = manifest[String(width)];
    let writes = 0;
    page.on("request", (r) => {
      if (r.url().endsWith(applyUrl)) writes++;
    });
    let dialog = await openImport(page, `valid-${width}.xlsx`);
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Скачать шаблон", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const path = await download.path();
    expect(path).toBeTruthy();
    expect(readFileSync(path!).subarray(0, 2).toString()).toBe("PK");
    const preview = await check(page);
    expect(preview.equipment.create).toBe(1);
    expect(preview.materials.create).toBe(1);
    await expect(dialog).toContainText("Насос оборотной воды");
    await expect(dialog).toContainText("Уплотнение вала");
    await page.screenshot({ path: info.outputPath(`preview-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const before = await (await page.request.get("/api/v1/catalog", { headers })).json();
    expect(
      before.equipment.some(
        (item: { inventory_number: string }) => item.inventory_number === keys.equipment_key,
      ),
    ).toBe(false);
    expect(before.materials.some((item: { code: string }) => item.code === keys.material_key)).toBe(false);
    expect(writes).toBe(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    dialog = await openImport(page, `valid-${width}.xlsx`);
    await check(page);
    const savedPromise = page.waitForResponse((r) => r.url().endsWith(applyUrl));
    await dialog.getByRole("button", { name: "Добавить записи · 2", exact: true }).click();
    const saved = await savedPromise;
    expect(saved.status()).toBe(200);
    const result = await saved.json();
    expect(result.created_equipment).toBe(1);
    expect(result.created_materials).toBe(1);
    const replay = await page.request.post(applyUrl, {
      headers: { ...headers, "Content-Type": mime, "X-Import-Fingerprint": preview.fingerprint },
      data: readFileSync(resolve(fixtures, `valid-${width}.xlsx`)),
    });
    expect(replay.status()).toBe(200);
    const replayResult = await replay.json();
    expect(replayResult.created_equipment + replayResult.created_materials).toBe(0);
    await expect(dialog.getByRole("status")).toContainText("Добавлено");
    expect(writes).toBe(1);
    const after = await (await page.request.get("/api/v1/catalog", { headers })).json();
    expect(
      after.equipment.filter(
        (item: { inventory_number: string }) => item.inventory_number === keys.equipment_key,
      ),
    ).toHaveLength(1);
    expect(after.materials.filter((item: { code: string }) => item.code === keys.material_key)).toHaveLength(
      1,
    );
    await dialog.getByRole("button", { name: "Закрыть", exact: true }).first().click();
    await expect(page.getByText(keys.equipment_key, { exact: true })).toBeVisible();
    dialog = await openImport(page, `valid-${width}.xlsx`);
    const duplicate = await check(page);
    expect(duplicate.equipment.skip + duplicate.materials.skip).toBe(2);
    await expect(dialog.getByRole("button", { name: "Добавить записи · 0", exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  });
}

test("invalid row blocks the whole workbook and errors explain sheet and row", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const headers = await openDirectory(page, "Материалы");
  const dialog = await openImport(page, "invalid.xlsx");
  const preview = await check(page);
  expect(preview.equipment.error).toBeGreaterThan(0);
  expect(preview.materials.create).toBe(1);
  await expect(dialog.getByRole("button", { name: /^Добавить записи · \d+$/ })).toBeDisabled();
  await expect(dialog).toContainText("строка 2");
  await expect(dialog).toContainText("Критичность");
  await page.screenshot({ path: info.outputPath("invalid-390.png") });
  const forced = await page.request.post(applyUrl, {
    headers: { ...headers, "Content-Type": mime, "X-Import-Fingerprint": preview.fingerprint },
    data: readFileSync(resolve(fixtures, "invalid.xlsx")),
  });
  expect(forced.status()).toBe(422);
  const current = await (await page.request.get("/api/v1/catalog", { headers })).json();
  expect(current.materials.some((item: { code: string }) => item.code === manifest.invalid_key)).toBe(false);
});

test("concurrent catalog change requires a fresh preview and never overwrites", async ({ page }) => {
  const headers = await openDirectory(page, "Материалы");
  const dialog = await openImport(page, "stale.xlsx");
  await check(page);
  const existing = await page.request.post("/api/v1/catalog/materials", {
    headers,
    data: { code: manifest.stale_key, name: "Уже созданный материал", unit: "шт" },
  });
  expect(existing.status()).toBe(201);
  const responsePromise = page.waitForResponse((r) => r.url().endsWith(applyUrl));
  await dialog.getByRole("button", { name: "Добавить записи · 1", exact: true }).click();
  expect((await responsePromise).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText("Проверьте файл заново");
  await expect(dialog.getByRole("button", { name: /^Добавить/ })).toHaveCount(0);
  const preview = await check(page);
  expect(preview.materials.error).toBe(1);
  const current = await (await page.request.get("/api/v1/catalog", { headers })).json();
  expect(current.materials.find((item: { code: string }) => item.code === manifest.stale_key).name).toBe(
    "Уже созданный материал",
  );
});

test("preview is paginated and changing file invalidates a delayed response", async ({ page }) => {
  await openDirectory(page, "Материалы");
  const dialog = await openImport(page, "pages.xlsx");
  await check(page);
  await expect(dialog).toContainText("Втулка 1");
  await expect(dialog.getByText("Втулка 15", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Вперёд", exact: true }).click();
  await expect(dialog).toContainText("Втулка 15");
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${previewUrl}`, async (route) => {
    const actual = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response: actual });
  });
  await dialog.getByRole("button", { name: "Проверить файл", exact: true }).click();
  await started;
  await dialog.getByLabel("Файл Excel", { exact: true }).setInputFiles(resolve(fixtures, "replacement.xlsx"));
  await expect(dialog.getByRole("button", { name: "Проверить файл", exact: true })).toBeEnabled();
  const old = page.waitForResponse((r) => r.url().endsWith(previewUrl));
  release();
  await old;
  await expect(dialog.getByRole("button", { name: /^Добавить/ })).toHaveCount(0);
  await page.unroute(`**${previewUrl}`);
  await check(page);
  await expect(dialog).toContainText("Новое уплотнение");
  await expect(dialog.getByText("Втулка 15", { exact: true })).toHaveCount(0);
});

test("master has no import action and cannot request template, preview or apply", async ({ page }) => {
  const headers = await openDirectory(page, "Оборудование", state.master_login);
  await expect(page.getByRole("button", { name: "Импорт Excel", exact: true })).toHaveCount(0);
  const template = await page.request.get("/api/v1/catalog/import-template.xlsx", { headers });
  expect(template.status()).toBe(403);
  for (const endpoint of [previewUrl, applyUrl]) {
    const response = await page.request.post(endpoint, {
      headers: { ...headers, "Content-Type": mime, "X-Import-Fingerprint": "0".repeat(64) },
      data: readFileSync(resolve(fixtures, "replacement.xlsx")),
    });
    expect(response.status()).toBe(403);
  }
});

test("unavailable preview can retry and invalid extension never uploads", async ({ page }) => {
  await openDirectory(page);
  const dialog = await openImport(page, "replacement.xlsx");
  let checks = 0;
  page.on("request", (r) => {
    if (r.url().endsWith(previewUrl)) checks++;
  });
  await dialog
    .getByLabel("Файл Excel", { exact: true })
    .setInputFiles({ name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("invalid") });
  await expect(dialog.getByRole("alert")).toContainText(".xlsx");
  await expect(dialog.getByRole("button", { name: "Проверить файл", exact: true })).toBeDisabled();
  expect(checks).toBe(0);
  await dialog.getByLabel("Файл Excel", { exact: true }).setInputFiles(resolve(fixtures, "replacement.xlsx"));
  await page.route(`**${previewUrl}`, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"unavailable"}' }),
  );
  await dialog.getByRole("button", { name: "Проверить файл", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Добавить/ })).toHaveCount(0);
  await page.unroute(`**${previewUrl}`);
  await check(page);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog).toContainText("Новое уплотнение");
});
