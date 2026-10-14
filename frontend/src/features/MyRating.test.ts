import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AnalyticsRating } from "../types";
import { MyRating } from "./MyRating";

const row: AnalyticsRating = {
  subject_id: "self",
  subject_name: "Исполнитель",
  score: 80.2,
  sample_size: 9,
  unavailable_components: [],
  components: {
    quality: { value: 0.8, numerator: 36, denominator: 45, detail: "Мастер выставил итоговые оценки." },
    rework: { value: 0.75, numerator: 2, denominator: 8, detail: "Два наряда с доработками." },
    refusal: { value: 0.8, numerator: 1, denominator: 5, detail: "Один необоснованный отказ." },
    volume: { value: 1, numerator: 1500, denominator: 1200, detail: "Шкала до 20 нормочасов." },
  },
};
const render = (rating = row) =>
  renderToStaticMarkup(createElement(MyRating, { row: rating, limitations: ["Веса перенормируются."] }));

describe("personal rating evidence", () => {
  it("labels inverse metrics as positive outcomes rather than displaying defect counts as successes", () => {
    const html = render();
    expect(html).toContain("Без доработок и повторов: 6 из 8");
    expect(html).toContain("Обоснованных отказов: 4 из 5 рассмотренных");
    expect(html).toContain("Средняя оценка: 4 из 5 · оценено работ: 9");
    expect(html).toContain("Выполнено: 25 нормочасов из 20 по шкале");
    expect(html).not.toContain("125%");
  });
  it("keeps unavailable evidence distinct from a measured zero", () => {
    const html = render({
      ...row,
      score: null,
      sample_size: 0,
      components: {
        quality: { value: null, numerator: null, denominator: 0, detail: "Нет оценок" },
        timeliness: { value: 0, numerator: 0, denominator: 3, detail: "Все сдачи просрочены" },
      },
    });
    expect(html).toContain("Недостаточно данных");
    expect(html).toContain("Не влияет на итоговую оценку");
    expect(html).toContain("В срок сдано: 0 из 3");
    expect(html).toContain("Предварительный результат: в оценке меньше 5 нарядов.");
    expect(html).not.toContain("NaN");
  });
  it("preserves detailed methodology without treating attributed work as personal closures", () => {
    const html = render();
    expect(html).toContain("Нарядов в оценке");
    expect(html).not.toContain("Закрыто нарядов");
    expect(html).toContain("<summary>Как рассчитывается оценка</summary>");
    expect(html).toContain("Мастер выставил итоговые оценки.");
    expect(html).toContain("Веса перенормируются.");
  });
});
