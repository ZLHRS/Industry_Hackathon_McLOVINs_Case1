import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Выйти/ })).toBeVisible();
}

async function fillQuickForm(page: Page) {
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[data-testid^="quick-equipment-"]').first().click();
  await dialog
    .getByLabel("Описание", { exact: true })
    .fill("Осмотреть привод и проверить крепление ограждения");
  await dialog.locator('[data-testid^="quick-executor-"]:not(:disabled)').first().click();
  await dialog.getByTestId("quick-deadline-2h").click();
  return dialog;
}

test.describe("mobile quick issuance", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("six interface taps create a persisted order with all required fields", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(page);
    // Count real pointer activations, including opening the form and submitting.
    // Text is inserted after a real focus tap; software keyboard taps, scrolling,
    // login and optional parameter edits are outside this explicitly defined metric.
    await page.evaluate(() => {
      document.documentElement.dataset.issueTaps = "0";
      document.addEventListener("click", () => {
        document.documentElement.dataset.issueTaps = String(
          Number(document.documentElement.dataset.issueTaps) + 1,
        );
      });
    });
    const start = Date.now();
    await page.getByRole("button", { name: "Выдать наряд", exact: true }).tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid^="quick-equipment-"]').first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("quick-open-390.png") });
    const equipment = dialog.locator('[data-testid^="quick-equipment-"]').first();
    const equipmentId = (await equipment.getAttribute("data-testid"))!.replace("quick-equipment-", "");
    await equipment.tap();
    const description = `Осмотреть привод и проверить крепление ограждения ${crypto.randomUUID().slice(0, 8)}`;
    await dialog.getByLabel("Описание", { exact: true }).tap();
    await page.keyboard.insertText(description);
    const executor = dialog.locator('[data-testid^="quick-executor-"]:not(:disabled)').first();
    await expect(executor).toBeVisible();
    const executorId = (await executor.getAttribute("data-testid"))!.replace("quick-executor-", "");
    await executor.tap();
    await dialog.getByTestId("quick-deadline-2h").tap();
    await dialog.getByTestId("quick-submit-order").scrollIntoViewIfNeeded();
    await expect(dialog.getByTestId("quick-order-summary")).toBeVisible();
    await page.screenshot({ path: info.outputPath("quick-ready-390.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const createdPromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/v1/work-orders") && response.request().method() === "POST",
    );
    await dialog.getByTestId("quick-submit-order").tap();
    const response = await createdPromise;
    expect(response.status()).toBe(201);
    const taps = await page.evaluate(() => Number(document.documentElement.dataset.issueTaps));
    expect(taps).toBe(6);
    const payload = response.request().postDataJSON();
    expect(payload).toMatchObject({
      description,
      equipment_id: equipmentId,
      executor_id: executorId,
      work_type: "unplanned",
      priority: "normal",
    });
    expect(payload.area_id).toBeTruthy();
    expect(new Date(payload.deadline).getTime()).toBeGreaterThan(Date.now());
    const orderId = (await response.json()).order_id;
    const stored = await page.request.get(`/api/v1/work-orders/${orderId}`, {
      headers: { Authorization: response.request().headers()["authorization"] },
    });
    expect(stored.status()).toBe(200);
    expect(await stored.json()).toMatchObject({
      equipment_id: equipmentId,
      executor_id: executorId,
      area_id: payload.area_id,
      description,
    });
    await expect(dialog).toBeHidden();
    await info.attach("interaction-count.json", {
      body: JSON.stringify(
        {
          interfaceTaps: taps,
          automationElapsedMs: Date.now() - start,
          viewport: "390x844",
          excludes: ["login", "text keystrokes", "keyboard dismissal", "scroll gestures", "optional changes"],
          physicalPhoneMeasured: false,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });
});

test("pending issuance cannot create duplicate orders", async ({ page }) => {
  await login(page);
  const dialog = await fillQuickForm(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/api/v1/work-orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const submitted = page.waitForRequest(
      (request) => request.url().endsWith("/api/v1/work-orders") && request.method() === "POST",
    );
    await dialog.getByTestId("quick-submit-order").click();
    await submitted;
    await expect(dialog.getByTestId("quick-submit-order")).toBeDisabled();
    await page.keyboard.press("Enter");
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(dialog).toBeHidden();
  expect(requests).toBe(1);
});

test("clearing description cancels pending suggestion indicators and ignores the late reply", async ({
  page,
}) => {
  await login(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/work-orders/suggestions", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        faults: [],
        executors: [],
        notes: [],
        selected_norm_minutes: null,
        required_specialty: null,
      }),
    });
  });
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[data-testid^="quick-equipment-"]').first().click();
  try {
    await dialog.getByLabel("Описание", { exact: true }).fill("Проверить крепление");
    await expect(dialog.getByText("Подбираем…", { exact: true })).toBeVisible();
    await dialog.getByLabel("Описание", { exact: true }).fill("");
    await expect(dialog.getByText("Подбираем…", { exact: true })).toBeHidden();
    const settled = page.waitForResponse((response) => response.url().endsWith("/work-orders/suggestions"));
    release();
    await settled;
    await expect(dialog.getByText("Подбираем…", { exact: true })).toBeHidden();
    await expect(dialog.locator('[data-testid^="quick-executor-"]')).toHaveCount(0);
  } finally {
    release();
  }
});

test("equipment changes invalidate the chosen executor and missing fields cannot submit", async ({
  page,
}, info) => {
  await login(page);
  const dialog = await fillQuickForm(page);
  const selected = dialog.locator('[data-testid^="quick-executor-"][aria-pressed="true"]');
  await expect(selected).toHaveCount(1);
  const otherEquipment = dialog.locator('[data-testid^="quick-equipment-"][aria-pressed="false"]').first();
  await otherEquipment.click();
  await expect(selected).toHaveCount(0);
  // Native/custom validation must prevent a POST with the now missing explicit choice.
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/work-orders") && request.method() === "POST") requests += 1;
  });
  const submit = dialog.getByTestId("quick-submit-order");
  if (await submit.isEnabled()) await submit.click();
  await expect(dialog).toBeVisible();
  expect(requests).toBe(0);
  for (const width of [1440, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByLabel("Описание", { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`quick-${width}.png`) });
  }
});
