import { useEffect, useRef, useState } from "react";
import type { Api, ApiError } from "../api";
import { Dialog } from "../components/Dialog";
import { getLocale, t } from "../lib/i18n";
import type { Catalog, FaultReportPage, FaultReportStatus, FaultReportView, Role } from "../types";
import "./fault-reports.css";

const pageSize = 10;

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

function statusLabel(status: FaultReportStatus) {
  if (status === "converted") return t("Наряд выдан");
  if (status === "dismissed") return t("Закрыто с пояснением");
  return t("Открыто");
}

function reportError(error: unknown) {
  const failure = error as ApiError;
  if (failure.status === 404) return t("Сообщение больше недоступно. Обновите список.");
  if (failure.status === 409 && failure.detail === "fault_report_not_open")
    return t("Сообщение уже обработано. Откройте актуальный список.");
  if (failure.status === 409 && failure.detail === "version_conflict")
    return t("Сообщение изменилось. Проверьте актуальные данные и повторите действие.");
  return t("Не удалось выполнить действие. Проверьте соединение и повторите.");
}

function createReportError(error: unknown) {
  const failure = error as ApiError;
  if (failure.status === 0 || failure.message === "Failed to fetch")
    return t("Не удалось подтвердить отправку. Повторите попытку — сообщение не продублируется.");
  return reportError(error);
}

type Props = {
  api: Api;
  role: Role;
  catalog: Catalog;
  mode: "executor" | "master" | "detail";
  reportId?: string;
  initialEquipmentId?: string;
  revision: number;
  onClose: () => void;
  onPrepare: (report: FaultReportView) => void;
  onChanged?: () => void;
};

type MasterSelectProps = {
  api: Api;
  equipmentId: string;
  masterId: string;
  disabled: boolean;
  onChange: (id: string) => void;
};

