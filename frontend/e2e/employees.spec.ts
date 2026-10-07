import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
async function signIn(page: Page, login = state.admin_login, secret = state.secret) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Сотрудники и доступ", exact: true })).toBeVisible();
}
async function authenticate(request: APIRequestContext, login: string, secret: string) {
  const response = await request.post("/api/v1/auth/login", { data: { login, secret } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });

test("administrator creates, scopes, resets and disables an employee", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const admin = await authenticate(request, state.admin_login, state.secret);
  const catalog = await (await request.get("/api/v1/catalog", { headers: headers(admin) })).json();
  const account = `staff.${crypto.randomUUID().slice(0, 8)}`;
  const initial = "Employee-test-first-42";
  const next = "Employee-test-next-43";
  await signIn(page);
  await page.getByRole("button", { name: "Добавить сотрудника", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Логин", { exact: true }).fill(account);
  await dialog.getByLabel("ФИО сотрудника", { exact: true }).fill("Сотрудник проверки доступа");
  await dialog.getByLabel("Специальность", { exact: true }).selectOption(catalog.fault_codes[0].specialty);
  await dialog.getByLabel("Разряд", { exact: true }).fill("3");
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByLabel("Пароль", { exact: true }).fill(initial);
  const createdResponse = page.waitForResponse(
    (r) => r.url().endsWith("/catalog/employees") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Создать сотрудника", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const employee = await created.json();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const firstToken = await authenticate(request, account, initial);
  await page.getByLabel("Поиск", { exact: true }).fill(account);
  const row = page.locator(".employee-row").filter({ hasText: account });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Настроить" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox").first()).toBeChecked();
  await dialog.getByLabel("Роль", { exact: true }).selectOption("manager");
  await dialog.getByRole("checkbox").first().uncheck();
  await dialog.getByRole("checkbox").nth(1).check();
  await dialog.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await request.get("/api/v1/auth/me", { headers: headers(firstToken) })).status()).toBe(401);
  const managerToken = await authenticate(request, account, initial);
  const me = await (await request.get("/api/v1/auth/me", { headers: headers(managerToken) })).json();
  expect(me.role).toBe("manager");
  expect(me.area_ids).toEqual([catalog.areas[1].id]);
  await row.getByRole("button", { name: "Настроить" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Сбросить пароль", exact: true }).click();
  dialog = page.getByRole("dialog");
  await page.screenshot({ path: info.outputPath("password-reset-desktop.png") });
  await dialog.getByLabel("Новый пароль", { exact: true }).fill(next);
  await dialog.getByLabel("Повторите пароль", { exact: true }).fill("несовпадающий-пароль");
  await dialog.getByRole("button", { name: "Сохранить пароль", exact: true }).click();
  await expect(dialog.getByText("Пароли не совпадают. Проверьте оба поля.")).toBeVisible();
  await dialog.getByLabel("Повторите пароль", { exact: true }).fill(next);
  await dialog.getByRole("button", { name: "Сохранить пароль", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (await request.post("/api/v1/auth/login", { data: { login: account, secret: initial } })).status(),
  ).toBe(401);
  expect((await request.get("/api/v1/auth/me", { headers: headers(managerToken) })).status()).toBe(401);
  const resetToken = await authenticate(request, account, next);
  await row.getByRole("button", { name: "Настроить" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Отключить доступ", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Подтвердить отключение", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row.getByText("Доступ отключён", { exact: true })).toBeVisible();
  expect((await request.get("/api/v1/auth/me", { headers: headers(resetToken) })).status()).toBe(401);
  expect(
    (await request.post("/api/v1/auth/login", { data: { login: account, secret: next } })).status(),
  ).toBe(401);
  await page.screenshot({ path: info.outputPath("employees-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "Настроить" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Сбросить пароль", exact: true }).click();
  await page.screenshot({ path: info.outputPath("password-reset-mobile.png") });
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть", exact: true }).click();
  await row.getByRole("button", { name: "Настроить" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: info.outputPath("employee-access-mobile.png") });
  await page.getByRole("dialog").getByRole("button", { name: "Включить доступ", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Включить доступ", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row.getByText("Доступ активен", { exact: true })).toBeVisible();
  await authenticate(request, account, next);
  const detail = await request.get(`/api/v1/catalog/employees/${employee.id}`, { headers: headers(admin) });
  expect((await detail.json()).area_ids).toEqual([catalog.areas[1].id]);
  await page.screenshot({ path: info.outputPath("employees-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test("administrator cannot disable self and own password change returns to login", async ({
  page,
  request,
}) => {
  const admin = await authenticate(request, state.admin_login, state.secret);
  const account = `admin.${crypto.randomUUID().slice(0, 8)}`;
  const secret = "Self-password-before-42";
  const after = "Self-password-after-43";
  const response = await request.post("/api/v1/catalog/employees", {
    headers: headers(admin),
    data: {
      login: account,
      display_name: "Администратор проверки",
      role: "admin",
      specialty: "mechanic",
      secret,
    },
  });
  expect(response.status()).toBe(201);
  await signIn(page, account, secret);
  await page.getByLabel("Поиск", { exact: true }).fill(account);
  await page
    .locator(".employee-row")
    .filter({ hasText: account })
    .getByRole("button", { name: "Настроить" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Роль", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Отключить доступ", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Сбросить пароль", exact: true }).click();
  const passwordDialog = page.getByRole("dialog");
  await passwordDialog.getByLabel("Новый пароль", { exact: true }).fill(after);
  await passwordDialog.getByLabel("Повторите пароль", { exact: true }).fill(after);
  await passwordDialog.getByRole("button", { name: "Сохранить пароль", exact: true }).click();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  expect((await request.post("/api/v1/auth/login", { data: { login: account, secret } })).status()).toBe(401);
  await signIn(page, account, after);
});
