import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.admin_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ" })).toBeVisible();
}

test("directory overview leads to focused sections and employee management on mobile", async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".reference-row")).toHaveCount(0);
  for (const title of [
    "Участки",
    "Оборудование",
    "Бригады",
    "Материалы",
    "Шифры неисправностей",
    "Нормативы времени",
    "Сотрудники",
  ]) {
    await expect(page.getByRole("button", { name: `Открыть раздел: ${title}`, exact: true })).toBeVisible();
  }
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`directory-overview-${width}.png`) });
  }
  await page.getByRole("button", { name: "Открыть раздел: Материалы", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Материалы", exact: true })).toBeFocused();
  await expect(page.locator(".reference-row").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить", exact: true })).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "Поиск по справочнику", exact: true })
    .fill("несуществующий-материал-987654");
  await expect(page.locator(".reference-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Сбросить фильтры", exact: true }).click();
  await expect(page.locator(".reference-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  await expect(page.getByRole("button", { name: "Открыть раздел: Материалы", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Открыть раздел: Оборудование", exact: true }).click();
  await page.getByLabel("Участок оборудования", { exact: true }).selectOption(state.area_id);
  await expect(page.locator(".reference-row").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("directory-equipment-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  await page.getByRole("button", { name: "Открыть раздел: Сотрудники", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("master reads all directory sections without administrative controls", async ({ page }, info) => {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const title of [
    "Участки",
    "Оборудование",
    "Бригады",
    "Материалы",
    "Шифры неисправностей",
    "Нормативы времени",
    "Сотрудники",
  ]) {
    await page.getByRole("button", { name: `Открыть раздел: ${title}`, exact: true }).click();
    await expect(page.locator(".reference-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Добавить|Изменить)/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (title === "Сотрудники")
      await page.screenshot({ path: info.outputPath("directory-staff-master-mobile.png") });
    await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  }
});

test("administrator manages operational reference records and removes only unreferenced entries", async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  const suffix = crypto.randomUUID().slice(0, 7).toUpperCase();

  await page.getByRole("button", { name: "Открыть раздел: Бригады", exact: true }).click();
  await page.getByRole("button", { name: "Добавить бригаду", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Код", { exact: true }).fill(`QA-BR-${suffix}`);
  await dialog.getByLabel("Название", { exact: true }).fill("Бригада проверки справочника");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  let row = page.locator(".reference-row").filter({ hasText: `QA-BR-${suffix}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill("Бригада проверки · обновлена");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  row = page.locator(".reference-row").filter({ hasText: "Бригада проверки · обновлена" });
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Удалить запись", exact: true }).click();
  await dialog.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  await page.getByRole("button", { name: "Открыть раздел: Материалы", exact: true }).click();
  await page.getByRole("button", { name: "Добавить материал", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Код", { exact: true }).fill(`QA-MAT-${suffix}`);
  await dialog.getByLabel("Название", { exact: true }).fill("Материал проверки удаления");
  await dialog.getByLabel("Единица измерения", { exact: true }).fill("шт");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  row = page.locator(".reference-row").filter({ hasText: `QA-MAT-${suffix}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Удалить запись", exact: true }).click();
  await dialog.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  await page.getByRole("button", { name: "Открыть раздел: Шифры неисправностей", exact: true }).click();
  await page.getByRole("button", { name: "Добавить шифр", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Код", { exact: true }).fill(`QA-FLT-${suffix}`);
  await dialog.getByLabel("Название", { exact: true }).fill("Неисправность для норматива");
  await dialog.getByLabel("Специализация", { exact: true }).fill("QA");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();

  await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  await page.getByRole("button", { name: "Открыть раздел: Нормативы времени", exact: true }).click();
  await page.getByRole("button", { name: "Добавить норматив", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Шифр неисправности", exact: true })
    .selectOption({ label: `QA-FLT-${suffix} · Неисправность для норматива` });
  await dialog.getByLabel("Тип оборудования", { exact: true }).fill("qa-pump");
  await dialog.getByLabel("Норма, минут", { exact: true }).fill("37");
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({ path: info.outputPath("time-norm-editor-mobile.png") });
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  row = page.locator(".reference-row").filter({ hasText: "qa-pump" });
  await expect(row).toContainText("37 мин");
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Удалить запись", exact: true }).click();
  await dialog.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Все разделы", exact: true }).click();
  await page.getByRole("button", { name: "Открыть раздел: Шифры неисправностей", exact: true }).click();
  await page.getByRole("searchbox", { name: "Поиск по справочнику", exact: true }).fill(`QA-FLT-${suffix}`);
  row = page.locator(".reference-row").filter({ hasText: `QA-FLT-${suffix}` });
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Удалить запись", exact: true }).click();
  await dialog.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
test("administrator manages an area lifecycle and only active directory entries feed forms", async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Справочные данные" })).toBeVisible();
  await page.getByRole("button", { name: "Открыть раздел: Участки", exact: true }).click();
  await page.getByRole("button", { name: "Добавить участок", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: info.outputPath("catalog-add-mobile-360.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  const code = `QA-${crypto.randomUUID().slice(0, 6)}`;
  await dialog.getByLabel("Код", { exact: true }).fill(code);
  await dialog.getByLabel("Название", { exact: true }).fill("Участок жизненного цикла");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  const row = page.locator(".reference-row").filter({ hasText: code });
  await expect(row).toBeVisible();
  await page.getByPlaceholder("Код, инвентарный номер или название").fill(code);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.screenshot({ path: info.outputPath("catalog-edit-desktop.png") });
  await page.getByRole("button", { name: "Архивировать запись", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("catalog-archive-confirm-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Подтвердить архивирование", exact: true }).click();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByRole("button", { name: "Восстановить запись", exact: true }).click();
  await page.getByRole("button", { name: "Активные", exact: true }).click();
  await expect(row).toBeVisible();
  await page.screenshot({ path: info.outputPath("catalog-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("catalog-mobile.png"), fullPage: true });
});

test("archive guard keeps equipment active and explains its unfinished order", async ({ page, request }) => {
  const loginResponse = await request.post("/api/v1/auth/login", {
    data: { login: state.admin_login, secret: state.secret },
  });
  expect(loginResponse.status()).toBe(200);
  const adminToken = (await loginResponse.json()).access_token;
  const headers = { Authorization: `Bearer ${adminToken}` };
  const suffix = crypto.randomUUID().slice(0, 8);
  const equipment = await request.post("/api/v1/catalog/equipment", {
    headers,
    data: {
      inventory_number: `GUARD-${suffix}`,
      name: "Оборудование проверки архива",
      area_id: state.area_id,
      equipment_type: "test",
      criticality: 3,
    },
  });
  expect(equipment.status()).toBe(201);
  const equipmentId = (await equipment.json()).id;
  const masterLogin = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(masterLogin.status()).toBe(200);
  const masterToken = (await masterLogin.json()).access_token;
  const issued = await request.post("/api/v1/work-orders", {
    headers: { Authorization: `Bearer ${masterToken}`, "Idempotency-Key": crypto.randomUUID() },
    data: {
      work_type: "unplanned",
      priority: "high",
      description: "Незавершённый наряд для проверки архива",
      area_id: state.area_id,
      equipment_id: equipmentId,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  expect(issued.status()).toBe(201);
  await login(page);
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  await page.getByRole("button", { name: "Открыть раздел: Оборудование", exact: true }).click();
  await page.getByPlaceholder("Код, инвентарный номер или название").fill(`GUARD-${suffix}`);
  const row = page.locator(".reference-row").filter({ hasText: `GUARD-${suffix}` });
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByRole("button", { name: "Архивировать запись", exact: true }).click();
  await page.getByRole("button", { name: "Подтвердить архивирование", exact: true }).click();
  await expect(page.getByText(/нельзя архивировать: есть незавершённые наряды/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить архивирование", exact: true })).toBeVisible();
  const catalog = await request.get("/api/v1/catalog", { headers });
  expect(
    (await catalog.json()).equipment.find((item: { id: string }) => item.id === equipmentId).is_active,
  ).toBe(true);
});
