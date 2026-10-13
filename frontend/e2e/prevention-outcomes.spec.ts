import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tmp/e2e-server.json"), "utf8"));
const endpoint = "/api/v1/analytics/prevention-outcomes";
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Idempotency-Key": crypto.randomUUID(),
});

async function auth(request: APIRequestContext, login: string) {
  const result = await request.post("/api/v1/auth/login", { data: { login, secret: state.secret } });
  expect(result.status()).toBe(200);
  return (await result.json()).access_token as string;
}

async function openReport(page: Page, login = state.master_login) {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByTestId("app-preferences-toggle")).toBeVisible();
  await page
    .getByRole("button", { name: /^(ИИ-анализ|Мои результаты)$/ })
    .first()
    .click();
  await page.getByRole("combobox", { name: "Период", exact: true }).selectOption("month");
  const ready = page.waitForResponse(
    (r) => r.url().includes("/analytics/report") && r.url().includes("period=month"),
  );
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  expect((await ready).status()).toBe(200);
}

async function createPrevention(request: APIRequestContext) {
  const master = await auth(request, state.master_login);
  // Build an actual recurrence through the API; the calendar seed does not
  // guarantee a recurring-fault signal in every area on every run date.
  const executor = await auth(request, state.executor_login);
  for (const complete of [true, false]) {
    const repair = await request.post("/api/v1/work-orders", {
      headers: headers(master),
      data: {
        work_type: "unplanned",
        description: "Проверка уплотнения и устранение течи",
        priority: "normal",
        area_id: state.area_id,
        equipment_id: state.equipment_id,
        fault_code_id: state.fault_code_id,
        executor_id: state.selected_executor_id,
        deadline: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    expect(repair.status()).toBe(201);
    if (complete) {
      const repairId = (await repair.json()).order_id;
      let version = (await command(request, executor, repairId, { action: "accept", expected_version: 1 }))
        .version;
      version = (await command(request, executor, repairId, { action: "start", expected_version: version }))
        .version;
      await command(request, executor, repairId, {
        action: "complete",
        expected_version: version,
        completion: {
          work_description: "Проверено уплотнение, устранена течь, проверен результат",
          fault_code_id: state.fault_code_id,
          materials: [],
          no_materials_reason: "Регулировка без замены",
        },
      });
    }
  }
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Qostanay" }).format(new Date());
  const response = await request.get(
    `/api/v1/analytics/report?period=month&date=${date}&area_id=${state.area_id}`,
    { headers: headers(master) },
  );
  expect(response.status()).toBe(200);
  const report = await response.json();
  const anomaly = report.anomalies.find((a: { family: string }) => a.family === "recurring_fault");
  expect(anomaly).toBeTruthy();
  const prepared = await request.post("/api/v1/analytics/preventive-draft", {
    headers: headers(master),
    data: {
      family: anomaly.family,
      equipment_id: anomaly.evidence.equipment_id,
      order_ids: anomaly.evidence.order_ids,
      query: {
        period: "custom",
        from: report.period.from,
        to: report.period.to,
        timezone: report.period.timezone,
        area_ids: [state.area_id],
      },
    },
  });
  expect(prepared.status()).toBe(200);
  const draft = await prepared.json();
  const created = await request.post("/api/v1/work-orders", {
    headers: headers(master),
    data: {
      work_type: "planned",
      description: draft.description,
      priority: "planned",
      area_id: draft.area_id,
      equipment_id: draft.equipment_id,
      fault_code_id: draft.fault_code_id,
      executor_id: state.selected_executor_id,
      deadline: new Date(Date.now() + 3600000).toISOString(),
      prevention_source: draft.source,
    },
  });
  expect(created.status()).toBe(201);
  return { master, draft, id: (await created.json()).order_id as string };
}

async function command(request: APIRequestContext, token: string, id: string, data: Record<string, unknown>) {
  const result = await request.post(`/api/v1/work-orders/${id}/actions`, { headers: headers(token), data });
  expect(result.status()).toBe(200);
  return result.json();
}

for (const width of [1440, 390]) {
  test(`prevention tracks real acceptance and subsequent repeat (${width}px)`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { master, draft, id } = await createPrevention(request);
    let reads = 0;
    page.on("request", (r) => {
      if (r.url().includes(endpoint)) reads++;
    });
    await openReport(page);
    const panel = page.getByTestId("prevention-outcomes");
    await expect(panel).toBeVisible();
    expect(reads).toBe(0);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`collapsed-${width}.png`) });
    await panel.locator(":scope > summary").click();
    const card = panel.getByTestId(`prevention-outcome-${id}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Ожидает выполнения");

    const executor = await auth(request, state.executor_login);
    let version = (await command(request, executor, id, { action: "accept", expected_version: 1 })).version;
    version = (await command(request, executor, id, { action: "start", expected_version: version })).version;
    await command(request, executor, id, {
      action: "complete",
      expected_version: version,
      completion: {
        work_description: "Проверено уплотнение, устранена причина течи, проведена контрольная проверка.",
        fault_code_id: draft.fault_code_id,
        materials: [],
        no_materials_reason: "Регулировка без замены деталей",
      },
    });
    const read = async () =>
      (await request.get(`/api/v1/work-orders/${id}`, { headers: headers(master) })).json();
    await expect.poll(async () => (await read()).status).toBe("ai_review");
    await command(request, master, id, {
      action: "override_close",
      expected_version: (await read()).version,
      master_score: 4,
      reason: "Результат контрольной проверки принят мастером",
    });
    // Reopen requests a fresh observation without issuing or changing work.
    await panel.locator(":scope > summary").click();
    await panel.locator(":scope > summary").click();
    await expect(card).toContainText("Наблюдение продолжается");
    const repeat = await request.post("/api/v1/work-orders", {
      headers: headers(master),
      data: {
        work_type: "unplanned",
        description: "Повторная течь после контрольной проверки",
        priority: "normal",
        area_id: draft.area_id,
        equipment_id: draft.equipment_id,
        fault_code_id: draft.fault_code_id,
        executor_id: state.selected_executor_id,
        deadline: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    expect(repeat.status()).toBe(201);
    const repeatId = (await repeat.json()).order_id;
    await panel.locator(":scope > summary").click();
    await panel.locator(":scope > summary").click();
    await expect(card).toContainText("Повтор зарегистрирован");
    // Focus the disclosure itself: its now descriptive order link opens the order.
    await card.locator(":scope > details > summary").focus();
    await card.locator(":scope > details > summary").press("Space");
    await expect(card.locator(`a[href="/orders/${repeatId}"]`)).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`repeat-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await card.locator(`a[href="/orders/${id}"]`).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("outcomes error can retry; report stays usable; executor cannot access outcomes", async ({
  page,
  request,
}) => {
  await page.route(`**${endpoint}*`, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"unavailable"}' }),
  );
  await openReport(page, state.manager_login);
  const panel = page.getByTestId("prevention-outcomes");
  await panel.locator(":scope > summary").click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Применить", exact: true })).toBeEnabled();
  await page.unroute(`**${endpoint}*`);
  const loaded = page.waitForResponse((r) => r.url().includes(endpoint));
  await panel.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await loaded).status()).toBe(200);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  const executor = await auth(request, state.executor_login);
  const blocked = await request.get(`${endpoint}?period=month&date=2026-10-11`, {
    headers: headers(executor),
  });
  expect(blocked.status()).toBe(403);
  await page.getByRole("button", { name: /Выйти/ }).click();
  await openReport(page, state.executor_login);
  await expect(page.getByTestId("prevention-outcomes")).toHaveCount(0);
});

