import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
const marker = crypto.randomUUID().slice(0, 8);
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Idempotency-Key": crypto.randomUUID(),
});
let master: string;
let brigadeId: string;
let responsibleId: string;
let juniorId: string;
let faultId: string;
let unmatchedId: string;
const code = `T-E-${marker}`;
const unmatchedCode = `T-U-${marker}`;
const description = `Осмотреть электрическую цепь, шифр ${code}`;

test.use({ hasTouch: true });
async function authenticate(request: APIRequestContext, login: string) {
  const response = await request.post("/api/v1/auth/login", { data: { login, secret: state.secret } });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}
async function login(page: Page) {
  await page.goto("/orders");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
}
async function openForm(page: Page) {
  await login(page);
  await page.getByRole("button", { name: "Выдать наряд", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId(`quick-equipment-${state.equipment_id}`).click();
  return dialog;
}
function recommendationResponse(page: Page, text: string) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/work-orders/brigade-options") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().description === text,
  );
}

test.beforeAll(async ({ request }) => {
  master = await authenticate(request, state.master_login);
  const admin = await authenticate(request, state.admin_login);
  const me = await (await request.get("/api/v1/auth/me", { headers: headers(master) })).json();
  for (const [faultCode, specialty] of [
    [code, "electrician"],
    [unmatchedCode, `automation_${marker}`],
  ]) {
    const response = await request.post("/api/v1/catalog/fault-codes", {
      headers: headers(admin),
      data: { code: faultCode, name: `Контроль ${faultCode}`, specialty },
    });
    expect(response.status()).toBe(201);
    if (faultCode === code) faultId = (await response.json()).id;
    else unmatchedId = (await response.json()).id;
  }
  for (const trade of ["mechanic", "electrician"]) {
    const response = await request.post("/api/v1/catalog/brigades", {
      headers: headers(admin),
      data: {
        code: `000-${trade === "mechanic" ? "A" : "B"}-${marker}`,
        name: trade === "electrician" ? "Электрики участка" : "Механики участка",
      },
    });
    expect(response.status()).toBe(201);
    const team = (await response.json()).id;
    if (trade === "electrician") brigadeId = team;
    for (let i = 0; i < 2; i++) {
      const employee = await request.post("/api/v1/catalog/employees", {
        headers: headers(admin),
        data: {
          login: `ranking.${marker}.${trade}.${i}`,
          display_name: i ? "Юрий Опытный" : "Алексей Начинающий",
          role: "executor",
          specialty: trade,
          grade: i ? 6 : 3,
          brigade_id: team,
          area_ids: me.area_ids,
          secret: state.secret,
        },
      });
      expect(employee.status()).toBe(201);
      const id = (await employee.json()).id;
      if (trade === "electrician") {
        if (i) responsibleId = id;
        else juniorId = id;
      }
    }
  }
});

for (const width of [390, 1440]) {
  test(`contextual brigade and qualified responsible still issue in six taps (${width}px)`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.evaluate(() => {
      document.documentElement.dataset.issueTaps = "0";
      document.addEventListener("click", () => {
        document.documentElement.dataset.issueTaps = String(
          Number(document.documentElement.dataset.issueTaps) + 1,
        );
      });
    });
    await page.getByRole("button", { name: "Выдать наряд", exact: true }).tap();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId(`quick-equipment-${state.equipment_id}`).tap();
    const result = recommendationResponse(page, description);
    await dialog.getByLabel("Описание", { exact: true }).tap();
    await page.keyboard.insertText(description);
    const response = await result;
    expect(response.status()).toBe(200);
    const recommendation = await response.json();
    expect(recommendation.context.specialty).toBe("electrician");
    expect(recommendation.context.specialty_source).toBe("inferred");
    expect(recommendation.items[0].brigade.id).toBe(brigadeId);
    expect(recommendation.items[0].suggested_responsible_id).toBe(responsibleId);
    expect(recommendation.items[0].recommended).toBe(true);
    const choice = dialog.getByTestId(`quick-brigade-${brigadeId}`);
    await expect(choice).toContainText("Юрий Опытный");
    await expect(dialog.getByTestId(`brigade-responsible-summary-${brigadeId}`)).toContainText("6");
    await choice.tap();
    await dialog.getByTestId("quick-deadline-2h").tap();
    await choice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`brigade-ranked-${width}.png`) });
    const issued = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/work-orders") && r.request().method() === "POST",
    );
    await dialog.getByTestId("quick-submit-order").tap();
    const saved = await issued;
    expect(saved.status()).toBe(201);
    expect(await page.evaluate(() => Number(document.documentElement.dataset.issueTaps))).toBe(6);
    const id = (await saved.json()).order_id;
    const order = await (await request.get(`/api/v1/work-orders/${id}`, { headers: headers(master) })).json();
    expect(order.brigade.id).toBe(brigadeId);
    expect(order.executor_id).toBe(responsibleId);
    expect(order.participants.map((member: { employee_id: string }) => member.employee_id).sort()).toEqual(
      [juniorId, responsibleId].sort(),
    );
    const cancelled = await request.post(`/api/v1/work-orders/${id}/actions`, {
      headers: headers(master),
      data: { action: "cancel", expected_version: order.version, reason: "Проверка рекомендации завершена" },
    });
    expect(cancelled.status()).toBe(200);
  });
}

