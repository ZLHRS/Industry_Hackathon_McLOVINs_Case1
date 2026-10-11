import { Api } from "../api";
import { message, t } from "../lib/i18n";
import { local, ruStatus } from "./OrderDetail";
import { useEffect, useRef, useState } from "react";
import type { AnalyticsQuery, PreventionOutcome, PreventionOutcomesPage } from "../types";

const pageSize = 5;

type Props = {
  api: Api;
  query: AnalyticsQuery | null;
  revision: number;
};

const outcomeLabels: Record<PreventionOutcome["outcome"], string> = {
  pending: "Ожидает выполнения",
  cancelled: "Отменён",
  under_observation: "Наблюдение продолжается",
  repeat_detected: "Повтор зарегистрирован",
  window_completed_no_recorded_repeat: "7 дней без зарегистрированного повтора",
  unknown: "Недостаточно данных",
};

function outcomeLabel(item: PreventionOutcome) {
  if (item.source?.family === "after_ppr") {
    if (item.outcome === "repeat_detected") return t("Внеплановый ремонт зарегистрирован");
    if (item.outcome === "window_completed_no_recorded_repeat") return t("7 дней без внеплановых ремонтов");
  }
  return t(outcomeLabels[item.outcome]);
}

function sourceLabel(kind: NonNullable<PreventionOutcome["source"]>["comparison_kind"]) {
  return kind === "same_fault"
    ? t("Повтор той же неисправности")
    : t("Внеплановый ремонт после профилактики");
}

function orderHref(id: string) {
  return `/orders/${encodeURIComponent(id)}`;
}

export function PreventionOutcomesPanel({ api, query, revision }: Props) {
  const [open, setOpen] = useState(false);
  const panelKey = `${revision}:${JSON.stringify(query)}`;
  return (
    <details
      className="prevention-outcomes"
      data-testid="prevention-outcomes"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("Контроль профилактики")}</summary>
      {open && <PreventionOutcomesResults key={panelKey} api={api} query={query} />}
    </details>
  );
}

function PreventionOutcomesResults({ api, query }: Omit<Props, "revision">) {
  const [page, setPage] = useState<PreventionOutcomesPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    if (!query) return;
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api
        .preventionOutcomes(query, offset, pageSize)
        .then((result) => {
          if (id === request.current) {
            setPage(result);
            setError("");
          }
        })
        .catch(() => {
          if (id === request.current) setError(t("Не удалось загрузить контроль профилактики."));
        })
        .finally(() => {
          if (id === request.current) {
            setLoading(false);
            setPaging(false);
          }
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      request.current += 1;
    };
  }, [api, offset, query, refresh]);

  const previous = () => {
    setPaging(true);
    setOffset((value) => Math.max(0, value - pageSize));
  };
  const next = () => {
    setPaging(true);
    setOffset((value) => value + pageSize);
  };
  return (
    <div className="prevention-outcomes-content">
      <p className="muted prevention-outcomes-context">
        {t(
          "Период отбирает профилактические наряды по дате выдачи. Наблюдение повторов начинается после закрытия.",
        )}
      </p>
      <p className="muted prevention-outcomes-context">
        {t("Наблюдение фиксирует записи журнала и не доказывает эффективность профилактики.")}
      </p>
      {!query && <p className="muted">{t("Сначала сформируйте отчёт с нужными фильтрами.")}</p>}
      {query && loading && <p className="muted">{t("Загружаем контроль профилактики…")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setError("");
              setRefresh((value) => value + 1);
            }}
          >
            {t("Повторить")}
          </button>
        </p>
      )}
      {page && !loading && page.items.length === 0 && (
        <p className="muted">{t("Профилактических нарядов за выбранный период нет.")}</p>
      )}
      {page?.items.map((item) => (
        <OutcomeCard item={item} key={item.order_id} />
      ))}
      {page && page.total > page.limit && (
        <nav className="prevention-outcomes-pages" aria-label={t("Страницы контроля профилактики")}>
          <button
            className="secondary"
            type="button"
            disabled={loading || paging || page.offset === 0}
            onClick={previous}
          >
            {t("Назад")}
          </button>
          <span>
            {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} {t("из")} {page.total}
          </span>
          <button
            className="secondary"
            type="button"
            disabled={loading || paging || page.offset + page.limit >= page.total}
            onClick={next}
          >
            {t("Вперёд")}
          </button>
        </nav>
      )}
      {page && (page.notes.length || page.truncated) ? (
        <p className="muted prevention-outcomes-note">
          {page.notes.length ? page.notes.map(message).join(" ") : t("Показаны не все найденные результаты.")}
        </p>
      ) : null}
    </div>
  );
}