function FaultReportMasterSelect({ api, equipmentId, masterId, disabled, onChange }: MasterSelectProps) {
  const [masters, setMasters] = useState<Array<{ id: string; display_name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    void api
      .faultReportMasters(equipmentId)
      .then(({ items }) => {
        if (id !== request.current) return;
        setError("");
        setMasters(items);
        if (items.length === 1) onChange(items[0].id);
      })
      .catch((caught) => {
        if (id === request.current) setError(reportError(caught));
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [api, equipmentId, onChange, retry]);

  return (
    <>
      <label>
        {t("Мастер")}
        <select
          data-testid="fault-report-master"
          aria-label={t("Мастер")}
          value={masterId}
          disabled={disabled || loading || masters.length === 1}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{loading ? t("Загрузка…") : t("Выберите мастера")}</option>
          {masters.map((master) => (
            <option key={master.id} value={master.id}>
              {master.display_name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="fault-report-masters-error">
          <p className="error">{error}</p>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setLoading(true);
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            {t("Повторить")}
          </button>
        </div>
      )}
      {!loading && !error && masters.length === 0 && (
        <p className="notice">{t("Для этого оборудования сейчас нет доступного мастера.")}</p>
      )}
    </>
  );
}

export function FaultReportsDialog({
  api,
  role,
  catalog,
  mode,
  reportId,
  initialEquipmentId = "",
  revision,
  onClose,
  onPrepare,
  onChanged,
}: Props) {
  const [equipmentId, setEquipmentId] = useState(initialEquipmentId);
  const [masterId, setMasterId] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reportsOpen, setReportsOpen] = useState(mode === "master");
  const [status, setStatus] = useState<"open" | "all">(mode === "executor" ? "all" : "open");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<FaultReportPage | null>(null);
  const [pageLoading, setPageLoading] = useState(mode !== "detail" && reportsOpen);
  const [detail, setDetail] = useState<FaultReportView | null>(null);
  const [dismissedId, setDismissedId] = useState("");
  const [dismissReason, setDismissReason] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const reportsRequest = useRef(0);
  const detailRequest = useRef(0);

  const loadReports = async (nextOffset = offset) => {
    const request = ++reportsRequest.current;
    setPageLoading(true);
    try {
      const next = await api.faultReports(status, nextOffset, pageSize);
      if (request !== reportsRequest.current) return;
      setError("");
      setPage(next);
      setOffset(next.offset);
    } catch (caught) {
      if (request === reportsRequest.current) setError(reportError(caught));
    } finally {
      if (request === reportsRequest.current) setPageLoading(false);
    }
  };

  useEffect(() => {
    if (mode !== "detail" || !reportId) return;
    const request = ++detailRequest.current;
    void api
      .faultReport(reportId)
      .then((report) => {
        if (request === detailRequest.current) {
          setError("");
          setDetail(report);
        }
      })
      .catch((caught) => {
        if (request === detailRequest.current) setError(reportError(caught));
      });
    return () => {
      detailRequest.current += 1;
    };
  }, [api, mode, reportId, revision]);

  useEffect(() => {
    if (mode === "detail" || !reportsOpen) return;
    const request = ++reportsRequest.current;
    void api
      .faultReports(status, offset, pageSize)
      .then((next) => {
        if (request === reportsRequest.current) {
          setError("");
          setPage(next);
          setOffset(next.offset);
        }
      })
      .catch((caught) => {
        if (request === reportsRequest.current) setError(reportError(caught));
      })
      .finally(() => {
        if (request === reportsRequest.current) setPageLoading(false);
      });
    return () => {
      reportsRequest.current += 1;
    };
  }, [api, mode, offset, reportsOpen, revision, status]);

  const updateReport = (next: FaultReportView) => {
    setDetail((current) => (current?.id === next.id ? next : current));
    setPage((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }
        : current,
    );
    onChanged?.();
  };

  const submit = async () => {
    if (submitting) return;
    if (!navigator.onLine) {
      setError(
        t(
          "Нет соединения. Не удалось подтвердить отправку. Повторите попытку — сообщение не продублируется.",
        ),
      );
      return;
    }
    if (!equipmentId || !masterId || description.trim().length < 3) {
      setError(t("Выберите оборудование, мастера и опишите неисправность."));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const report = await api.createFaultReport({
        equipment_id: equipmentId,
        master_id: masterId,
        description: description.trim(),
      });
      setDescription("");
      setReportsOpen(true);
      setStatus("all");
      setOffset(0);
      setPageLoading(true);
      setPage((current) =>
        current
          ? {
              ...current,
              offset: 0,
              total: current.total + 1,
              items: [report, ...current.items].slice(0, pageSize),
            }
          : current,
      );
      onChanged?.();
    } catch (caught) {
      setError(createReportError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = async (report: FaultReportView) => {
    if (dismissing || dismissReason.trim().length < 3) return;
    setDismissing(true);
    setError("");
    try {
      const next = await api.dismissFaultReport(report.id, {
        expected_version: report.version,
        reason: dismissReason.trim(),
      });
      setDismissedId("");
      setDismissReason("");
      updateReport(next);
    } catch (caught) {
      setError(reportError(caught));
    } finally {
      setDismissing(false);
    }
  };

  const title =
    mode === "master"
      ? t("Сообщения о поломках")
      : mode === "detail"
        ? t("Сообщение о поломке")
        : t("Сообщить о поломке");
  const reports = mode === "detail" ? (detail ? [detail] : []) : (page?.items ?? []);
  const canSubmit = Boolean(equipmentId && masterId && description.trim().length >= 3 && !submitting);

  return (
    <Dialog title={title} onClose={onClose}>
      <section className="fault-report-dialog" data-testid="fault-report-dialog">
        {mode === "executor" && (
          <section className="fault-report-form" aria-label={t("Новое сообщение о поломке")}>
            <p className="muted">{t("Опишите поломку. Мастер получит сообщение и решит, нужен ли наряд.")}</p>
            <label>
              {t("Оборудование")}
              <select
                data-testid="fault-report-equipment"
                aria-label={t("Оборудование")}
                value={equipmentId}
                disabled={submitting}
                onChange={(event) => {
                  setEquipmentId(event.target.value);
                  setMasterId("");
                }}
              >
                <option value="">{t("Выберите оборудование")}</option>
                {catalog.equipment
                  .filter((item) => item.is_active !== false)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.inventory_number} · {item.name}
                    </option>
                  ))}
              </select>
            </label>
            {equipmentId ? (
              <FaultReportMasterSelect
                key={equipmentId}
                api={api}
                equipmentId={equipmentId}
                masterId={masterId}
                disabled={submitting}
                onChange={setMasterId}
              />
            ) : (
              <label>
                {t("Мастер")}
                <select data-testid="fault-report-master" aria-label={t("Мастер")} disabled>
                  <option>{t("Выберите мастера")}</option>
                </select>
              </label>
            )}
            <label>
              {t("Что произошло")}
              <textarea
                data-testid="fault-report-description"
                aria-label={t("Что произошло")}
                value={description}
                maxLength={2000}
                disabled={submitting}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary"
              data-testid="fault-report-submit"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {submitting ? t("Отправляем…") : t("Отправить сообщение")}
            </button>
          </section>
        )}

        {mode !== "detail" && (
          <details
            className="fault-report-history"
            open={reportsOpen}
            onToggle={(event) => {
              if (event.currentTarget.open) setPageLoading(true);
              setReportsOpen(event.currentTarget.open);
            }}
          >
            <summary>{mode === "master" ? t("Открытые сообщения") : t("Мои сообщения")}</summary>
            {mode === "master" && (
              <label className="fault-report-status-filter">
                {t("Статус")}
                <select
                  value={status}
                  onChange={(event) => {
                    setPage(null);
                    setStatus(event.target.value as "open" | "all");
                    setOffset(0);
                    setPageLoading(true);
                  }}
                >
                  <option value="open">{t("Открытые")}</option>
                  <option value="all">{t("Все сообщения")}</option>
                </select>
              </label>
            )}
          </details>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {(mode === "detail" || reportsOpen) && !error && ((mode === "detail" && !detail) || pageLoading) && (
          <p className="muted">{t("Загрузка…")}</p>
        )}
        {(mode === "detail" || reportsOpen) &&
          reports.map((report) => (
            <article
              className="fault-report-row"
              data-testid={`fault-report-row-${report.id}`}
              key={report.id}
            >
              <div className="fault-report-row-head">
                <div>
                  <strong>
                    {report.equipment_inventory_number} · {report.equipment_name}
                  </strong>
                  <small>
                    {report.area_name} · {formatDate(report.created_at)}
                  </small>
                </div>
                <span className={`fault-report-state is-${report.status}`}>{statusLabel(report.status)}</span>
              </div>
              <p>{report.description}</p>
              <dl className="fault-report-facts">
                <div>
                  <dt>{t("Сообщил")}</dt>
                  <dd>{report.reporter_name}</dd>
                </div>
                <div>
                  <dt>{t("Мастер")}</dt>
                  <dd>{report.master_name}</dd>
                </div>
                {report.work_order_number && (
                  <div>
                    <dt>{t("Наряд")}</dt>
                    <dd>{report.work_order_number}</dd>
                  </div>
                )}
                {report.dismissal_reason && (
                  <div>
                    <dt>{t("Причина")}</dt>
                    <dd>{report.dismissal_reason}</dd>
                  </div>
                )}
              </dl>
              {role === "master" && report.status === "open" && (
                <div className="fault-report-actions">
                  <button
                    type="button"
                    className="primary"
                    data-testid={`fault-report-prepare-${report.id}`}
                    onClick={() => onPrepare(report)}
                  >
                    {t("Подготовить наряд")}
                  </button>
                  <details
                    className="fault-report-dismiss"
                    open={dismissedId === report.id}
                    onToggle={(event) => {
                      if (event.currentTarget.open) {
                        setDismissedId(report.id);
                        setDismissReason("");
                      } else setDismissedId((current) => (current === report.id ? "" : current));
                    }}
                  >
                    <summary data-testid={`fault-report-dismiss-${report.id}`}>
                      {t("Закрыть с пояснением")}
                    </summary>
                    <label>
                      {t("Причина")}
                      <textarea
                        data-testid="fault-report-dismiss-reason"
                        aria-label={t("Причина")}
                        value={dismissedId === report.id ? dismissReason : ""}
                        maxLength={1000}
                        onChange={(event) => setDismissReason(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      data-testid="fault-report-dismiss-confirm"
                      disabled={dismissing || dismissReason.trim().length < 3}
                      onClick={() => void dismiss(report)}
                    >
                      {dismissing ? t("Сохраняем…") : t("Закрыть сообщение")}
                    </button>
                  </details>
                </div>
              )}
            </article>
          ))}
        {(mode === "detail" || reportsOpen) && !pageLoading && !error && reports.length === 0 && (
          <p className="muted">{t("Сообщений пока нет.")}</p>
        )}
        {mode !== "detail" && reportsOpen && page && page.total > page.limit && (
          <div className="fault-report-pagination">
            <button
              type="button"
              className="secondary"
              disabled={offset === 0 || pageLoading}
              onClick={() => void loadReports(Math.max(0, offset - page.limit))}
            >
              {t("Назад")}
            </button>
            <span>
              {offset + 1}–{Math.min(offset + page.items.length, page.total)} {t("из")} {page.total}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={offset + page.items.length >= page.total || pageLoading}
              onClick={() => void loadReports(offset + page.items.length)}
            >
              {t("Вперёд")}
            </button>
          </div>
        )}
      </section>
    </Dialog>
  );
}
