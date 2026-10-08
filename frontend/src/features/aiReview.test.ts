import { describe, expect, it } from "vitest";
import { masterCloseOptions, masterDecisionPayload, validateMasterDecision } from "./aiReview";
import type { Review } from "../types";

describe("master closing availability", () => {
  const review: Review = {
    id: "review",
    order_version: 10,
    verdict: "accepted_with_remarks",
    score: 4,
    needs_master_review: true,
    explanation: "Photo unavailable",
    model_name: "test",
    created_at: "2026-10-08T00:00:00Z",
    master_score: null,
    is_current: true,
  };
  it("requires manual acceptance even when a provisional AI score is positive", () => {
    expect(masterCloseOptions("ai_review", review)).toEqual({ canClose: false, canOverride: true });
  });
  it("allows ordinary acceptance when AI does not require manual review", () => {
    expect(masterCloseOptions("ai_review", { ...review, needs_master_review: false })).toEqual({
      canClose: true,
      canOverride: false,
    });
  });
  it("allows manual acceptance for rework and for a missing AI score", () => {
    expect(masterCloseOptions("rework", { ...review, verdict: "rework_required" }).canOverride).toBe(true);
    expect(masterCloseOptions("ai_review", { ...review, score: null })).toEqual({
      canClose: false,
      canOverride: true,
    });
  });
  it("does not offer closing without a review or for completed orders", () => {
    expect(masterCloseOptions("ai_review")).toEqual({ canClose: false, canOverride: false });
    expect(masterCloseOptions("closed", review)).toEqual({ canClose: false, canOverride: false });
  });
});

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
