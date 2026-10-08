import { t, getLocale, message } from "../lib/i18n";
import "./order-ux.css";
import { canReviewRepair, canViewRepairOutcome, roleLabels } from "../lib/roleAccess";
import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, capturePhotoTime } from "../api";
import { OfflineStorageError } from "../lib/offline";
import { blackenPixels, normalizeRedaction, type RedactionRect } from "../lib/photoRedaction";
import { Dialog } from "../components/Dialog";
import { AIReviewReport, ExecutorFeedbackReport, ReviewHistory } from "./AIReviewReport";
import {
  masterCloseOptions,
  masterDecisionPayload,
  validateMasterDecision,
  type MasterDecision,
} from "./aiReview";
import type { ActionRequest, Catalog, EventItem, OrderDetail, Role, Workload } from "../types";

const ruStatus: Record<string, string> = {
  get issued() {
    return t("Выдан");
  },
  get accepted() {
    return t("Принят");
  },
  get queued() {
    return t("В очереди");
  },
  get rejected() {
    return t("Отказ");
  },
  get in_progress() {
    return t("В работе");
  },
  get paused() {
    return t("Пауза");
  },
  get completed() {
    return t("Сдан");
  },
  get ai_review() {
    return t("Проверка");
  },
  get closed() {
    return t("Закрыт");
  },
  get cancelled() {
    return t("Отменён");
  },
  get rework() {
    return t("Доработка");
  },
};
const ruPriority: Record<string, string> = {
  get emergency() {
    return t("Аварийный");
  },
  get high() {
    return t("Высокий");
  },
  get normal() {
    return t("Обычный");
  },
  get planned() {
    return t("Плановый");
  },
};
const ruWorkType: Record<string, string> = {
  get planned() {
    return t("Плановый");
  },
  get unplanned() {
    return t("Внеплановый");
  },
};
const actionLabels: Record<string, string> = {
  get issue() {
    return t("Наряд выдан");
  },
  get accept() {
    return t("Наряд принят");
  },
  get queue() {
    return t("Добавлен в очередь");
  },
  get reject() {
    return t("Отказ от наряда");
  },
  get start() {
    return t("Работа начата");
  },
  get resume() {
    return t("Работа возобновлена");
  },
  get pause() {
    return t("Работа приостановлена");
  },
  get complete() {
    return t("Работа сдана");
  },
  get start_ai_review() {
    return t("Проверка начата");
  },
  get request_rework() {
    return t("Возврат на доработку");
  },
  get mark_rework() {
    return t("Доработка назначена");
  },
  get close() {
    return t("Наряд закрыт");
  },
  get override_close() {
    return t("Наряд закрыт вручную");
  },
  get cancel() {
    return t("Наряд отменён");
  },
  get change_priority() {
    return t("Приоритет изменён");
  },
  get reassign() {
    return t("Исполнитель переназначен");
  },
  get comment() {
    return t("Комментарий");
  },
  get record_downtime() {
    return t("Простой");
  },
  get adjudicate_refusal() {
    return t("Оценка отказа");
  },
};
const eventComment = (event: EventItem) => {
  const value = event.details.comment;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const confirmedActionStatuses: Record<string, string[]> = {
  accept: ["accepted"],
  queue: ["queued"],
  reject: ["rejected"],
  start: ["in_progress"],
  resume: ["in_progress"],
  pause: ["paused"],
  complete: ["completed", "ai_review", "closed"],
};
const local = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Almaty",
      }).format(new Date(value))
    : "—";
export { ruStatus, ruPriority, local };

