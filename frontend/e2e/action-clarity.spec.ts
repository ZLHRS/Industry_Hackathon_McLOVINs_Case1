import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
test("master actions have isolated reasons and require explicit confirmation", async ({
  page,
  request,
}, info) => {
  const auth = await request.post("/api/v1/auth/login", {
    data: { login: state.master_login, secret: state.secret },
  });
  expect(auth.status()).toBe(200);
  const token = (await auth.json()).access_token;
  const headers = { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() };
  const description = `Проверка управления ${crypto.randomUUID().slice(0, 8)}`;
  const created = await request.post("/api/v1/work-orders", {
    headers,
    data: {
      work_type: "unplanned",
      priority: "normal",
      description,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).order_id;
  const read = async () => {
    const result = await request.get(`/api/v1/work-orders/${id}`, { headers });
    expect(result.status()).toBe(200);
    return result.json();
  };
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByText(description, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Изменить приоритет", { exact: true }).click();
  await dialog.getByLabel("Новый приоритет", { exact: true }).selectOption("high");
  await expect(dialog.getByRole("button", { name: "Сохранить приоритет", exact: true })).toBeDisabled();
  await dialog.getByLabel("Причина изменения приоритета", { exact: true }).fill("Требуется ускорить ремонт");
  expect((await read()).priority).toBe("normal");
  await dialog.getByRole("button", { name: "Сохранить приоритет", exact: true }).click();
  await expect.poll(async () => (await read()).priority).toBe("high");
  await dialog.getByText("Переназначить исполнителя", { exact: true }).click();
  const select = dialog.getByLabel("Новый исполнитель", { exact: true });
  const next = await select
    .locator("option")
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value).find(Boolean));
  expect(next).toBeTruthy();
  await select.selectOption(next!);
  await expect(dialog.getByRole("button", { name: "Переназначить", exact: true })).toBeDisabled();
  await dialog.getByLabel("Причина переназначения", { exact: true }).fill("Передача свободному исполнителю");
  expect((await read()).executor_id).toBe(state.selected_executor_id);
  await dialog.getByRole("button", { name: "Переназначить", exact: true }).click();
  await expect.poll(async () => (await read()).executor_id).toBe(next);
  await dialog.locator("summary").filter({ hasText: "Отменить наряд" }).click();
  await dialog.getByLabel("Причина отмены", { exact: true }).fill("Работы больше не требуются");
  await expect(dialog.getByRole("button", { name: "Отменить наряд", exact: true })).toBeDisabled();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByRole("heading", { name: "Управление мастера", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`master-actions-${width}.png`) });
    await dialog
      .locator("details.master-action-panel")
      .filter({ has: page.locator("summary", { hasText: "Изменить приоритет" }) })
      .screenshot({ path: info.outputPath(`priority-panel-${width}.png`) });
    await dialog
      .locator("details.master-action-danger")
      .screenshot({ path: info.outputPath(`cancel-panel-${width}.png`) });
  }
  await dialog.getByLabel("Я понимаю, что наряд будет отменён", { exact: true }).check();
  await dialog.getByRole("button", { name: "Отменить наряд", exact: true }).click();
  await expect.poll(async () => (await read()).status).toBe("cancelled");
  await expect(dialog.getByRole("heading", { name: "Управление мастера", exact: true })).toHaveCount(0);
});
