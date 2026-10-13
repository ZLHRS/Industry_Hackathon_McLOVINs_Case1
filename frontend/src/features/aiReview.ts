import { t } from "../lib/i18n";
import type { OrderDetail, Review } from "../types";
export type MasterDecision = "close" | "override_close" | "request_rework";

export function masterReviewActions(status: OrderDetail["status"], review?: Review) {
  const reviewReady = Boolean(review);
  const awaitingMasterDecision = status === "ai_review" && reviewReady;
  const legacyRework = status === "rework" && review?.verdict === "rework_required";
  return {
    canAccept: awaitingMasterDecision || legacyRework,
    canRequestRework: awaitingMasterDecision,
    acceptAction: awaitingMasterDecision
      ? ("close" as const)
      : legacyRework
        ? ("override_close" as const)
        : null,
  };
}

export function validateMasterDecision({
  action,
  reason,
  score,
  requiresMasterScore = false,
}: {
  action: MasterDecision;
  reason: string;
  score: string;
  requiresMasterScore?: boolean;
}): string | null {
  const normalizedReason = reason.trim();
  const normalizedScore = score.trim();
  if (action !== "request_rework" && requiresMasterScore && !normalizedScore)
    return t("Укажите оценку мастера от 1 до 5.");
  if (action !== "request_rework" && normalizedScore) {
    const parsed = Number(normalizedScore);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5)
      return t("Оценка мастера — целое число от 1 до 5.");
  }
  if (normalizedReason.length < 3) {
    return t("Укажите обоснование решения не короче 3 символов.");
  }
  return null;
}

export function masterDecisionPayload(action: MasterDecision, reason: string, score: string) {
  const normalizedScore = score.trim();
  const payload: { reason?: string; master_score?: number } = {};
  if (reason.trim()) payload.reason = reason.trim();
  if (action !== "request_rework" && normalizedScore) payload.master_score = Number(normalizedScore);
  return payload;
}
