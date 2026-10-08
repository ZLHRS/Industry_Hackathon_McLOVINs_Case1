import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = JSON.parse(readFileSync(resolve(root, "tmp/e2e-server.json"), "utf8"));

async function login(page: Page, installBeforeLogin = false) {
  await page.goto("/");
  await expect(page.locator(".language-switcher")).toHaveCount(1);
  await expect(page.getByTestId("app-preferences-toggle")).toHaveCount(0);
  if (installBeforeLogin) await supplyInstallPrompt(page);
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
}

test("installation offered on login remains available after authentication", async ({ page }) => {
  await login(page, true);
  await page.getByTestId("app-preferences-toggle").click();
  await expect(
    page.getByTestId("app-preferences-panel").getByRole("button", {
      name: "Установить приложение",
      exact: true,
    }),
  ).toBeVisible();
});

async function supplyInstallPrompt(page: Page, fail = false) {
  // Browser-owned installation is represented by its event contract; this does
  // not install software or assert OS-level PWA installation.
  await page.evaluate((fail) => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        document.documentElement.dataset.installCalls = String(
          Number(document.documentElement.dataset.installCalls ?? 0) + 1,
        );
        if (fail) throw new Error("test install prompt failure");
      },
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    });
    window.dispatchEvent(event);
  }, fail);
}

test("one settings menu replaces page banners and dialog language controls", async ({ page }, info) => {
  await login(page);
  await supplyInstallPrompt(page);
  const toggle = page.getByTestId("app-preferences-toggle");
  const panel = page.getByTestId("app-preferences-panel");
  await expect(panel).toBeHidden();
  await expect(page.locator(".app-main .device-setup")).toHaveCount(0);
  await expect(page.locator(".app-main .language-switcher")).toHaveCount(0);
  await expect(page.locator(".language-switcher")).toHaveCount(1);
  await toggle.click();
  await expect(panel.getByRole("button", { name: "Установить приложение", exact: true })).toBeVisible();
  await expect(panel).toContainText("компьютере");
  await expect(panel).toContainText("телефоне");
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const installBox = await panel.locator(".device-setup").boundingBox();
  const languageBox = await panel.locator(".language-switcher").boundingBox();
  expect(installBox!.y + installBox!.height).toBeLessThanOrEqual(languageBox!.y);
  await page.screenshot({ path: info.outputPath("settings-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("settings-390.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await panel.getByLabel("Язык / Тіл / Language").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".language-switcher")).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const route of ["/workload", "/reference", "/analytics"]) {
    await page.goto(route);
    await expect(toggle).toBeVisible();
    await expect(page.locator(".language-switcher")).toHaveCount(1);
    await expect(page.locator(".app-main .device-setup")).toHaveCount(0);
  }
});

test("deferred installation survives a closed menu and dismissal stays in the browser", async ({ page }) => {
  await login(page);
  await supplyInstallPrompt(page);
  const toggle = page.getByTestId("app-preferences-toggle");
  const panel = page.getByTestId("app-preferences-panel");
  await toggle.click();
  await toggle.click();
  await toggle.click();
  await panel.getByRole("button", { name: "Установить приложение", exact: true }).click();
  await expect(panel).toContainText("Установка отменена");
  expect(await page.evaluate(() => document.documentElement.dataset.installCalls)).toBe("1");
  await expect(panel.getByRole("button", { name: "Установить приложение", exact: true })).toHaveCount(0);
  await expect(panel.locator(".language-switcher")).toBeVisible();
});

test("failed install is handled and appinstalled removes the install offer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await supplyInstallPrompt(page, true);
  await page.getByTestId("app-preferences-toggle").click();
  const panel = page.getByTestId("app-preferences-panel");
  await panel.getByRole("button", { name: "Установить приложение", exact: true }).click();
  await expect(panel).toContainText("Не удалось открыть установку");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(panel.getByRole("button", { name: "Установить приложение", exact: true })).toHaveCount(0);
  await expect(panel.locator(".language-switcher")).toBeVisible();
  expect(errors).toEqual([]);
});