export type ActionOutcome = { state: "confirmed" | "pending" | "blocked"; message?: string };
type Props = {
  id: string;
  role: Role;
  currentUserId: string;
  catalog: Catalog;
  workers: Workload[];
  load: (id: string) => Promise<{ detail: OrderDetail; events: EventItem[] }>;
  onAction: (id: string, request: ActionRequest, queue?: boolean) => Promise<ActionOutcome>;
  onPhoto: (
    id: string,
    kind: "before" | "after",
    version: number,
    file: File,
    aiShareAllowed: boolean,
    capturedAt?: string,
  ) => Promise<void>;
  photoUrl: (path: string) => Promise<string>;
  onReport: (id: string) => Promise<{ blob: Blob; filename: string }>;
  onDowntime: (
    id: string,
    input: {
      expected_version: number;
      started_at?: string | null;
      ended_at?: string | null;
      reason: string;
      void?: boolean;
    },
  ) => Promise<unknown>;
  onAssessRefusal: (
    id: string,
    rejectionEventId: string,
    input: { expected_version: number; justified: boolean; reason: string },
  ) => Promise<unknown>;
  revision: number;
  onClose: () => void;
};
export function OrderDetailDialog({
  id,
  role,
  currentUserId,
  catalog,
  workers,
  load,
  onAction,
  onPhoto,
  photoUrl,
  onReport,
  onDowntime,
  onAssessRefusal,
  revision,
  onClose,
}: Props) {
  const [detail, setDetail] = useState<OrderDetail>();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ActionOutcome>();
  const [requestedAction, setRequestedAction] = useState("");
  const startRequested = useRef(false);
  const [reportExporting, setReportExporting] = useState(false);
  const [downtime, setDowntime] = useState({ started_at: "", ended_at: "", reason: "" });
  const [refusal, setRefusal] = useState({ event_id: "", justified: "true", reason: "" });
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [priority, setPriority] = useState("");
  const [priorityReason, setPriorityReason] = useState("");
  const [reassignExecutorId, setReassignExecutorId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [masterScore, setMasterScore] = useState("");
  const [materials, setMaterials] = useState<{ material_id: string; quantity: string }[]>([
    { material_id: "", quantity: "" },
  ]);
  const [noMaterials, setNoMaterials] = useState(false);
  const [completion, setCompletion] = useState({
    work_description: "",
    fault_code_id: "",
    no_materials_reason: "",
  });
  const refreshGeneration = useRef(0);
  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    return load(id)
      .then(({ detail: next, events: history }) => {
        if (generation !== refreshGeneration.current) return;
        setDetail(next);
        setEvents(history);
      })
      .catch((caught: ApiError) => {
        if (generation !== refreshGeneration.current) return;
        if (caught.status === 404) {
          setDetail(undefined);
          setEvents([]);
        }
        setError(
          caught.status === 404
            ? t("Наряд больше недоступен.")
            : caught.detail === "history_limit_exceeded"
              ? t(
                  "Журнал превышает предел 2 000 событий. Сузьте период в отчёте или обратитесь к администратору.",
                )
              : t("Не удалось загрузить карточку."),
        );
      });
  }, [id, load]);
  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, revision]);
  useEffect(() => {
    if (busy) return;
    const started = startRequested.current && detail?.status === "in_progress";
    if (started) startRequested.current = false;
    const target = started ? "work-progress" : error ? "action-error" : feedback ? "action-feedback" : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(target);
      element?.scrollIntoView({ block: "start" });
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, detail?.status, feedback, error]);
  async function act(action: string, extra: Record<string, unknown> = {}, queue = false) {
    if (!detail) return;
    setBusy(true);
    setError("");
    setFeedback(undefined);
    setRequestedAction(action);
    startRequested.current = action === "start" || action === "resume";
    try {
      const outcome = await onAction(id, { action, expected_version: detail.version, ...extra }, queue);
      if (outcome.state !== "confirmed") {
        setFeedback(outcome);
        if (outcome.state === "blocked") startRequested.current = false;
      }
      await refresh();
      setReason("");
      setComment("");
      setPriority("");
      setPriorityReason("");
      setReassignExecutorId("");
      setReassignReason("");
      setCancelReason("");
      setCancelConfirmed(false);
      setMasterScore("");
    } catch (caught) {
      startRequested.current = false;
      const failure = caught as ApiError;
      setError(
        caught instanceof OfflineStorageError
          ? caught.message
          : failure.status === 409 && failure.detail === "version_conflict"
            ? t("Наряд изменился. Проверьте обновлённые данные и повторите действие.")
            : failure.status === 409
              ? t(
                  "Действие недоступно в текущем состоянии наряда. Проверьте данные и выберите доступное действие.",
                )
              : failure.status === 401
                ? t("Сессия завершена.")
                : t("Действие не выполнено."),
      );
      if (failure.status === 409) await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function decideMaster(action: MasterDecision) {
    const validation = validateMasterDecision({ action, reason, score: masterScore });
    if (validation) {
      setError(validation);
      return;
    }
    await act(action, masterDecisionPayload(action, reason, masterScore));
  }
  async function submitCompletion(event: FormEvent) {
    event.preventDefault();
    if (!completion.work_description || !completion.fault_code_id) return;
    const lines = materials.filter((line) => line.material_id || line.quantity);
    if (noMaterials) {
      if (completion.no_materials_reason.trim().length < 3) {
        setError(t("Укажите причину отсутствия материалов."));
        return;
      }
    } else if (
      !lines.length ||
      lines.some(
        (line) => !line.material_id || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0,
      )
    ) {
      setError(t("Добавьте материал и положительное количество либо отметьте отсутствие материалов."));
      return;
    }
    const completionData = noMaterials
      ? {
          work_description: completion.work_description,
          fault_code_id: completion.fault_code_id,
          materials: [],
          no_materials_reason: completion.no_materials_reason,
          comment: comment || undefined,
        }
      : {
          work_description: completion.work_description,
          fault_code_id: completion.fault_code_id,
          materials: lines,
          comment: comment || undefined,
        };
    await act("complete", { completion: completionData }, true);
  }
  async function downloadReport() {
    setReportExporting(true);
    try {
      const file = await onReport(id);
      const href = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(href);
    } catch {
      setError(t("Не удалось скачать отчёт Excel."));
    } finally {
      setReportExporting(false);
    }
  }
  async function saveDowntime(voidRecord = false) {
    if (!detail || (!voidRecord && (!downtime.started_at || downtime.reason.trim().length < 3))) return;
    setBusy(true);
    setError("");
    try {
      await onDowntime(id, {
        expected_version: detail.version,
        reason: downtime.reason,
        void: voidRecord,
        started_at: voidRecord ? null : downtime.started_at + ":00+05:00",
        ended_at: voidRecord || !downtime.ended_at ? null : downtime.ended_at + ":00+05:00",
      });
      setDowntime({ started_at: "", ended_at: "", reason: "" });
      await refresh();
    } catch {
      setError(t("Простой не сохранён. Проверьте время и причину."));
    } finally {
      setBusy(false);
    }
  }
  async function assessRefusal() {
    if (!detail || !refusal.event_id || refusal.reason.trim().length < 3) return;
    setBusy(true);
    setError("");
    try {
      await onAssessRefusal(id, refusal.event_id, {
        expected_version: detail.version,
        justified: refusal.justified === "true",
        reason: refusal.reason,
      });
      setRefusal({ event_id: "", justified: "true", reason: "" });
      await refresh();
    } catch {
      setError(t("Оценка отказа не сохранена."));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File, aiShareAllowed: boolean, capturedAt?: string) {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await onPhoto(
        id,
        role === "master" ? "before" : "after",
        detail.version,
        file,
        aiShareAllowed,
        capturedAt,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <Dialog title={t("Карточка наряда")} onClose={onClose}>
        <p className={error ? "error" : "muted"}>{error || t("Загрузка…")}</p>
      </Dialog>
    );
  const machine = catalog.equipment.find((item) => item.id === detail.equipment_id);
  const area = catalog.areas.find((item) => item.id === detail.area_id);
  const canExecutor = role === "executor" && detail.executor_id === currentUserId;
  const detailedReview = canReviewRepair(role);
  const canViewOutcome = canViewRepairOutcome(role) && (!canExecutor || detail.executor_id === currentUserId);
  const masterOwns = role === "master" && detail.master_id === currentUserId;
  const rejections = events.filter((item) => item.action === "reject");
  const latestDowntime = [...events].reverse().find((item) => item.action === "record_downtime");
  const currentReview = detail.reviews.find((review) => review.is_current);
  const currentMaterials = detail.materials.filter(
    (item) => item.submission_version === detail.last_submission_version,
  );
  const { canClose, canOverride } = masterCloseOptions(detail.status, currentReview);
  const masterScoreRequiresReason = masterScore.trim().length > 0 && reason.trim().length < 3;
  const executorNext: Partial<Record<OrderDetail["status"], string>> = {
    issued: t("Ознакомьтесь с заданием и примите наряд. Если заняты, поставьте его в очередь."),
    accepted: t("Когда будете готовы приступить, нажмите «Начать работу»."),
    queued: t("Наряд в очереди. Начните его, когда завершите текущую работу."),
    in_progress: t("Опишите выполненные работы, добавьте материалы и фото, затем сдайте наряд мастеру."),
    paused: t("Работа приостановлена. Нажмите «Возобновить», чтобы продолжить."),
    rework: t("Прочитайте замечания мастера ниже и начните доработку."),
    completed: t("Работа сдана. Ожидайте решения мастера — повторная сдача не нужна."),
    ai_review: t("Работа сдана. Ожидайте решения мастера — повторная сдача не нужна."),
    closed: t("Наряд закрыт. Здесь сохранены отчёт, фотографии и история работы."),
    cancelled: t("Наряд отменён. Выполнять это задание больше не нужно."),
    rejected: t("Отказ передан мастеру. Дальнейшее назначение определяет мастер."),
  };
  const nextStep = canExecutor
    ? executorNext[detail.status]
    : masterOwns
      ? ["completed", "ai_review"].includes(detail.status)
        ? currentReview
          ? t("Изучите отчёт исполнителя и проверку, затем примите ремонт или верните на доработку.")
          : t("Работа сдана. Дождитесь результатов проверки перед решением по ремонту.")
        : detail.status === "rejected"
          ? t("Исполнитель отказался от наряда. Изучите причину и назначьте дальнейшие действия.")
          : ["closed", "cancelled"].includes(detail.status)
            ? t("Наряд завершён. Отчёт и история доступны для просмотра.")
            : t("Наряд назначен исполнителю. При необходимости уточните приоритет или назначение.")
      : t("Режим просмотра. Изменять наряд и принимать ремонт может выдавший его мастер.");
  const executorAction =
    canExecutor &&
    ["issued", "accepted", "queued", "in_progress", "paused", "rework"].includes(detail.status);
  const canReassign = [
    "issued",
    "accepted",
    "queued",
    "rejected",
    "in_progress",
    "paused",
    "rework",
  ].includes(detail.status);
  return (
    <Dialog title={`${detail.number} · ${ruStatus[detail.status]}`} onClose={onClose}>
      <div className="order-detail">
        <div className="order-tools">
          <p className="order-description">{detail.description}</p>
          {detailedReview && (
            <button
              className="secondary"
              type="button"
              onClick={() => void downloadReport()}
              disabled={reportExporting}
            >
              {reportExporting ? t("Готовим…") : t("Отчёт Excel")}
            </button>
          )}
        </div>
        <div className="order-next-step">
          <div>
            <strong>{["closed", "cancelled"].includes(detail.status) ? t("Итог") : t("Что дальше")}</strong>
            <p>{nextStep}</p>
          </div>
          {executorAction && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const actions = document.getElementById("executor-actions");
                actions?.scrollIntoView({ block: "start" });
                actions?.focus({ preventScroll: true });
              }}
            >
              {t("К действиям")}
            </button>
          )}
        </div>
        <dl className="facts">
          <div>
            <dt>{t("Оборудование")}</dt>
            <dd>{machine ? `${machine.inventory_number} · ${machine.name}` : detail.equipment_id}</dd>
          </div>
          <div>
            <dt>{t("Участок")}</dt>
            <dd>{area ? `${area.code} · ${area.name}` : detail.area_id}</dd>
          </div>
          <div>
            <dt>{t("Вид работ")}</dt>
            <dd>{ruWorkType[detail.work_type] ?? detail.work_type}</dd>
          </div>
          <div>
            <dt>{t("Срок")}</dt>
            <dd className={detail.overdue ? "danger-text" : ""}>{local(detail.deadline)}</dd>
          </div>
          <div>
            <dt>{t("Приоритет")}</dt>
            <dd>{ruPriority[detail.priority]}</dd>
          </div>
          <div>
            <dt>{t("Попытка ремонта")}</dt>
            <dd>{detail.attempt}</dd>
          </div>
          <div>
            <dt>{t("Выдан")}</dt>
            <dd>{local(detail.issued_at)}</dd>
          </div>
          {detail.started_at && (
            <div>
              <dt>{t("Начат")}</dt>
              <dd>{local(detail.started_at)}</dd>
            </div>
          )}
          {detail.completed_at && (
            <div>
              <dt>{t("Сдан")}</dt>
              <dd>{local(detail.completed_at)}</dd>
            </div>
          )}
          {detail.closed_at && (
            <div>
              <dt>{t("Закрыт")}</dt>
              <dd>{local(detail.closed_at)}</dd>
            </div>
          )}
          {detail.master_name && (
            <div>
              <dt>{t("Мастер")}</dt>
              <dd>{detail.master_name}</dd>
            </div>
          )}
          {detail.executor_name && (
            <div>
              <dt>{t("Исполнитель")}</dt>
              <dd>{detail.executor_name}</dd>
            </div>
          )}
        </dl>
        {detail.comment?.trim() && (
          <section className="order-comment">
            <h3>{t("Последний комментарий")}</h3>
            <p>{detail.comment}</p>
          </section>
        )}
        {detail.last_submission_version !== null && detail.work_description && (
          <section className="repair-submission">
            <h3>{t("Отчёт исполнителя")}</h3>
            <p className="review-explanation">{detail.work_description}</p>
            <p className="muted">
              {t("Неисправность:")}{" "}
              {catalog.fault_codes.find((item) => item.id === detail.fault_code_id)?.name ?? t("Не указана")}
            </p>
            {detail.no_materials_reason && (
              <p>
                {t("Без расхода материалов:")} {detail.no_materials_reason}
              </p>
            )}
          </section>
        )}
        {canExecutor && detail.executor_feedback && detail.executor_feedback.length > 0 ? (
          <ExecutorFeedbackReport
            feedback={detail.executor_feedback}
            status={detail.status}
            attempt={detail.attempt}
          />
        ) : (
          canViewOutcome &&
          (currentReview || detail.ai_job || detail.reviews.length > 0 || detail.status === "completed") && (
            <AIReviewReport
              review={currentReview}
              aiJob={detail.ai_job}
              attempt={detail.attempt}
              audience={canExecutor ? "executor" : "reviewer"}
              decisionResolved={
                detail.status === "closed" || detail.status === "cancelled" ? detail.status : false
              }
            />
          )
        )}
        {canExecutor && detail.status === "rework" && (
          <section className="action-block">
            <h3>{t("Что исправить")}</h3>
            <p>
              {[...events].reverse().find((item) => item.action === "request_rework")?.reason ??
                t("Свяжитесь с мастером, чтобы уточнить замечания перед продолжением работы.")}
            </p>
          </section>
        )}
        {error && (
          <p className="error" role="alert" id="action-error" tabIndex={-1}>
            {message(error)}
          </p>
        )}
        {canExecutor &&
          ["issued", "accepted", "queued", "in_progress", "paused", "rework"].includes(detail.status) && (
            <section className="action-block" id="executor-actions" tabIndex={-1}>
              <h3>{t("Действия исполнителя")}</h3>
              {feedback &&
                !(
                  feedback.state === "pending" &&
                  (confirmedActionStatuses[requestedAction] ?? []).includes(detail.status)
                ) && (
                  <div id="action-feedback" className="action-feedback" role="status" tabIndex={-1}>
                    <strong>
                      {feedback.state === "blocked" ? t("Действие не выполнено") : t("Ожидаем подтверждения")}
                    </strong>
                    <p>{feedback.message}</p>
                    <button type="button" className="secondary" onClick={onClose}>
                      {t("К очереди отправки")}
                    </button>
                  </div>
                )}
              {detail.status === "in_progress" && (
                <section
                  id="work-progress"
                  className="work-progress"
                  tabIndex={-1}
                  aria-label={t("Работа начата")}
                >
                  <h3>{t("Работа начата")}</h3>
                  <p>
                    {t(
                      "Наряд в работе. Выполните задание, затем добавьте фото, опишите результат и сдайте работу мастеру.",
                    )}
                  </p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      const form = document.getElementById("completion-form");
                      form?.scrollIntoView({ block: "start" });
                      form?.focus({ preventScroll: true });
                    }}
                  >
                    {t("Заполнить отчёт")}
                  </button>
                </section>
              )}
              <div className="action-row">
                {detail.status === "issued" && (
                  <>
                    <button className="primary" disabled={busy} onClick={() => void act("accept", {}, true)}>
                      {t("Принять")}
                    </button>
                    <button className="secondary" disabled={busy} onClick={() => void act("queue", {}, true)}>
                      {t("В очередь")}
                    </button>
                  </>
                )}
                {["accepted", "queued", "rework"].includes(detail.status) && (
                  <button className="primary" disabled={busy} onClick={() => void act("start", {}, true)}>
                    {busy ? t("Начинаем…") : t("Начать работу")}
                  </button>
                )}
                {detail.status === "paused" && (
                  <button className="primary" disabled={busy} onClick={() => void act("resume", {}, true)}>
                    {t("Возобновить")}
                  </button>
                )}
              </div>
              {detail.status === "issued" && (
                <details className="secondary-action">
                  <summary>{t("Не могу выполнить наряд")}</summary>
                  <label>
                    {t("Причина отказа")}
                    <textarea
                      disabled={busy}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      minLength={3}
                      maxLength={1000}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => void act("reject", { reason }, true)}
                  >
                    {t("Отказаться")}
                  </button>
                </details>
              )}
              {detail.status === "in_progress" && (
                <details className="secondary-action">
                  <summary>{t("Приостановить работу")}</summary>
                  <label>
                    {t("Причина паузы")}
                    <textarea
                      disabled={busy}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      minLength={3}
                      maxLength={1000}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => void act("pause", { reason }, true)}
                  >
                    {t("Поставить на паузу")}
                  </button>
                </details>
              )}
              {["in_progress", "paused"].includes(detail.status) && (
                <PhotoUploadPanel
                  label={t("Фото после")}
                  busy={busy}
                  onUpload={(file, aiShareAllowed, capturedAt) => upload(file, aiShareAllowed, capturedAt)}
                />
              )}
            </section>
          )}
        {canExecutor && ["in_progress", "paused"].includes(detail.status) && (
          <form
            className="action-block"
            id="completion-form"
            tabIndex={-1}
            onSubmit={(e) => void submitCompletion(e)}
          >
            <h3>{t("Сдать работу")}</h3>
            <label>
              {t("Что выполнено")}
              <textarea
                required
                value={completion.work_description}
                onChange={(e) => setCompletion({ ...completion, work_description: e.target.value })}
              />
            </label>
            <label>
              {t("Шифр неисправности")}
              <select
                required
                value={completion.fault_code_id}
                onChange={(e) => setCompletion({ ...completion, fault_code_id: e.target.value })}
              >
                <option value="">{t("Выберите шифр")}</option>
                {catalog.fault_codes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={noMaterials}
                onChange={(e) => setNoMaterials(e.target.checked)}
              />{" "}
              {t("Материалы не использовались")}
            </label>
            {noMaterials ? (
              <label>
                {t("Причина отсутствия материалов")}
                <textarea
                  required
                  minLength={3}
                  value={completion.no_materials_reason}
                  onChange={(e) => setCompletion({ ...completion, no_materials_reason: e.target.value })}
                />
              </label>
            ) : (
              <>
                <div className="material-lines">
                  {materials.map((line, index) => (
                    <div className="two-col" key={index}>
                      <label>
                        {t("Материал")}
                        <select
                          required
                          value={line.material_id}
                          onChange={(e) =>
                            setMaterials((current) =>
                              current.map((row, rowIndex) =>
                                rowIndex === index ? { ...row, material_id: e.target.value } : row,
                              ),
                            )
                          }
                        >
                          <option value="">{t("Выберите материал")}</option>
                          {catalog.materials
                            .filter(
                              (item) =>
                                !materials.some(
                                  (row, rowIndex) => rowIndex !== index && row.material_id === item.id,
                                ),
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.code} · {item.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        {t("Количество")}
                        <input
                          required
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(e) =>
                            setMaterials((current) =>
                              current.map((row, rowIndex) =>
                                rowIndex === index
                                  ? { ...row, quantity: e.target.value.replace(",", ".") }
                                  : row,
                              ),
                            )
                          }
                          placeholder="0,125"
                        />
                      </label>
                      {materials.length > 1 && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setMaterials((current) => current.filter((_, rowIndex) => rowIndex !== index))
                          }
                        >
                          {t("Удалить строку")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setMaterials((current) => [...current, { material_id: "", quantity: "" }])}
                >
                  {t("Добавить материал")}
                </button>
              </>
            )}{" "}
            <button className="primary" disabled={busy}>
              {t("Сдать наряд")}
            </button>
          </form>
        )}
        {masterOwns && (
          <section className="action-block audit-controls">
            <h3>{t("Учёт простоя")}</h3>
            <p className="muted">
              {latestDowntime
                ? latestDowntime.details.void === true
                  ? t("Последняя запись простоя аннулирована.")
                  : t("Последняя запись: {0}", [
                      local(String(latestDowntime.details.started_at ?? latestDowntime.occurred_at)),
                    ])
                : t("Интервал вносится мастером и не выводится из статуса наряда.")}
            </p>
            <div className="action-row">
              <label>
                {t("Начало простоя")}
                <input
                  type="datetime-local"
                  value={downtime.started_at}
                  disabled={busy}
                  onChange={(event) => setDowntime((value) => ({ ...value, started_at: event.target.value }))}
                />
              </label>
              <label>
                {t("Окончание (можно оставить открытым)")}
                <input
                  type="datetime-local"
                  value={downtime.ended_at}
                  disabled={busy}
                  onChange={(event) => setDowntime((value) => ({ ...value, ended_at: event.target.value }))}
                />
              </label>
            </div>
            <label>
              {t("Причина записи или исправления")}
              <textarea
                value={downtime.reason}
                disabled={busy}
                minLength={3}
                onChange={(event) => setDowntime((value) => ({ ...value, reason: event.target.value }))}
              />
            </label>
            <div className="action-row">
              <button
                type="button"
                className="secondary"
                disabled={busy || !downtime.started_at || downtime.reason.trim().length < 3}
                onClick={() => void saveDowntime()}
              >
                {t("Зафиксировать простой")}
              </button>
              {latestDowntime && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || downtime.reason.trim().length < 3}
                  onClick={() => void saveDowntime(true)}
                >
                  {t("Аннулировать последнюю запись")}
                </button>
              )}
            </div>
          </section>
        )}
        {masterOwns && rejections.length > 0 && (
          <section className="action-block audit-controls">
            <h3>{t("Оценка отказа")}</h3>
            <p className="muted">{t("Решение добавляется к исходному отказу и не меняет статус наряда.")}</p>
            <label>
              {t("Отказ")}
              <select
                value={refusal.event_id}
                disabled={busy}
                onChange={(event) => setRefusal((value) => ({ ...value, event_id: event.target.value }))}
              >
                <option value="">{t("Выберите отказ…")}</option>
                {rejections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {local(item.occurred_at)} · {item.reason ?? t("без причины")}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="assessment-choice">
              <legend>{t("Оценка")}</legend>
              <label>
                <input
                  type="radio"
                  name="assessment"
                  value="true"
                  checked={refusal.justified === "true"}
                  onChange={(event) => setRefusal((value) => ({ ...value, justified: event.target.value }))}
                />{" "}
                {t("Обоснован")}
              </label>
              <label>
                <input
                  type="radio"
                  name="assessment"
                  value="false"
                  checked={refusal.justified === "false"}
                  onChange={(event) => setRefusal((value) => ({ ...value, justified: event.target.value }))}
                />{" "}
                {t("Необоснован")}
              </label>
            </fieldset>
            <label>
              {t("Основание решения")}
              <textarea
                value={refusal.reason}
                disabled={busy}
                minLength={3}
                onChange={(event) => setRefusal((value) => ({ ...value, reason: event.target.value }))}
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy || !refusal.event_id || refusal.reason.trim().length < 3}
              onClick={() => void assessRefusal()}
            >
              {t("Сохранить оценку")}
            </button>
          </section>
        )}
        {masterOwns && !["closed", "cancelled"].includes(detail.status) && (
          <section className="action-block master-controls">
            <h3>{t("Управление мастера")}</h3>
            <p className="muted">
              {t("Каждое действие оформляется отдельно: причина относится только к выбранному изменению.")}
            </p>
            {(detail.status === "ai_review" || canOverride) && (
              <section className="master-action-panel">
                <h4>{t("Решение мастера")}</h4>
                <p className="muted">
                  {t(
                    "Вывод и оценка ИИ предварительные. Закрытие или возврат — решение мастера; итоговая оценка берётся из вашей оценки либо из действительной рекомендации ИИ.",
                  )}
                </p>
                <label>
                  {t("Причина решения")}
                  <textarea
                    disabled={busy}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={3}
                  />
                </label>
                {["ai_review", "rework"].includes(detail.status) && (
                  <label>
                    {t("Оценка мастера (необязательно)")}
                    <input
                      type="number"
                      min="1"
                      max="5"
                      step="1"
                      inputMode="numeric"
                      disabled={busy}
                      value={masterScore}
                      placeholder="1–5"
                      onChange={(event) => setMasterScore(event.target.value)}
                    />
                  </label>
                )}
                <div className="master-panel-actions">
                  {detail.status === "ai_review" && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || reason.trim().length < 3}
                        onClick={() => void decideMaster("request_rework")}
                      >
                        {t("Вернуть на доработку")}
                      </button>
                      {canClose && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy || masterScoreRequiresReason}
                          onClick={() => void decideMaster("close")}
                        >
                          {masterScore.trim() ? t("Закрыть вручную") : t("Подтвердить оценку ИИ и закрыть")}
                        </button>
                      )}
                    </>
                  )}
                  {canOverride && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || reason.trim().length < 3}
                      onClick={() => void decideMaster("override_close")}
                    >
                      {!masterScore.trim() &&
                      currentReview?.score != null &&
                      ["accepted", "accepted_with_remarks"].includes(currentReview.verdict ?? "")
                        ? t("Подтвердить оценку ИИ и закрыть")
                        : t("Закрыть вручную")}
                    </button>
                  )}
                </div>
              </section>
            )}
            {detail.status === "issued" && (
              <section className="master-action-panel">
                <h4>{t("Фото до ремонта")}</h4>
                <p className="muted">
                  {t("Необязательно. Добавьте исходное состояние оборудования до начала работ.")}
                </p>
                <PhotoUploadPanel
                  label={t("Фотография")}
                  busy={busy}
                  onUpload={(file, aiShareAllowed, capturedAt) => upload(file, aiShareAllowed, capturedAt)}
                />
              </section>
            )}
            <details className="master-action-panel">
              <summary>{t("Изменить приоритет")}</summary>
              <div className="master-panel-body">
                <label>
                  {t("Новый приоритет")}
                  <select
                    aria-label={t("Новый приоритет")}
                    value={priority}
                    disabled={busy}
                    onChange={(event) => setPriority(event.target.value)}
                  >
                    <option value="">{t("Выберите приоритет…")}</option>
                    {Object.entries(ruPriority).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("Причина изменения приоритета")}
                  <textarea
                    value={priorityReason}
                    disabled={busy}
                    minLength={3}
                    onChange={(event) => setPriorityReason(event.target.value)}
                  />
                </label>
                <div className="master-panel-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !priority || priorityReason.trim().length < 3}
                    onClick={() => void act("change_priority", { priority, reason: priorityReason })}
                  >
                    {t("Сохранить приоритет")}
                  </button>
                </div>
              </div>
            </details>
            {canReassign && (
              <details className="master-action-panel">
                <summary>{t("Переназначить исполнителя")}</summary>
                <div className="master-panel-body">
                  <label>
                    {t("Новый исполнитель")}
                    <select
                      aria-label={t("Новый исполнитель")}
                      value={reassignExecutorId}
                      disabled={busy}
                      onChange={(event) => setReassignExecutorId(event.target.value)}
                    >
                      <option value="">{t("Выберите исполнителя…")}</option>
                      {workers
                        .filter((person) => person.is_on_shift && person.employee_id !== detail.executor_id)
                        .map((person) => (
                          <option key={person.employee_id} value={person.employee_id}>
                            {person.display_name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    {t("Причина переназначения")}
                    <textarea
                      value={reassignReason}
                      disabled={busy}
                      minLength={3}
                      onChange={(event) => setReassignReason(event.target.value)}
                    />
                  </label>
                  <div className="master-panel-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !reassignExecutorId || reassignReason.trim().length < 3}
                      onClick={() =>
                        void act("reassign", { executor_id: reassignExecutorId, reason: reassignReason })
                      }
                    >
                      {t("Переназначить")}
                    </button>
                  </div>
                </div>
              </details>
            )}
            <details className="master-action-panel master-action-danger">
              <summary>{t("Отменить наряд")}</summary>
              <div className="master-panel-body">
                <p className="muted">{t("Отменённый наряд нельзя вернуть в работу.")}</p>
                <label>
                  {t("Причина отмены")}
                  <textarea
                    value={cancelReason}
                    disabled={busy}
                    minLength={3}
                    onChange={(event) => setCancelReason(event.target.value)}
                  />
                </label>
                <label className="master-confirmation">
                  <input
                    type="checkbox"
                    checked={cancelConfirmed}
                    disabled={busy}
                    onChange={(event) => setCancelConfirmed(event.target.checked)}
                  />
                  {t("Я понимаю, что наряд будет отменён")}
                </label>
                <div className="master-panel-actions">
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy || !cancelConfirmed || cancelReason.trim().length < 3}
                    onClick={() => void act("cancel", { reason: cancelReason })}
                  >
                    {t("Отменить наряд")}
                  </button>
                </div>
              </div>
            </details>
          </section>
        )}
        {(canExecutor || masterOwns) && !["closed", "cancelled"].includes(detail.status) && (
          <section className="action-block">
            <h3>{t("Комментарий")}</h3>
            <textarea
              aria-label={t("Текст комментария")}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={5000}
            />
            <button
              type="button"
              className="secondary"
              disabled={busy || !comment.trim()}
              onClick={() => void act("comment", { comment })}
            >
              {t("Добавить комментарий")}
            </button>
          </section>
        )}
        <section>
          <h3>{t("Материалы текущей сдачи и фотографии")}</h3>
          {currentMaterials.length ? (
            <ul className="plain-list">
              {currentMaterials.map((item) => (
                <li key={item.id}>
                  {item.name} — {item.quantity} {item.unit}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t("Материалы не зафиксированы.")}</p>
          )}
          <PhotoGallery photos={detail.photos} getUrl={photoUrl} attempt={detail.attempt} />
          {!canExecutor && canViewOutcome && <ReviewHistory reviews={detail.reviews} audience="reviewer" />}
        </section>
        <section>
          <h3>{t("Журнал")}</h3>
          <details className="secondary-action">
            <summary>{t("Показать историю действий")}</summary>
            <ol className="timeline">
              {events
                .filter(
                  (item) =>
                    canViewOutcome ||
                    ![
                      "start_ai_review",
                      "record_ai_assessment",
                      "mark_rework",
                      "record_downtime",
                      "adjudicate_refusal",
                    ].includes(item.action),
                )
                .map((item) => {
                  const comment = eventComment(item);
                  return (
                    <li key={item.id}>
                      <strong>
                        {actionLabels[item.action] ?? ruStatus[item.to_status] ?? item.to_status}
                      </strong>
                      <span>
                        {local(item.occurred_at)} ·{" "}
                        {item.actor_display_name ??
                          item.actor_name ??
                          roleLabels[item.actor_role as keyof typeof roleLabels] ??
                          t("Сотрудник")}
                      </span>
                      {item.reason && <small>{item.reason}</small>}
                      {comment && <small>{comment}</small>}
                      {item.action === "record_downtime" && (
                        <small>
                          <strong>
                            {item.details.void === true
                              ? t("Простой аннулирован")
                              : t("Простой зафиксирован")}
                          </strong>
                          {item.details.started_at
                            ? t(": с {0}", [local(String(item.details.started_at))])
                            : ""}
                          {item.details.ended_at ? t(" по {0}", [local(String(item.details.ended_at))]) : ""}
                        </small>
                      )}
                      {item.action === "adjudicate_refusal" && (
                        <small>
                          <strong>
                            {t("Отказ:")}{" "}
                            {item.details.justified === true ? t("обоснован") : t("необоснован")}
                          </strong>
                        </small>
                      )}
                    </li>
                  );
                })}
            </ol>
          </details>
        </section>
      </div>
    </Dialog>
  );
}

function PhotoUploadPanel({
  label,
  busy,
  onUpload,
}: {
  label: string;
  busy: boolean;
  onUpload: (file: File, aiShareAllowed: boolean, capturedAt?: string) => Promise<void>;
}) {
  const inputId = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [redactions, setRedactions] = useState<RedactionRect[]>([]);
  const [draft, setDraft] = useState<RedactionRect>();
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>();
  const [maskMode, setMaskMode] = useState(false);
  const [manual, setManual] = useState({ x: "", y: "", width: "", height: "" });
  const [aiShareAllowed, setAiShareAllowed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function select(file: File | undefined) {
    if (preview) URL.revokeObjectURL(preview);
    setSelected(file);
    setPreview(file ? URL.createObjectURL(file) : undefined);
    setRedactions([]);
    setDraft(undefined);
    setDragStart(undefined);
    setMaskMode(false);
    setManual({ x: "", y: "", width: "", height: "" });
    setAiShareAllowed(false);
    setError("");
  }

  function point(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = previewRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  }

  function beginMask(event: React.PointerEvent<HTMLDivElement>) {
    if (!maskMode) return;
    const start = point(event);
    if (!start) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(start);
    setDraft(undefined);
  }

  function drawMask(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const next = point(event);
    if (next) setDraft(normalizeRedaction(dragStart, next) ?? undefined);
  }

  function finishMask(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const end = point(event);
    const next = end ? normalizeRedaction(dragStart, end) : null;
    if (next) setRedactions((current) => [...current, next]);
    setDragStart(undefined);
    setDraft(undefined);
  }

  function addManualMask() {
    const x = Number(manual.x) / 100;
    const y = Number(manual.y) / 100;
    const width = Number(manual.width) / 100;
    const height = Number(manual.height) / 100;
    if (![x, y, width, height].every(Number.isFinite)) return;
    const next = normalizeRedaction({ x, y }, { x: x + width, y: y + height });
    if (!next) return;
    setRedactions((current) => [...current, next]);
    setManual({ x: "", y: "", width: "", height: "" });
  }

  async function flattenedPhoto(file: File) {
    if (!redactions.length) return file;
    // Never upload the original if a requested privacy operation cannot be performed.
    if (typeof createImageBitmap !== "function") throw new Error("redaction_unavailable");
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas_unavailable");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      blackenPixels(frame.data, canvas.width, canvas.height, redactions);
      context.putImageData(frame, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("redaction_failed");
      return new File([blob], file.name.replace(/\.[^.]+$/, "") + "-redacted.jpg", {
        type: "image/jpeg",
        lastModified: file.lastModified,
      });
    } finally {
      bitmap.close();
    }
  }

  async function send() {
    if (!selected) return;
    setUploading(true);
    setError("");
    try {
      const [capturedAt, upload] = await Promise.all([capturePhotoTime(selected), flattenedPhoto(selected)]);
      await onUpload(upload, aiShareAllowed, capturedAt);
      select(undefined);
    } catch {
      setError(t("Фото не загружено. Проверьте тип, размер, соединение и доступ."));
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="photo-upload-panel" aria-label={t("Подготовка загрузки фото")}>
      <label htmlFor={inputId}>
        {label}
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={busy || uploading}
          onChange={(event) => select(event.target.files?.[0])}
        />
      </label>
      {selected && (
        <div className="photo-upload-preview">
          {preview && <img src={preview} alt={t("Предпросмотр: {0}", [selected.name])} />}
          <div>
            <strong>{selected.name}</strong>
            <small>
              {new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(
                selected.size / 1024 / 1024,
              )}{" "}
              {t("МБ")}
            </small>
          </div>
        </div>
      )}
      {selected && preview && (
        <>
          <div
            className={`photo-redaction-stage ${maskMode ? "masking" : ""}`}
            ref={previewRef}
            onPointerDown={beginMask}
            onPointerMove={drawMask}
            onPointerUp={finishMask}
            onPointerCancel={finishMask}
            aria-label={
              maskMode
                ? t("Проведите по фотографии, чтобы скрыть участок")
                : t("Предпросмотр для скрытия участков")
            }
            role={maskMode ? "application" : undefined}
          >
            <img src={preview} alt={t("Предпросмотр для ручного скрытия данных")} />
            {[...redactions, ...(draft ? [draft] : [])].map((redaction, index) => (
              <span
                className="photo-redaction-box"
                key={`${redaction.left}-${redaction.top}-${index}`}
                style={{
                  left: `${redaction.left * 100}%`,
                  top: `${redaction.top * 100}%`,
                  width: `${(redaction.right - redaction.left) * 100}%`,
                  height: `${(redaction.bottom - redaction.top) * 100}%`,
                }}
              />
            ))}
          </div>
          <div className="photo-redaction-tools">
            <button
              type="button"
              className={maskMode ? "primary" : "secondary"}
              aria-pressed={maskMode}
              disabled={busy || uploading}
              onClick={() => setMaskMode((active) => !active)}
            >
              {maskMode ? t("Завершить скрытие") : t("Скрыть личные данные")}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={!redactions.length || busy || uploading}
              onClick={() => setRedactions((current) => current.slice(0, -1))}
            >
              {t("Отменить последнее")}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={!redactions.length || busy || uploading}
              onClick={() => setRedactions([])}
            >
              {t("Очистить скрытия")}
            </button>
          </div>
          <p className="photo-privacy-note">
            {t(
              "Скрытие ручное: проведите по участку на фото. После загрузки будет сохранён JPEG с чёрными прямоугольниками, исходный файл не отправляется.",
            )}
          </p>
          <details className="photo-manual-mask">
            <summary>{t("Ввести область скрытия точно")}</summary>
            <p>{t("Координаты в процентах от левого верхнего угла изображения.")}</p>
            <div>
              {(["x", "y", "width", "height"] as const).map((field) => (
                <label key={field}>
                  {{ x: "X", y: "Y", width: t("Ширина"), height: t("Высота") }[field]}, %
                  <input
                    type="number"
                    min="0"
                    max="100"
                    inputMode="decimal"
                    value={manual[field]}
                    disabled={busy || uploading}
                    onChange={(event) =>
                      setManual((current) => ({ ...current, [field]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <button type="button" className="secondary" disabled={busy || uploading} onClick={addManualMask}>
              {t("Добавить область")}
            </button>
          </details>
        </>
      )}
      <label className="check photo-ai-consent">
        <input
          type="checkbox"
          checked={aiShareAllowed}
          disabled={!selected || busy || uploading}
          onChange={(event) => setAiShareAllowed(event.target.checked)}
        />{" "}
        {t("На фото только оборудование, личные и конфиденциальные данные скрыты. Разрешить анализ ИИ.")}
      </label>
      <small className="photo-privacy-note">
        {t(
          "Без этой отметки фото сохранится во внутреннем наряде и не будет передано внешнему ИИ. Отметка не заменяет проверку кадра человеком.",
        )}
      </small>
      {error && <p className="error">{message(error)}</p>}
      <button
        type="button"
        className="secondary"
        disabled={!selected || busy || uploading}
        onClick={() => void send()}
      >
        {uploading ? t("Загружаем…") : t("Загрузить фото")}
      </button>
    </section>
  );
}

function PhotoEvidenceGroup({
  title,
  photos,
  urls,
}: {
  title: string;
  photos: OrderDetail["photos"];
  urls: Record<string, string>;
}) {
  if (!photos.length) return null;
  return (
    <section className="photo-evidence">
      <h4>{title}</h4>
      <div className="photo-grid">
        {photos.map((photo) => (
          <figure key={photo.id}>
            {urls[photo.id] ? (
              <img
                src={urls[photo.id]}
                alt={`${photo.kind === "before" ? t("До ремонта") : t("После ремонта")}, ${local(photo.uploaded_at)}`}
              />
            ) : (
              <div className="photo-placeholder" role="status">
                {t("Загружаем фото…")}
              </div>
            )}
            <figcaption>{local(photo.uploaded_at)}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function PhotoGallery({
  photos,
  getUrl,
  attempt,
}: {
  photos: OrderDetail["photos"];
  getUrl: (path: string) => Promise<string>;
  attempt: number;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const created: string[] = [];
    const load = async (photo: OrderDetail["photos"][number]) => {
      try {
        const url = await getUrl(photo.content_url);
        created.push(url);
        return [photo.id, url] as const;
      } catch {
        return null;
      }
    };
    void Promise.all(photos.map(load)).then((entries) => {
      if (!active) {
        created.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      setUrls(
        Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null)),
      );
    });
    return () => {
      active = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [photos, getUrl]);
  if (!photos.length) return <p className="muted">{t("Фото не загружены.")}</p>;
  const originals = photos.filter((photo) => photo.kind === "before");
  const currentAfter = photos.filter((photo) => photo.kind === "after" && photo.attempt === attempt);
  const priorAfter = photos.filter((photo) => photo.kind === "after" && photo.attempt !== attempt);
  return (
    <div className="photo-evidence-list">
      <PhotoEvidenceGroup title={t("Исходные фото до ремонта")} photos={originals} urls={urls} />
      <PhotoEvidenceGroup
        title={t("Фото после: текущая попытка {0}", [attempt])}
        photos={currentAfter}
        urls={urls}
      />
      {priorAfter.length > 0 && (
        <details className="photo-history">
          <summary>
            {t("Фото предыдущих попыток (")}
            {priorAfter.length})
          </summary>
          <PhotoEvidenceGroup title={t("Предыдущие доказательства")} photos={priorAfter} urls={urls} />
        </details>
      )}
    </div>
  );
}
