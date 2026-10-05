export type MasterDecision = "close" | "override_close" | "request_rework";

export function validateMasterDecision({
  action,
  reason,
  score,
}: {
  action: MasterDecision;
  reason: string;
  score: string;
}): string | null {
  const normalizedReason = reason.trim();
  const normalizedScore = score.trim();
  if (action !== "request_rework" && normalizedScore) {
    const parsed = Number(normalizedScore);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5)
      return "Оценка мастера — целое число от 1 до 5.";
    if (normalizedReason.length < 3) return "Для оценки мастера укажите обоснование не короче 3 символов.";
  }
  if (["override_close", "request_rework"].includes(action) && normalizedReason.length < 3) {
    return "Укажите обоснование решения не короче 3 символов.";
  }
  return null;
}

export function masterDecisionPayload(action: MasterDecision, reason: string, score: string) {
  const normalizedScore = score.trim();
  const payload: { reason?: string; master_score?: number } = {};
  if (reason.trim()) payload.reason = reason.trim();
  if (action !== "request_rework" && normalizedScore) payload.master_score = Number(normalizedScore);
  if (action === "close" && !normalizedScore) delete payload.reason;
  return payload;
}
