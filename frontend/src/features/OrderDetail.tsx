import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { Dialog } from "../components/Dialog";
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
  revision,
  onClose,
}: Props) {
  const [detail, setDetail] = useState<OrderDetail>();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [priority, setPriority] = useState("");
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
        setError(caught.status === 404 ? "Наряд больше недоступен." : "Не удалось загрузить карточку.");
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
    } catch (caught) {
      const failure = caught as ApiError;
      setError(
        failure.status === 409
          ? "Версия карточки изменилась. Карточка обновлена — повторите решение осознанно."
          : failure.status === 401
            ? "Сессия завершена."
            : "Действие не выполнено.",
      );
    } finally {
      setBusy(false);
    }
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
  const canExecutor = role === "executor";
  const masterOwns = role === "master" && detail.master_id === currentUserId;
  const currentReview = detail.reviews.find((review) => review.is_current);
  const canClose =
    detail.status === "ai_review" &&
    currentReview &&
    !currentReview.needs_master_review &&
    ["accepted", "accepted_with_remarks"].includes(currentReview.verdict ?? "");
  const canOverride =
    (detail.status === "ai_review" && currentReview?.needs_master_review) ||
    (detail.status === "rework" && currentReview?.verdict === "rework_required");
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
        <p className="order-description">{detail.description}</p>
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {canExecutor && (
          <section className="action-block">
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
              <>
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
              </>
            )}
            {detail.status === "in_progress" && (
              <>
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
              </>
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
          <section className="action-block">
            <h3>Управление мастера</h3>
            <label>
              Причина решения
              <textarea
                disabled={busy}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
              />
            </label>
            {!["closed", "cancelled"].includes(detail.status) && (
              <div className="action-row">
                <label>
                  Новый приоритет
                  <select value={priority} onChange={(event) => setPriority(event.target.value)}>
                    <option value="">Изменить приоритет…</option>
                    {Object.entries(ruPriority).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || reason.trim().length < 3 || !priority}
                  onClick={() => void act("change_priority", { priority, reason })}
                >
                  Изменить приоритет
                </button>
              </div>
            )}
            <div className="action-row">
              {detail.status === "issued" && (
                <label>
                  Фото до
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={upload}
                    disabled={busy}
                  />
                </label>
              )}
              {!["closed", "cancelled"].includes(detail.status) && (
                <button
                  className="secondary"
                  disabled={busy || reason.length < 3}
                  onClick={() => void act("cancel", { reason })}
                >
                  Отменить
                </button>
              )}
              {detail.status === "ai_review" && (
                <>
                  <button
                    className="secondary"
                    disabled={busy || reason.length < 3}
                    onClick={() => void act("request_rework", { reason })}
                  >
                    Вернуть
                  </button>
                  {canClose && (
                    <button className="primary" disabled={busy} onClick={() => void act("close")}>
                      Закрыть
                    </button>
                  )}
                </>
              )}
              {canOverride && (
                <button
                  className="secondary"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void act("override_close", { reason })}
                >
                  Закрыть вручную
                </button>
              )}
              {canReassign && (
                <label>
                  Исполнитель
                  <select
                    defaultValue=""
                    disabled={busy || reason.trim().length < 3}
                    onChange={(e) =>
                      e.target.value && void act("reassign", { executor_id: e.target.value, reason })
                    }
                  >
                    <option value="">Переназначить…</option>
                    {workers
                      .filter((person) => person.is_on_shift)
                      .map((person) => (
                        <option key={person.employee_id} value={person.employee_id}>
                          {person.display_name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          </section>
        )}
        {role !== "manager" && role !== "admin" && (
          <section className="action-block">
            <h3>Комментарий</h3>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} />
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
          <h3>Материалы, фото и проверка</h3>
          {detail.materials.length ? (
            <ul className="plain-list">
              {detail.materials.map((item) => (
                <li key={item.id}>
                  {item.name} — {item.quantity} {item.unit}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Материалы не зафиксированы.</p>
          )}
          <PhotoGallery photos={detail.photos} getUrl={photoUrl} />
          {detail.reviews.map((review) => (
            <p className="review" key={review.id}>
              Проверка {review.is_current ? "текущая" : "прошлая"}: {review.verdict || "ожидается"}.{" "}
              {review.explanation}
            </p>
          ))}
        </section>
        <section>
          <h3>Журнал</h3>
          <ol className="timeline">
            {events.map((item) => (
              <li key={item.id}>
                <strong>{ruStatus[item.to_status] || item.to_status}</strong>
                <span>
                  {local(item.occurred_at)} · {item.actor_role}
                </span>
                {item.reason && <small>{item.reason}</small>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Dialog>
  );
}

function PhotoGallery({
  photos,
  getUrl,
}: {
  photos: OrderDetail["photos"];
  getUrl: (path: string) => Promise<string>;
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
  return (
    <div className="photo-grid">
      {photos.map((photo) => (
        <figure key={photo.id}>
          <img
            src={urls[photo.id]}
            alt={`${photo.kind === "before" ? "До ремонта" : "После ремонта"}, ${local(photo.uploaded_at)}`}
          />
          <figcaption>{photo.kind === "before" ? "До ремонта" : "После ремонта"}</figcaption>
        </figure>
      ))}
    </div>
  );
}
