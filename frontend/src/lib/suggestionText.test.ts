import { afterEach, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { suggestionText } from "./suggestionText";

afterEach(() => setLanguage("ru"));

it("translates service explanations when switching languages without modifying embedded data", () => {
  const source = "Специальность соответствует шифру: «Механик $& {0}».";
  setLanguage("en");
  expect(suggestionText(source)).toBe("Specialty matches the code: “Механик $& {0}”.");
  setLanguage("kk");
  expect(suggestionText("Нет активных нарядов.")).toBe("Белсенді нарядтар жоқ.");
  expect(suggestionText("В очереди или на паузе: 3.")).toBe("Кезекте немесе кідірісте: 3.");
  expect(suggestionText("Unknown server explanation")).toBe("Unknown server explanation");
});

it("preserves all values in quality and sample size explanations", () => {
  setLanguage("en");
  expect(
    suggestionText("Средняя итоговая оценка: 4.25/5 по 8 закрытым работам на типе «насос» за 180 дней."),
  ).toBe("Average final score: 4.25/5 across 8 closed jobs for type “насос” over 180 days.");
  expect(
    suggestionText(
      "Оценённых закрытых работ на типе «насос»: 2; для сортировки по качеству нужно не менее 3.",
    ),
  ).toBe("Rated closed jobs for type “насос”: 2; at least 3 are needed to rank by quality.");
});
