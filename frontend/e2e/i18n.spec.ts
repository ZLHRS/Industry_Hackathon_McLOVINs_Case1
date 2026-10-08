import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read-only smoke tests against the local demo. All work-order writes are intercepted.
test.use({ screenshot: "off", trace: "off" });
const languageLabel = "Язык / Тіл / Language";
const credentials = resolve(process.cwd(), "../var/docker/industrial-credentials.txt");
const password = () => {
  const result = /^Password: (.+)$/m.exec(readFileSync(credentials, "utf8"));
  if (!result) throw new Error("Local demo credentials are missing");
  return result[1].trim();
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
type Language = keyof typeof copy;
async function switchLanguage(page: Page, language: Language) {
  await page.locator(".language-switcher select:visible").first().selectOption(language);
  await expect(page.locator("html")).toHaveAttribute("lang", language);
}
async function login(page: Page, account: string, language: Language = "ru") {
  await page.goto("/");
  await switchLanguage(page, language);
  await page.getByLabel(copy[language].login, { exact: true }).fill(account);
  await page.getByLabel(copy[language].password, { exact: true }).fill(password());
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

test("switching an open order form preserves draft, identifiers and request payload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const writes: unknown[] = [];
  await page.route("**/api/v1/work-orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes.push(route.request().postDataJSON());
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: '{"detail":"i18n_test_no_write"}',
    });
  });
  await login(page, "master.sadykov");
  await expect(page.getByRole("heading", { name: copy.ru.orders, exact: true })).toBeVisible();
  await page.getByRole("button", { name: copy.ru.issue, exact: true }).click();
  const dialog = page.getByRole("dialog");
  const draft = "Қазақша тапсырма / English / Русский — <test>";
  await dialog.getByLabel("Описание", { exact: true }).fill(draft);
  const equipment = dialog.getByRole("combobox", { name: "Оборудование", exact: true });
  await equipment.selectOption({ index: 1 });
  const technician = dialog.getByRole("combobox", { name: "Исполнитель", exact: true });
  const employeeId = await technician
    .locator("option:not([disabled])")
    .evaluateAll((options) => (options as HTMLOptionElement[]).find((o) => o.value)?.value);
  if (!employeeId) throw new Error("No demo technician available");
  await technician.selectOption(employeeId);
  await dialog.getByRole("button", { name: "Через 1 час", exact: true }).click();
  for (const language of ["ru", "kk", "en"] as const) {
    await dialog.getByLabel(languageLabel).selectOption(language);
    await expect(dialog.getByRole("textbox", { name: copy[language].description, exact: true })).toHaveValue(
      draft,
    );
    await dialog.getByRole("button", { name: copy[language].issue, exact: true }).click();
    await expect.poll(() => writes.length).toBe(["ru", "kk", "en"].indexOf(language) + 1);
  }
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[1]).toEqual(writes[2]);
  expect((writes[0] as { description: string }).description).toBe(draft);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await expect(dialog.getByLabel(languageLabel)).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: copy.en.orders, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("suggestions localize immediately and invalidate old results without clearing the draft", async ({
  page,
}) => {
  await login(page, "master.sadykov");
  await page.getByRole("button", { name: copy.ru.issue, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Оборудование", exact: true }).selectOption({ index: 1 });
  const draft = "Motor overheating / Қозғалтқыш қызып кетті";
  await dialog.getByRole("textbox", { name: "Описание", exact: true }).fill(draft);
  const responsePromise = page.waitForResponse((r) => r.url().endsWith("/work-orders/suggestions"));
  await dialog.getByRole("button", { name: "Подобрать по описанию", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect((await response.json()).faults.length).toBeGreaterThan(0);
  for (const [language, choose] of [
    ["en", "Choose code"],
    ["kk", "Кодты таңдау"],
    ["ru", "Выбрать шифр"],
  ] as const) {
    await dialog.getByLabel(languageLabel).selectOption(language);
    await expect(dialog.getByRole("button", { name: choose, exact: true }).first()).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: copy[language].description, exact: true })).toHaveValue(
      draft,
    );
    if (language === "en") await expect(dialog.locator(".suggestion-results")).toContainText("The word");
    if (language === "kk") await expect(dialog.locator(".suggestion-results")).toContainText("сөзі");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
  }
  const description = dialog.getByRole("textbox", { name: "Описание", exact: true });
  await description.fill(draft + " changed");
  await description.fill(draft);
  await expect(dialog.getByRole("button", { name: "Выбрать шифр", exact: true })).toHaveCount(0);
  await expect(
    dialog.getByText("Данные изменились. Подберите варианты снова.", { exact: true }),
  ).toBeVisible();
  await page.route("**/api/v1/work-orders/suggestions", (route) =>
    route.fulfill({ status: 503, json: { detail: "test_unavailable" } }),
  );
  await dialog.getByRole("button", { name: "Подобрать по описанию", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Подбор недоступен");
  await dialog.getByLabel(languageLabel).selectOption("en");
  await expect(dialog.getByRole("alert")).toContainText("Suggestions are unavailable");
  await expect(dialog.getByRole("textbox", { name: copy.en.description, exact: true })).toHaveValue(draft);
});

for (const [role, account, routes] of [
  ["master", "master.sadykov", ["/orders", "/workload", "/reference", "/analytics"]],
  ["executor", "exec.amanov", ["/orders", "/analytics"]],
  ["manager", "manager.tulegen", ["/orders", "/workload", "/analytics"]],
  ["admin", "admin.karim", ["/employees", "/reference"]],
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
