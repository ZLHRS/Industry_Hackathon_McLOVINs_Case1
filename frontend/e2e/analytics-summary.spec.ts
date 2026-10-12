import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const state = JSON.parse(readFileSync(resolve("../tmp/e2e-server.json"), "utf8"));

for (const width of [390, 768, 1440]) {
  test(`summary is readable, transparent about its source, and recovers from errors at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
    await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.locator(".order-row").first()).toBeVisible();
    await page.goto("/analytics");
    const panel = page.getByRole("region", { name: "ИИ-сводка мастера", exact: true });
    await expect(panel).toBeVisible();
    const period = await panel.locator(".ai-summary-period").innerText();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let source = "openai";
    let fail = false;
    // Only the narrative is a controlled fixture; the surrounding report comes from the test API.
    await page.route(/\/api\/v1\/analytics\/summary\?/, async (route) => {
      await pending;
      if (fail) return route.fulfill({ status: 503, json: { detail: "unavailable" } });
      return route.fulfill({
        json: {
          source,
          model: source === "openai" ? "test-model" : null,
          text: `Обзор за ${period}. За выбранный период: выдано 24, выполнено 18, закрыто 16. Просроченных нарядов: 4. Незакрытый остаток: 8 нарядов. Средняя длительность ремонта — 2.5 ч. Рекомендуемые действия: Проверьте просроченные наряды и назначьте следующий шаг. Разберите незакрытый остаток работ по текущему приоритету. Сверьте длительности работ с нормативами и исходными записями.`,
          limitations: [
            "Все числовые утверждения сформированы сервером из агрегированного отчёта.",
            "Сводка не объясняет причины, не прогнозирует отказы и не оценивает отдельных сотрудников.",
          ],
          evidence_ids: ["order_flow", "overdue_orders"],
        },
      });
    });
    await panel.getByRole("button", { name: "Сформировать ИИ-сводку", exact: true }).click();
    await expect(panel.locator(".loading-skeleton")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Формируем…", exact: true })).toBeDisabled();
    release();
    await expect(panel.getByRole("heading", { name: "Главное за период", exact: true })).toBeVisible();
    await expect(panel.locator(".ai-summary-facts li")).toHaveCount(4);
    await expect(panel.locator(".ai-summary-actions li")).toHaveCount(3);
    await expect(panel.getByText("Средняя длительность ремонта — 2.5 ч.", { exact: true })).toBeVisible();
    await expect(panel.getByText("ИИ-анализ", { exact: true })).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await panel.screenshot({ path: info.outputPath(`summary-${width}.png`) });
    await panel.locator("summary").click();
    await expect(
      panel.getByText("Все числовые утверждения сформированы сервером из агрегированного отчёта.", {
        exact: true,
      }),
    ).toBeVisible();
    source = "rules";
    await panel.getByRole("button", { name: "Обновить сводку", exact: true }).click();
    await expect(panel.getByText("Обзор показателей без ИИ-интерпретации.", { exact: true })).toBeVisible();
    await expect(panel.getByText("ИИ-анализ", { exact: true })).toHaveCount(0);
    fail = true;
    await panel.getByRole("button", { name: "Обновить сводку", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("ИИ-сводка не сформирована");
    await expect(panel.locator(".ai-summary-facts li")).toHaveCount(4);
    await expect(panel.locator(".loading-skeleton")).toHaveCount(0);
  });
}

test("an obsolete summary cannot overwrite a refreshed report or finish its newer request", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill(state.master_login);
  await page.getByLabel("Пароль", { exact: true }).fill(state.secret);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".order-row").first()).toBeVisible();
  await page.goto("/analytics");
  const panel = page.getByRole("region", { name: "ИИ-сводка мастера", exact: true });
  await expect(panel).toBeVisible();
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(() => new Promise<void>((resolve) => releases.push(resolve)));
  let requestIndex = 0;
  await page.route(/\/api\/v1\/analytics\/summary\?/, async (route) => {
    const index = requestIndex++;
    await gates[index];
    await route.fulfill({
      json: {
        source: "rules",
        model: null,
        text: index === 0 ? "Устаревшая сводка." : "Актуальная сводка.",
        limitations: [],
        evidence_ids: [],
      },
    });
  });
  await panel.getByRole("button", { name: "Сформировать ИИ-сводку", exact: true }).click();
  await expect.poll(() => requestIndex).toBe(1);
  // Simulate a report refresh while the previous narrative response is still in flight.
  await page.locator(".analytics-filters").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(panel.getByRole("button", { name: "Сформировать ИИ-сводку", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Сформировать ИИ-сводку", exact: true }).click();
  await expect.poll(() => requestIndex).toBe(2);
  const oldResponse = page.waitForResponse((response) => response.url().includes("/analytics/summary"));
  releases[0]();
  await oldResponse;
  await expect(panel.getByRole("button", { name: "Формируем…", exact: true })).toBeDisabled();
  await expect(panel.getByText("Устаревшая сводка.", { exact: true })).toHaveCount(0);
  releases[1]();
  await expect(panel.getByText("Актуальная сводка.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Обновить сводку", exact: true })).toBeEnabled();
});
