import { describe, expect, it } from "vitest";
import { summarySections } from "./summaryPresentation";

describe("summary presentation", () => {
  it("separates the server introduction, facts and actions without changing numbers", () => {
    expect(
      summarySections(
        "Обзор за 12.10.2026. Выдано 12 нарядов. Среднее время — 1.5 ч. Рекомендуемые действия: Проверьте сроки. Сверьте нормативы.",
        "12.10.2026",
      ),
    ).toEqual({
      facts: ["Выдано 12 нарядов.", "Среднее время — 1.5 ч."],
      actions: ["Проверьте сроки.", "Сверьте нормативы."],
    });
  });
  it("keeps unmatched prose and never creates recommendations", () => {
    expect(summarySections("Нет данных для выбранного периода.", "Сегодня")).toEqual({
      facts: ["Нет данных для выбранного периода."],
      actions: [],
    });
  });
  it("does not interpret markup as instructions or HTML", () => {
    const text = '<img src=x onerror="alert(1)">';
    expect(summarySections(text, "Сегодня")).toEqual({ facts: [text], actions: [] });
  });
});
