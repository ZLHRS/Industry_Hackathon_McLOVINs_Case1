import { Skeleton } from "../components/Skeleton";
import { t, getLocale, message } from "../lib/i18n";
import { AnalyticsSummaryPanel } from "./AnalyticsSummaryPanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError } from "../api";
import { Icon, type IconName } from "../components/Icon";
import { PreventionOutcomesPanel } from "./PreventionOutcomesPanel";
import { HistoryTrends } from "./HistoryTrends";
import type {
  AnalyticsOptions,
  AnalyticsQuery,
  AnalyticsReport,
  AnalyticsSummary,
  PreventiveDraft,
  PreventionSource,
  Role,
} from "../types";

export type AnalyticsMode = "report" | "insights";

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
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
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
// Each tab keeps its own filters for the session, so switching tabs never loses a chosen period.
const rememberedQueries: Partial<Record<AnalyticsMode, AnalyticsQuery>> = {};

export function AnalyticsView({
  api,
  role,
  mode = "report",
  revision,
  onPreventiveDraft,
}: {
  api: Api;
  role: Role;
  mode?: AnalyticsMode;
  revision: number;
  onPreventiveDraft: (draft: PreventiveDraft) => void;
}) {
  const insights = mode === "insights" && role !== "executor";
  const [query, setQuery] = useState<AnalyticsQuery>(
    () => rememberedQueries[mode] ?? queryString(insights ? { period: "month" } : {}),
  );
  const [options, setOptions] = useState<AnalyticsOptions | null>(null);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [appliedQuery, setAppliedQuery] = useState<AnalyticsQuery | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reportRevision, setReportRevision] = useState(0);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const mounted = useRef(true);
  const reportRequest = useRef(0);
  const summaryRequest = useRef(0);
  const people = role === "master" || role === "manager";
  const refresh = async (next = query) => {
    const request = ++reportRequest.current;
    summaryRequest.current += 1;
    setSummarizing(false);
    setSummaryError("");
    setLoading(true);
    setError("");
    try {
      const nextReport = await api.analyticsReport(next);
      if (!mounted.current || request !== reportRequest.current) return;
      setReport(nextReport);
      setAppliedQuery(next);
      rememberedQueries[mode] = next;
      setReportRevision(revision);
      setSummary(null);
      setSummaryError("");
    } catch (e) {
      if (!mounted.current || request !== reportRequest.current) return;
      setError(
        e instanceof ApiError && e.status === 403
          ? t("Этот отчёт недоступен для вашей роли.")
          : t("Не удалось сформировать отчёт. Проверьте параметры периода и соединение."),
      );
    } finally {
      if (mounted.current && request === reportRequest.current) setLoading(false);
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reportRequest.current += 1;
      summaryRequest.current += 1;
    };
  }, []);
  // The first realtime sync after opening the page is a baseline, not a change since the report.
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (firstRevision.current === 0 && revision > 0 && reportRevision === 0) {
      firstRevision.current = revision;
      const timer = window.setTimeout(() => setReportRevision(revision), 0);
      return () => window.clearTimeout(timer);
    }
  }, [revision, reportRevision]);
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
    if (summarizing || loading) return;
    const request = ++summaryRequest.current;
    setSummarizing(true);
    setSummaryError("");
    try {
      const next = await api.analyticsSummary(appliedQuery ?? query);
      if (mounted.current && request === summaryRequest.current) setSummary(next);
    } catch (e) {
      if (!mounted.current || request !== summaryRequest.current) return;
      const detail = e instanceof ApiError ? e.detail : "";
      setSummaryError(
        detail === "summary_cooldown_30_seconds"
          ? t("Сводка уже формировалась. Подождите 30 секунд и повторите запрос.")
          : detail === "summary_capacity_reached"
            ? t("ИИ-сводки сейчас заняты. Подождите и повторите запрос.")
            : t("ИИ-сводка не сформирована. Исходные показатели доступны ниже."),
      );
    } finally {
      if (mounted.current && request === summaryRequest.current) setSummarizing(false);
    }
  };
  const preparePreventive = async (source: PreventionSource) => {
    if (preparing) return;
    setPreparing(true);
    setError("");
    try {
      const draft = await api.preventiveDraft(source);
      if (mounted.current) onPreventiveDraft(draft);
    } catch {
      if (mounted.current)
        setError(t("Не удалось подготовить профилактический наряд. Обновите отчёт и повторите."));
    } finally {
      if (mounted.current) setPreparing(false);
    }
  };
  const heading = insights
    ? {
        eyebrow: t("ИИ-КОНТРОЛЁР СМЕНЫ"),
        title: t("ИИ-анализ"),
        lead: t(
          "Закономерности в истории нарядов: проблемное оборудование, повторные отказы и сигналы с рекомендациями.",
        ),
      }
    : {
        eyebrow: t("РЕЗУЛЬТАТЫ РАБОТЫ"),
        title: role === "executor" ? t("Мой отчёт") : t("Отчёты смены"),
        lead:
          role === "executor"
            ? t("Ваши наряды, оценка и время работы за выбранный период · время Костаная")
            : t("Итоги смены по журналу нарядов: выполнение, рейтинг, материалы и простои · время Костаная"),
      };
  return (
    <section
      className={`workspace analytics ${insights ? "analytics-insights" : "analytics-report"}`}
      aria-busy={loading}
    >
      <div className="page-head analytics-head">
        <div>
          <p className="eyebrow">{heading.eyebrow}</p>
          <h1>{heading.title}</h1>
          <p className="muted analytics-lead">{heading.lead}</p>
        </div>
        <div className="analytics-actions">
          {!insights && (
            <button
              className="secondary with-icon"
              onClick={() => void download()}
              disabled={!report || exporting}
            >
              <Icon name="download" />
              {exporting ? t("Готовим Excel…") : t("Скачать Excel")}
            </button>
          )}
          {!insights && (
            <button
              className="secondary with-icon analytics-print"
              type="button"
              onClick={() => window.print()}
              disabled={!report}
              title={t("Сохранить отчёт в PDF или распечатать")}
              aria-label={t("Сохранить отчёт в PDF или распечатать")}
            >
              <Icon name="printer" />
              PDF
            </button>
          )}
          <button
            className="primary with-icon"
            onClick={() => void refresh()}
            disabled={loading || summarizing}
          >
            <Icon name="refresh" />
            {loading ? t("Считаем…") : insights ? t("Обновить анализ") : t("Обновить отчёт")}
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
        <button className="secondary with-icon analytics-apply" disabled={loading || summarizing}>
          <Icon name="check" />
          {t("Применить")}
        </button>
      </form>
      {pendingFilters && (
        <p className="muted report-pending">
          <Icon name="alert" />
          {insights
            ? t("Фильтры изменены. Нажмите «Применить», чтобы обновить анализ.")
            : t(
                "Фильтры изменены. Нажмите «Применить», чтобы обновить показанный отчёт, выгрузку и ИИ-сводку.",
              )}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {message(error)}
        </p>
      )}
      {loading && !report && (
        <Skeleton
          variant="report"
          count={insights ? 4 : 5}
          label={
            insights ? t("Ищем закономерности в истории нарядов…") : t("Формируем отчёт по журналу нарядов…")
          }
        />
      )}
      {report && (
        <>
          <div className="report-caption">
            <span className="report-caption-period">
              <Icon name="calendar" />
              <strong>{report.period.label}</strong>
            </span>
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
            {loading ? (
              <span className="report-caption-loading" role="status">
                <span className="spinner-dot" aria-hidden="true" />
                {t("Обновляем…")}
              </span>
            ) : (
              stale && (
                <button
                  type="button"
                  className="report-stale"
                  onClick={() => void refresh()}
                  title={t("Появились новые изменения.")}
                >
                  <span className="report-stale-dot" aria-hidden="true" />
                  {t("Есть новые данные")}
                  <span className="report-stale-action">
                    <Icon name="refresh" />
                    {t("Обновить данные")}
                  </span>
                </button>
              )
            )}
          </div>
          <ReportWarnings
            warnings={
              insights
                ? [
                    ...report.meta.warnings,
                    ...(report.forecast ? [`${t("Прогноз отказов")}: ${report.forecast.formula}`] : []),
                    ...(report.breakdown_time
                      ? [`${t("Поломки по сменам")}: ${report.breakdown_time.formula}`]
                      : []),
                  ]
                : report.meta.warnings
            }
          />
          {insights ? (
            <InsightsBody
              report={report}
              equipment={machines}
              api={api}
              role={role}
              revision={revision}
              appliedQuery={appliedQuery}
              preparing={preparing}
              onPrepare={(source) => void preparePreventive(source)}
            />
          ) : (
            <>
              <section className="metric-grid">
                <Metric icon="orders" label={t("Выдано")} value={report.orders.issued} />
                <Metric icon="check" label={t("Завершено")} value={report.orders.completed} tone="teal" />
                <Metric icon="checkCircle" label={t("Закрыто")} value={report.orders.closed} tone="green" />
                <Metric
                  icon="close"
                  label={t("Отказы")}
                  value={report.orders.rejected}
                  tone={report.orders.rejected > 0 ? "red" : undefined}
                />
                <Metric
                  icon="inbox"
                  label={t("Незакрыто")}
                  value={report.orders.backlog}
                  warn={report.orders.backlog > 0}
                />
                <Metric
                  icon="alert"
                  label={t("Просрочено")}
                  value={report.orders.overdue}
                  warn={report.orders.overdue > 0}
                  tone={report.orders.overdue > 0 ? "red" : undefined}
                />
                <DurationMetric
                  icon="zap"
                  label={t("Реакция")}
                  value={report.durations.response_seconds}
                  note={t("В среднем до первого ответа")}
                />
                <DurationMetric
                  icon="wrench"
                  label={t("Работа")}
                  value={report.durations.work_seconds}
                  note={t("В среднем, без пауз")}
                />
                {people && (
                  <DurationMetric
                    icon="pause"
                    label={t("Простой")}
                    value={report.downtime.known_seconds}
                    note={t("Только записанные интервалы")}
                  />
                )}
                <Metric
                  icon="activity"
                  label={t("Активные наряды")}
                  value={report.activity.active_order_count}
                />
              </section>
              <section className="analytics-section">
                <Heading
                  icon="trophy"
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
              {people && (
                <AnalyticsSummaryPanel
                  summary={summary}
                  period={report.period.label}
                  busy={summarizing}
                  disabled={loading}
                  error={summaryError}
                  onGenerate={() => void requestSummary()}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function InsightsBody({
  report,
  equipment,
  api,
  role,
  revision,
  appliedQuery,
  preparing,
  onPrepare,
}: {
  report: AnalyticsReport;
  equipment: AnalyticsOptions["equipment"];
  api: Api;
  role: Role;
  revision: number;
  appliedQuery: AnalyticsQuery | null;
  preparing: boolean;
  onPrepare: (source: PreventionSource) => void;
}) {
  const severity = { high: 0, medium: 0, low: 0 };
  for (const item of report.anomalies) severity[item.severity] += 1;
  const machines = report.leaders.machines.slice(0, 5);
  const areas = report.leaders.areas.slice(0, 5);
  const repeat = report.anomalies.filter((item) => item.family === "recurring_fault").length;
  return (
    <>
      <section className="insight-strip" aria-label={t("Сводка сигналов")}>
        <article className="insight-tile is-high">
          <span className="insight-tile-icon">
            <Icon name="alert" />
          </span>
          <div>
            <strong>{severity.high}</strong>
            <small>{t("Высокий приоритет")}</small>
          </div>
        </article>
        <article className="insight-tile is-medium">
          <span className="insight-tile-icon">
            <Icon name="zap" />
          </span>
          <div>
            <strong>{severity.medium}</strong>
            <small>{t("Средний приоритет")}</small>
          </div>
        </article>
        <article className="insight-tile is-low">
          <span className="insight-tile-icon">
            <Icon name="activity" />
          </span>
          <div>
            <strong>{severity.low}</strong>
            <small>{t("Низкий приоритет")}</small>
          </div>
        </article>
        <article className="insight-tile is-repeat">
          <span className="insight-tile-icon">
            <Icon name="refresh" />
          </span>
          <div>
            <strong>{repeat}</strong>
            <small>{t("Повторные неисправности")}</small>
          </div>
        </article>
      </section>
      <section className="analytics-section analytics-split leaders-split">
        <Leaders
          icon="wrench"
          eye={t("ТОП ПРОБЛЕМНОГО ОБОРУДОВАНИЯ")}
          title={t("Проблемное оборудование")}
          note={t("По числу нарядов за период; учитываются просрочки и простой.")}
          rows={machines}
        />
        <Leaders
          icon="pin"
          eye={t("УЧАСТКИ")}
          title={t("Проблемные участки")}
          note={t("Где больше всего работ и просрочек.")}
          rows={areas}
        />
      </section>
      <HistoryTrends
        forecast={report.forecast}
        timing={report.breakdown_time}
        equipmentName={(id, fallback) => {
          const item = equipment.find((machine) => machine.id === id);
          return item ? `${item.code ? item.code + " · " : ""}${item.name}` : fallback;
        }}
      />
      <section className="analytics-section">
        <Heading
          icon="sparkles"
          eye={t("СИГНАЛЫ")}
          title={t("Аномалии с доказательствами")}
          note={t("Система показывает только наблюдаемые факты.")}
        />
        <Anomalies
          report={report}
          canPrepare={role === "master"}
          preparing={preparing}
          onPrepare={onPrepare}
        />
      </section>
      <PreventionOutcomesPanel api={api} query={appliedQuery} revision={revision} />
    </>
  );
}

function Leaders({
  icon,
  eye,
  title,
  note,
  rows,
}: {
  icon: IconName;
  eye: string;
  title: string;
  note: string;
  rows: AnalyticsReport["leaders"]["machines"];
}) {
  const max = Math.max(1, ...rows.map((row) => row.order_count));
  return (
    <div className="leaders">
      <Heading icon={icon} eye={eye} title={title} note={note} />
      {rows.length ? (
        <ol className="leader-list">
          {rows.map((row, index) => (
            <li key={row.id} className={index === 0 ? "is-top" : undefined}>
              <span className="leader-rank">{index + 1}</span>
              <div className="leader-body">
                <div className="leader-line">
                  <strong>{row.name}</strong>
                  <span className="leader-count">{t("{0} нар.", [row.order_count])}</span>
                </div>
                <div className="leader-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(4, percent(row.order_count, max))}%` }} />
                </div>
                <small>
                  {row.overdue_count > 0 ? (
                    <span className="leader-overdue">{t("Просрочено: {0}", [row.overdue_count])}</span>
                  ) : (
                    <span>{t("Без просрочек")}</span>
                  )}
                  {" · "}
                  {t("Простой: {0}", [duration(row.downtime_seconds)])}
                </small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{t("За период нет нарядов для сравнения.")}</p>
      )}
    </div>
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
        <option value="">{t("Все")}</option>
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
function Heading({ icon, eye, title, note }: { icon?: IconName; eye: string; title: string; note: string }) {
  return (
    <div className="section-heading">
      <div className="section-heading-title">
        {icon && (
          <span className="section-heading-icon" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
        <div>
          <p className="eyebrow">{eye}</p>
          <h2>{title}</h2>
        </div>
      </div>
      <small>{note}</small>
    </div>
  );
}
function Metric({
  icon,
  label,
  value,
  note,
  warn,
  tone,
}: {
  icon?: IconName;
  label: string;
  value: string | number;
  note?: string;
  warn?: boolean;
  tone?: "teal" | "green" | "red";
}) {
  return (
    <article className={"metric " + (warn ? "metric-warning " : "") + (tone ? `metric-${tone}` : "")}>
      <div className="metric-head">
        <span>{label}</span>
        {icon && (
          <span className="metric-icon" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
      </div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}
function DurationMetric({
  icon,
  label,
  value,
  note,
}: {
  icon: IconName;
  label: string;
  value: number | null | undefined;
  note: string;
}) {
  return value == null ? (
    <article className="metric metric-empty">
      <div className="metric-head">
        <span>{label}</span>
        <span className="metric-icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
      </div>
      <strong aria-label={t("Недостаточно данных")}>—</strong>
      <small>{t("Недостаточно данных")}</small>
    </article>
  ) : (
    <Metric icon={icon} label={label} value={duration(value)} note={note} />
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
      <RatingTable
        title={privateView ? t("Моя оценка") : t("Исполнители")}
        rows={employee}
        ranked={!privateView}
      />
      {!privateView && <RatingTable title={t("Бригады")} rows={brigade} ranked />}{" "}
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
const anomalyIcons: Record<string, IconName> = {
  recurring_fault: "refresh",
  after_ppr: "shield",
  material_outlier: "package",
  rework_concentration: "user",
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
function RatingTable({
  title,
  rows,
  ranked,
}: {
  title: string;
  rows: AnalyticsReport["ratings"]["employees"];
  ranked: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.score ?? 0));
  return (
    <div className="rating-table">
      <h3>{title}</h3>
      {rows.map((row, index) => (
        <div
          className={`rating-row${ranked && index < 3 && row.score != null ? ` is-podium rank-${index + 1}` : ""}`}
          key={row.subject_id}
        >
          <div className="rating-name">
            <strong>
              {ranked && (
                <span className="rating-rank" aria-label={t("Место {0}", [index + 1])}>
                  {index + 1}
                </span>
              )}
              {row.subject_name}
            </strong>
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
        icon="package"
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
  const total = report.downtime.planned_seconds + report.downtime.unplanned_seconds;
  return (
    <div>
      <Heading
        icon="pause"
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
      {total > 0 && (
        <div className="downtime-split" aria-hidden="true">
          <span className="is-planned" style={{ flexGrow: report.downtime.planned_seconds }} />
          <span className="is-unplanned" style={{ flexGrow: report.downtime.unplanned_seconds }} />
        </div>
      )}
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
function preventionSource(
  report: AnalyticsReport,
  item: AnalyticsReport["anomalies"][number],
): PreventionSource | null {
  if (item.family !== "recurring_fault" && item.family !== "after_ppr") return null;
  const equipmentId = item.evidence.equipment_id;
  const orderIds = item.evidence.order_ids;
  if (
    typeof equipmentId !== "string" ||
    !Array.isArray(orderIds) ||
    !orderIds.length ||
    !orderIds.every((id): id is string => typeof id === "string")
  )
    return null;
  return {
    query: {
      period: "custom",
      from: report.period.from,
      to: report.period.to,
      timezone: report.period.timezone,
      area_ids: report.filters.area_ids,
      equipment_ids: report.filters.equipment_ids,
      executor_ids: report.filters.executor_ids,
      brigade_ids: report.filters.brigade_ids,
    },
    family: item.family,
    equipment_id: equipmentId,
    order_ids: orderIds,
  };
}
function Anomalies({
  report,
  canPrepare,
  preparing,
  onPrepare,
}: {
  report: AnalyticsReport;
  canPrepare: boolean;
  preparing: boolean;
  onPrepare: (source: PreventionSource) => void;
}) {
  const order = { high: 0, medium: 1, low: 2 } as const;
  const anomalies = report.anomalies
    .map((item, index) => ({ item, index }))
    .sort(
      (first, second) =>
        order[first.item.severity] - order[second.item.severity] || first.index - second.index,
    );
  // One group per signal type: the rule is explained once, each finding is a short row.
  const groups: Array<{ family: string; items: typeof anomalies }> = [];
  for (const entry of anomalies) {
    const group = groups.find((value) => value.family === entry.item.family);
    if (group) group.items.push(entry);
    else groups.push({ family: entry.item.family, items: [entry] });
  }
  return anomalies.length ? (
    <div className="anomaly-groups">
      {groups.map((group) => {
        const sharedFormula = group.items.every(({ item }) => item.formula === group.items[0].item.formula)
          ? group.items[0].item.formula
          : null;
        return (
          <section className="anomaly-group" key={group.family}>
            <header className="anomaly-group-head">
              <span className="anomaly-family">
                <Icon name={anomalyIcons[group.family] ?? "sparkles"} />
                {anomalyLabels[group.family] ?? group.family}
              </span>
              <b className="anomaly-group-count">{group.items.length}</b>
              {sharedFormula && (
                <p className="anomaly-formula">
                  <strong>{t("Правило:")}</strong> {sharedFormula}
                </p>
              )}
            </header>
            <div className="anomaly-list">
              {group.items.map(({ item, index }) => {
                const source = preventionSource(report, item);
                const facts = entries(item.evidence).filter(([key]) => !/(?:^|_)ids?$/.test(key));
                return (
                  <article className={"anomaly severity-" + item.severity} key={item.title + index}>
                    <div className="anomaly-summary">
                      <span className="status">{anomalyLabels[item.severity] ?? item.severity}</span>
                      <h3>{item.title}</h3>
                      {!sharedFormula && (
                        <p className="anomaly-formula">
                          <strong>{t("Правило:")}</strong> {item.formula}
                        </p>
                      )}
                    </div>
                    {facts.length > 0 && (
                      <dl className="anomaly-facts">
                        {facts.map(([key, value]) => (
                          <div key={key}>
                            <dt>{evidenceLabels[key] ?? key.replaceAll("_", " ")}</dt>
                            <dd>{evidenceValue(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {canPrepare && source && (
                      <button
                        className="secondary with-icon prevention-action"
                        type="button"
                        data-testid={`prevention-prepare-${item.family}-${index}`}
                        disabled={preparing}
                        onClick={() => onPrepare(source)}
                      >
                        <Icon name="plus" />
                        {preparing ? t("Подготавливаем…") : t("Подготовить наряд")}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
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
  const max = Math.max(1, ...rows.map((row) => row.active_seconds + row.paused_seconds));
  return (
    <section>
      <Heading
        icon="timer"
        eye={t("СМЕННАЯ ЗАГРУЗКА")}
        title={t("Активная работа")}
        note={t("Показаны только подтверждённые интервалы по нарядам.")}
      />
      <div className="compact-table activity-table">
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
                <span className="activity-cell">
                  {duration(row.active_seconds)} / {duration(row.paused_seconds)}
                  <span className="activity-bar" aria-hidden="true">
                    <span className="is-active" style={{ width: `${percent(row.active_seconds, max)}%` }} />
                    <span className="is-paused" style={{ width: `${percent(row.paused_seconds, max)}%` }} />
                  </span>
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
