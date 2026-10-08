import { t, getLocale, message } from "../lib/i18n";
import { readableLimitation } from "../lib/presentationText";
import { useEffect, useMemo, useState } from "react";
import { Api, ApiError } from "../api";
import type { AnalyticsOptions, AnalyticsQuery, AnalyticsReport, Role } from "../types";

const zone = "Asia/Qostanay";
const names = {
  get shift() {
    return t("Смена");
  },
  get day() {
    return t("День");
  },
  get week() {
    return t("Неделя");
  },
  get month() {
    return t("Месяц");
  },
  get custom() {
    return t("Период");
  },
} as const;
const date = () => new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(new Date());
const duration = (value: number | null | undefined) => {
  if (value == null) return t("Недостаточно данных");
  const m = Math.round(value / 60);
  return m < 60 ? t("{0} мин", [m]) : t("{0} ч {1} мин", [Math.floor(m / 60), m % 60]);
};
const entries = (value: Record<string, unknown>) => Object.entries(value).filter(([, v]) => v != null);
const shortDate = (value?: string) => value?.slice(0, 10) ?? date();
const queryString = (query: Partial<AnalyticsQuery>): AnalyticsQuery => ({
  period: "day",
  date: date(),
  timezone: zone,
  area_id: [],
  equipment_id: [],
  executor_id: [],
  brigade_id: [],
  ...query,
});
export function AnalyticsView({ api, role, revision }: { api: Api; role: Role; revision: number }) {
  const [query, setQuery] = useState<AnalyticsQuery>(queryString({}));
  const [options, setOptions] = useState<AnalyticsOptions | null>(null);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [appliedQuery, setAppliedQuery] = useState<AnalyticsQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reportRevision, setReportRevision] = useState(0);
  const [summary, setSummary] = useState<{ text: string; source: string; limitations?: string[] } | null>(
    null,
  );
  const [summarizing, setSummarizing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const people = role === "master" || role === "manager";
  const refresh = async (next = query) => {
    setLoading(true);
    setError("");
    try {
      setReport(await api.analyticsReport(next));
      setAppliedQuery(next);
      setReportRevision(revision);
      setSummary(null);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? t("Этот отчёт недоступен для вашей роли.")
          : t("Не удалось сформировать отчёт. Проверьте параметры периода и соединение."),
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void api
      .analyticsOptions()
      .then(setOptions)
      .catch(() => setError(t("Не удалось получить значения фильтров.")));
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
    // initial read is ephemeral and summary is never automatic
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stale = report !== null && reportRevision < revision;
  const pendingFilters = appliedQuery !== null && JSON.stringify(query) !== JSON.stringify(appliedQuery);
  const machines = useMemo(() => options?.equipment ?? [], [options]);
  const setOne = (field: "area_id" | "equipment_id" | "executor_id" | "brigade_id", value: string) =>
    setQuery((q) => ({ ...q, [field]: value ? [value] : [] }));
  const download = async () => {
    setExporting(true);
    try {
      const file = await api.analyticsExport(appliedQuery ?? query),
        url = URL.createObjectURL(file.blob),
        a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("Не удалось скачать XLSX. Повторите попытку."));
    } finally {
      setExporting(false);
    }
  };
  const requestSummary = async () => {
    setSummarizing(true);
    try {
      setSummary(await api.analyticsSummary(appliedQuery ?? query));
    } catch (e) {
      const detail = e instanceof ApiError ? e.detail : "";
      setError(
        detail === "summary_cooldown_30_seconds"
          ? t("Сводка уже формировалась. Подождите 30 секунд и повторите запрос.")
          : detail === "summary_capacity_reached"
            ? t("ИИ-сводки сейчас заняты. Подождите и повторите запрос.")
            : t("ИИ-сводка не сформирована. Исходные показатели доступны ниже."),
      );
    } finally {
      setSummarizing(false);
    }
  };
  return (
    <section className="workspace analytics" aria-busy={loading}>
      <div className="page-head analytics-head">
        <div>
          <p className="eyebrow">{t("РЕЗУЛЬТАТЫ РАБОТЫ")}</p>
          <h1>{role === "executor" ? t("Мой отчёт") : t("Отчёты смены")}</h1>
          <p className="muted">{t("По журналу нарядов · время Костаная")}</p>
        </div>
        <div className="analytics-actions">
          <button className="secondary" onClick={() => void download()} disabled={!report || exporting}>
            {exporting ? t("Готовим Excel…") : t("Скачать Excel")}
          </button>
          <button className="primary" onClick={() => void refresh()} disabled={loading || summarizing}>
            {loading ? t("Считаем…") : t("Обновить отчёт")}
          </button>
        </div>
      </div>
      <form
        className="analytics-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void refresh();
        }}
      >
        <label>
          {t("Период")}
          <select
            value={query.period}
            onChange={(e) =>
              setQuery((q) => {
                const period = e.target.value as AnalyticsQuery["period"];
                return {
                  ...q,
                  period,
                  shift: period === "shift" ? (q.shift ?? "day") : undefined,
                  date: period === "custom" ? undefined : (q.date ?? date()),
                  from: period === "custom" ? (q.from ?? date() + "T00:00:00+05:00") : undefined,
                  to: period === "custom" ? (q.to ?? date() + "T00:00:00+05:00") : undefined,
                };
              })
            }
          >
            {Object.entries(names).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {query.period === "shift" && (
          <label>
            {t("Смена")}
            <select
              value={query.shift ?? "day"}
              onChange={(e) => setQuery((q) => ({ ...q, shift: e.target.value as "day" | "night" }))}
            >
              <option value="day">{t("Дневная · 08:00–20:00")}</option>
              <option value="night">{t("Ночная · 20:00–08:00")}</option>
            </select>
          </label>
        )}
        {query.period === "custom" ? (
          <>
            <label>
              {t("С")}
              <input
                type="date"
                value={shortDate(query.from)}
                onChange={(e) => setQuery((q) => ({ ...q, from: e.target.value + "T00:00:00+05:00" }))}
              />
            </label>
            <label>
              {t("По")}
              <input
                type="date"
                value={shortDate(query.to)}
                onChange={(e) => setQuery((q) => ({ ...q, to: e.target.value + "T00:00:00+05:00" }))}
              />
            </label>
          </>
        ) : (
          <label>
            {t("Дата отчёта")}
            <input
              type="date"
              value={query.date ?? date()}
              onChange={(e) => setQuery((q) => ({ ...q, date: e.target.value }))}
            />
          </label>
        )}
        <Filter
          title={t("Участок")}
          items={options?.areas ?? []}
          value={query.area_id[0]}
          onChange={(v) => setOne("area_id", v)}
        />
        <Filter
          title={t("Оборудование")}
          items={machines}
          value={query.equipment_id[0]}
          onChange={(v) => setOne("equipment_id", v)}
        />
        {people && (
          <>
            <Filter
              title={t("Исполнитель")}
              items={options?.executors ?? []}
              value={query.executor_id[0]}
              onChange={(v) => setOne("executor_id", v)}
            />
            <Filter
              title={t("Бригада")}
              items={options?.brigades ?? []}
              value={query.brigade_id[0]}
              onChange={(v) => setOne("brigade_id", v)}
            />
          </>
        )}
        <button className="secondary" disabled={loading || summarizing}>
          {t("Применить")}
        </button>
      </form>
      {pendingFilters && (
        <p className="muted report-pending">
          {t("Фильтры изменены. Нажмите «Применить», чтобы обновить показанный отчёт, выгрузку и ИИ-сводку.")}
        </p>
      )}
      {stale && (
        <div className="banner">
          {t("Появились новые изменения.")}{" "}
          <button onClick={() => void refresh()}>{t("Обновить данные")}</button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {message(error)}
        </p>
      )}
      {loading && !report && (
        <div className="empty">
          <span className="spinner" />
          <p>{t("Формируем отчёт по журналу нарядов…")}</p>
        </div>
      )}
      {report && (
        <>
          <div className="report-caption">
            <strong>{report.period.label}</strong>
            <span>
              {t("Сформирован:")}{" "}
              {new Intl.DateTimeFormat(getLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: zone,
              }).format(new Date(report.meta.as_of))}
            </span>
            <span>
              {t("Нарядов в расчёте:")} {report.meta.row_count}
            </span>
          </div>
          <ReportWarnings warnings={report.meta.warnings} />
          <section className="metric-grid">
            <Metric label={t("Выдано")} value={report.orders.issued} />
            <Metric label={t("Завершено")} value={report.orders.completed} />
            <Metric label={t("Закрыто")} value={report.orders.closed} />
            <Metric label={t("Отказы")} value={report.orders.rejected} />
            <Metric label={t("Незакрыто")} value={report.orders.backlog} warn={report.orders.backlog > 0} />
            <Metric label={t("Просрочено")} value={report.orders.overdue} warn={report.orders.overdue > 0} />
            <Metric
              label={t("Реакция")}
              value={duration(report.durations.response_seconds)}
              note={t("В среднем до первого ответа")}
            />
            <Metric
              label={t("Работа")}
              value={duration(report.durations.work_seconds)}
              note={t("В среднем, без пауз")}
            />
            {people && (
              <Metric
                label={t("Простой")}
                value={duration(report.downtime.known_seconds)}
                note={t("Только записанные интервалы")}
              />
            )}
            <Metric label={t("Активные наряды")} value={report.activity.active_order_count} />
          </section>
          <section className="analytics-section">
            <Heading
              eye={people ? t("СРАВНЕНИЕ") : t("ЛИЧНЫЕ РЕЗУЛЬТАТЫ")}
              title={people ? t("Рейтинг исполнения") : t("Моя оценка")}
              note={t("Оценка показывает только подтверждённые компоненты; малые выборки отмечены.")}
            />
            <Ratings report={report} privateView={role === "executor"} />
          </section>
          {people && (
            <section className="analytics-section analytics-split">
              <Materials report={report} />
              <Downtime report={report} />
            </section>
          )}
          <section className="analytics-section">
            <Activity report={report} />
          </section>
          {role !== "executor" && (
            <section className="analytics-section">
              <Heading
                eye={t("СИГНАЛЫ")}
                title={t("Аномалии с доказательствами")}
                note={t("Система показывает только наблюдаемые факты.")}
              />
              <Anomalies report={report} />
            </section>
          )}
          {people && (
            <section className="analytics-section ai-summary">
              <Heading
                eye={t("ПО ЗАПРОСУ")}
                title={t("ИИ-сводка мастера")}
                note={t("Основные выводы и рекомендации за выбранный период.")}
              />
              <button className="secondary" onClick={() => void requestSummary()} disabled={summarizing}>
                {summarizing ? t("Формируем…") : t("Сформировать ИИ-сводку")}
              </button>
              {summary && (
                <article className="summary-result">
                  <p>{summary.text}</p>
                  {summary.source !== "openai" && (
                    <small>{t("Обзор показателей без ИИ-интерпретации.")}</small>
                  )}
                  {!!summary.limitations?.length && (
                    <small>{summary.limitations.map(readableLimitation).join(" ")}</small>
                  )}
                </article>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
function Filter({
  title,
  items,
  value,
  onChange,
}: {
  title: string;
  items: AnalyticsOptions["areas"];
  value?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {title}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("Все доступные")}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.code ? `${i.code} · ` : ""}
            {i.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Heading({ eye, title, note }: { eye: string; title: string; note: string }) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eye}</p>
        <h2>{title}</h2>
      </div>
      <small>{note}</small>
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: string | number;
  note?: string;
  warn?: boolean;
}) {
  return (
    <article className={"metric " + (warn ? "metric-warning" : "")}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}
function Ratings({ report, privateView }: { report: AnalyticsReport; privateView: boolean }) {
  const employee = report.ratings.employees,
    brigade = report.ratings.brigades;
  if (!employee.length && !brigade.length)
    return (
      <div className="empty">
        <h3>{t("Рейтинг пока не рассчитан")}</h3>
        <p>{t("Для периода недостаточно подтверждённых данных.")}</p>
      </div>
    );
  return (
    <div className="ratings-grid">
      <RatingTable title={privateView ? t("Моя оценка") : t("Исполнители")} rows={employee} />
      {!privateView && <RatingTable title={t("Бригады")} rows={brigade} />}{" "}
      {report.ratings.limitations.length > 0 && (
        <p className="muted rating-note">{report.ratings.limitations.join(" ")}</p>
      )}
    </div>
  );
}
const componentLabels: Record<string, string> = {
  get quality() {
    return t("Качество");
  },
  get timeliness() {
    return t("Срок");
  },
  get rework() {
    return t("Доработки");
  },
  get volume() {
    return t("Объём");
  },
  get refusal() {
    return t("Отказы");
  },
};
const anomalyLabels: Record<string, string> = {
  get recurring_fault() {
    return t("Повторяемость неисправности");
  },
  get after_ppr() {
    return t("После ППР");
  },
  get material_outlier() {
    return t("Отклонение материалов");
  },
  get rework_concentration() {
    return t("Концентрация доработок");
  },
  get low() {
    return t("Низкий");
  },
  get medium() {
    return t("Средний");
  },
  get high() {
    return t("Высокий");
  },
};
const evidenceLabels: Record<string, string> = {
  get order_ids() {
    return t("Наряды");
  },
  get count() {
    return t("Количество");
  },
  get denominator() {
    return t("Основание");
  },
  get numerator() {
    return t("Числитель");
  },
  get equipment_id() {
    return t("Оборудование");
  },
  get material_id() {
    return t("Материал");
  },
  get rate() {
    return t("Доля");
  },
  get baseline_rate() {
    return t("Средняя доля");
  },
  get baseline_median() {
    return t("Обычный расход (медиана)");
  },
  get total() {
    return t("Всего");
  },
};
function componentName(name: string) {
  return componentLabels[name] ?? name;
}
function evidenceValue(value: unknown) {
  if (Array.isArray(value))
    return value.length > 3
      ? t("{0} и ещё {1}", [value.slice(0, 3).join(", "), value.length - 3])
      : value.join(", ");
  return typeof value === "object" ? t("Составное доказательство") : String(value);
}
function RatingTable({ title, rows }: { title: string; rows: AnalyticsReport["ratings"]["employees"] }) {
  const max = Math.max(1, ...rows.map((r) => r.score ?? 0));
  return (
    <div className="rating-table">
      <h3>{title}</h3>
      {rows.map((row) => (
        <div className="rating-row" key={row.subject_id}>
          <div className="rating-name">
            <strong>{row.subject_name}</strong>
            <small>
              {t("Нарядов:")} {row.sample_size}
              {row.unavailable_components.length
                ? t(" · нет: {0}", [row.unavailable_components.map(componentName).join(", ")])
                : ""}
            </small>
          </div>
          <div className="score-bar">
            <span style={{ width: `${Math.max(0, Math.min(100, ((row.score ?? 0) / max) * 100))}%` }} />
          </div>
          <b>{row.score == null ? "—" : Math.round(row.score)}</b>
          <details>
            <summary>{t("Состав оценки")}</summary>
            <ul className="component-list">
              {entries(row.components).map(([key, value]) => {
                const item = value as {
                  value?: number | null;
                  numerator?: number | null;
                  denominator?: number | null;
                  detail?: string;
                };
                return (
                  <li key={key}>
                    <strong>
                      {componentName(key)}:{" "}
                      {item.value == null ? t("нет данных") : `${Math.round(item.value * 100)}%`}
                    </strong>
                    {item.numerator != null && item.denominator != null && (
                      <span>
                        {" "}
                        · {item.numerator} {t("из")} {item.denominator}
                      </span>
                    )}
                    {item.detail && <small>{item.detail}</small>}
                  </li>
                );
              })}
            </ul>
          </details>
        </div>
      ))}
    </div>
  );
}
function Materials({ report }: { report: AnalyticsReport }) {
  const render = (
    title: string,
    rows: Array<{
      material_id: string;
      material_name: string;
      unit: string;
      quantity: number;
      order_count: number;
      dimension_name?: string | null;
    }>,
  ) =>
    rows.length ? (
      <details className="material-breakdown">
        <summary>
          {title} ({rows.length})
        </summary>
        <div className="compact-table">
          {rows.map((row, index) => (
            <div className="table-row" key={row.material_id + row.unit + index}>
              <strong>
                {row.material_name}
                {row.dimension_name ? ` · ${row.dimension_name}` : ""}
              </strong>
              <span>
                {row.quantity} {row.unit}
              </span>
              <span>{row.order_count}</span>
            </div>
          ))}
        </div>
      </details>
    ) : null;
  const usage = report.materials.usage;
  return (
    <div>
      <Heading
        eye={t("РЕСУРСЫ")}
        title={t("Материалы")}
        note={t("Расход разделён по материалу и единице.")}
      />
      <div className="compact-table">
        {usage.length ? (
          <>
            <div className="table-head">
              <span>{t("Материал")}</span>
              <span>{t("Расход")}</span>
              <span>{t("Нарядов")}</span>
            </div>
            {usage.map((row, index) => (
              <div className="table-row" key={row.material_id + row.unit + index}>
                <strong>{row.material_name}</strong>
                <span>
                  {row.quantity} {row.unit}
                </span>
                <span>{row.order_count}</span>
              </div>
            ))}
          </>
        ) : (
          <p className="muted">{t("Расхода материалов в выбранном периоде нет.")}</p>
        )}
      </div>
      {render(t("По участкам"), report.materials.by_area as [])}
      {render(t("По оборудованию"), report.materials.by_equipment as [])}
      {render(t("По исполнителям"), report.materials.by_executor as [])}
    </div>
  );
}
function Downtime({ report }: { report: AnalyticsReport }) {
  const rows = report.downtime.by_equipment;
  return (
    <div>
      <Heading
        eye={t("ОБОРУДОВАНИЕ")}
        title={t("Зафиксированный простой")}
        note={t("Только явно внесённые интервалы, не выводится из статусов.")}
      />
      <div className="downtime-total">
        <span>
          {t("Плановый:")} <strong>{duration(report.downtime.planned_seconds)}</strong>
        </span>
        <span>
          {t("Неплановый:")} <strong>{duration(report.downtime.unplanned_seconds)}</strong>
        </span>
      </div>
      <div className="compact-table">
        {rows.length ? (
          rows.map((row) => (
            <div className="table-row" key={row.equipment_id}>
              <strong>{row.equipment_name}</strong>
              <span>{duration(row.known_seconds)}</span>
              <span>
                {row.unknown_order_count
                  ? t("Нет записи: {0}", [row.unknown_order_count])
                  : t("Интервал записан")}
              </span>
            </div>
          ))
        ) : (
          <p className="muted">{t("Нет записанных интервалов простоя.")}</p>
        )}
      </div>
      {Object.keys(report.downtime.by_fault).length > 0 && (
        <p className="muted downtime-causes">
          {t("По неисправностям:")}{" "}
          {Object.entries(report.downtime.by_fault)
            .map(([fault, value]) => `${fault} — ${duration(value)}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
function Anomalies({ report }: { report: AnalyticsReport }) {
  return report.anomalies.length ? (
    <div className="anomaly-list">
      {report.anomalies.map((item, index) => (
        <article className={"anomaly severity-" + item.severity} key={item.title + index}>
          <div>
            <span className="status">{anomalyLabels[item.severity] ?? item.severity}</span>
            <h3>{item.title}</h3>
            <p>{anomalyLabels[item.family] ?? item.family}</p>
          </div>
          <div>
            <p className="anomaly-formula">
              <strong>{t("Правило:")}</strong> {item.formula}
            </p>
            <dl>
              {entries(item.evidence)
                .filter(([key]) => !/(?:^|_)ids?$/.test(key))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{evidenceLabels[key] ?? key.replaceAll("_", " ")}</dt>
                    <dd>{evidenceValue(value)}</dd>
                  </div>
                ))}
            </dl>
          </div>
        </article>
      ))}
    </div>
  ) : (
    <div className="empty">
      <h3>{t("Аномалий не найдено")}</h3>
      <p>{t("В периоде нет достаточных доказательств для сигнала.")}</p>
    </div>
  );
}
function Activity({ report }: { report: AnalyticsReport }) {
  const rows = report.activity.by_employee;
  return (
    <section>
      <Heading
        eye={t("СМЕННАЯ ЗАГРУЗКА")}
        title={t("Активная работа")}
        note={t("Показаны только подтверждённые интервалы по нарядам.")}
      />
      <div className="compact-table">
        {rows.length ? (
          <>
            <div className="table-head">
              <span>{t("Исполнитель")}</span>
              <span>{t("Работа / пауза")}</span>
              <span>{t("Нарядов")}</span>
            </div>
            {rows.map((row) => (
              <div className="table-row" key={row.employee_id}>
                <strong>{row.employee_name}</strong>
                <span>
                  {duration(row.active_seconds)} / {duration(row.paused_seconds)}
                </span>
                <span>{row.order_count}</span>
              </div>
            ))}
          </>
        ) : (
          <p className="muted">{t("Активных интервалов в выбранном периоде нет.")}</p>
        )}
      </div>
    </section>
  );
}

function ReportWarnings({ warnings }: { warnings: string[] }) {
  const immediate = warnings.filter((warning) => warning.includes(t("ещё не наблюдался")));
  const methodology = warnings.filter((warning) => !immediate.includes(warning));
  return (
    <>
      {immediate.map((warning) => (
        <p className="banner" key={warning}>
          {warning}
        </p>
      ))}
      {methodology.length > 0 && (
        <details className="report-limitations">
          <summary>
            {t("Методика и ограничения (")}
            {methodology.length})
          </summary>
          {methodology.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
    </>
  );
}
