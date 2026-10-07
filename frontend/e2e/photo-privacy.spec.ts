import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const state = JSON.parse(readFileSync(resolve("../tmp/e2e-server.json"), "utf8"));
const consent = "На фото только оборудование, личные и конфиденциальные данные скрыты. Разрешить анализ ИИ.";
async function prepare(page: Page, request: APIRequestContext) {
  const auth = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(auth.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await auth.json()).access_token}` };
  const title = `Фото и приватность ${crypto.randomUUID().slice(0, 8)}`;
  const created = await request.post("/api/v1/work-orders", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: {
      work_type: "unplanned",
      priority: "normal",
      description: title,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).order_id as string;
  const order = async () => (await request.get(`/api/v1/work-orders/${id}`, { headers })).json();
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByText(title, { exact: true }).click();
  return {
    id,
    headers,
    order,
    detail: page.getByRole("dialog"),
    cleanup: async () => {
      const current = await order();
      const result = await request.post(`/api/v1/work-orders/${id}/actions`, {
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        data: {
          action: "cancel",
          expected_version: current.version,
          reason: "Завершена изолированная проверка фото",
        },
      });
      expect(result.ok()).toBeTruthy();
    },
  };
}
async function image(page: Page, noisy = false) {
  const data = await page.evaluate((noise) => {
    const canvas = document.createElement("canvas");
    canvas.width = noise ? 3000 : 320;
    canvas.height = noise ? 2000 : 640;
    const ctx = canvas.getContext("2d")!;
    if (noise) {
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 721;
      for (let i = 0; i < pixels.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          seed = (1664525 * seed + 1013904223) >>> 0;
          pixels.data[i + c] = seed >>> 24;
        }
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
    } else {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL("image/jpeg", 0.95).split(",")[1];
  }, noisy);
  return Buffer.from(data, "base64");
}
async function mask(page: Page) {
  await page.getByText("Ввести область скрытия точно", { exact: true }).click();
  for (const [label, value] of [
    ["X, %", "10"],
    ["Y, %", "10"],
    ["Ширина, %", "30"],
    ["Высота, %", "30"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Добавить область", exact: true }).click();
}
test("portrait masking preserves geometry and stores blackened pixels without AI consent", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const flow = await prepare(page, request);
  try {
    await flow.detail
      .getByLabel("Фотография", { exact: true })
      .setInputFiles({ name: "portrait.jpg", mimeType: "image/jpeg", buffer: await image(page) });
    await expect(flow.detail.getByLabel(consent, { exact: true })).not.toBeChecked();
    await mask(page);
    const stage = flow.detail.locator(".photo-redaction-stage");
    const box = await stage.boundingBox();
    expect(box!.height / box!.width).toBeGreaterThan(1.9);
    await stage.screenshot({ path: info.outputPath("portrait-mask.png") });
    await flow.detail.getByRole("button", { name: "Загрузить фото", exact: true }).click();
    await expect.poll(async () => (await flow.order()).photos.length).toBe(1);
    const photo = (await flow.order()).photos[0];
    expect(photo.ai_share_allowed).toBe(false);
    const response = await request.get(photo.content_url, { headers: flow.headers });
    expect(response.ok()).toBeTruthy();
    const pixels = await page.evaluate(
      async (base64) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/jpeg;base64,${base64}`)).blob(),
        );
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        return [0.25, 0.7].map((ratio) =>
          Array.from(
            ctx.getImageData(Math.floor(bitmap.width * ratio), Math.floor(bitmap.height * ratio), 1, 1).data,
          ).slice(0, 3),
        );
      },
      (await response.body()).toString("base64"),
    );
    expect(pixels[0].every((v) => v < 20)).toBe(true);
    expect(pixels[1].every((v) => v > 235)).toBe(true);
  } finally {
    await flow.cleanup();
  }
});
test("masking fails closed when image processing is unavailable", async ({ page, request }) => {
  const flow = await prepare(page, request);
  try {
    const buffer = await image(page);
    await page.evaluate(() =>
      Object.defineProperty(window, "createImageBitmap", { value: undefined, configurable: true }),
    );
    await flow.detail
      .getByLabel("Фотография", { exact: true })
      .setInputFiles({ name: "portrait.jpg", mimeType: "image/jpeg", buffer });
    await mask(page);
    await flow.detail.getByLabel(consent, { exact: true }).check();
    await flow.detail.getByRole("button", { name: "Загрузить фото", exact: true }).click();
    await expect(
      page.getByText("Фото не загружено. Проверьте тип, размер, соединение и доступ.", { exact: true }),
    ).toBeVisible();
    expect((await flow.order()).photos).toHaveLength(0);
  } finally {
    await flow.cleanup();
  }
});
test("large camera photo uploads within ten seconds on a simulated 1 Mbps link", async ({
  page,
  request,
}, info) => {
  const flow = await prepare(page, request);
  const cdp = await page.context().newCDPSession(page);
  try {
    const buffer = await image(page, true);
    expect(buffer.byteLength).toBeGreaterThan(1200000);
    await flow.detail
      .getByLabel("Фотография", { exact: true })
      .setInputFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 2000000 / 8,
      uploadThroughput: 1000000 / 8,
      connectionType: "cellular3g",
    });
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input).includes("/photos?") && init?.body instanceof Blob)
          document.documentElement.dataset.uploadPayloadBytes = String(init.body.size);
        return original(input, init);
      };
    });
    const uploaded = page.waitForResponse(
      (r) => r.url().includes(`/work-orders/${flow.id}/photos?`) && r.request().method() === "POST",
    );
    const start = Date.now();
    await flow.detail.getByRole("button", { name: "Загрузить фото", exact: true }).click();
    const response = await uploaded;
    expect(response.status()).toBe(201);
    const elapsed = Date.now() - start;
    const sent = await page.evaluate(() => Number(document.documentElement.dataset.uploadPayloadBytes));
    expect(sent).toBeGreaterThan(0);
    const measurement = {
      simulated: true,
      physical_device: false,
      upload_bits_per_second: 1000000,
      latency_ms: 150,
      input_bytes: buffer.byteLength,
      sent_bytes: sent,
      elapsed_ms: elapsed,
    };
    writeFileSync(info.outputPath("photo-network-measurement.json"), JSON.stringify(measurement, null, 2));
    console.log("SIMULATED_PHOTO_UPLOAD", JSON.stringify(measurement));
    expect(sent).toBeLessThanOrEqual(600000);
    expect(elapsed).toBeLessThan(10000);
  } finally {
    await cdp.detach();
    await flow.cleanup();
  }
});
