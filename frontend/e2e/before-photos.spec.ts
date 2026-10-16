import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));
const consent = "На фото только оборудование, личные и конфиденциальные данные скрыты. Разрешить анализ ИИ.";
// A valid 8x8 PNG. Keeping it in-memory exercises the browser's native file input without a fixture dependency.
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGPcF6XBgA0wYRUdtBIA/x4BUEggtekAAAAASUVORK5CYII=",
  "base64",
);

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
}

async function fillRequiredFields(page: Page, description: string) {
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[data-testid^="quick-equipment-"]').first().click();
  await dialog.getByLabel("Описание", { exact: true }).fill(description);
  await dialog.locator('[data-testid^="quick-executor-"]:not(:disabled)').first().click();
  await dialog.getByTestId("quick-deadline-2h").click();
  await expect(dialog.getByTestId("quick-order-summary")).toBeVisible();
  return dialog;
}

function imageFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `fault-${index + 1}.png`,
    mimeType: "image/png",
    buffer: tinyPng,
  }));
}

function workOrderPost(request: import("@playwright/test").Request) {
  const url = new URL(request.url());
  return request.method() === "POST" && url.pathname === "/api/v1/work-orders";
}

test.describe("before photos while issuing an order", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("caps picker at five and persists opted-in before photos after the order is created", async ({
    page,
  }, info) => {
    await login(page);
    const description = `Фото до ремонта ${crypto.randomUUID().slice(0, 8)}`;
    const dialog = await fillRequiredFields(page, description);
    const picker = dialog.locator('.before-photo-picker input[type="file"]');
    await picker.setInputFiles(imageFiles(6));

    await expect(dialog.getByText("Фото: 5 из 5", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Можно приложить до 5 фото.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("img", { name: /^Фото неисправности \d$/ })).toHaveCount(5);
    await dialog.getByLabel(consent, { exact: true }).check();
    await page.screenshot({
      path: info.outputPath("before-photos-picker-390.png"),
      fullPage: true,
    });

    const creates: import("@playwright/test").Request[] = [];
    const uploads: import("@playwright/test").Request[] = [];
    page.on("request", (request) => {
      if (workOrderPost(request)) creates.push(request);
      const url = new URL(request.url());
      if (request.method() === "POST" && /\/api\/v1\/work-orders\/[^/]+\/photos$/.test(url.pathname)) {
        uploads.push(request);
      }
    });
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/work-orders",
    );
    await dialog.getByTestId("quick-submit-order").click();
    const createResponse = await created;
    expect(createResponse.status()).toBe(201);
    const orderId = (await createResponse.json()).order_id as string;
    await expect(dialog).toBeHidden();

    expect(creates).toHaveLength(1);
    expect(uploads).toHaveLength(5);
    for (const request of uploads) {
      const url = new URL(request.url());
      expect(url.searchParams.get("kind")).toBe("before");
      expect(url.searchParams.get("ai_share_allowed")).toBe("true");
      expect(request.headers()["content-type"]).toContain("image/png");
    }

    const token = await page.evaluate(
      () => JSON.parse(localStorage.getItem("naryadai.session.v1") ?? "null")?.token ?? null,
    );
    const stored = await page.request.get(`/api/v1/work-orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stored.status()).toBe(200);
    const order = await stored.json();
    expect(order.description).toBe(description);
    expect(order.photos).toHaveLength(5);
    const image = await page.request.get(order.photos[0].content_url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toMatch(/^image\//);
    expect((await image.body()).length).toBe(order.photos[0].size_bytes);
    expect(order.photos[0].size_bytes).toBeGreaterThan(0);
    expect(order.photos).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "before", ai_share_allowed: true })]),
    );
    expect(
      order.photos.every((photo: { kind: string; ai_share_allowed: boolean }) => photo.kind === "before"),
    ).toBe(true);
    expect(
      order.photos.every((photo: { kind: string; ai_share_allowed: boolean }) => photo.ai_share_allowed),
    ).toBe(true);
  });

  test("a failed before-photo upload keeps the created order and shows a recovery warning", async ({
    page,
  }) => {
    await login(page);
    const description = `Фото не загружено ${crypto.randomUUID().slice(0, 8)}`;
    const dialog = await fillRequiredFields(page, description);
    await dialog.locator('.before-photo-picker input[type="file"]').setInputFiles(imageFiles(1));

    let creates = 0;
    page.on("request", (request) => {
      if (workOrderPost(request)) creates += 1;
    });
    await page.route(/\/api\/v1\/work-orders\/[^/]+\/photos\?/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "photo_storage_unavailable" }),
      });
    });
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/work-orders",
    );
    await dialog.getByTestId("quick-submit-order").click();
    const createResponse = await created;
    expect(createResponse.status()).toBe(201);
    const orderId = (await createResponse.json()).order_id as string;
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("Наряд выдан, но фото не загружено. Добавьте фото в карточке наряда.", { exact: true }),
    ).toBeVisible();
    expect(creates).toBe(1);

    const token = await page.evaluate(
      () => JSON.parse(localStorage.getItem("naryadai.session.v1") ?? "null")?.token ?? null,
    );
    const stored = await page.request.get(`/api/v1/work-orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stored.status()).toBe(200);
    const order = await stored.json();
    expect(order.description).toBe(description);
    expect(order.photos).toEqual([]);
  });
});