test("outcome display distinguishes completed observation from missing evidence and pages results", async ({
  page,
}, info) => {
  await openReport(page, state.manager_login);
  // Only the response display is simulated here. Time boundaries and evidence
  // correctness are covered against PostgreSQL in test_prevention_outcomes.py.
  const sample = {
    order_id: "sample",
    number: "ПР-100",
    issued_at: "2026-10-01T08:00:00Z",
    area_id: state.area_id,
    equipment_id: state.equipment_id,
    equipment_inventory_number: "НC-021",
    equipment_name: "Насос оборотной воды",
    status: "closed",
    notes: [],
    closure: { closed_at: "2026-10-02T08:00:00Z", master_event_id: "closure" },
    source: {
      family: "recurring_fault",
      comparison_kind: "same_fault",
      title: "Повторная течь уплотнения",
      recommendation: "Проверить причину повторной течи",
      formula: "Тот же шифр и оборудование",
      order_ids: [],
      evidence_orders: [],
    },
    observation: {
      window_days: 7,
      window_end: "2026-10-09T08:00:00Z",
      observed_until: "2026-10-09T08:00:00Z",
      repeat_evidence_truncated: false,
      repeat_orders: [],
    },
  };
  await page.route(`**${endpoint}*`, async (route) => {
    const statuses = [
      "window_completed_no_recorded_repeat",
      "under_observation",
      "repeat_detected",
      "unknown",
      "pending",
      "cancelled",
    ];
    const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
    const limit = Number(new URL(route.request().url()).searchParams.get("limit") ?? 5);
    const items = statuses
      .map((outcome, i) => ({
        ...sample,
        order_id: `sample-${i}`,
        number: `Проверка состояния ${i + 1}`,
        outcome,
        status: i === 4 ? "issued" : i === 5 ? "cancelled" : "closed",
        closure: i < 3 ? sample.closure : null,
        source:
          i === 3
            ? null
            : i === 2
              ? { ...sample.source, comparison_kind: "any_unplanned", family: "after_ppr" }
              : sample.source,
        observation:
          i < 3
            ? {
                ...sample.observation,
                observed_days: i === 0 ? 7 : 1,
                repeat_count: i === 2 ? 1 : 0,
                repeat_orders: i === 2 ? sample.observation.repeat_orders : [],
              }
            : null,
      }))
      .slice(offset, offset + limit);
    await route.fulfill({
      json: {
        items,
        offset,
        limit,
        total: 6,
        notes: [],
        truncated: false,
        measured_at: "2026-10-09T08:00:00Z",
        period: {
          kind: "month",
          timezone: "Asia/Qostanay",
          from: "2026-10-01T00:00:00Z",
          to: "2026-11-01T00:00:00Z",
          label: "Октябрь 2026",
        },
      },
    });
  });
  const panel = page.getByTestId("prevention-outcomes");
  await panel.locator(":scope > summary").click();
  await expect(panel).toContainText("7 дней без зарегистрированного повтора");
  await expect(panel).toContainText("Недостаточно данных");
  await expect(panel).toContainText("Внеплановый ремонт зарегистрирован");
  const unknownOutcome = panel.getByTestId("prevention-outcome-sample-3");
  const outcomeDetails = unknownOutcome.locator(":scope > details");
  // The order number is a same-context link inside the summary. Toggle the native
  // disclosure from its keyboard-accessible summary rather than following that link.
  await outcomeDetails.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(outcomeDetails).toHaveAttribute("open", "");
  await unknownOutcome.getByText("Основание и методика", { exact: true }).click();
  await expect(panel).toContainText("Основание недоступно");
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("observation-states.png") });
  await panel.getByRole("button", { name: "Вперёд", exact: true }).click();
  await expect(panel).toContainText("Отменён");
  await expect(panel.getByTestId("prevention-outcome-sample-0")).toHaveCount(0);
  await panel.getByRole("button", { name: "Назад", exact: true }).click();
  await expect(panel).toContainText("7 дней без зарегистрированного повтора");
});

test("applied filters discard delayed outcomes and empty result is explicit", async ({ page }) => {
  await openReport(page);
  let release!: () => void;
  let arrived!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let requests = 0;
  await page.route(`**${endpoint}*`, async (route) => {
    const first = ++requests === 1;
    const response = await route.fetch();
    const data = await response.json();
    if (first) {
      arrived();
      await hold;
      await route.fulfill({
        json: {
          ...data,
          items: data.items.map((item: object) => ({ ...item, number: "Устаревший результат" })),
        },
      });
    } else await route.fulfill({ json: { ...data, items: [], total: 0 } });
  });
  const panel = page.getByTestId("prevention-outcomes");
  await panel.locator(":scope > summary").click();
  await firstRequest;
  await page.getByRole("combobox", { name: "Период", exact: true }).selectOption("day");
  // Changing controls alone must not change the already applied report query.
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(panel).toContainText("Профилактических нарядов за выбранный период нет.");
  const late = page.waitForResponse((r) => r.url().includes(endpoint) && r.url().includes("period=month"));
  release();
  await late;
  await expect(panel.getByText("Устаревший результат", { exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Профилактических нарядов за выбранный период нет.");
});
