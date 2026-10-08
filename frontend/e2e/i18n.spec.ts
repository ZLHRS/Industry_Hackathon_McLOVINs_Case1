import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translations } from "../src/lib/translations";

// Read-only smoke tests against the isolated E2E server. All work-order writes are intercepted.
test.use({ screenshot: "off", trace: "off" });
const languageLabel = "Язык / Тіл / Language";
const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8")) as {
  secret: string;
  master_login: string;
  executor_login: string;
  manager_login: string;
  admin_login: string;
};
const copy = {
  ru: {
    signIn: "Войти",
    login: "Логин",
    password: "Пароль",
    orders: "Наряды участка",
    issue: "Выдать наряд",
    description: "Описание",
    close: "Закрыть",
  },
  kk: {
    signIn: "Кіру",
    login: "Логин",
    password: "Пароль",
    orders: "Учаске нарядтары",
    issue: "Наряд беру",
    description: "Сипаттама",
    close: "Жабу",
  },
  en: {
    signIn: "Sign in",
    login: "Login",
    password: "Password",
    orders: "Area work orders",
    issue: "Issue work order",
    description: "Description",
    close: "Close",
  },
};
const additionalSettings = {
  ru: "Дополнительные параметры",
  kk: "Қосымша параметрлер",
  en: "Additional settings",
};
type Language = keyof typeof copy;
async function switchLanguage(page: Page, language: Language) {
  const toggle = page.getByTestId("app-preferences-toggle");
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await page.getByTestId("app-preferences-panel").getByLabel(languageLabel).selectOption(language);
    await toggle.click();
  } else {
    await page.locator(".language-switcher select:visible").selectOption(language);
  }
  await expect(page.locator("html")).toHaveAttribute("lang", language);
}
async function login(page: Page, account: string, language: Language = "ru") {
  await page.goto("/");
  await switchLanguage(page, language);
  await page.getByLabel(copy[language].login, { exact: true }).fill(account);
  await page.getByLabel(copy[language].password, { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: copy[language].signIn, exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("languages persist without clearing login inputs, including mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("master.sadykov");
  await page.getByLabel("Пароль", { exact: true }).fill("not-submitted");
  for (const language of ["kk", "en", "ru"] as const) {
    await switchLanguage(page, language);
    await expect(page.getByRole("button", { name: copy[language].signIn, exact: true })).toBeVisible();
    await expect(page.getByLabel(copy[language].login, { exact: true })).toHaveValue("master.sadykov");
    await expect(page.getByLabel(copy[language].password, { exact: true })).toHaveValue("not-submitted");
    await noOverflow(page);
  }
  await switchLanguage(page, "kk");
  await page.reload();
  await expect(page.getByRole("button", { name: "Кіру", exact: true })).toBeVisible();
});

function localized(key: string, language: Language) {
  return language === "ru" ? key : (translations[key]?.[language] ?? key);
}

for (const language of ["ru", "kk", "en"] as const) {
  test(`${language}: order form uses the chosen language without its own switcher`, async ({ page }) => {
    const writes: Record<string, unknown>[] = [];
    await page.route("**/api/v1/work-orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      writes.push(route.request().postDataJSON());
      await route.fulfill({ status: 422, json: { detail: "i18n_test_no_write" } });
    });
    await login(page, state.master_login, language);
    await page.getByRole("button", { name: copy[language].issue, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".language-switcher")).toHaveCount(0);
    await dialog.getByText(additionalSettings[language], { exact: true }).click();
    const draft = "Қазақша тапсырма / English / Русский — <test>";
    await dialog.getByRole("textbox", { name: copy[language].description, exact: true }).fill(draft);
    const equipment = dialog.getByRole("combobox", {
      name: localized("Оборудование", language),
      exact: true,
    });
    await equipment.selectOption({ index: 1 });
    const equipmentId = await equipment.inputValue();
    const technician = dialog.getByRole("combobox", {
      name: localized("Исполнитель", language),
      exact: true,
    });
    const employeeId = await technician
      .locator("option:not([disabled])")
      .evaluateAll((options) => (options as HTMLOptionElement[]).find((option) => option.value)?.value);
    if (!employeeId) throw new Error("No isolated fixture technician available");
    await technician.selectOption(employeeId);
    await dialog.getByRole("button", { name: localized("Через 1 час", language), exact: true }).click();
    await dialog.getByRole("button", { name: copy[language].issue, exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      description: draft,
      equipment_id: equipmentId,
      executor_id: employeeId,
    });
    await expect(dialog.getByRole("textbox", { name: copy[language].description, exact: true })).toHaveValue(
      draft,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await dialog.getByRole("button", { name: copy[language].close, exact: true }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: copy[language].orders, exact: true })).toBeVisible();
  });

  test(`${language}: suggestions and failures follow the main menu language`, async ({ page }) => {
    await login(page, state.master_login);
    await switchLanguage(page, language);
    await page.getByRole("button", { name: copy[language].issue, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(additionalSettings[language], { exact: true }).click();
    await dialog
      .getByRole("combobox", { name: localized("Оборудование", language), exact: true })
      .selectOption({ index: 1 });
    const description = dialog.getByRole("textbox", { name: copy[language].description, exact: true });
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/work-orders/suggestions"),
    );
    await description.fill("Motor overheating / Қозғалтқыш қызып кетті");
    expect((await responsePromise).status()).toBe(200);
    await expect(dialog.locator(".advanced-fault-suggestions")).toBeVisible();
    if (language === "en")
      await expect(dialog.locator(".advanced-fault-suggestions")).toContainText("The word");
    if (language === "kk") await expect(dialog.locator(".advanced-fault-suggestions")).toContainText("сөзі");
    await page.route("**/api/v1/work-orders/suggestions", (route) =>
      route.fulfill({ status: 503, json: { detail: "test_unavailable" } }),
    );
    await description.fill("Motor overheating refreshed");
    const failures = {
      ru: "Подбор недоступен",
      kk: "Ұсыныстар қолжетімсіз",
      en: "Suggestions are unavailable",
    };
    await expect(dialog.getByRole("alert")).toContainText(failures[language]);
    await expect(dialog.locator(".language-switcher")).toHaveCount(0);
  });
}
for (const [role, account, routes] of [
  ["master", state.master_login, ["/orders", "/workload", "/reference", "/analytics"]],
  ["executor", state.executor_login, ["/orders", "/analytics"]],
  ["manager", state.manager_login, ["/orders", "/workload", "/analytics"]],
  ["admin", state.admin_login, ["/employees", "/reference"]],
] as const) {
  test(`${role}: all permitted screens in three languages on a phone`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, "en");
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator(".app-main h1")).toBeVisible();
      for (const language of ["en", "kk", "ru"] as const) {
        await switchLanguage(page, language);
        await noOverflow(page);
        await expect(page.locator(".app-main h1")).not.toBeEmpty();
      }
    }
    expect(errors).toEqual([]);
  });
}
