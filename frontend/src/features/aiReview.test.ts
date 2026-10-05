import { describe, expect, it } from "vitest";
import { masterDecisionPayload, validateMasterDecision } from "./aiReview";

describe("master AI review decision validation", () => {
  it("allows an ordinary close without a score or reason", () => {
    expect(validateMasterDecision({ action: "close", reason: "", score: "" })).toBeNull();
    expect(masterDecisionPayload("close", "", "")).toEqual({});
  });

  it("requires an audited reason when a master score is supplied", () => {
    expect(validateMasterDecision({ action: "close", reason: "", score: "4" })).toMatch(/обоснование/i);
    expect(masterDecisionPayload("close", "Проверил доказательства", "4")).toEqual({
      reason: "Проверил доказательства",
      master_score: 4,
    });
  });

  it("requires a reason for manual close and rework", () => {
    expect(validateMasterDecision({ action: "override_close", reason: "", score: "" })).toMatch(
      /обоснование/i,
    );
    expect(validateMasterDecision({ action: "request_rework", reason: "ок", score: "" })).toMatch(
      /обоснование/i,
    );
  });

  it("does not submit a score with a rework request", () => {
    expect(
      validateMasterDecision({ action: "request_rework", reason: "Нужна новая фотография", score: "4" }),
    ).toBeNull();
    expect(masterDecisionPayload("request_rework", "Нужна новая фотография", "4")).toEqual({
      reason: "Нужна новая фотография",
    });
  });
  it("rejects an out-of-range or fractional master score", () => {
    expect(validateMasterDecision({ action: "close", reason: "достаточно", score: "6" })).toMatch(/1 до 5/);
    expect(validateMasterDecision({ action: "close", reason: "достаточно", score: "3.5" })).toMatch(/целое/);
  });
});
