import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnalyticsSummaryPanel } from "./AnalyticsSummaryPanel";
import type { AnalyticsSummary } from "../types";

const base: AnalyticsSummary = {
  source: "rules",
  model: null,
  text: "Обзор за Сегодня. Просроченных нарядов: 3. Рекомендуемые действия: Проверьте сроки.",
  evidence_ids: ["overdue_orders"],
  limitations: ["Нет ответа модели"],
};
function render(summary: AnalyticsSummary) {
  return renderToStaticMarkup(
    createElement(AnalyticsSummaryPanel, {
      summary,
      period: "Сегодня",
      busy: false,
      disabled: false,
      error: "",
      onGenerate() {},
    }),
  );
}
it("connects each structured fact to its next step and reveals demo provenance", () => {
  const html = render({
    ...base,
    row_count: 12,
    synthetic_count: 8,
    as_of: "2026-10-15T04:00:00Z",
    timezone: "UTC",
    highlights: [
      {
        evidence_id: "overdue_orders",
        title: "Просроченные работы",
        priority: "attention",
        fact: "Просроченных нарядов: 3.",
        context: ["Контекст из отчёта"],
        next_step: "Уточните препятствие у исполнителя.",
      },
    ],
  });
  expect(html).toContain("Требует внимания");
  expect(html).toContain("Уточните препятствие у исполнителя.");
  expect(html).toContain("Контекст из отчёта");
  expect(html).toContain("Учебных нарядов: 8.");
  expect(html).toContain("В основе сводки: 12 нарядов");
  expect(html).toContain("04:00");
  expect(html).not.toContain("UTC+5");
  expect(html).not.toContain("ai-summary-columns");
});
it("retains older text summaries and correctly labels the rules fallback", () => {
  const html = render(base);
  expect(html).toContain("Обзор по данным");
  expect(html).toContain("Просроченных нарядов: 3.");
  expect(html).toContain("Проверьте сроки.");
  expect(html).not.toContain("Учебных нарядов");
});
