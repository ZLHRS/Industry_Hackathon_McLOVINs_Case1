import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryTrends } from "./HistoryTrends";
import { setLanguage } from "../lib/i18n";
import type { BreakdownTime } from "../types";
afterEach(() => setLanguage("ru"));
const timing: BreakdownTime = {
  days: 90,
  timezone: "Asia/Qostanay",
  formula: "",
  total: 19,
  day_shift: 19,
  night_shift: 0,
  buckets: [0, 19, 0, 0],
  dominant_shift: null,
  ratio: null,
  from_downtime: 0,
};
it("does not describe a small one-sided sample as uniform", () => {
  const html = renderToStaticMarkup(
    createElement(HistoryTrends, { timing, equipmentName: (_, name) => name }),
  );
  expect(html).toContain("Недостаточно данных для вывода по сменам");
  expect(html).not.toContain("поломки распределены равномерно");
});
it("distinguishes a sufficient balanced sample from insufficient evidence", () => {
  const html = renderToStaticMarkup(
    createElement(HistoryTrends, {
      timing: { ...timing, total: 20, day_shift: 10, night_shift: 10 },
      equipmentName: (_, name) => name,
    }),
  );
  expect(html).toContain("поломки распределены равномерно");
  expect(html).not.toContain("Недостаточно данных для вывода по сменам");
});
it("localizes the insufficient sample explanation", () => {
  for (const language of ["kk", "en"] as const) {
    setLanguage(language);
    const html = renderToStaticMarkup(
      createElement(HistoryTrends, { timing, equipmentName: (_, name) => name }),
    );
    expect(html).not.toContain("Недостаточно данных для вывода по сменам");
    expect(html).toContain("20");
  }
});
