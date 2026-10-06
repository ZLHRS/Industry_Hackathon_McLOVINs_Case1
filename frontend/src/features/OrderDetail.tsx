import "./order-ux.css";
import { canReviewRepair, roleLabels } from "../lib/roleAccess";
import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { Dialog } from "../components/Dialog";
import { AIReviewReport, ReviewHistory } from "./AIReviewReport";
import { masterDecisionPayload, validateMasterDecision, type MasterDecision } from "./aiReview";
import type { ActionRequest, Catalog, EventItem, OrderDetail, Role, Workload } from "../types";

const ruStatus: Record<string, string> = {
  issued: "Выдан",
  accepted: "Принят",
  queued: "В очереди",
  rejected: "Отказ",
  in_progress: "В работе",
  paused: "Пауза",
  completed: "Сдан",
  ai_review: "Проверка",
  closed: "Закрыт",
  cancelled: "Отменён",
  rework: "Доработка",
};
const ruPriority: Record<string, string> = {
  emergency: "Аварийный",
  high: "Высокий",
  normal: "Обычный",
  planned: "Плановый",
};
const local = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Almaty",
      }).format(new Date(value))
    : "—";
export { ruStatus, ruPriority, local };

type Props = {
  id: string;
  role: Role;
  currentUserId: string;
  catalog: Catalog;
  workers: Workload[];
  load: (id: string) => Promise<{ detail: OrderDetail; events: EventItem[] }>;
  onAction: (id: string, request: ActionRequest, queue?: boolean) => Promise<void>;
  onPhoto: (id: string, kind: "before" | "after", version: number, file: File) => Promise<void>;
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
  const [photo, setPhoto] = useState<File>();
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
            ? "Наряд больше недоступен."
            : caught.detail === "history_limit_exceeded"
              ? "Журнал превышает предел 2 000 событий. Сузьте период в отчёте или обратитесь к администратору."
              : "Не удалось загрузить карточку.",
        );
      });
  }, [id, load]);
  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, revision]);
  async function act(action: string, extra: Record<string, unknown> = {}, queue = false) {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await onAction(id, { action, expected_version: detail.version, ...extra }, queue);
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
      const failure = caught as ApiError;
      setError(
        failure.status === 409
          ? "Наряд изменился. Проверьте обновлённые данные и повторите действие."
          : failure.status === 401
            ? "Сессия завершена."
            : "Действие не выполнено.",
      );
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
        setError("Укажите причину отсутствия материалов.");
        return;
      }
    } else if (
      !lines.length ||
      lines.some(
        (line) => !line.material_id || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0,
      )
    ) {
      setError("Добавьте материал и положительное количество либо отметьте отсутствие материалов.");
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
      setError("Не удалось скачать отчёт Excel.");
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
      setError("Простой не сохранён. Проверьте время и причину.");
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
      setError("Оценка отказа не сохранена.");
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !detail) return;
    setPhoto(file);
    setBusy(true);
    try {
      await onPhoto(id, role === "master" ? "before" : "after", detail.version, file);
      await refresh();
    } catch {
      setError("Фото не загружено. Проверьте тип, размер и доступ.");
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <Dialog title="Карточка наряда" onClose={onClose}>
        <p className={error ? "error" : "muted"}>{error || "Загрузка…"}</p>
      </Dialog>
    );
  const machine = catalog.equipment.find((item) => item.id === detail.equipment_id);
  const canExecutor = role === "executor" && detail.executor_id === currentUserId;
  const detailedReview = canReviewRepair(role);
  const masterOwns = role === "master" && detail.master_id === currentUserId;
  const rejections = events.filter((item) => item.action === "reject");
  const latestDowntime = [...events].reverse().find((item) => item.action === "record_downtime");
  const currentReview = detail.reviews.find((review) => review.is_current);
  const currentMaterials = detail.materials.filter(
    (item) => item.submission_version === detail.last_submission_version,
  );
  const canClose =
    detail.status === "ai_review" &&
    currentReview &&
    !currentReview.needs_master_review &&
    ["accepted", "accepted_with_remarks"].includes(currentReview.verdict ?? "");
  const canOverride =
    (detail.status === "ai_review" && currentReview?.needs_master_review) ||
    (detail.status === "rework" && currentReview?.verdict === "rework_required");
  const masterScoreRequiresReason = masterScore.trim().length > 0 && reason.trim().length < 3;
  const executorNext: Partial<Record<OrderDetail["status"], string>> = {
    issued: "Ознакомьтесь с заданием и примите наряд. Если заняты, поставьте его в очередь.",
    accepted: "Когда будете готовы приступить, нажмите «Начать работу».",
    queued: "Наряд в очереди. Начните его, когда завершите текущую работу.",
    in_progress: "Опишите выполненные работы, добавьте материалы и фото, затем сдайте наряд мастеру.",
    paused: "Работа приостановлена. Нажмите «Возобновить», чтобы продолжить.",
    rework: "Прочитайте замечания мастера ниже и начните доработку.",
    completed: "Работа сдана. Ожидайте решения мастера — повторная сдача не нужна.",
    ai_review: "Работа сдана. Ожидайте решения мастера — повторная сдача не нужна.",
    closed: "Наряд закрыт. Здесь сохранены отчёт, фотографии и история работы.",
    cancelled: "Наряд отменён. Выполнять это задание больше не нужно.",
    rejected: "Отказ передан мастеру. Дальнейшее назначение определяет мастер.",
  };
  const nextStep = canExecutor
    ? executorNext[detail.status]
    : masterOwns
      ? ["completed", "ai_review"].includes(detail.status)
        ? currentReview
          ? "Изучите отчёт исполнителя и проверку, затем примите ремонт или верните на доработку."
          : "Работа сдана. Дождитесь результатов проверки перед решением по ремонту."
        : detail.status === "rejected"
          ? "Исполнитель отказался от наряда. Изучите причину и назначьте дальнейшие действия."
          : ["closed", "cancelled"].includes(detail.status)
            ? "Наряд завершён. Отчёт и история доступны для просмотра."
            : "Наряд назначен исполнителю. При необходимости уточните приоритет или назначение."
      : "Режим просмотра. Изменять наряд и принимать ремонт может выдавший его мастер.";
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
              {reportExporting ? "Готовим…" : "Отчёт Excel"}
            </button>
          )}
        </div>
        <div className="order-next-step">
          <div>
            <strong>{["closed", "cancelled"].includes(detail.status) ? "Итог" : "Что дальше"}</strong>
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
              К действиям
            </button>
          )}
        </div>
        <dl className="facts">
          <div>
            <dt>Оборудование</dt>
            <dd>{machine ? `${machine.inventory_number} · ${machine.name}` : detail.equipment_id}</dd>
          </div>
          <div>
            <dt>Срок</dt>
            <dd className={detail.overdue ? "danger-text" : ""}>{local(detail.deadline)}</dd>
          </div>
          <div>
            <dt>Приоритет</dt>
            <dd>{ruPriority[detail.priority]}</dd>
          </div>
          <div>
            <dt>Попытка ремонта</dt>
            <dd>{detail.attempt}</dd>
          </div>
        </dl>
        {detail.last_submission_version !== null && detail.work_description && (
          <section className="repair-submission">
            <h3>Отчёт исполнителя</h3>
            <p className="review-explanation">{detail.work_description}</p>
            <p className="muted">
              Неисправность:{" "}
              {catalog.fault_codes.find((item) => item.id === detail.fault_code_id)?.name ?? "Не указана"}
            </p>
            {detail.no_materials_reason && <p>Без расхода материалов: {detail.no_materials_reason}</p>}
          </section>
        )}
        {detailedReview &&
          (currentReview || detail.ai_job || detail.reviews.length > 0 || detail.status === "completed") && (
            <AIReviewReport review={currentReview} aiJob={detail.ai_job} attempt={detail.attempt} />
          )}
        {canExecutor && detail.status === "rework" && (
          <section className="action-block">
            <h3>Что исправить</h3>
            <p>
              {[...events].reverse().find((item) => item.action === "request_rework")?.reason ??
                "Свяжитесь с мастером, чтобы уточнить замечания перед продолжением работы."}
            </p>
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {canExecutor &&
          ["issued", "accepted", "queued", "in_progress", "paused", "rework"].includes(detail.status) && (
            <section className="action-block" id="executor-actions" tabIndex={-1}>
              <h3>Действия исполнителя</h3>
              <div className="action-row">
                {detail.status === "issued" && (
                  <>
                    <button className="primary" disabled={busy} onClick={() => void act("accept", {}, true)}>
                      Принять
                    </button>
                    <button className="secondary" disabled={busy} onClick={() => void act("queue", {}, true)}>
                      В очередь
                    </button>
                  </>
                )}
                {["accepted", "queued", "rework"].includes(detail.status) && (
                  <button className="primary" disabled={busy} onClick={() => void act("start", {}, true)}>
                    Начать работу
                  </button>
                )}
                {detail.status === "paused" && (
                  <button className="primary" disabled={busy} onClick={() => void act("resume", {}, true)}>
                    Возобновить
                  </button>
                )}
              </div>
              {detail.status === "issued" && (
                <details className="secondary-action">
                  <summary>Не могу выполнить наряд</summary>
                  <label>
                    Причина отказа
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
                    Отказаться
                  </button>
                </details>
              )}
              {detail.status === "in_progress" && (
                <details className="secondary-action">
                  <summary>Приостановить работу</summary>
                  <label>
                    Причина паузы
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
                    Поставить на паузу
                  </button>
                </details>
              )}
              {["in_progress", "paused"].includes(detail.status) && (
                <label className="file-input">
                  Фото после
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={upload}
                    disabled={busy}
                  />
                  <span>{photo?.name || "Выбрать файл"}</span>
                </label>
              )}
            </section>
          )}
        {canExecutor && ["in_progress", "paused"].includes(detail.status) && (
          <form className="action-block" onSubmit={(e) => void submitCompletion(e)}>
            <h3>Сдать работу</h3>
            <label>
              Что выполнено
              <textarea
                required
                value={completion.work_description}
                onChange={(e) => setCompletion({ ...completion, work_description: e.target.value })}
              />
            </label>
            <label>
              Шифр неисправности
              <select
                required
                value={completion.fault_code_id}
                onChange={(e) => setCompletion({ ...completion, fault_code_id: e.target.value })}
              >
                <option value="">Выберите шифр</option>
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
              Материалы не использовались
            </label>
            {noMaterials ? (
              <label>
                Причина отсутствия материалов
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
                        Материал
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
                          <option value="">Выберите материал</option>
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
                        Количество
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
                          Удалить строку
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
                  Добавить материал
                </button>
              </>
            )}{" "}
            <button className="primary" disabled={busy}>
              Сдать наряд
            </button>
          </form>
        )}
        {masterOwns && (
          <section className="action-block audit-controls">
            <h3>Учёт простоя</h3>
            <p className="muted">
              {latestDowntime
                ? latestDowntime.details.void === true
                  ? "Последняя запись простоя аннулирована."
                  : `Последняя запись: ${local(String(latestDowntime.details.started_at ?? latestDowntime.occurred_at))}`
                : "Интервал вносится мастером и не выводится из статуса наряда."}
            </p>
            <div className="action-row">
              <label>
                Начало простоя
                <input
                  type="datetime-local"
                  value={downtime.started_at}
                  disabled={busy}
                  onChange={(event) => setDowntime((value) => ({ ...value, started_at: event.target.value }))}
                />
              </label>
              <label>
                Окончание (можно оставить открытым)
                <input
                  type="datetime-local"
                  value={downtime.ended_at}
                  disabled={busy}
                  onChange={(event) => setDowntime((value) => ({ ...value, ended_at: event.target.value }))}
                />
              </label>
            </div>
            <label>
              Причина записи или исправления
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
                Зафиксировать простой
              </button>
              {latestDowntime && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || downtime.reason.trim().length < 3}
                  onClick={() => void saveDowntime(true)}
                >
                  Аннулировать последнюю запись
                </button>
              )}
            </div>
          </section>
        )}
        {masterOwns && rejections.length > 0 && (
          <section className="action-block audit-controls">
            <h3>Оценка отказа</h3>
            <p className="muted">Решение добавляется к исходному отказу и не меняет статус наряда.</p>
            <label>
              Отказ
              <select
                value={refusal.event_id}
                disabled={busy}
                onChange={(event) => setRefusal((value) => ({ ...value, event_id: event.target.value }))}
              >
                <option value="">Выберите отказ…</option>
                {rejections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {local(item.occurred_at)} · {item.reason ?? "без причины"}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="assessment-choice">
              <legend>Оценка</legend>
              <label>
                <input
                  type="radio"
                  name="assessment"
                  value="true"
                  checked={refusal.justified === "true"}
                  onChange={(event) => setRefusal((value) => ({ ...value, justified: event.target.value }))}
                />{" "}
                Обоснован
              </label>
              <label>
                <input
                  type="radio"
                  name="assessment"
                  value="false"
                  checked={refusal.justified === "false"}
                  onChange={(event) => setRefusal((value) => ({ ...value, justified: event.target.value }))}
                />{" "}
                Необоснован
              </label>
            </fieldset>
            <label>
              Основание решения
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
              Сохранить оценку
            </button>
          </section>
        )}
        {masterOwns && !["closed", "cancelled"].includes(detail.status) && (
          <section className="action-block master-controls">
            <h3>Управление мастера</h3>
            <p className="muted">
              Каждое действие оформляется отдельно: причина относится только к выбранному изменению.
            </p>
            {(detail.status === "ai_review" || canOverride) && (
              <section className="master-action-panel">
                <h4>Решение по проверке</h4>
                <label>
                  Причина решения
                  <textarea
                    disabled={busy}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={3}
                  />
                </label>
                {["ai_review", "rework"].includes(detail.status) && (
                  <label>
                    Оценка мастера (необязательно)
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
                        Вернуть на доработку
                      </button>
                      {canClose && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy || masterScoreRequiresReason}
                          onClick={() => void decideMaster("close")}
                        >
                          Закрыть наряд
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
                      Закрыть вручную
                    </button>
                  )}
                </div>
              </section>
            )}
            {detail.status === "issued" && (
              <section className="master-action-panel">
                <h4>Фото до ремонта</h4>
                <p className="muted">Добавьте исходное состояние оборудования до начала работ.</p>
                <label>
                  Фотография
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={upload}
                    disabled={busy}
                  />
                </label>
              </section>
            )}
            <details className="master-action-panel">
              <summary>Изменить приоритет</summary>
              <div className="master-panel-body">
                <label>
                  Новый приоритет
                  <select
                    aria-label="Новый приоритет"
                    value={priority}
                    disabled={busy}
                    onChange={(event) => setPriority(event.target.value)}
                  >
                    <option value="">Выберите приоритет…</option>
                    {Object.entries(ruPriority).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Причина изменения приоритета
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
                    Сохранить приоритет
                  </button>
                </div>
              </div>
            </details>
            {canReassign && (
              <details className="master-action-panel">
                <summary>Переназначить исполнителя</summary>
                <div className="master-panel-body">
                  <label>
                    Новый исполнитель
                    <select
                      aria-label="Новый исполнитель"
                      value={reassignExecutorId}
                      disabled={busy}
                      onChange={(event) => setReassignExecutorId(event.target.value)}
                    >
                      <option value="">Выберите исполнителя…</option>
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
                    Причина переназначения
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
                      Переназначить
                    </button>
                  </div>
                </div>
              </details>
            )}
            <details className="master-action-panel master-action-danger">
              <summary>Отменить наряд</summary>
              <div className="master-panel-body">
                <p className="muted">Отменённый наряд нельзя вернуть в работу.</p>
                <label>
                  Причина отмены
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
                  Я понимаю, что наряд будет отменён
                </label>
                <div className="master-panel-actions">
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy || !cancelConfirmed || cancelReason.trim().length < 3}
                    onClick={() => void act("cancel", { reason: cancelReason })}
                  >
                    Отменить наряд
                  </button>
                </div>
              </div>
            </details>
          </section>
        )}
        {(canExecutor || masterOwns) && !["closed", "cancelled"].includes(detail.status) && (
          <section className="action-block">
            <h3>Комментарий</h3>
            <textarea
              aria-label="Текст комментария"
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
              Добавить комментарий
            </button>
          </section>
        )}
        <section>
          <h3>Материалы текущей сдачи и фотографии</h3>
          {currentMaterials.length ? (
            <ul className="plain-list">
              {currentMaterials.map((item) => (
                <li key={item.id}>
                  {item.name} — {item.quantity} {item.unit}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Материалы не зафиксированы.</p>
          )}
          <PhotoGallery photos={detail.photos} getUrl={photoUrl} attempt={detail.attempt} />
          {detailedReview && <ReviewHistory reviews={detail.reviews} />}
        </section>
        <section>
          <h3>Журнал</h3>
          <details className="secondary-action">
            <summary>Показать историю действий</summary>
            <ol className="timeline">
              {events
                .filter(
                  (item) =>
                    detailedReview ||
                    ![
                      "start_ai_review",
                      "record_ai_assessment",
                      "mark_rework",
                      "record_downtime",
                      "adjudicate_refusal",
                    ].includes(item.action),
                )
                .map((item) => (
                  <li key={item.id}>
                    <strong>{ruStatus[item.to_status] || item.to_status}</strong>
                    <span>
                      {local(item.occurred_at)} ·{" "}
                      {roleLabels[item.actor_role as keyof typeof roleLabels] ?? "Сотрудник"}
                    </span>
                    {item.reason && <small>{item.reason}</small>}
                    {item.action === "record_downtime" && (
                      <small>
                        <strong>
                          {item.details.void === true ? "Простой аннулирован" : "Простой зафиксирован"}
                        </strong>
                        {item.details.started_at ? `: с ${local(String(item.details.started_at))}` : ""}
                        {item.details.ended_at ? ` по ${local(String(item.details.ended_at))}` : ""}
                      </small>
                    )}
                    {item.action === "adjudicate_refusal" && (
                      <small>
                        <strong>
                          Отказ: {item.details.justified === true ? "обоснован" : "необоснован"}
                        </strong>
                      </small>
                    )}
                  </li>
                ))}
            </ol>
          </details>
        </section>
      </div>
    </Dialog>
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
                alt={`${photo.kind === "before" ? "До ремонта" : "После ремонта"}, ${local(photo.uploaded_at)}`}
              />
            ) : (
              <div className="photo-placeholder" role="status">
                Загружаем фото…
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
  if (!photos.length) return <p className="muted">Фото не загружены.</p>;
  const originals = photos.filter((photo) => photo.kind === "before");
  const currentAfter = photos.filter((photo) => photo.kind === "after" && photo.attempt === attempt);
  const priorAfter = photos.filter((photo) => photo.kind === "after" && photo.attempt !== attempt);
  return (
    <div className="photo-evidence-list">
      <PhotoEvidenceGroup title="Исходные фото до ремонта" photos={originals} urls={urls} />
      <PhotoEvidenceGroup
        title={`Фото после: текущая попытка ${attempt}`}
        photos={currentAfter}
        urls={urls}
      />
      {priorAfter.length > 0 && (
        <details className="photo-history">
          <summary>Фото предыдущих попыток ({priorAfter.length})</summary>
          <PhotoEvidenceGroup title="Предыдущие доказательства" photos={priorAfter} urls={urls} />
        </details>
      )}
    </div>
  );
}
