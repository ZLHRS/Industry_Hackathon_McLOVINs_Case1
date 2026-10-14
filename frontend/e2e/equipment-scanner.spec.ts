import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { qrSvgDataUrl } from "../src/lib/equipmentQr";

test.use({ reducedMotion: "reduce" });

const state = JSON.parse(readFileSync(new URL("../../tmp/e2e-server.json", import.meta.url), "utf8"));
const path = `/equipment/${state.equipment_id}`;
const scanName = "Сканировать QR оборудования";
async function login(page: Page, role = "executor") {
  await page.goto("/orders");
  await page.getByLabel("Логин", { exact: true }).fill(state[`${role}_login`]);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".topbar")).toBeVisible();
}
function qr(value = `https://technaryad.online${path}`) {
  return qrSvgDataUrl(value);
}
async function photo(page: Page, value: string) {
  await page.setContent(`<img alt="fixture" src="${qr(value)}" width="360" height="360">`);
  return page.getByAltText("fixture").screenshot();
}

test("phone-only shortcut precedes settings; camera decodes equipment QR and stops after navigation", async ({
  page,
}, info) => {
  await page.addInitScript(
    ({ imageUrl }) => {
      const state = window as unknown as { stopped: number; cameraOptions?: MediaStreamConstraints };
      state.stopped = 0;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          state.cameraOptions = constraints;
          const image = new Image();
          image.src = imageUrl;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 480;
          const draw = () => {
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, 640, 480);
            ctx.drawImage(image, 140, 60, 360, 360);
          };
          draw();
          const stream = canvas.captureStream(5);
          const timer = setInterval(draw, 200);
          const track = stream.getVideoTracks()[0];
          const stop = track.stop.bind(track);
          track.stop = () => {
            clearInterval(timer);
            state.stopped++;
            stop();
          };
          return stream;
        },
      });
    },
    { imageUrl: qr() },
  );
  await login(page);
  const toggle = page.getByRole("button", { name: scanName });
  await expect(toggle).toBeHidden();
  await page.screenshot({ animations: "disabled", path: info.outputPath("desktop-no-scanner.png") });
  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(toggle).toBeVisible();
    await page.screenshot({ animations: "disabled", path: info.outputPath(`header-${width}.png`) });
    const scan = (await toggle.boundingBox())!;
    const settings = (await page.getByTestId("app-preferences-toggle").boundingBox())!;
    expect(scan.x + scan.width).toBeLessThanOrEqual(settings.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ animations: "disabled", path: info.outputPath("phone-header.png") });
  await toggle.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: info.outputPath("phone-scanner.png") });
  await page.getByRole("button", { name: "Включить камеру", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Мои наряды", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { stopped: number }).stopped)).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as { cameraOptions: MediaStreamConstraints }).cameraOptions),
  ).toMatchObject({ audio: false, video: { facingMode: { ideal: "environment" } } });
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("phone-equipment.png"),
    fullPage: true,
  });
});

test("denied camera has photo fallback that decodes a real QR", async ({ page }, info) => {
  const buffer = await photo(page, `https://technaryad.online${path}`);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError");
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "master");
  await page.getByRole("button", { name: scanName }).click();
  await page.getByRole("button", { name: "Включить камеру", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Доступ к камере запрещён");
  await page.screenshot({ animations: "disabled", path: info.outputPath("phone-denied.png") });
  await page
    .getByLabel("Выбрать фото QR", { exact: true })
    .setInputFiles({ name: "equipment.png", mimeType: "image/png", buffer });
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole("button", { name: "Выдать наряд", exact: true })).toBeVisible();
});

test("foreign QR stays in scanner; corrupt image can be retried and closing restores focus", async ({
  page,
}) => {
  const foreign = await photo(page, `https://example.org${path}`);
  await page.setViewportSize({ width: 320, height: 740 });
  await login(page);
  await page.getByRole("button", { name: scanName }).click();
  const file = page.getByLabel("Выбрать фото QR", { exact: true });
  await file.setInputFiles({ name: "foreign.png", mimeType: "image/png", buffer: foreign });
  await expect(page.getByRole("alert")).toContainText("Это не QR оборудования ТехНаряда");
  await expect(page).toHaveURL(/\/orders$/);
  await file.setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toContainText("Не удалось прочитать изображение");
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.getByRole("button", { name: scanName })).toBeFocused();
});

test("closing before camera permission resolves stops the late stream", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { finishCamera: () => void; stopped: boolean };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          state.finishCamera = () =>
            resolve({
              getTracks: () => [
                {
                  stop: () => {
                    state.stopped = true;
                  },
                },
              ],
            });
        }),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: scanName }).click();
  await page.getByRole("button", { name: "Включить камеру", exact: true }).click();
  await expect(page.getByText("Включаем камеру…")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.evaluate(() => (window as unknown as { finishCamera: () => void }).finishCamera());
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { stopped: boolean }).stopped))
    .toBe(true);
  await expect(page).toHaveURL(/\/orders$/);
});
