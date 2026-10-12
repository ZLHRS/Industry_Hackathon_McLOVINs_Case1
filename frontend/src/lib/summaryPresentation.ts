/** Format server-authored prose without inventing, translating or dropping facts. */
export function summarySections(text: string, period: string) {
  const content = text.trim();
  const marker = "Рекомендуемые действия:";
  const split = content.indexOf(marker);
  let facts = split < 0 ? content : content.slice(0, split).trim();
  const actions = split < 0 ? "" : content.slice(split + marker.length).trim();
  const introduction = `Обзор за ${period}.`;
  if (facts.startsWith(introduction)) facts = facts.slice(introduction.length).trim();
  const sentences = (value: string) => {
    if (!value) return [];
    if (typeof Intl.Segmenter !== "function") return value.split(/\n+/).filter(Boolean);
    return Array.from(new Intl.Segmenter("ru", { granularity: "sentence" }).segment(value), (part) =>
      part.segment.trim(),
    ).filter(Boolean);
  };
  return { facts: sentences(facts), actions: sentences(actions) };
}