function OutcomeCard({ item }: { item: PreventionOutcome }) {
  const observation = item.observation;
  const source = item.source;
  const afterPpr = source?.family === "after_ppr";
  return (
    <article className="prevention-outcome" data-testid={`prevention-outcome-${item.order_id}`}>
      <details>
        <summary>
          <a href={orderHref(item.order_id)}>{item.number}</a>
          <span>
            {item.equipment_inventory_number} · {item.equipment_name}
          </span>
          <b className={`prevention-outcome-status outcome-${item.outcome}`}>{outcomeLabel(item)}</b>
        </summary>
        <div className="prevention-outcome-detail">
          <dl>
            <div>
              <dt>{t("Выдан")}</dt>
              <dd>{local(item.issued_at)}</dd>
            </div>
            <div>
              <dt>{t("Статус")}</dt>
              <dd>{ruStatus[item.status] ?? item.status}</dd>
            </div>
            <div>
              <dt>{t("Закрыт")}</dt>
              <dd>
                {item.closure
                  ? local(item.closure.closed_at)
                  : item.status === "closed"
                    ? t("Нет подтверждённой даты")
                    : t("Не закрыт")}
              </dd>
            </div>
          </dl>
          {observation && (
            <section className="prevention-observation">
              <h4>{t("Наблюдение")}</h4>
              <p>
                {t("Дней наблюдения: {0} из {1}", [
                  Math.floor(observation.observed_days),
                  observation.window_days,
                ])}{" "}
                · {t("До:")} {local(observation.window_end)}
              </p>
              <p>
                {t("Проверено по состоянию на:")} {local(observation.observed_until)}
              </p>
              <p>
                {afterPpr
                  ? t("Внеплановых ремонтов в журнале: {0}", [observation.repeat_count])
                  : t("Повторов в журнале: {0}", [observation.repeat_count])}
                {observation.repeat_evidence_truncated ? ` · ${t("Показаны не все связанные наряды.")}` : ""}
              </p>
              {observation.repeat_orders.length > 0 && (
                <p>
                  {afterPpr ? t("Связанные внеплановые ремонты:") : t("Связанные повторы:")}{" "}
                  {observation.repeat_orders.map((order, index) => (
                    <span key={order.id}>
                      {index > 0 ? ", " : ""}
                      <a href={orderHref(order.id)}>{order.number}</a>
                    </span>
                  ))}
                </p>
              )}
            </section>
          )}
          <details className="prevention-outcome-evidence">
            <summary>{t("Основание и методика")}</summary>
            <div>
              {source ? (
                <>
                  <strong>{source.title}</strong>
                  <p>{source.recommendation}</p>
                  <p>
                    <strong>{t("Сравнение:")}</strong> {sourceLabel(source.comparison_kind)}
                  </p>
                  <p>
                    <strong>{t("Правило:")}</strong> {source.formula}
                  </p>
                  {source.evidence_orders.length > 0 && (
                    <p>
                      <strong>{t("Исходные наряды:")}</strong>{" "}
                      {source.evidence_orders.map((order, index) => (
                        <span key={order.id}>
                          {index > 0 ? ", " : ""}
                          <a href={orderHref(order.id)}>{order.number}</a>
                        </span>
                      ))}
                    </p>
                  )}
                </>
              ) : (
                <p className="muted">{t("Основание недоступно.")}</p>
              )}
              {item.notes.map((note) => (
                <p className="muted" key={note}>
                  {message(note)}
                </p>
              ))}
            </div>
          </details>
        </div>
      </details>
    </article>
  );
}
