/** Human-entered text only: credentials, IDs, push keys and binary data stay exact. */
const textFields = new Set([
  "login",
  "name",
  "display_name",
  "code",
  "inventory_number",
  "equipment_type",
  "specialty",
  "unit",
  "description",
  "work_description",
  "no_materials_reason",
  "comment",
  "reason",
  "question",
]);

export function trimInputText(key: string, value: unknown): unknown {
  return typeof value === "string" && textFields.has(key) ? value.trim() : value;
}

export function inputJson(value: unknown): string {
  return JSON.stringify(value, trimInputText);
}
