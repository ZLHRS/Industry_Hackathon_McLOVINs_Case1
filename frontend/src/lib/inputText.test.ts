import { describe, expect, it } from "vitest";
import { inputJson } from "./inputText";

describe("user-entered request text", () => {
  it("trims nested form text while preserving meaningful internal spaces and newlines", () => {
    const input = {
      login: "  master.sadykov\u00a0",
      description: "  Проверить  насос\nи крепления  ",
      completion: { work_description: "\n Заменили подшипник \t", comment: "  " },
      materials: [{ quantity: "1.000", name: "  Подшипник  " }],
    };
    expect(JSON.parse(inputJson(input))).toEqual({
      login: "master.sadykov",
      description: "Проверить  насос\nи крепления",
      completion: { work_description: "Заменили подшипник", comment: "" },
      materials: [{ quantity: "1.000", name: "Подшипник" }],
    });
    expect(input.login).toBe("  master.sadykov\u00a0");
  });

  it("does not alter credentials, identifiers, push material or null values", () => {
    const input = {
      secret: " password ",
      id: " id ",
      keys: { auth: " auth ", p256dh: " key " },
      reason: null,
    };
    expect(JSON.parse(inputJson(input))).toEqual(input);
  });
});
