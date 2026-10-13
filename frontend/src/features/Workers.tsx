import { useState } from "react";
import { Icon } from "../components/Icon";
import { getLocale, t } from "../lib/i18n";
import type { Workload } from "../types";

type Availability = Workload["availability"];
type Filter = "all" | Availability;

// Case R07: green — free, yellow — busy, blue — has a queue, grey — off shift.
const availabilityOrder: Availability[] = ["free", "busy", "queued", "off_shift"];

function availabilityLabel(value: Availability) {
  return value === "busy"
    ? t("Занят")
    : value === "free"
      ? t("Свободен")
      : value === "queued"
        ? t("Очередь")
        : t("Не в смене");
}

function availabilityGroupLabel(value: Availability) {
  return value === "busy"
    ? t("Заняты")
    : value === "free"
      ? t("Свободны")
      : value === "queued"
        ? t("С очередью")
        : t("Не в смене");
}

function elapsed(since: string | null) {
  if (!since) return null;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 60) return t("{0} мин", [minutes]);
  if (minutes < 24 * 60) return t("{0} ч {1} мин", [Math.floor(minutes / 60), minutes % 60]);
  return t("{0} д {1} ч", [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60)]);
}

function WorkerCard({
  person,
  onOpen,
  onEmployeeOrders,
}: {
  person: Workload;
  onOpen: (id: string) => void;
  onEmployeeOrders: (employeeId: string) => void;
}) {
  const since = elapsed(person.current_started_at);
  return (
    <article className={`worker worker-card is-${person.availability}`}>
      <div className="worker-card-head">
        <span className={`availability ${person.availability}`}></span>
        <div className="worker-identity">
          <button
            type="button"
            className="workload-person-link"
            onClick={() => onEmployeeOrders(person.employee_id)}
            title={t("Открыть наряды сотрудника")}
          >
            {person.display_name}
          </button>
          <small>
            {person.specialty} · {person.grade} {t("разряд")}
          </small>
        </div>
        <b className={`availability-label ${person.availability}`}>
          {availabilityLabel(person.availability)}
        </b>
      </div>
      {person.current_order_id && person.current_order_number && (
        <button
          className="workload-order-link worker-current"
          type="button"
          onClick={() => onOpen(person.current_order_id!)}
          title={t("Открыть наряд {0}", [person.current_order_number])}
        >
          <span className="worker-current-title">
            {person.current_order_title ??
              person.current_order_description ??
              t("Наряд {0}", [person.current_order_number])}
          </span>
          <span className="worker-current-meta">
            {person.current_order_equipment && <span>{person.current_order_equipment}</span>}
            <span>{person.current_order_number}</span>
            {since && <span className="worker-since">{t("в работе {0}", [since])}</span>}
          </span>
        </button>
      )}
      {(person.queue_length > 0 || person.paused_count > 0) && (
        <div className="worker-card-foot">
          {person.queue_length > 0 && (
            <small className="workload-queue" title={t("В очереди:") + " " + person.queue_length}>
              <Icon name="list" />
              {t("В очереди:")} {person.queue_length}
            </small>
          )}
          {person.paused_count > 0 && (
            <small className="worker-paused">
              <Icon name="pause" />
              {t("На паузе: {0}", [person.paused_count])}
            </small>
          )}
        </div>
      )}
    </article>
  );
}

export function WorkloadView({
  workers,
  onOpen,
  onEmployeeOrders,
}: {
  workers: Workload[];
  onOpen: (id: string) => void;
  onEmployeeOrders: (employeeId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const counts: Record<Availability, number> = { free: 0, busy: 0, queued: 0, off_shift: 0 };
  for (const person of workers) counts[person.availability] += 1;
  const needle = query.trim().toLocaleLowerCase(getLocale());
  const matches = (person: Workload) =>
    !needle ||
    [
      person.display_name,
      person.specialty,
      person.current_order_title ?? "",
      person.current_order_number ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase(getLocale())
      .includes(needle);
  const groups = availabilityOrder
    .filter((key) => filter === "all" || filter === key)
    .map((key) => ({
      key,
      people: workers
        .filter((person) => person.availability === key && matches(person))
        .sort((first, second) => first.display_name.localeCompare(second.display_name, getLocale())),
    }))
    .filter((group) => group.people.length > 0);
  return (
    <section className="workspace workers-workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">{t("СМЕНА")}</p>
          <h1>{t("Исполнители")}</h1>
        </div>
      </div>

      <div className="workers-toolbar">
        <div className="workers-filters" role="group" aria-label={t("Фильтр по статусу")}>
          <button
            type="button"
            className={filter === "all" ? "workers-filter is-active" : "workers-filter"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            {t("Все")} <b>{workers.length}</b>
          </button>
          {availabilityOrder.map((key) => (
            <button
              key={key}
              type="button"
              className={`workers-filter ${key}${filter === key ? " is-active" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter((current) => (current === key ? "all" : key))}
            >
              <span className={`workers-filter-dot ${key}`} aria-hidden="true" />
              {availabilityGroupLabel(key)} <b>{counts[key]}</b>
            </button>
          ))}
        </div>
        <label className="order-search workers-search">
          <Icon name="search" className="order-search-icon" />
          <span className="sr-only">{t("Поиск исполнителя")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Поиск по имени или наряду")}
            aria-label={t("Поиск исполнителя")}
          />
        </label>
      </div>

      {groups.length === 0 ? (
        <div className="empty workers-empty">
          <h2>{t("Никого не найдено")}</h2>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setFilter("all");
              setQuery("");
            }}
          >
            {t("Сбросить фильтры")}
          </button>
        </div>
      ) : (
        <div className="workload workers-groups">
          {groups.map((group) => (
            <section
              key={group.key}
              className={`workers-group is-${group.key}`}
              aria-label={availabilityGroupLabel(group.key)}
            >
              <h2 className="workers-group-title">
                <span className={`workers-filter-dot ${group.key}`} aria-hidden="true" />
                {availabilityGroupLabel(group.key)}
                <small>{group.people.length}</small>
              </h2>
              <div className="workers-grid">
                {group.people.map((person) => (
                  <WorkerCard
                    key={person.employee_id}
                    person={person}
                    onOpen={onOpen}
                    onEmployeeOrders={onEmployeeOrders}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
