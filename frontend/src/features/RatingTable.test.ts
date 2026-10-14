import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RatingTable } from "./RatingTable";
import type { AnalyticsRating } from "../types";

const row: AnalyticsRating = {
  subject_id: "person", subject_name: "Исполнитель", score: 42, sample_size: 3,
  unavailable_components: ["quality"],
  components: {
    quality: { value: null, numerator: 0, denominator: 0, detail: "Нет оценок" },
    timeliness: { value: 0, numerator: 0, denominator: 3, detail: "Сданы позже срока" },
    rework: { value: .75, numerator: 1, denominator: 4, detail: "Одна доработка" },
  },
};
const render = (rating = row) => renderToStaticMarkup(createElement(RatingTable, { title: "Исполнители", rows: [rating], ranked: true }));
it("uses an absolute score scale even when the leader scores below 100", () => {
  const html = render();
  expect(html).toContain('width:42%');
  expect(html).toContain('Оценка: 42 из 100');
  expect(html).toContain('Малая выборка');
  expect(html).toContain('Без доработок и повторов: 3 из 4');
  expect(html).toContain('В срок сдано: 0 из 3');
  expect(html).toContain('Нет данных');
});
it("does not award a podium place to unavailable scores", () => {
  const html = render({ ...row, score: null });
  expect(html).not.toContain('ratings-place--1');
  expect(html).not.toContain('Место 1');
  expect(html).toContain('Рейтинг пока не рассчитан');
});
