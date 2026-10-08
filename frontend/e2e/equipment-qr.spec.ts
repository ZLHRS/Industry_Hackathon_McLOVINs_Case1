import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import jsQR from "jsqr";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
const equipmentPath = `/equipment/${state.equipment_id}`;
async function login(page: Page, role: string, path = equipmentPath) {
  await page.goto(path);
  await page.getByLabel("Логин", { exact: true }).fill(state[`${role}_login`]);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path + "$"));
  await expect(page.getByRole("button", { name: /Выйти/ }).first()).toBeVisible();
}
async function adminToken(request: APIRequestContext) {
  const response = await request.post("/api/v1/auth/login", {
    data: { login: state.admin_login, secret: state.secret },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}

test("master scans a decodable QR, logs in and issues with equipment prefilled", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "master");
  const qr = page.getByRole("img", { name: "QR-код оборудования", exact: true });
  await expect(qr).toBeVisible();
  const pixels = await qr.evaluate(async (image) => {
    const img = image as HTMLImageElement;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.getBoundingClientRect().width);
    canvas.height = canvas.width;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  expect(decoded?.data).toBe(new URL(equipmentPath, info.project.use.baseURL).href);
  await page.screenshot({ path: info.outputPath("qr-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await qr.evaluate((image) => image.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: info.outputPath("qr-mobile.png") });
  // Print CSS must show the equipment label without the surrounding private workspace.
  await page.emulateMedia({ media: "print" });
  await expect(qr).toBeVisible();
  await expect(page.locator(".side-nav")).toBeHidden();
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath("qr-print.png"), fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.goto(equipmentPath);
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "Участок", exact: true })).toHaveValue(state.area_id);
  await expect(dialog.getByRole("combobox", { name: "Оборудование", exact: true })).toHaveValue(
    state.equipment_id,
  );
  await expect(dialog.getByRole("combobox", { name: "Исполнитель", exact: true })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "Описание", exact: true }).fill("Осмотр по QR-коду оборудования");
  await dialog
    .getByRole("combobox", { name: "Исполнитель", exact: true })
    .selectOption(state.selected_executor_id);
  await dialog.getByRole("button", { name: "Через 2 часа", exact: true }).click();
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({
    area_id: state.area_id,
    equipment_id: state.equipment_id,
  });
  expect(errors).toEqual([]);
});

for (const role of ["executor", "manager", "admin"] as const) {
  test(`${role}: QR opens only the permitted equipment actions`, async ({ page }) => {
    await login(page, role);
    await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
    if (role === "executor" || role === "manager") {
      await page
        .getByRole("button", {
          name: role === "executor" ? "Мои наряды" : "Наряды оборудования",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(new RegExp("equipment_id=" + state.equipment_id));
    } else {
      await expect(page.getByRole("img", { name: "QR-код оборудования", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Наряды оборудования", exact: true })).toHaveCount(0);
    }
  });
}

test("foreign and nonexistent equipment links disclose no equipment and cannot issue", async ({
  page,
  request,
}) => {
  const auth = await adminToken(request);
  const headers = { Authorization: `Bearer ${auth}` };
  const areaResponse = await request.post("/api/v1/catalog/areas", {
    headers,
    data: { code: "QR-" + crypto.randomUUID().slice(0, 8), name: "Закрытый тестовый участок" },
  });
  expect(areaResponse.status()).toBe(201);
  const area = await areaResponse.json();
  const response = await request.post("/api/v1/catalog/equipment", {
    headers,
    data: {
      area_id: area.id,
      inventory_number: "QR-" + crypto.randomUUID().slice(0, 8),
      name: "Недоступная тестовая машина",
      equipment_type: "pump",
      criticality: 2,
    },
  });
  expect(response.status()).toBe(201);
  const equipment = await response.json();
  await login(page, "master", `/equipment/${equipment.id}`);
  await expect(page.getByRole("heading", { name: "Оборудование недоступно", exact: true })).toBeVisible();
  await expect(page.getByText("Недоступная тестовая машина", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
  await page.goto(`/equipment/${crypto.randomUUID()}`);
  await expect(page.getByRole("heading", { name: "Оборудование недоступно", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
});

test("archived equipment is readable by QR but cannot start a new repair", async ({ page, request }) => {
  const auth = await adminToken(request);
  const headers = { Authorization: `Bearer ${auth}` };
  const created = await request.post("/api/v1/catalog/equipment", {
    headers,
    data: {
      area_id: state.area_id,
      inventory_number: "QR-ARCH-" + crypto.randomUUID().slice(0, 8),
      name: "Архивная машина QR",
      equipment_type: "pump",
      criticality: 2,
    },
  });
  expect(created.status()).toBe(201);
  const machine = await created.json();
  const archived = await request.patch(`/api/v1/catalog/equipment/${machine.id}`, {
    headers,
    data: { is_active: false },
  });
  expect(archived.status()).toBe(200);
  await login(page, "master", `/equipment/${machine.id}`);
  await expect(page.getByRole("heading", { name: new RegExp("Архивная машина QR") })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
  await expect(page.getByText(/В архиве/).first()).toBeVisible();
});

test("session expiry keeps equipment link for re-login while clearing private session", async ({
  page,
  request,
}) => {
  await login(page, "master");
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem("naryadai.session.token"));
  const revoked = await request.post("/api/v1/auth/logout", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(204);
  await expect(page.getByRole("heading", { name: "Вход в смену", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(equipmentPath + "$"));
  expect(await page.evaluate(() => sessionStorage.getItem("naryadai.session.token"))).toBeNull();
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(equipmentPath + "$"));
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("QR from directory can be downloaded and clipboard denial is handled", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await login(page, "admin");
  await page.goto("/reference/equipment");
  await page.getByRole("button", { name: "QR-код", exact: true }).first().click();
  await expect(page).toHaveURL(/\/equipment\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("img", { name: "QR-код оборудования", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Копировать ссылку", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Не удалось скопировать" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать QR-код", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-qr\.svg$/);
  expect(await download.failure()).toBeNull();
  await page.goto("/reference/equipment");
  await expect(page.getByRole("button", { name: "QR-код", exact: true }).first()).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "QR-код", exact: true }).first()).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  expect(errors).toEqual([]);
});

test("leaving the QR page and returning does not reopen the previous issue form", async ({ page }) => {
  await login(page, "master", "/reference/equipment");
  await page.getByRole("button", { name: "QR-код", exact: true }).first().click();
  await expect(page).toHaveURL(/\/equipment\/[0-9a-f-]{36}$/);
  const destination = page.url();
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/reference\/equipment$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
