import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = JSON.parse(readFileSync(resolve(project, "tmp/e2e-server.json"), "utf8")) as {
  secret: string;
  master_login: string;
  executor_login: string;
  selected_executor_id: string;
  area_id: string;
  equipment_id: string;
  fault_code_id: string;
};

const title = () => `AI-проверка E2E ${crypto.randomUUID().slice(0, 8)}`;

async function login(page: Page, account: string) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(account);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /Выйти/ })).toBeVisible();
}

async function token(request: APIRequestContext, account: string) {
  const response = await request.post("/api/v1/auth/login", {
    data: { login: account, secret: state.secret },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).access_token as string;
}

async function action(request: APIRequestContext, auth: string, id: string, body: Record<string, unknown>) {
  const response = await request.post(`/api/v1/work-orders/${id}/actions`, {
    headers: { Authorization: `Bearer ${auth}`, "Idempotency-Key": crypto.randomUUID() },
    data: body,
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function readOrder(request: APIRequestContext, auth: string, id: string) {
  const response = await request.get(`/api/v1/work-orders/${id}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function createManualReviewCandidate(request: APIRequestContext) {
  const master = await token(request, state.master_login);
  const executor = await token(request, state.executor_login);
  const description = title();
  const created = await request.post("/api/v1/work-orders", {
    headers: { Authorization: `Bearer ${master}`, "Idempotency-Key": crypto.randomUUID() },
    data: {
      work_type: "unplanned",
      priority: "high",
      description,
      area_id: state.area_id,
      equipment_id: state.equipment_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).order_id as string;
  const accepted = await action(request, executor, id, { action: "accept", expected_version: 1 });
  const started = await action(request, executor, id, {
    action: "start",
    expected_version: accepted.version,
  });
  await action(request, executor, id, {
    action: "complete",
    expected_version: started.version,
    completion: {
      work_description: "Выполнена проверка агрегата, заменено уплотнение и восстановлена герметичность.",
      fault_code_id: state.fault_code_id,
      materials: [],
      no_materials_reason: "Для учебной проверки материалы не потребовались.",
    },
  });
  await expect
    .poll(async () => (await readOrder(request, master, id)).status, { timeout: 15_000 })
    .toBe("ai_review");
  const detail = await readOrder(request, master, id);
  const review = detail.reviews.find((item: { is_current: boolean }) => item.is_current);
  expect(review).toBeTruthy();
  expect(review.needs_master_review).toBe(true);
  return { id, description, master, review };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("master audits fallback AI review with a score and manual close", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const candidate = await createManualReviewCandidate(request);
  const originalAiScore = candidate.review.score;

  await login(page, state.master_login);
  await expect(page.getByText(candidate.description, { exact: true })).toBeVisible();
  await page.getByText(candidate.description, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /Нужна доработка|Принято|Вердикт/ })).toBeVisible();
  await expect(dialog.getByText(/Автоматическая проверка/).first()).toBeVisible();
  await expect(dialog.getByLabel("Оценка мастера (необязательно)", { exact: true })).toBeVisible();
  await dialog.getByLabel("Оценка мастера (необязательно)", { exact: true }).fill("4");
  await expect(dialog.getByRole("button", { name: "Закрыть вручную", exact: true })).toBeDisabled();
  await dialog.getByRole("region", { name: "Автоматическая проверка", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("ai-review-master-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await dialog.getByRole("region", { name: "Автоматическая проверка", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("ai-review-master-mobile.png"), fullPage: false });
  await dialog
    .getByLabel("Причина решения", { exact: true })
    .fill("Мастер проверил доказательства и подтверждает закрытие.");
  await expect(dialog.getByRole("button", { name: "Закрыть вручную", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Закрыть вручную", exact: true }).click();
  await expect
    .poll(async () => (await readOrder(request, candidate.master, candidate.id)).status)
    .toBe("closed");
  const closed = await readOrder(request, candidate.master, candidate.id);
  const review = closed.reviews.find((item: { is_current: boolean }) => item.is_current);
  expect(review.master_score).toBe(4);
  expect(review.score).toBe(originalAiScore);
  const events = await request.get(`/api/v1/work-orders/${candidate.id}/events`, {
    headers: { Authorization: `Bearer ${candidate.master}` },
  });
  expect(
    (await events.json()).items.find((item: { action: string }) => item.action === "override_close").reason,
  ).toMatch(/подтверждает закрытие/);
  expect(errors).toEqual([]);
});

test("master returns current review to rework and executor starts a clean attempt", async ({
  page,
  request,
}) => {
  const candidate = await createManualReviewCandidate(request);
  try {
    await login(page, state.master_login);
    await page.getByText(candidate.description, { exact: true }).click();
    const detail = page.getByRole("dialog");
    await detail
      .getByLabel("Причина решения", { exact: true })
      .fill("Нужно добавить фото результата и уточнить описание.");
    await detail.getByRole("button", { name: "Вернуть", exact: true }).click();
    await expect
      .poll(async () => (await readOrder(request, candidate.master, candidate.id)).status)
      .toBe("rework");
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("button", { name: /Выйти/ }).click();
    await login(page, state.executor_login);
    await page.getByText(candidate.description, { exact: true }).click();
    const executorDetail = page.getByRole("dialog");
    await expect(executorDetail.getByText(candidate.description, { exact: true })).toBeVisible();
    await expect(executorDetail.getByRole("button", { name: "Начать работу", exact: true })).toBeVisible();
    await executorDetail.getByRole("button", { name: "Начать работу", exact: true }).click();
    await expect
      .poll(async () => (await readOrder(request, candidate.master, candidate.id)).status)
      .toBe("in_progress");
    const restarted = await readOrder(request, candidate.master, candidate.id);
    expect(restarted.reviews.some((item: { is_current: boolean }) => item.is_current)).toBe(false);
    await expect(executorDetail.getByText("Отчёт для этой попытки ещё не сформирован.")).toBeVisible();
  } finally {
    const current = await readOrder(request, candidate.master, candidate.id);
    if (!["closed", "cancelled"].includes(current.status)) {
      await action(request, candidate.master, candidate.id, {
        action: "cancel",
        expected_version: current.version,
        reason: "Завершена изолированная браузерная проверка доработки.",
      });
    }
  }
});