test("explanation is optional, confirms the fault and leaves responsible choice to the master", async ({
  page,
}, info) => {
  const dialog = await openForm(page);
  const initial = recommendationResponse(page, description);
  await dialog.getByLabel("Описание", { exact: true }).fill(description);
  await initial;
  const choice = dialog.getByTestId(`quick-brigade-${brigadeId}`);
  const why = dialog.getByTestId(`brigade-why-${brigadeId}`);
  await expect(dialog.getByTestId(`brigade-reasons-${brigadeId}`)).not.toBeVisible();
  await why.click();
  await expect(dialog.getByTestId(`brigade-reasons-${brigadeId}`)).toBeVisible();
  await expect(dialog.getByTestId(`brigade-reasons-${brigadeId}`)).toContainText("3");
  await page.screenshot({ path: info.outputPath("brigade-explanation-1440.png") });
  await choice.click();
  await dialog.getByText("Дополнительные параметры", { exact: true }).click();
  const confirmed = recommendationResponse(page, description);
  await dialog.getByRole("combobox", { name: "Шифр неисправности", exact: true }).selectOption(faultId);
  expect((await (await confirmed).json()).context.specialty_source).toBe("confirmed");
  await choice.click();
  const responsible = dialog.getByRole("combobox", { name: "Ответственный", exact: true });
  await responsible.selectOption(juniorId);
  await expect(responsible).toHaveValue(juniorId);
  await expect(dialog.getByTestId(`brigade-responsible-summary-${brigadeId}`)).toContainText(
    "Алексей Начинающий",
  );
  const rationale = dialog.getByTestId(`brigade-reasons-${brigadeId}`);
  await expect(rationale).toContainText("Ответственный выбран мастером.");
  await expect(rationale).not.toContainText("Выбран по текущей нагрузке");
  await rationale.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("brigade-manual-responsible-1440.png") });
});

test("late old recommendation cannot overwrite a newer no-specialist context", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route("**/api/v1/work-orders/brigade-options", async (route) => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().description !== description)
      return route.continue();
    const response = await route.fetch();
    reached();
    await held;
    await route.fulfill({ response });
  });
  const dialog = await openForm(page);
  try {
    await dialog.getByLabel("Описание", { exact: true }).fill(description);
    await intercepted;
    await dialog.getByText("Дополнительные параметры", { exact: true }).click();
    await dialog.getByRole("combobox", { name: "Шифр неисправности", exact: true }).selectOption(unmatchedId);
    const newerDescription = `Контроль ${unmatchedCode}`;
    const newer = recommendationResponse(page, newerDescription);
    await dialog.getByLabel("Описание", { exact: true }).fill(newerDescription);
    const data = await (await newer).json();
    expect(data.items.every((item: { recommended: boolean }) => !item.recommended)).toBe(true);
    const note = dialog.getByTestId("brigade-context-note");
    await expect(note).toContainText("Нет бригад");
    const late = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/work-orders/brigade-options") &&
        response.request().method() === "POST" &&
        response.request().postDataJSON().description === description &&
        !response.request().postDataJSON().fault_code_id,
    );
    release();
    await (await late).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect(note).toContainText("Нет бригад");
    await expect(dialog.locator('[data-testid^="quick-brigade-"][aria-pressed="true"]')).toHaveCount(0);
  } finally {
    release();
  }
});
