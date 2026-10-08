import { t } from "./i18n";

// Only the recommendation service's fixed explanation templates are localized.
// Captured catalog names, employee data and words from the description stay intact.
const templates = [
  "В описании указан шифр «{0}».",
  "Совпадение с названием неисправности: {0}.",
  "Слово «{0}» соответствует группе «{1}».",
  "Для оценки учтены последние {0} закрытых работ за {1} дней.",
  "Для подбора рассмотрены первые {0} исполнителей по имени.",
  "В очереди или на паузе: {0}.",
  "Специальность соответствует шифру: «{0}».",
  "Оценённых закрытых работ на типе «{0}»: {1}; для сортировки по качеству нужно не менее {2}.",
  "Средняя итоговая оценка: {0}/5 по {1} закрытым работам на типе «{2}» за {3} дней.",
];
const patterns = templates.map((template) => ({
  template,
  pattern: new RegExp(
    "^" +
      template
        .split(/\{\d+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("(.*?)") +
      "$",
    "s",
  ),
}));

export function suggestionText(value: string): string {
  for (const { template, pattern } of patterns) {
    const match = pattern.exec(value);
    if (match) return t(template, match.slice(1));
  }
  return t(value);
}
