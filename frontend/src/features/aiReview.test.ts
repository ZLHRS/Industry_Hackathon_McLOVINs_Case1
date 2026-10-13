import { describe, expect, it } from "vitest";
import { masterDecisionPayload, masterReviewActions, validateMasterDecision } from "./aiReview";
import type { Review } from "../types";

describe("master review actions", () => {
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
  it("lets the master accept or request rework for any ready AI recommendation", () => {
    expect(masterReviewActions("ai_review", review)).toEqual({
      canAccept: true,
      canRequestRework: true,
      acceptAction: "close",
    });
    expect(masterReviewActions("ai_review", { ...review, verdict: "rework_required" })).toEqual({
      canAccept: true,
      canRequestRework: true,
      acceptAction: "close",
    });
  });
  it("keeps an older rework review actionable without opening new decisions", () => {
    expect(masterReviewActions("rework", { ...review, verdict: "rework_required" })).toEqual({
      canAccept: true,
      canRequestRework: false,
      acceptAction: "override_close",
    });
  });
  it("offers decisions when the AI has no recommendation or score", () => {
    expect(masterReviewActions("ai_review", { ...review, verdict: null, score: null })).toEqual({
      canAccept: true,
      canRequestRework: true,
      acceptAction: "close",
    });
  });
  it("does not offer closing without a review or for completed orders", () => {
    expect(masterReviewActions("ai_review")).toEqual({
      canAccept: false,
      canRequestRework: false,
      acceptAction: null,
    });
    expect(masterReviewActions("closed", review)).toEqual({
      canAccept: false,
      canRequestRework: false,
      acceptAction: null,
    });
  });
});

describe("master AI review decision validation", () => {
  it("requires a recorded reason for master acceptance and rework", () => {
    expect(validateMasterDecision({ action: "close", reason: "", score: "" })).toMatch(/обоснование/i);
    expect(validateMasterDecision({ action: "request_rework", reason: "ок", score: "" })).toMatch(
      /обоснование/i,
    );
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
  it("requires the master score when the AI had none", () => {
    expect(
      validateMasterDecision({
        action: "close",
        reason: "Мастер проверил работу",
        score: "",
        requiresMasterScore: true,
      }),
    ).toMatch(/оценку мастера/i);
  });
});
