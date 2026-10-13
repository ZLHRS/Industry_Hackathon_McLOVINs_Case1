import { Skeleton } from "../components/Skeleton";
import { suggestionText } from "../lib/suggestionText";
import { orderTitle } from "../lib/orderText";
import { boardColumnOrders, belongsToOverdueBoardColumn, currentBusyOrderNumber } from "./workspaceBoard";
import { t, message } from "../lib/i18n";
import {
  activeOrderStatuses as activeStatuses,
  archivedOrderStatuses as archiveStatuses,
  type OrderFilters,
} from "../lib/orderFilters";
import { roleLabels } from "../lib/roleAccess";
import type { DirectoryFilters, DirectorySection } from "../lib/navigation";
import "./workspace-ux.css";
import "./reference-ux.css";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Icon, type IconName } from "../components/Icon";
import { OrderReference } from "../components/OrderReference";
import { Api, ApiError } from "../api";
import { local, ruPriority, ruStatus } from "./OrderDetail";
import { SimilarRepairsPanel } from "./SimilarRepairsPanel";
import { CatalogImport } from "./CatalogImport";
import { BeforePhotoPicker } from "./BeforePhotoPicker";
import type {
  BeforePhotos,
  Catalog,
  BrigadeAssignmentOption,
  BrigadeAssignmentOptions,
  BrigadeOptionsRequest,
  CreateOrder,
  MasterOption,
  Order,
  OrderDetail,
  OrderPage,
  OrderSuggestionExecutor,
  OrderSuggestions,
  PreventiveDraft,
  Role,
  SimilarRepairsRequest,
  Workload,
} from "../types";

type CatalogEditorKind = "area" | "equipment" | "brigade" | "material" | "fault-code" | "time-norm";

function almatyInputDate(value: Date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(value)
    .replace(" ", "T");
}

function endOfCurrentShift() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const minutesToBoundary =
    hour < 8 ? (8 - hour) * 60 - minute : hour < 20 ? (20 - hour) * 60 - minute : (32 - hour) * 60 - minute;
  return almatyInputDate(new Date(Date.now() + Math.max(1, minutesToBoundary) * 60_000));
}

function brigadeAvailabilityLabel(value: BrigadeAssignmentOption["participants"][number]["availability"]) {
  if (value === "free") return t("Свободен");
  if (value === "busy") return t("Занят");
  if (value === "queued") return t("В очереди");
  return t("Пауза");
}

function crewAvailability(option: BrigadeAssignmentOption) {
  const free = option.participants.filter((person) => person.availability === "free").length;
  return t("Свободны {0} из {1}", [free, option.participants.length]);
}

function brigadeSpecialtySummary(
  option: BrigadeAssignmentOption,
  context: BrigadeAssignmentOptions["context"],
) {
  if (context.specialty && option.specialty_match) {
    return t("Специалист по {0}: {1}", [context.specialty, option.matching_specialists]);
  }
  if (context.specialty && option.specialty_match === false) {
    return t("Нет подтверждённого специалиста по {0}", [context.specialty]);
  }
  if (context.specialty_source === "inferred" && context.specialty) {
    return t("Специальность определена по описанию: {0}", [context.specialty]);
  }
  return t("Специальность не определена");
}

function brigadeQualitySummary(option: BrigadeAssignmentOption) {
  if (option.quality_score === null || option.quality_sample_count <= 0) {
    return t("Недостаточно данных о качестве");
  }
  return t("Качество: {0}/5 по {1} нарядам", [option.quality_score.toFixed(1), option.quality_sample_count]);
}

function responsibleSummary(person: BrigadeAssignmentOption["participants"][number] | undefined) {
  if (!person) return "—";
  const availability = brigadeAvailabilityLabel(person.availability);
  return `${person.display_name} · ${person.grade} ${t("разряд")} · ${availability}`;
}

export function OrdersView({
  role,
  page,
  catalog,
  workload,
  masters,
  currentUserId,
  filters,
  onFilters,
  onOpen,
  onCreate,
  onAssistant,
  faultReportCount,
  onFaultReports,
  onHistory,
  onSuggest,
  onSimilar,
  onViewEvidence,
  onBrigadeOptions,
  onWorkers,
  loading,
}: {
  role: Role;
  page: OrderPage | null;
  catalog: Catalog | null;
  workload: Workload[];
  masters: MasterOption[];
  currentUserId: string;
  filters: OrderFilters;
  onFilters: (next: OrderFilters) => void;
  onOpen: (id: string) => void;
  onCreate: (input: CreateOrder, photos?: BeforePhotos) => Promise<void>;
  onAssistant: () => void;
  faultReportCount: number;
  onFaultReports: () => void;
  onHistory: (equipmentId: string) => Promise<void>;
  onSuggest: (input: {
    area_id: string;
    equipment_id: string;
    description: string;
    fault_code_id?: string | null;
  }) => Promise<OrderSuggestions>;
  onSimilar: (input: SimilarRepairsRequest) => Promise<import("../types").SimilarRepairs>;
  onViewEvidence: (id: string) => Promise<OrderDetail>;
  onBrigadeOptions: (input: BrigadeOptionsRequest) => Promise<BrigadeAssignmentOptions>;
  onWorkers?: () => void;
  loading: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(filters.query);
  const committedQuery = useRef(filters.query);
  const view = {
    executor: {
      eyebrow: t("МОЯ СМЕНА"),
      title: t("Мои наряды"),
      guidance: t("Откройте наряд, чтобы принять его, начать работу или завершить выполнение."),
    },
    master: {
      eyebrow: t("УПРАВЛЕНИЕ СМЕНОЙ"),
      title: t("Наряды участка"),
      guidance: t("Выдавайте наряды и контролируйте ход работ по участку."),
    },
    manager: {
      eyebrow: t("КОНТРОЛЬ РАБОТ"),
      title: t("Наряды участка"),
      guidance: t("Просматривайте ход работ и переключайте список по текущей задаче."),
    },
    admin: {
      eyebrow: t("ПРОСМОТР РАБОТ"),
      title: t("Наряды"),
      guidance: t("Просматривайте текущий список нарядов."),
    },
  }[role];
  const activeTab = filters.status.join(",") === activeStatuses.join(",");
  const archiveTab = filters.status.join(",") === archiveStatuses.join(",");
  const additionalFilterCount = [
    Boolean(filters.priority),
    Boolean(filters.area_id),
    Boolean(filters.equipment_id),
    Boolean(filters.executor_id),
    Boolean(filters.master_id && filters.master_id !== currentUserId && filters.master_id !== "all"),
    filters.overdue,
  ].filter(Boolean).length;
  const hasAdditionalFilters = additionalFilterCount > 0;
  const resetFilters = () => {
    setSearchInput("");
    onFilters({
      ...filters,
      priority: "",
      area_id: "",
      equipment_id: "",
      executor_id: "",
      master_id: role === "master" ? currentUserId : "",
      query: "",
      attention: false,
      sort: "priority",
      overdue: false,
      offset: 0,
    });
  };
  useEffect(() => {
    if (searchInput === filters.query) return;
    const timeout = window.setTimeout(() => {
      const query = searchInput.trim();
      committedQuery.current = query;
      setSearchInput(query);
      onFilters({ ...filters, query, offset: 0 });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [filters, onFilters, searchInput]);
  useEffect(() => {
    if (filters.query === committedQuery.current) return;
    committedQuery.current = filters.query;
    const timeout = window.setTimeout(() => setSearchInput(filters.query), 0);
    return () => window.clearTimeout(timeout);
  }, [filters.query]);
  const visibleOrders = page?.items ?? [];
  const urgentCount = page?.attention_count ?? 0;
  const activeCount = (page?.counts.in_progress ?? 0) + (page?.counts.paused ?? 0);
  const waitingCount = (page?.counts.issued ?? 0) + (page?.counts.accepted ?? 0) + (page?.counts.queued ?? 0);
  const onShiftWorkers = workload.filter((person) => person.is_on_shift).length;
  const freeWorkers = workload.filter((person) => person.availability === "free").length;
  const emptyState = visibleOrders.length === 0;
  const focusOrder =
    role === "executor" && activeTab
      ? (["in_progress", "paused", "rework", "issued", "accepted", "queued"] as const)
          .map((status) => visibleOrders.find((order) => order.status === status))
          .find(Boolean)
      : undefined;
  const unfilteredEmpty = !hasAdditionalFilters && !filters.query && !filters.attention;

  return (
    <section className="workspace orders-workspace" aria-busy={loading}>
      <div className="page-head">
        <div>
          <p className="eyebrow">{view.eyebrow}</p>
          <h1>{view.title}</h1>
          <p className="muted orders-guidance">{view.guidance}</p>
        </div>
        {role === "master" && (
          <div className="orders-page-actions">
            <button className="secondary with-icon" type="button" onClick={onAssistant}>
              <Icon name="sparkles" />
              {t("Помощник")}
            </button>
            <button
              className={`secondary with-icon fault-reports-button${faultReportCount ? " has-reports" : ""}`}
              type="button"
              onClick={onFaultReports}
            >
              <Icon name="alert" />
              <span className="label-full">{t("Сообщения о поломках")}</span>
              <span className="label-short" aria-hidden="true">
                {t("Поломки")}
              </span>
              <span className="sr-only"> ({faultReportCount})</span>
              <b className="count-badge" aria-hidden="true">
                {faultReportCount}
              </b>
            </button>
            <button className="primary with-icon" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              {t("Выдать наряд")}
            </button>
          </div>
        )}
        {role === "executor" && (
          <div className="orders-page-actions">
            <button className="secondary with-icon" type="button" onClick={onFaultReports}>
              <Icon name="alert" />
              {t("Сообщить о поломке")}
            </button>
          </div>
        )}
      </div>

      {focusOrder && <ExecutorFocus order={focusOrder} catalog={catalog} onOpen={onOpen} />}

      {page && (role !== "executor" || (urgentCount > 0 && !focusOrder)) && (
        <section className={`operations-strip role-${role}`} aria-label={t("Сводка очереди")}>
          <button
            type="button"
            className={filters.attention ? "operations-signal is-active" : "operations-signal"}
            onClick={() => onFilters({ ...filters, attention: !filters.attention, offset: 0 })}
            aria-pressed={filters.attention}
          >
            <span className="operations-kicker">
              <Icon name="alert" />
              {t("Требуют внимания")}
            </span>
            <strong>{urgentCount}</strong>
            <small>{filters.attention ? t("Показаны срочные") : t("Сроки и высокий приоритет")}</small>
          </button>
          <div className="operations-stat">
            <span>
              <Icon name="wrench" />
              {t("Выполняются")}
            </span>
            <strong>{activeCount}</strong>
          </div>
          {role !== "executor" && (
            <>
              <div className="operations-stat is-extra">
                <span>
                  <Icon name="inbox" />
                  {t("Ждут начала")}
                </span>
                <strong>{waitingCount}</strong>
              </div>
              {onWorkers && workload.length > 0 && (
                <button
                  type="button"
                  className="operations-stat operations-link is-extra"
                  onClick={onWorkers}
                  title={t("Открыть список исполнителей")}
                >
                  <span>
                    <Icon name="workload" />
                    {t("Свободны")}
                  </span>
                  <strong>
                    {freeWorkers}
                    <small> / {onShiftWorkers}</small>
                  </strong>
                </button>
              )}
            </>
          )}
        </section>
      )}

      {page && (
        <div className="status-tabs" aria-label={t("Список нарядов")}>
          <button
            className={activeTab ? "active" : ""}
            aria-pressed={activeTab}
            onClick={() =>
              onFilters({ ...filters, query: searchInput.trim(), status: activeStatuses, offset: 0 })
            }
          >
            <Icon name="activity" />
            {t("В работе")}
          </button>
          <button
            className={archiveTab ? "active" : ""}
            aria-pressed={archiveTab}
            onClick={() =>
              onFilters({ ...filters, query: searchInput.trim(), status: archiveStatuses, offset: 0 })
            }
          >
            <Icon name="history" />
            {t("История")}
          </button>
        </div>
      )}

      <div className="orders-filter-actions">
        <label className="order-search">
          <Icon name="search" className="order-search-icon" />
          <span className="sr-only">{t("Поиск наряда")}</span>
          <input
            type="search"
            value={searchInput}
            maxLength={120}
            onBlur={() => setSearchInput((value) => value.trim())}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t("Номер, задача или оборудование")}
            aria-label={t("Поиск наряда")}
          />
        </label>
        <label className="order-sort-control" title={t("Сортировка")}>
          <Icon name="sort" />
          <span className="sr-only">{t("Сортировка")}</span>
          <select
            aria-label={t("Сортировка")}
            value={filters.sort}
            onChange={(e) =>
              onFilters({ ...filters, sort: e.target.value as OrderFilters["sort"], offset: 0 })
            }
          >
            <option value="priority">{t("По приоритету")}</option>
            <option value="deadline">{t("Ближайший срок")}</option>
            <option value="newest">{t("Сначала новые")}</option>
            <option value="oldest">{t("Сначала старые")}</option>
          </select>
        </label>
        <button
          className="filter-toggle"
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="order-filters"
          aria-label={additionalFilterCount ? t("Фильтры: выбрано ") + additionalFilterCount : t("Фильтры")}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <Icon name="filter" />
          <span className="filter-toggle-label">{t("Фильтры")}</span>
          {additionalFilterCount ? <b className="filter-count">{additionalFilterCount}</b> : null}
        </button>
        {hasAdditionalFilters && (
          <button className="text-button reset-order-filters" type="button" onClick={resetFilters}>
            <Icon name="close" />
            {t("Сбросить фильтры")}
          </button>
        )}
      </div>

      <div id="order-filters" className={"filters " + (filtersOpen ? "is-open" : "")}>
        <label>
          {t("Приоритет")}
          <select
            aria-label={t("Приоритет")}
            value={filters.priority}
            onChange={(e) => onFilters({ ...filters, priority: e.target.value, offset: 0 })}
          >
            <option value="">{t("Все приоритеты")}</option>
            {Object.entries(ruPriority).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {catalog && (
          <label>
            {t("Участок")}
            <select
              aria-label={t("Участок")}
              value={filters.area_id}
              onChange={(e) =>
                onFilters({ ...filters, area_id: e.target.value, equipment_id: "", offset: 0 })
              }
            >
              <option value="">{t("Все участки")}</option>
              {catalog.areas
                .filter((item) => item.is_active !== false)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {catalog && (
          <label>
            {t("Оборудование")}
            <select
              aria-label={t("Оборудование")}
              value={filters.equipment_id}
              onChange={(e) => onFilters({ ...filters, equipment_id: e.target.value, offset: 0 })}
            >
              <option value="">{t("Всё оборудование")}</option>
              {catalog.equipment
                .filter(
                  (item) =>
                    item.is_active !== false && (!filters.area_id || item.area_id === filters.area_id),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.inventory_number} · {item.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {(role === "master" || role === "manager" || role === "executor") && (
          <label>
            {t("Мастер")}
            <select
              aria-label={t("Мастер")}
              value={filters.master_id === "all" ? "" : filters.master_id}
              onChange={(e) =>
                onFilters({
                  ...filters,
                  master_id: e.target.value || (role === "master" || role === "manager" ? "all" : ""),
                  offset: 0,
                })
              }
            >
              <option value="">{t("Все мастера")}</option>
              {role === "master" && <option value={currentUserId}>{t("Мои наряды")}</option>}
              {masters
                .filter((item) => item.id !== currentUserId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.display_name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {role !== "executor" && (
          <label>
            {t("Исполнитель")}
            <select
              aria-label={t("Исполнитель")}
              value={filters.executor_id}
              onChange={(e) => onFilters({ ...filters, executor_id: e.target.value, offset: 0 })}
            >
              <option value="">{t("Все исполнители")}</option>
              {workload.map((item) => (
                <option key={item.employee_id} value={item.employee_id}>
                  {item.display_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={filters.overdue}
            onChange={(e) => onFilters({ ...filters, overdue: e.target.checked, offset: 0 })}
          />
          {t("Только просроченные")}
        </label>
      </div>

      {page && (
        <p className="orders-summary" aria-live="polite">
          {filters.query || filters.attention ? t("Найдено") : t("В списке")}:{" "}
          <strong>{visibleOrders.length}</strong>
          {visibleOrders.length !== page.total && t(" из {0}", [page.total])}
        </p>
      )}
      {loading && page && (
        <p className="muted" role="status">
          {t("Обновляем наряды…")}
        </p>
      )}
      {!page ? (
        loading ? (
          <Skeleton
            variant={role === "executor" ? "list" : "board"}
            count={4}
            label={t("Загружаем наряды…")}
          />
        ) : null
      ) : emptyState ? (
        <div className="empty orders-empty">
          <h2>
            {unfilteredEmpty
              ? archiveTab
                ? t("История пока пуста")
                : t("Нет текущих нарядов")
              : t("По выбранным условиям нарядов нет")}
          </h2>
          <p>
            {unfilteredEmpty
              ? archiveTab
                ? t("Здесь появятся закрытые и отменённые наряды.")
                : role === "master"
                  ? t("Создайте первый наряд, когда появится работа на участке.")
                  : t("Новые наряды появятся здесь после выдачи мастером.")
              : hasAdditionalFilters
                ? t("Сбросьте дополнительные фильтры или выберите другой список нарядов.")
                : t("Переключитесь между текущими нарядами и историей.")}
          </p>
          {hasAdditionalFilters && (
            <button className="secondary" type="button" onClick={resetFilters}>
              {t("Сбросить фильтры")}
            </button>
          )}
        </div>
      ) : archiveTab ? (
        <HistoryGrid orders={visibleOrders} catalog={catalog} onOpen={onOpen} />
      ) : role !== "executor" ? (
        <Kanban orders={visibleOrders} catalog={catalog} onOpen={onOpen} onHistory={onHistory} />
      ) : (
        <div className="order-list worker-queue">
          {visibleOrders.map((order) => (
            <OrderRow key={order.id} order={order} catalog={catalog} onOpen={onOpen} />
          ))}
        </div>
      )}

      {page && page.total > page.limit && <Pagination page={page} filters={filters} onFilters={onFilters} />}
      {creating && catalog && (
        <CreateOrderDialog
          catalog={catalog}
          workers={workload}
          onClose={() => setCreating(false)}
          onCreate={async (input, photos) => {
            await onCreate(input, photos);
            setCreating(false);
          }}
          onSuggest={onSuggest}
          onSimilar={onSimilar}
          onViewEvidence={onViewEvidence}
          onBrigadeOptions={onBrigadeOptions}
        />
      )}
    </section>
  );
}

/** Native select options cannot wrap: keep a busy person's task readable in one line. */
function shortTitle(value: string) {
  return value.length > 42 ? `${value.slice(0, 41).trimEnd()}…` : value;
}

/** The one order an executor should act on now. Opens the same detail as the list row. */
function ExecutorFocus({
  order,
  catalog,
  onOpen,
}: {
  order: Order;
  catalog: Catalog | null;
  onOpen: (id: string) => void;
}) {
  const machine = catalog?.equipment.find((item) => item.id === order.equipment_id);
  const description = orderTitle(order);
  const working = order.status === "in_progress" || order.status === "paused";
  return (
    <section
      className={`executor-focus priority-${order.priority}${working ? " is-working" : ""}`}
      aria-label={t("Текущая задача")}
    >
      <div className="executor-focus-top">
        <span className="executor-focus-kicker">{working ? t("Текущий наряд") : t("Следующий наряд")}</span>
        <span className={`status status-${order.status}`}>{ruStatus[order.status]}</span>
      </div>
      <p className="executor-focus-title">
        <b>{order.number}</b> {description}
      </p>
      <p className="executor-focus-meta">
        {machine && (
          <span>
            <Icon name="wrench" />
            {machine.inventory_number} · {machine.name}
          </span>
        )}
        <span className={order.overdue ? "danger-text" : undefined}>
          <Icon name="clock" />
          {t("Срок:")} {local(order.deadline)}
        </span>
      </p>
      <button
        type="button"
        className="primary with-icon executor-focus-open"
        onClick={() => onOpen(order.id)}
      >
        {t("Перейти к наряду")}
        <Icon name="chevronRight" />
      </button>
    </section>
  );
}

function HistoryGrid({
  orders,
  catalog,
  onOpen,
}: {
  orders: Order[];
  catalog: Catalog | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="order-history-grid" aria-label={t("История нарядов")}>
      {orders.map((order) => (
        <OrderRow key={order.id} order={order} catalog={catalog} onOpen={onOpen} />
      ))}
    </div>
  );
}

function Pagination({
  page,
  filters,
  onFilters,
}: {
  page: OrderPage;
  filters: OrderFilters;
  onFilters: (next: OrderFilters) => void;
}) {
  const pages = Math.ceil(page.total / page.limit);
  const current = Math.floor(page.offset / page.limit) + 1;
  const numbers = Array.from(
    new Set(
      [1, 2, current - 1, current, current + 1, pages - 1, pages].filter(
        (number) => number >= 1 && number <= pages,
      ),
    ),
  ).sort((first, second) => first - second);
  const goTo = (number: number) => onFilters({ ...filters, offset: (number - 1) * page.limit });
  return (
    <nav className="pagination" aria-label={t("Страницы нарядов")}>
      <button
        className="secondary pagination-step"
        disabled={current === 1}
        onClick={() => goTo(current - 1)}
        aria-label={t("Назад")}
        title={t("Назад")}
      >
        <Icon name="chevronLeft" />
      </button>
      <div className="pagination-pages" aria-label={t("Номер страницы")}>
        {numbers.map((number, index) => (
          <span key={number} className="pagination-entry">
            {index > 0 && number - numbers[index - 1] > 1 && <span aria-hidden="true">…</span>}
            <button
              type="button"
              className={number === current ? "is-current" : ""}
              aria-label={t("Страница {0}", [number])}
              aria-current={number === current ? "page" : undefined}
              onClick={() => goTo(number)}
            >
              {number}
            </button>
          </span>
        ))}
      </div>
      <span className="pagination-summary">
        {page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} {t("из")} {page.total}
      </span>
      <button
        className="secondary pagination-step"
        disabled={current === pages}
        onClick={() => goTo(current + 1)}
        aria-label={t("Далее")}
        title={t("Далее")}
      >
        <Icon name="chevronRight" />
      </button>
    </nav>
  );
}

function Kanban({
  orders,
  catalog,
  onOpen,
  onHistory,
}: {
  orders: Order[];
  catalog: Catalog | null;
  onOpen: (id: string) => void;
  onHistory: (equipmentId: string) => Promise<void>;
}) {
  const columns: Array<[string, string, Order["status"][]]> = [
    [t("К выдаче"), "queue", ["issued", "accepted", "queued"]],
    [t("В работе"), "progress", ["in_progress", "paused"]],
    [t("На проверке"), "review", ["completed", "ai_review"]],
    [t("Доработка и отказы"), "rework", ["rework", "rejected"]],
    [t("Закрытые"), "closed", ["closed"]],
    [t("Отменённые"), "cancelled", ["cancelled"]],
  ] satisfies Array<[string, string, Order["status"][]]>;
  const overdue = orders.filter(belongsToOverdueBoardColumn);
  const visibleColumns = [
    ...(overdue.length
      ? [{ title: t("Просроченные"), key: "overdue", items: overdue, className: "kanban-column-overdue" }]
      : []),
    ...columns
      .map(([title, key, statuses]) => ({
        title,
        key,
        items: boardColumnOrders(orders, statuses),
        className: undefined,
      }))
      .filter(({ items }) => items.length),
  ];
  return (
    <div className="kanban" aria-label={t("Доска нарядов")}>
      {visibleColumns.map(({ title, key, items, className }) => {
        return (
          <section
            key={title}
            data-column={key}
            className={`kanban-column${className ? ` ${className}` : ""}`}
          >
            <h2>
              {title} <small>{items.length}</small>
            </h2>
            {items.length ? (
              items.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  catalog={catalog}
                  onOpen={onOpen}
                  onHistory={onHistory}
                />
              ))
            ) : (
              <p className="muted">{t("Нет нарядов")}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
function OrderRow({
  order,
  catalog,
  onOpen,
  onHistory,
}: {
  order: Order;
  catalog: Catalog | null;
  onOpen: (id: string) => void;
  onHistory?: (equipmentId: string) => Promise<void>;
}) {
  const machine = catalog?.equipment.find((item) => item.id === order.equipment_id);
  const description = orderTitle(order);
  return (
    <article className={`order-row priority-${order.priority}`}>
      <button
        className="order-hit"
        onClick={() => onOpen(order.id)}
        aria-label={`${order.description} · ${t("Открыть наряд {0}", [order.number])}`}
      >
        <span className="order-main">
          {(order.priority === "emergency" || order.priority === "high") && (
            <span className={`order-priority-tag ${order.priority}`}>
              {order.priority === "emergency" && <Icon name="zap" />}
              {ruPriority[order.priority]}
            </span>
          )}
          <OrderReference description={description} number={order.number} className="order-row-reference" />
          <small>{machine ? `${machine.inventory_number} · ${machine.name}` : t("Оборудование")}</small>
          {order.brigade && (
            <small className="order-brigade">
              {t("Бригада:")} {order.brigade.code} · {order.brigade.name}
              {order.participants?.find((person) => person.role === "responsible") && (
                <>
                  {" · "}
                  {t("Ответственный:")}{" "}
                  {order.participants.find((person) => person.role === "responsible")?.display_name}
                </>
              )}
            </small>
          )}
        </span>
        <span className={`status status-${order.status}`}>{ruStatus[order.status]}</span>
        <span className={order.overdue ? "deadline danger-text" : "deadline"}>
          <Icon name="clock" />
          {local(order.deadline)}
        </span>
      </button>
      {machine && onHistory && (
        <button
          className="history-button"
          onClick={() => void onHistory(machine.id)}
          aria-label={t("История {0}", [machine.name])}
          title={t("История {0}", [machine.name])}
        >
          <Icon name="history" />
        </button>
      )}
    </article>
  );
}
export function CreateOrderDialog({
  catalog,
  workers,
  onClose,
  onCreate,
  onSuggest,
  onSimilar,
  initialAreaId,
  initialEquipmentId,
  preventiveDraft,
  faultReportDraft,
  onViewEvidence,
  onBrigadeOptions,
}: {
  catalog: Catalog;
  workers: Workload[];
  onClose: () => void;
  onCreate: (input: CreateOrder, photos?: BeforePhotos) => Promise<void>;
  onSuggest: (input: {
    area_id: string;
    equipment_id: string;
    description: string;
    fault_code_id?: string | null;
  }) => Promise<OrderSuggestions>;
  onSimilar: (input: SimilarRepairsRequest) => Promise<import("../types").SimilarRepairs>;
  initialAreaId?: string;
  initialEquipmentId?: string;
  preventiveDraft?: PreventiveDraft;
  faultReportDraft?: Pick<
    import("../types").FaultReportView,
    "id" | "area_id" | "equipment_id" | "description"
  >;
  onViewEvidence?: (id: string) => Promise<OrderDetail>;
  onBrigadeOptions: (input: BrigadeOptionsRequest) => Promise<BrigadeAssignmentOptions>;
}) {
  const initialEquipment = catalog.equipment.find(
    (item) =>
      item.id === (preventiveDraft?.equipment_id ?? faultReportDraft?.equipment_id ?? initialEquipmentId),
  );
  const initialArea =
    preventiveDraft?.area_id ??
    faultReportDraft?.area_id ??
    initialEquipment?.area_id ??
    initialAreaId ??
    catalog.areas.find((item) => item.is_active !== false)?.id ??
    "";
  const linkedEquipment = Boolean(preventiveDraft || faultReportDraft);
  const [input, setInput] = useState({
    work_type: preventiveDraft ? "planned" : "unplanned",
    description: preventiveDraft?.description ?? faultReportDraft?.description ?? "",
    area_id: initialArea,
    equipment_id: initialEquipment?.id ?? "",
    fault_code_id: preventiveDraft?.fault_code_id ?? "",
    executor_id: "",
    brigade_id: "",
    participant_ids: [] as string[],
    priority: "normal",
    deadline: "",
    comment: "",
  });
  const [beforePhotos, setBeforePhotos] = useState<File[]>([]);
  const [beforePhotosShared, setBeforePhotosShared] = useState(false);
  const [error, setError] = useState("");
  const [suggestionError, setSuggestionError] = useState("");
  const [suggestions, setSuggestions] = useState<OrderSuggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [brigadeOptions, setBrigadeOptions] = useState<BrigadeAssignmentOptions | null>(null);
  const [brigadesLoading, setBrigadesLoading] = useState(false);
  const [brigadesError, setBrigadesError] = useState("");
  const [brigadeRefresh, setBrigadeRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [evidence, setEvidence] = useState<OrderDetail | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState("");
  const [evidenceError, setEvidenceError] = useState("");
  const evidenceRequest = useRef(0);
  const [equipmentQuery, setEquipmentQuery] = useState("");
  const requestId = useRef(0);
  const brigadeRequestId = useRef(0);
  const suggestRef = useRef(onSuggest);
  const brigadeOptionsRef = useRef(onBrigadeOptions);
  useEffect(() => {
    suggestRef.current = onSuggest;
  }, [onSuggest]);
  useEffect(() => {
    brigadeOptionsRef.current = onBrigadeOptions;
  }, [onBrigadeOptions]);
  const activeEquipment = useMemo(
    () => catalog.equipment.filter((item) => item.is_active !== false),
    [catalog.equipment],
  );
  const equipment = useMemo(
    () => activeEquipment.filter((item) => item.area_id === input.area_id),
    [activeEquipment, input.area_id],
  );
  const quickEquipment = useMemo(() => {
    const query = equipmentQuery.trim().toLocaleLowerCase();
    if (!query) return activeEquipment;
    return activeEquipment.filter((item) =>
      [item.inventory_number, item.name, item.equipment_type].join(" ").toLocaleLowerCase().includes(query),
    );
  }, [activeEquipment, equipmentQuery]);
  const suggestionKey = [
    input.area_id,
    input.equipment_id,
    input.description.trim(),
    input.fault_code_id,
  ].join("|");
  const canSuggest = Boolean(input.area_id && input.equipment_id && input.description.trim().length >= 3);
  const [receivedKey, setReceivedKey] = useState("");
  const selectedEquipment = activeEquipment.find((item) => item.id === input.equipment_id);
  const selectedNorm = catalog.time_norms.find(
    (item) =>
      item.fault_code_id === input.fault_code_id && item.equipment_type === selectedEquipment?.equipment_type,
  )?.minutes;
  const [selectedSuggestedExecutor, setSelectedSuggestedExecutor] = useState<OrderSuggestionExecutor | null>(
    null,
  );
  const manualExecutorExists = workers.some((item) => item.employee_id === input.executor_id);
  const updateInput = (next: typeof input, invalidatesSuggestions = false) => {
    if (invalidatesSuggestions) {
      requestId.current += 1;
      brigadeRequestId.current += 1;
      setSuggesting(false);
      setBrigadesLoading(false);
      setSuggestionError("");
      setBrigadesError("");
      setReceivedKey("");
      setBrigadeOptions(null);
      setBrigadeRefresh((value) => value + 1);
    }
    setInput(
      invalidatesSuggestions
        ? {
            ...next,
            brigade_id: "",
            participant_ids: [],
            executor_id: input.brigade_id ? "" : next.executor_id,
          }
        : next,
    );
  };
  useEffect(
    () => () => {
      requestId.current += 1;
      brigadeRequestId.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!canSuggest) {
      brigadeRequestId.current += 1;
      return;
    }
    const request = ++brigadeRequestId.current;
    const timer = window.setTimeout(() => {
      setBrigadesLoading(true);
      setBrigadesError("");
      const context: BrigadeOptionsRequest = {
        area_id: input.area_id,
        equipment_id: input.equipment_id,
        description: input.description.trim(),
        ...(input.fault_code_id ? { fault_code_id: input.fault_code_id } : {}),
      };
      void brigadeOptionsRef
        .current(context)
        .then((result) => {
          if (request !== brigadeRequestId.current) return;
          setBrigadeOptions(result);
        })
        .catch(() => {
          if (request !== brigadeRequestId.current) return;
          setBrigadeOptions(null);
          setBrigadesError(t("Не удалось подобрать бригаду. Выберите исполнителя или повторите попытку."));
        })
        .finally(() => {
          if (request === brigadeRequestId.current) setBrigadesLoading(false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [brigadeRefresh, canSuggest, input.area_id, input.description, input.equipment_id, input.fault_code_id]);

  useEffect(() => {
    const description = input.description.trim();
    if (!input.area_id || !input.equipment_id || !description) {
      requestId.current += 1;
      return;
    }
    const id = ++requestId.current;
    const key = suggestionKey;
    const timer = window.setTimeout(() => {
      setSuggesting(true);
      setSuggestionError("");
      void suggestRef
        .current({
          area_id: input.area_id,
          equipment_id: input.equipment_id,
          description,
          fault_code_id: input.fault_code_id || null,
        })
        .then((result) => {
          if (id !== requestId.current || key !== suggestionKey) return;
          setSuggestions(result);
          setReceivedKey(key);
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setSuggestions(null);
          setSuggestionError(t("Подбор недоступен. Заполните поля вручную или повторите попытку."));
        })
        .finally(() => {
          if (id === requestId.current) setSuggesting(false);
        });
    }, 450);
    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
  }, [input.area_id, input.description, input.equipment_id, input.fault_code_id, suggestionKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError("");
    if (!input.equipment_id || !input.executor_id || !input.description.trim()) {
      setError(t("Заполните оборудование, описание и исполнителя."));
      return;
    }
    if (!input.deadline) {
      setError(t("Укажите срок выполнения."));
      return;
    }
    try {
      setSubmitting(true);
      const { brigade_id, participant_ids, ...orderInput } = input;
      await onCreate(
        {
          ...orderInput,
          work_type: preventiveDraft ? "planned" : (input.work_type as CreateOrder["work_type"]),
          priority: input.priority as CreateOrder["priority"],
          deadline: input.deadline + ":00+05:00",
          fault_code_id: input.fault_code_id || undefined,
          comment: input.comment || undefined,
          prevention_source: preventiveDraft?.source,
          fault_report_id: faultReportDraft?.id,
          ...(brigade_id ? { brigade_id, participant_ids } : {}),
        },
        beforePhotos.length ? { files: beforePhotos, aiShareAllowed: beforePhotosShared } : undefined,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.detail === "brigade_membership_changed") {
        brigadeRequestId.current += 1;
        setInput((current) => ({ ...current, brigade_id: "", participant_ids: [], executor_id: "" }));
        setBrigadeOptions(null);
        setBrigadesError(t("Состав бригады изменился. Выберите бригаду и ответственного заново."));
        setBrigadeRefresh((value) => value + 1);
        return;
      }
      setError(
        preventiveDraft && caught instanceof ApiError && caught.detail === "prevention_source_stale"
          ? t("Основание изменилось. Закройте форму, обновите отчёт и подготовьте наряд заново.")
          : t("Наряд не создан. Проверьте обязательные поля и доступ участка."),
      );
    } finally {
      setSubmitting(false);
    }
  }
  function chooseEquipment(equipmentId: string) {
    const item = activeEquipment.find((candidate) => candidate.id === equipmentId);
    if (!item) return;
    setSelectedSuggestedExecutor(null);
    updateInput(
      { ...input, area_id: item.area_id, equipment_id: item.id, executor_id: "", fault_code_id: "" },
      true,
    );
  }
  function chooseExecutor(person: OrderSuggestionExecutor) {
    setSelectedSuggestedExecutor(person);
    updateInput({ ...input, executor_id: person.employee_id, brigade_id: "", participant_ids: [] });
  }
  async function viewEvidence(orderId: string) {
    if (!onViewEvidence) return;
    if (evidence?.id === orderId) {
      evidenceRequest.current += 1;
      setEvidence(null);
      return;
    }
    const request = ++evidenceRequest.current;
    setEvidenceError("");
    setEvidence(null);
    setEvidenceLoading(orderId);
    try {
      const result = await onViewEvidence(orderId);
      if (request === evidenceRequest.current) setEvidence(result);
    } catch {
      if (request === evidenceRequest.current) setEvidenceError(t("Не удалось открыть связанный наряд."));
    } finally {
      if (request === evidenceRequest.current) setEvidenceLoading("");
    }
  }
  const selectedExecutor =
    suggestions?.executors.find((person) => person.employee_id === input.executor_id) ??
    selectedSuggestedExecutor ??
    workers.find((person) => person.employee_id === input.executor_id);
  const selectedBrigade = brigadeOptions?.items.find((item) => item.brigade.id === input.brigade_id) ?? null;
  const recommendedBrigade = brigadeOptions?.items.find((item) => item.recommended) ?? null;
  const featuredBrigade = selectedBrigade ?? recommendedBrigade ?? brigadeOptions?.items[0] ?? null;
  const selectedBrigadeResponsible = selectedBrigade?.participants.find(
    (person) => person.employee_id === input.executor_id,
  );
  const activeSuggestions = canSuggest && receivedKey === suggestionKey ? suggestions : null;
  const activeSuggestionError = canSuggest ? suggestionError : "";
  const similarInput = useMemo<SimilarRepairsRequest | null>(
    () =>
      canSuggest
        ? {
            area_id: input.area_id,
            equipment_id: input.equipment_id,
            description: input.description.trim(),
            fault_code_id: input.fault_code_id || null,
          }
        : null,
    [canSuggest, input.area_id, input.description, input.equipment_id, input.fault_code_id],
  );
  return (
    <Dialog title={preventiveDraft ? t("Профилактический наряд") : t("Выдать наряд")} onClose={onClose}>
      <form className="dialog-form guided-order-form" onSubmit={(event) => void submit(event)}>
        {preventiveDraft && (
          <section className="prevention-origin" data-testid="prevention-origin" aria-label={t("Основание")}>
            <div>
              <strong>{t("Основание:")}</strong> {preventiveDraft.title}
            </div>
            <details>
              <summary>{t("Связанные наряды ({0})", [preventiveDraft.evidence_orders.length])}</summary>
              <ul>
                {preventiveDraft.evidence_orders.map((order) => (
                  <li key={order.id}>
                    <button
                      className="text-button prevention-order-link"
                      type="button"
                      onClick={() => void viewEvidence(order.id)}
                      aria-label={`${order.description ?? ""} · ${t("Открыть наряд {0}", [order.number])}`}
                      aria-expanded={evidence?.id === order.id}
                      disabled={evidenceLoading === order.id}
                    >
                      {evidenceLoading === order.id ? (
                        t("Загрузка…")
                      ) : (
                        <OrderReference description={order.description} number={order.number} />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {evidenceError && <p className="error">{evidenceError}</p>}
              {evidence && (
                <section
                  className="prevention-evidence-preview"
                  data-testid="prevention-evidence-preview"
                  aria-live="polite"
                >
                  <OrderReference description={evidence.description} number={evidence.number} />
                  <span>{ruStatus[evidence.status] ?? evidence.status}</span>
                  <p>{evidence.description}</p>
                  <small>
                    {t("Срок:")} {local(evidence.deadline)}
                  </small>
                </section>
              )}
            </details>
          </section>
        )}
        {!preventiveDraft && (
          <div className="form-progress" aria-label={t("Шаги выдачи наряда")}>
            <span>
              <b>1</b> {t("Оборудование")}
            </span>
            <span>
              <b>2</b> {t("Описание")}
            </span>
            <span>
              <b>3</b> {t("Исполнитель и срок")}
            </span>
          </div>
        )}
        <p className="form-hint">
          {preventiveDraft
            ? t("Проверьте описание, назначьте исполнителя и срок.")
            : t("Выберите оборудование, опишите работу и назначьте исполнителя со сроком.")}
        </p>
        {preventiveDraft ? (
          <section className="prevention-equipment-step" aria-label={t("Оборудование")}>
            <strong>{t("Оборудование")}</strong>
            <span>
              {selectedEquipment
                ? `${selectedEquipment.inventory_number} · ${selectedEquipment.name}`
                : t("Оборудование не найдено.")}
            </span>
          </section>
        ) : (
          <section className="quick-order-step" aria-labelledby="quick-equipment-heading">
            <div className="quick-order-step-head">
              <div>
                <h3 id="quick-equipment-heading">1. {t("Выберите оборудование")}</h3>
                <p>{t("Участок определится по оборудованию.")}</p>
              </div>
              {selectedEquipment && (
                <span className="quick-selection" aria-live="polite">
                  {selectedEquipment.inventory_number}
                </span>
              )}
            </div>
            <>
              <label className="quick-search">
                <span className="sr-only">{t("Найти оборудование")}</span>
                <input
                  type="search"
                  value={equipmentQuery}
                  onChange={(event) => setEquipmentQuery(event.target.value)}
                  placeholder={t("Найти оборудование")}
                />
              </label>
              <div className="quick-equipment-grid" aria-label={t("Оборудование")}>
                {quickEquipment.map((item) => (
                  <button
                    className="quick-choice quick-equipment-choice"
                    key={item.id}
                    type="button"
                    data-testid={`quick-equipment-${item.id}`}
                    aria-pressed={input.equipment_id === item.id}
                    onClick={() => chooseEquipment(item.id)}
                  >
                    <strong>{item.inventory_number}</strong>
                    <span>{item.name}</span>
                    <small>
                      {catalog.areas.find((area) => area.id === item.area_id)?.name ?? t("Участок не указан")}
                    </small>
                  </button>
                ))}
              </div>
              {quickEquipment.length === 0 && <p className="muted">{t("Оборудование не найдено.")}</p>}
            </>
          </section>
        )}
        <label>
          {t("Описание")}
          <textarea
            aria-label={t("Описание")}
            required
            minLength={1}
            value={input.description}
            onChange={(event) => updateInput({ ...input, description: event.target.value }, true)}
          />
        </label>
        <BeforePhotoPicker
          files={beforePhotos}
          aiShareAllowed={beforePhotosShared}
          disabled={submitting}
          onFiles={setBeforePhotos}
          onAiShareAllowed={setBeforePhotosShared}
        />
        <SimilarRepairsPanel
          input={similarInput}
          requestKey={suggestionKey}
          onLoad={onSimilar}
          onViewEvidence={onViewEvidence}
        />
        <section className="order-suggestions" aria-label={t("Подбор вариантов")}>
          <div className="order-suggestions-head">
            <div>
              <h3>2. {t("Исполнитель или бригада")}</h3>
              <p>{t("Подбор запускается после описания и не назначает исполнителя сам.")}</p>
            </div>
            {canSuggest && (suggesting || brigadesLoading) && (
              <span className="suggestion-loading">{t("Подбираем…")}</span>
            )}
          </div>
          {(!input.equipment_id || !input.description.trim()) && (
            <p className="muted">{t("Сначала выберите оборудование и опишите работу.")}</p>
          )}
          {activeSuggestionError && (
            <p className="error" role="alert">
              {message(activeSuggestionError)}
            </p>
          )}
          {brigadesError && (
            <div className="suggestion-note" role="status">
              <p className="muted">{brigadesError}</p>
              <button
                type="button"
                className="secondary"
                data-testid="brigade-retry"
                disabled={brigadesLoading}
                onClick={() => setBrigadeRefresh((value) => value + 1)}
              >
                {t("Повторить")}
              </button>
            </div>
          )}
          {canSuggest && !brigadesLoading && !brigadesError && brigadeOptions?.items.length === 0 && (
            <p className="muted suggestion-note" data-testid="brigade-empty">
              {t(
                "Нет доступных бригад: нужны не менее двух сотрудников одной бригады на смене с доступом к этому участку.",
              )}
            </p>
          )}
          {(activeSuggestions || brigadeOptions) && (
            <div className="suggestion-results">
              {featuredBrigade &&
                (() => {
                  const result = brigadeOptions;
                  if (!result) return null;
                  const option = featuredBrigade;
                  const responsible = option.participants.find(
                    (person) =>
                      person.employee_id ===
                      (input.brigade_id === option.brigade.id
                        ? input.executor_id
                        : option.suggested_responsible_id),
                  );
                  const responsibleChosenManually =
                    input.brigade_id === option.brigade.id &&
                    input.executor_id !== option.suggested_responsible_id;
                  return (
                    <section className="brigade-suggestion" aria-label={t("Бригада")}>
                      <h4>{option.recommended ? t("Рекомендуемая бригада") : t("Доступная бригада")}</h4>
                      <button
                        className="suggestion-card quick-choice quick-executor-choice quick-brigade-choice"
                        type="button"
                        data-testid={`quick-brigade-${option.brigade.id}`}
                        aria-pressed={input.brigade_id === option.brigade.id}
                        onClick={() => {
                          setSelectedSuggestedExecutor(null);
                          setInput((current) => ({
                            ...current,
                            executor_id: option.suggested_responsible_id,
                            brigade_id: option.brigade.id,
                            participant_ids: option.participant_ids,
                          }));
                        }}
                      >
                        <div>
                          <strong>
                            {option.brigade.code} · {option.brigade.name}
                          </strong>
                          <small>
                            {brigadeSpecialtySummary(option, result.context)} · {crewAvailability(option)} ·{" "}
                            {brigadeQualitySummary(option)}
                          </small>
                          <small
                            className="brigade-members"
                            data-testid={`brigade-responsible-summary-${option.brigade.id}`}
                          >
                            {t("Ответственный:")} {responsibleSummary(responsible)}
                          </small>
                        </div>
                        <span className="quick-choice-action">
                          {input.brigade_id === option.brigade.id ? t("Выбрано") : t("Выбрать")}
                        </span>
                      </button>
                      <details className="brigade-rationale" data-testid={`brigade-why-${option.brigade.id}`}>
                        <summary>{t("Почему этот состав")}</summary>
                        <div data-testid={`brigade-reasons-${option.brigade.id}`}>
                          <p>{option.reasons.map(message).join(" · ") || t("Причины не указаны.")}</p>
                          <p>
                            {responsibleChosenManually
                              ? t("Ответственный выбран мастером.")
                              : `${t("Ответственный:")} ${option.responsible_reasons.map(message).join(" · ") || "—"}`}
                          </p>
                          {result.notes.map((note, index) => (
                            <p className="muted" key={index}>
                              {message(note)}
                            </p>
                          ))}
                        </div>
                      </details>
                    </section>
                  );
                })()}
              {brigadeOptions &&
                brigadeOptions.items.length > 0 &&
                (brigadeOptions.context.specialty_source !== "confirmed" ||
                  !brigadeOptions.items.some((item) => item.recommended)) && (
                  <p className="muted suggestion-note" data-testid="brigade-context-note">
                    {brigadeOptions.notes.map(message).join(" · ") ||
                      (brigadeOptions.context.specialty_source === "inferred"
                        ? t("Специальность определена по описанию: {0}", [
                            brigadeOptions.context.specialty ?? "—",
                          ])
                        : brigadeOptions.context.specialty_source === "unknown"
                          ? t("Специальность не определена")
                          : brigadeOptions.context.specialty
                            ? t("Нет подтверждённого специалиста по {0}", [brigadeOptions.context.specialty])
                            : t("Подтверждённой рекомендации по бригаде нет."))}
                  </p>
                )}
              {activeSuggestions && activeSuggestions.executors.length > 0 && (
                <section>
                  <h4>{t("Исполнители")}</h4>
                  {activeSuggestions.executors.map((person) => {
                    const workloadPerson = workers.find(
                      (worker) => worker.employee_id === person.employee_id,
                    );
                    const currentOrderNumber =
                      person.availability === "busy" && workloadPerson
                        ? currentBusyOrderNumber(workloadPerson)
                        : null;
                    return (
                      <button
                        className="suggestion-card quick-choice quick-executor-choice"
                        key={person.employee_id}
                        type="button"
                        data-testid={`quick-executor-${person.employee_id}`}
                        aria-pressed={!input.brigade_id && input.executor_id === person.employee_id}
                        disabled={!person.is_on_shift}
                        onClick={() => chooseExecutor(person)}
                      >
                        <div>
                          <strong>
                            {person.display_name} · {person.specialty} · {person.grade} {t("разряд")}
                          </strong>
                          {person.reasons.length > 0 && (
                            <small>{person.reasons.map(suggestionText).join(" · ")}</small>
                          )}
                          <small>
                            {person.availability === "free"
                              ? t("Свободен")
                              : person.availability === "queued"
                                ? t("В очереди")
                                : t("Занят")}
                            {person.queue_length > 0 && (
                              <>
                                {" "}
                                {t("· очередь:")} {person.queue_length}
                              </>
                            )}
                            {person.paused_count > 0 && (
                              <>
                                {" "}
                                {t("· пауз:")} {person.paused_count}
                              </>
                            )}
                            {currentOrderNumber && (
                              <span className="suggestion-current-order">
                                {t("Текущий наряд:")}{" "}
                                <OrderReference
                                  description={workloadPerson?.current_order_description}
                                  number={currentOrderNumber}
                                />
                              </span>
                            )}
                          </small>
                        </div>
                        <span className="quick-choice-action">
                          {!input.brigade_id && input.executor_id === person.employee_id
                            ? t("Выбрано")
                            : t("Выбрать")}
                        </span>
                      </button>
                    );
                  })}
                </section>
              )}
              {activeSuggestions?.notes.map((note, index) => (
                <p className="muted suggestion-note" key={index}>
                  {suggestionText(note)}
                </p>
              ))}
            </div>
          )}
        </section>
        <section className="quick-order-step deadline-step" aria-labelledby="quick-deadline-heading">
          <div className="quick-order-defaults" aria-label={t("Параметры наряда")}>
            <label>
              {t("Тип")}
              <select
                value={input.work_type}
                disabled={Boolean(preventiveDraft)}
                onChange={(event) => updateInput({ ...input, work_type: event.target.value })}
              >
                <option value="unplanned">{t("Внеплановый")}</option>
                <option value="planned">{t("Плановый")}</option>
              </select>
            </label>
            <label>
              {t("Приоритет")}
              <select
                value={input.priority}
                onChange={(event) => updateInput({ ...input, priority: event.target.value })}
              >
                {Object.entries(ruPriority).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="quick-order-step-head">
            <div>
              <h3 id="quick-deadline-heading">3. {t("Срок")}</h3>
              <p>{t("Выберите реальный срок: он не рассчитывается автоматически.")}</p>
            </div>
          </div>
          <div className="deadline-presets" aria-label={t("Быстрый выбор срока")}>
            <button
              type="button"
              className="secondary"
              data-testid="quick-deadline-1h"
              onClick={() =>
                updateInput({ ...input, deadline: almatyInputDate(new Date(Date.now() + 60 * 60_000)) })
              }
            >
              {t("Через 1 час")}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="quick-deadline-2h"
              onClick={() =>
                updateInput({ ...input, deadline: almatyInputDate(new Date(Date.now() + 2 * 60 * 60_000)) })
              }
            >
              {t("Через 2 часа")}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="quick-deadline-shift"
              onClick={() => updateInput({ ...input, deadline: endOfCurrentShift() })}
            >
              {t("До конца смены")}
            </button>
          </div>
        </section>
        <p className="quick-order-summary" data-testid="quick-order-summary" aria-live="polite">
          <strong>{t("К выдаче:")}</strong>{" "}
          {selectedEquipment
            ? `${selectedEquipment.inventory_number} · ${selectedEquipment.name}`
            : t("оборудование не выбрано")}
          {selectedBrigade
            ? ` · ${selectedBrigade.brigade.code} · ${selectedBrigade.brigade.name} · ${t("Ответственный:")} ${selectedBrigadeResponsible?.display_name ?? "—"} · ${t("Участники:")} ${selectedBrigade.participants.map((person) => person.display_name).join(", ")}`
            : selectedExecutor
              ? ` · ${selectedExecutor.display_name}`
              : ` · ${t("исполнитель не выбран")}`}
          {input.deadline ? ` · ${input.deadline.replace("T", " ")}` : ` · ${t("срок не выбран")}`}
        </p>
        <details className="order-advanced-options">
          <summary>{t("Дополнительные параметры")}</summary>
          <div className="order-advanced-content">
            <label>
              {t("Участок")}
              <select
                value={input.area_id}
                disabled={linkedEquipment}
                onChange={(event) => {
                  setSelectedSuggestedExecutor(null);
                  updateInput(
                    {
                      ...input,
                      area_id: event.target.value,
                      equipment_id: "",
                      executor_id: "",
                      fault_code_id: "",
                    },
                    true,
                  );
                }}
              >
                {catalog.areas
                  .filter((item) => item.is_active !== false)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("Оборудование")}
              <select
                value={input.equipment_id}
                disabled={linkedEquipment}
                onChange={(event) => chooseEquipment(event.target.value)}
              >
                <option value="">{t("Выберите оборудование")}</option>
                {equipment.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.inventory_number} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Шифр неисправности")}
              <select
                value={input.fault_code_id}
                onChange={(event) => {
                  setSelectedSuggestedExecutor(null);
                  updateInput({ ...input, fault_code_id: event.target.value, executor_id: "" }, true);
                }}
              >
                <option value="">{t("Не выбран")}</option>
                {catalog.fault_codes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            {!input.fault_code_id && activeSuggestions && activeSuggestions.faults.length > 0 && (
              <section className="advanced-fault-suggestions" aria-label={t("Шифры неисправности")}>
                <h4>{t("Подходящие шифры")}</h4>
                {activeSuggestions.faults.map((fault) => (
                  <button
                    type="button"
                    className="text-button"
                    key={fault.fault_code_id}
                    onClick={() => {
                      setSelectedSuggestedExecutor(null);
                      updateInput({ ...input, fault_code_id: fault.fault_code_id, executor_id: "" }, true);
                    }}
                  >
                    {fault.code} · {fault.name}
                    {fault.norm_minutes !== null ? ` · ${fault.norm_minutes} ${t("мин")}` : ""}
                    {fault.reasons.length > 0 && (
                      <small>{fault.reasons.map(suggestionText).join(" · ")}</small>
                    )}
                  </button>
                ))}
              </section>
            )}
            {selectedNorm !== undefined ? (
              <p className="suggestion-norm">
                {t("Ориентир трудоёмкости:")} {selectedNorm} {t("мин. Это не срок выполнения.")}
              </p>
            ) : input.fault_code_id ? (
              <p className="muted suggestion-note">
                {t("Для выбранного шифра и типа оборудования нормы пока нет.")}
              </p>
            ) : null}
            <label>
              {t("Бригада")}
              <select
                aria-label={t("Бригада")}
                value={input.brigade_id}
                onChange={(event) => {
                  const option = brigadeOptions?.items.find((item) => item.brigade.id === event.target.value);
                  if (option) {
                    setSelectedSuggestedExecutor(null);
                    setInput((current) => ({
                      ...current,
                      executor_id: option.suggested_responsible_id,
                      brigade_id: option.brigade.id,
                      participant_ids: option.participant_ids,
                    }));
                    return;
                  }
                  setSelectedSuggestedExecutor(null);
                  updateInput({ ...input, brigade_id: "", participant_ids: [] });
                }}
              >
                <option value="">{t("Индивидуальное назначение")}</option>
                {brigadeOptions?.items.map((option) => (
                  <option key={option.brigade.id} value={option.brigade.id}>
                    {option.brigade.code} · {option.brigade.name} ·{" "}
                    {t("Участников: {0}", [option.participants.length])}
                  </option>
                ))}
              </select>
            </label>
            {selectedBrigade && (
              <p className="brigade-selection" aria-live="polite">
                <strong>
                  {selectedBrigade.brigade.code} · {selectedBrigade.brigade.name}
                </strong>
                <span>
                  {brigadeSpecialtySummary(
                    selectedBrigade,
                    brigadeOptions?.context ?? {
                      specialty: null,
                      specialty_source: "unknown",
                      quality_history_days: 180,
                      quality_minimum: 3,
                    },
                  )}{" "}
                  · {crewAvailability(selectedBrigade)} · {brigadeQualitySummary(selectedBrigade)}
                </span>
                <span>
                  {t("Ответственный:")} {responsibleSummary(selectedBrigadeResponsible)}
                </span>
                {selectedBrigade.specialty_match === false && (
                  <span className="brigade-selection-warning">
                    {t("В бригаде нет подходящего специалиста")}
                  </span>
                )}
              </p>
            )}
            <label>
              {selectedBrigade ? t("Ответственный") : t("Исполнитель")}
              <select
                aria-label={selectedBrigade ? t("Ответственный") : t("Исполнитель")}
                value={input.executor_id}
                onChange={(event) => {
                  setSelectedSuggestedExecutor(null);
                  updateInput({ ...input, executor_id: event.target.value });
                }}
              >
                <option value="">{t("Выберите исполнителя")}</option>
                {selectedSuggestedExecutor && !manualExecutorExists && (
                  <option value={selectedSuggestedExecutor.employee_id}>
                    {selectedSuggestedExecutor.display_name} · {selectedSuggestedExecutor.specialty} ·{" "}
                    {selectedSuggestedExecutor.grade} {t("разряд")}
                  </option>
                )}
                {selectedBrigade
                  ? selectedBrigade.participants.map((person) => (
                      <option key={person.employee_id} value={person.employee_id}>
                        {person.display_name} · {brigadeAvailabilityLabel(person.availability)}
                      </option>
                    ))
                  : workers
                      .filter((person) => person.area_ids?.includes(input.area_id))
                      .map((person) => (
                        <option
                          key={person.employee_id}
                          value={person.employee_id}
                          disabled={!person.is_on_shift}
                        >
                          {person.display_name} · {person.specialty} · {person.grade} {t("разряд ·")}{" "}
                          {person.availability === "free"
                            ? t("Свободен")
                            : person.availability === "queued"
                              ? t("В очереди")
                              : person.availability === "busy"
                                ? t("В работе")
                                : t("Не на смене")}
                          {currentBusyOrderNumber(person)
                            ? `${person.current_order_description ? ` · ${shortTitle(person.current_order_description)}` : ""} · № ${currentBusyOrderNumber(person)}`
                            : ""}
                        </option>
                      ))}
              </select>
            </label>
            <label>
              {t("Срок (Asia/Almaty)")}
              <input
                type="datetime-local"
                value={input.deadline}
                onChange={(event) => updateInput({ ...input, deadline: event.target.value })}
              />
            </label>
            <label>
              {t("Комментарий для исполнителя")}
              <input
                value={input.comment}
                onChange={(event) => updateInput({ ...input, comment: event.target.value })}
              />
            </label>
          </div>
        </details>
        {error && <p className="error">{message(error)}</p>}
        <button
          className="primary"
          data-testid="quick-submit-order"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? t("Выдаём наряд…") : t("Выдать наряд")}
        </button>
      </form>
    </Dialog>
  );
}
const sectionIcons: Record<DirectorySection, IconName> = {
  areas: "pin",
  equipment: "wrench",
  brigades: "workload",
  materials: "package",
  "fault-codes": "alert",
  "time-norms": "clock",
  employees: "employees",
};
export function ReferenceView({
  role,
  catalog,
  employees,
  api,
  onCatalogChange,
  onEmployees,
  onEmployeeOrders,
  onEquipmentQr,
  section,
  onSectionChange,
  directoryFilters,
  onDirectoryFiltersChange,
}: {
  role: Role;
  catalog: Catalog | null;
  employees: { id: string; display_name: string; role: string; is_on_shift: boolean }[];
  api: Api;
  onCatalogChange: () => Promise<void>;
  onEmployees?: () => void;
  onEmployeeOrders?: (employeeId: string) => void;
  onEquipmentQr?: (equipmentId: string) => void;
  section: DirectorySection | null;
  onSectionChange: (section: DirectorySection | null) => void;
  directoryFilters: DirectoryFilters;
  onDirectoryFiltersChange: (filters: DirectoryFilters) => void;
}) {
  const [editor, setEditor] = useState<{ kind: CatalogEditorKind; id?: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const cardRefs = useRef<Partial<Record<DirectorySection, HTMLButtonElement | null>>>({});
  const previousSection = useRef<DirectorySection | null>(null);
  useEffect(() => {
    const previous = previousSection.current;
    previousSection.current = section;
    if (section) {
      if (section !== previous) setEditor(null);
      const frame = requestAnimationFrame(() => sectionHeading.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (!previous) return;
    setEditor(null);
    const frame = requestAnimationFrame(() => cardRefs.current[previous]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [section]);
  if (!catalog)
    return (
      <section className="workspace">
        <p>{t("Загрузка справочников…")}</p>
      </section>
    );
  const canManageCatalog = role === "admin";
  const activeAreas = catalog.areas.filter((item) => item.is_active !== false).length;
  const activeEquipment = catalog.equipment.filter((item) => item.is_active !== false).length;
  const sectionCards: Array<{
    id: DirectorySection;
    title: string;
    count?: number;
    summary: string;
  }> = [
    {
      id: "areas",
      title: t("Участки"),
      count: catalog.areas.length,
      summary: t("{0} активных · зоны обслуживания и выдачи работ", [activeAreas]),
    },
    {
      id: "equipment",
      title: t("Оборудование"),
      count: catalog.equipment.length,
      summary: t("{0} активных · инвентарные номера и критичность", [activeEquipment]),
    },
    ...(role === "admin" || role === "master"
      ? [
          {
            id: "brigades" as const,
            title: t("Бригады"),
            count: catalog.brigades.length,
            summary: t("Состав ремонтных групп и назначение сотрудников"),
          },
        ]
      : []),
    {
      id: "materials",
      title: t("Материалы"),
      count: catalog.materials.length,
      summary: t("Расходники и единицы измерения для отчётов"),
    },
    {
      id: "fault-codes",
      title: t("Шифры неисправностей"),
      count: catalog.fault_codes.length,
      summary: t("Коды и специализации для сдачи работ"),
    },
    ...(role === "admin" || role === "master"
      ? [
          {
            id: "time-norms" as const,
            title: t("Нормативы времени"),
            count: catalog.time_norms.length,
            summary: t("Ориентир по шифру неисправности и типу оборудования"),
          },
        ]
      : []),
    {
      id: "employees",
      title: t("Сотрудники"),
      count: role === "admin" ? undefined : employees.length,
      summary:
        role === "admin" ? t("Учётные записи и доступы") : t("Состав смены и доступность исполнителей"),
    },
  ];
  const directorySearch = directoryFilters.query;
  const directoryState = directoryFilters.state;
  const equipmentAreaId = directoryFilters.area;
  const updateDirectoryFilters = (next: Partial<typeof directoryFilters>) =>
    onDirectoryFiltersChange({ ...directoryFilters, ...next });
  const resetFilters = () => onDirectoryFiltersChange({ query: "", state: "active", area: "" });
  const openSection = (next: DirectorySection) => {
    if (next === "employees" && role === "admin" && onEmployees) {
      onEmployees();
      return;
    }
    onSectionChange(next);
  };
  const goToOverview = () => onSectionChange(null);
  const needle = directorySearch.trim().toLocaleLowerCase("ru-RU");
  const matches = (...values: string[]) => values.join(" ").toLocaleLowerCase("ru-RU").includes(needle);
  const inState = (active: boolean) =>
    directoryState === "all" || (directoryState === "active" ? active : !active);
  const empty = (count: number) =>
    count === 0 && (
      <div className="reference-empty" role="status">
        <strong>{t("По этим условиям ничего не найдено.")}</strong>
        <p>{t("Измените поиск или сбросьте фильтры.")}</p>
        <button type="button" className="secondary" onClick={resetFilters}>
          {t("Сбросить фильтры")}
        </button>
      </div>
    );
  const stateTabs = (label: string) => (
    <div className="directory-tabs" aria-label={label}>
      {(["active", "archived", "all"] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={directoryState === value ? "active" : ""}
          aria-pressed={directoryState === value}
          onClick={() => updateDirectoryFilters({ state: value })}
        >
          {value === "active" ? t("Активные") : value === "archived" ? t("Архив") : t("Все")}
        </button>
      ))}
    </div>
  );
  const search = (placeholder: string, visibleLabel = false) => (
    <label className={`reference-search${visibleLabel ? " reference-search-labeled" : ""}`}>
      <span className={visibleLabel ? "reference-filter-label" : "sr-only"}>{t("Поиск по справочнику")}</span>
      <input
        aria-label={t("Поиск по справочнику")}
        value={directorySearch}
        onChange={(event) => updateDirectoryFilters({ query: event.target.value })}
        placeholder={placeholder}
        type="search"
      />
    </label>
  );
  const stateLabel = (isActive: boolean) => (isActive ? t("Активна") : t("В архиве"));
  const resultCount = (count: number) => (
    <p className="reference-results">
      {t("Найдено:")} {count}
    </p>
  );
  const areas = catalog.areas.filter(
    (item) => inState(item.is_active !== false) && matches(item.code, item.name),
  );
  const equipment = catalog.equipment.filter(
    (item) =>
      inState(item.is_active !== false) &&
      (!equipmentAreaId || item.area_id === equipmentAreaId) &&
      matches(item.inventory_number, item.name, item.equipment_type),
  );
  const materials = catalog.materials.filter((item) => matches(item.code, item.name, item.unit));
  const faultCodes = catalog.fault_codes.filter((item) => matches(item.code, item.name, item.specialty));
  const brigades = catalog.brigades.filter((item) => matches(item.code, item.name));
  const timeNorms = catalog.time_norms.filter((item) => {
    const fault = catalog.fault_codes.find((code) => code.id === item.fault_code_id);
    return matches(fault?.code ?? "", fault?.name ?? "", item.equipment_type, String(item.minutes));
  });
  const staff = employees.filter((item) =>
    matches(
      item.display_name,
      roleLabels[item.role as Role] ?? item.role,
      item.is_on_shift ? t("в смене") : t("не в смене"),
    ),
  );

  if (!section)
    return (
      <section className="workspace reference-workspace">
        <div className="page-head">
          <div>
            <p className="eyebrow">{canManageCatalog ? t("СПРАВОЧНИКИ") : t("КОНТЕКСТ УЧАСТКА")}</p>
            <h1>{canManageCatalog ? t("Справочные данные") : t("Справочники")}</h1>
            <p className="muted reference-lead">
              {t("Выберите раздел, чтобы посмотреть сведения и выполнить доступные действия.")}
            </p>
          </div>
        </div>
        <div className="reference-overview" aria-label={t("Разделы справочника")}>
          {sectionCards.map((item) => (
            <button
              key={item.id}
              type="button"
              className="reference-card"
              aria-label={t("Открыть раздел: {0}", [item.title])}
              onClick={() => openSection(item.id)}
              ref={(node) => {
                cardRefs.current[item.id] = node;
              }}
            >
              <Icon name={sectionIcons[item.id]} className="reference-card-icon" />
              {item.count !== undefined && <span className="reference-card-count">{item.count}</span>}
              <strong>{item.title}</strong>
              <small>{item.summary}</small>
              <span className="reference-card-action">
                {t("Открыть раздел")}
                <Icon name="chevronRight" />
              </span>
            </button>
          ))}
        </div>
      </section>
    );

  const sectionTitle = sectionCards.find((item) => item.id === section)?.title ?? t("Справочники");
  const editorMatchesSection =
    editor &&
    ((editor.kind === "area" && section === "areas") ||
      (editor.kind === "equipment" && section === "equipment") ||
      (editor.kind === "brigade" && section === "brigades") ||
      (editor.kind === "material" && section === "materials") ||
      (editor.kind === "fault-code" && section === "fault-codes") ||
      (editor.kind === "time-norm" && section === "time-norms"));
  const addAction: Partial<Record<DirectorySection, { kind: CatalogEditorKind; label: string }>> = {
    areas: { kind: "area", label: t("Добавить участок") },
    equipment: { kind: "equipment", label: t("Добавить оборудование") },
    brigades: { kind: "brigade", label: t("Добавить бригаду") },
    materials: { kind: "material", label: t("Добавить материал") },
    "fault-codes": { kind: "fault-code", label: t("Добавить шифр") },
    "time-norms": { kind: "time-norm", label: t("Добавить норматив") },
  };
  return (
    <section className="workspace reference-workspace">
      <div className="page-head">
        <div>
          <nav className="reference-breadcrumb" aria-label={t("Навигация справочника")}>
            <button type="button" className="text-button reference-back" onClick={goToOverview}>
              {t("Все разделы")}
            </button>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{sectionTitle}</span>
          </nav>
          <p className="eyebrow">{canManageCatalog ? t("СПРАВОЧНИКИ") : t("ТОЛЬКО ЧТЕНИЕ")}</p>
          <h1 ref={sectionHeading} tabIndex={-1}>
            {sectionTitle}
          </h1>
        </div>
        {canManageCatalog && section && addAction[section] && (
          <div className="reference-head-actions">
            {(section === "equipment" || section === "materials") && (
              <button className="secondary" type="button" onClick={() => setImportOpen(true)}>
                {t("Импорт Excel")}
              </button>
            )}
            <button className="primary" onClick={() => setEditor({ kind: addAction[section]!.kind })}>
              {addAction[section]!.label}
            </button>
          </div>
        )}
      </div>
      {canManageCatalog && (section === "areas" || section === "equipment") && (
        <p className="notice">
          {t(
            "Управляйте участками и оборудованием. Архив не используется при выдаче новых нарядов, но сохраняется в истории.",
          )}
        </p>
      )}
      {section === "areas" && (
        <section className="reference-directory" aria-label={t("Список участков")}>
          <div className="directory-controls">
            {search(t("Код, инвентарный номер или название"))}
            {stateTabs(t("Статус участков"))}
          </div>
          {resultCount(areas.length)}
          <div className="reference-list">
            {areas.map((item) => (
              <article
                className={`reference-row ${item.is_active === false ? "is-archived" : ""}`}
                key={item.id}
              >
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </div>
                <div className="reference-row-meta">
                  <span className={item.is_active !== false ? "reference-state" : "reference-state archived"}>
                    {stateLabel(item.is_active !== false)}
                  </span>
                  {canManageCatalog && (
                    <button className="text-button" onClick={() => setEditor({ kind: "area", id: item.id })}>
                      {t("Изменить")}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {empty(areas.length)}
        </section>
      )}
      {section === "equipment" && (
        <section className="reference-directory" aria-label={t("Список оборудования")}>
          <div className="directory-controls equipment-controls">
            {search(t("Код, инвентарный номер или название"), true)}
            <label className="reference-area-filter">
              <span>{t("Участок")}</span>
              <select
                aria-label={t("Участок оборудования")}
                value={equipmentAreaId}
                onChange={(event) => updateDirectoryFilters({ area: event.target.value })}
              >
                <option value="">{t("Все участки")}</option>
                {catalog.areas.map((area) => (
                  <option value={area.id} key={area.id}>
                    {area.code} · {area.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="reference-status-filter">
              <span className="reference-filter-label">{t("Статус")}</span>
              {stateTabs(t("Статус оборудования"))}
            </div>
          </div>
          {resultCount(equipment.length)}
          <div className="reference-list">
            {equipment.map((item) => {
              const area = catalog.areas.find((value) => value.id === item.area_id);
              return (
                <article
                  className={`reference-row ${item.is_active === false ? "is-archived" : ""}`}
                  key={item.id}
                >
                  <div>
                    <strong>{item.inventory_number}</strong>
                    <span>{item.name}</span>
                    <small>
                      {area ? `${area.code} · ${area.name}` : t("Участок не найден")} · {item.equipment_type}{" "}
                      {t("· критичность")} {item.criticality}/5
                    </small>
                  </div>
                  <div className="reference-row-meta">
                    <span
                      className={item.is_active !== false ? "reference-state" : "reference-state archived"}
                    >
                      {stateLabel(item.is_active !== false)}
                    </span>
                    {(role === "master" || role === "admin") && onEquipmentQr && (
                      <button className="text-button" type="button" onClick={() => onEquipmentQr(item.id)}>
                        QR-код
                      </button>
                    )}
                    {canManageCatalog && (
                      <button
                        className="text-button"
                        onClick={() => setEditor({ kind: "equipment", id: item.id })}
                      >
                        {t("Изменить")}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {empty(equipment.length)}
        </section>
      )}
      {section === "materials" && (
        <section className="reference-directory" aria-label={t("Список материалов")}>
          <div className="directory-controls">{search(t("Код или название материала"))}</div>
          {resultCount(materials.length)}
          <div className="reference-list">
            {materials.map((item) => (
              <article className="reference-row" key={item.id}>
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </div>
                <div className="reference-row-meta">
                  <span className="reference-unit">
                    {t("Ед. изм.:")} {item.unit}
                  </span>
                  {canManageCatalog && (
                    <button
                      className="text-button"
                      onClick={() => setEditor({ kind: "material", id: item.id })}
                    >
                      {t("Изменить")}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {empty(materials.length)}
        </section>
      )}
      {section === "fault-codes" && (
        <section className="reference-directory" aria-label={t("Список шифров неисправностей")}>
          <div className="directory-controls">{search(t("Шифр или название неисправности"))}</div>
          {resultCount(faultCodes.length)}
          <div className="reference-list">
            {faultCodes.map((item) => (
              <article className="reference-row" key={item.id}>
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </div>
                <div className="reference-row-meta">
                  <span className="reference-unit">
                    {t("Специализация:")} {item.specialty || t("Не указана")}
                  </span>
                  {canManageCatalog && (
                    <button
                      className="text-button"
                      onClick={() => setEditor({ kind: "fault-code", id: item.id })}
                    >
                      {t("Изменить")}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {empty(faultCodes.length)}
        </section>
      )}
      {section === "brigades" && (
        <section className="reference-directory" aria-label={t("Список бригад")}>
          <div className="directory-controls">{search(t("Код или название бригады"))}</div>
          {resultCount(brigades.length)}
          <div className="reference-list">
            {brigades.map((item) => (
              <article className="reference-row" key={item.id}>
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </div>
                {canManageCatalog && (
                  <div className="reference-row-meta">
                    <button
                      className="text-button"
                      onClick={() => setEditor({ kind: "brigade", id: item.id })}
                    >
                      {t("Изменить")}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          {empty(brigades.length)}
        </section>
      )}
      {section === "time-norms" && (
        <section className="reference-directory" aria-label={t("Список нормативов времени")}>
          <div className="directory-controls">{search(t("Шифр, тип оборудования или минуты"))}</div>
          {resultCount(timeNorms.length)}
          <div className="reference-list">
            {timeNorms.map((item) => {
              const fault = catalog.fault_codes.find((code) => code.id === item.fault_code_id);
              return (
                <article className="reference-row" key={item.id}>
                  <div>
                    <strong>{fault ? `${fault.code} · ${fault.name}` : t("Шифр не найден")}</strong>
                    <span>{item.equipment_type}</span>
                  </div>
                  <div className="reference-row-meta">
                    <span className="reference-unit">
                      {t("Норма:")} {item.minutes} {t("мин")}
                    </span>
                    {canManageCatalog && (
                      <button
                        className="text-button"
                        onClick={() => setEditor({ kind: "time-norm", id: item.id })}
                      >
                        {t("Изменить")}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {empty(timeNorms.length)}
        </section>
      )}
      {section === "employees" && (
        <section className="reference-directory" aria-label={t("Список сотрудников")}>
          <div className="directory-controls">{search(t("Имя, роль или смена"))}</div>
          {resultCount(staff.length)}
          <div className="reference-list">
            {staff.map((item, index) => (
              <article className="reference-row" key={`${item.display_name}-${index}`}>
                <div>
                  {item.role === "executor" && onEmployeeOrders ? (
                    <button
                      type="button"
                      className="reference-person-link"
                      onClick={() => onEmployeeOrders(item.id)}
                    >
                      {item.display_name}
                    </button>
                  ) : (
                    <strong>{item.display_name}</strong>
                  )}
                  <span>{roleLabels[item.role as Role] ?? t("Сотрудник")}</span>
                </div>
                <div className="reference-row-meta">
                  <span className={item.is_on_shift ? "reference-state" : "reference-state archived"}>
                    {item.is_on_shift ? t("В смене") : t("Не в смене")}
                  </span>
                </div>
              </article>
            ))}
          </div>
          {empty(staff.length)}
        </section>
      )}
      {editorMatchesSection &&
        editor &&
        (editor.kind === "area" || editor.kind === "equipment" ? (
          <CatalogEditor
            key={`${section}-${editor.kind}-${editor.id ?? "new"}`}
            catalog={catalog}
            api={api}
            editor={editor as { kind: "area" | "equipment"; id?: string }}
            onClose={() => setEditor(null)}
            onSaved={async () => {
              setEditor(null);
              await onCatalogChange();
            }}
          />
        ) : (
          <SimpleCatalogEditor
            key={`${section}-${editor.kind}-${editor.id ?? "new"}`}
            catalog={catalog}
            api={api}
            editor={editor as { kind: Exclude<CatalogEditorKind, "area" | "equipment">; id?: string }}
            onClose={() => setEditor(null)}
            onSaved={async () => {
              setEditor(null);
              await onCatalogChange();
            }}
          />
        ))}
      {importOpen && (section === "equipment" || section === "materials") && (
        <CatalogImport
          api={api}
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            await onCatalogChange();
          }}
        />
      )}
    </section>
  );
}

function CatalogEditor({
  catalog,
  api,
  editor,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  api: Api;
  editor: { kind: "area" | "equipment"; id?: string };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const area = editor.kind === "area" ? catalog.areas.find((item) => item.id === editor.id) : undefined;
  const equipment =
    editor.kind === "equipment" ? catalog.equipment.find((item) => item.id === editor.id) : undefined;
  const [input, setInput] = useState({
    code: area?.code ?? "",
    name: area?.name ?? equipment?.name ?? "",
    inventory_number: equipment?.inventory_number ?? "",
    area_id: equipment?.area_id ?? catalog.areas.find((item) => item.is_active !== false)?.id ?? "",
    equipment_type: equipment?.equipment_type ?? "",
    criticality: String(equipment?.criticality ?? 3),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (editor.kind === "area") {
        const value = { code: input.code.trim(), name: input.name.trim() };
        if (area) await api.updateArea(area.id, value);
        else await api.createArea(value);
      } else {
        const value = {
          inventory_number: input.inventory_number.trim(),
          name: input.name.trim(),
          area_id: input.area_id,
          equipment_type: input.equipment_type.trim(),
          criticality: Number(input.criticality),
        };
        if (equipment) await api.updateEquipment(equipment.id, value);
        else await api.createEquipment(value);
      }
      await onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.detail === "equipment_has_history"
          ? t("Оборудование с историей нарядов нельзя перенести на другой участок.")
          : caught instanceof ApiError && caught.status === 409
            ? t("Такой код уже есть или ссылка недействительна.")
            : t("Не удалось сохранить изменения."),
      );
    } finally {
      setBusy(false);
    }
  };
  const setActive = async () => {
    const target = area ?? equipment;
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      if (area) await api.setAreaActive(area.id, area.is_active === false);
      if (equipment) await api.setEquipmentActive(equipment.id, equipment.is_active === false);
      await onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.detail === "active_work_orders_exist"
          ? t(
              "{0} нельзя архивировать: есть незавершённые наряды. Завершите или отмените их, затем повторите.",
              [area ? t("Участок") : t("Оборудование")],
            )
          : t("Не удалось изменить статус записи."),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${editor.id ? t("Изменить") : t("Добавить")} · ${editor.kind === "area" ? t("участок") : t("оборудование")}`}
      onClose={onClose}
    >
      <form className="catalog-editor" onSubmit={(event) => void submit(event)}>
        {editor.kind === "area" ? (
          <>
            <label>
              {t("Код")}
              <input
                value={input.code}
                onChange={(event) => setInput({ ...input, code: event.target.value })}
                required
              />
            </label>
            <label>
              {t("Название")}
              <input
                value={input.name}
                onChange={(event) => setInput({ ...input, name: event.target.value })}
                required
              />
            </label>
          </>
        ) : (
          <>
            <label>
              {t("Инвентарный номер")}
              <input
                value={input.inventory_number}
                onChange={(event) => setInput({ ...input, inventory_number: event.target.value })}
                required
              />
            </label>
            <label>
              {t("Название")}
              <input
                value={input.name}
                onChange={(event) => setInput({ ...input, name: event.target.value })}
                required
              />
            </label>
            <label>
              {t("Участок")}
              <select
                value={input.area_id}
                onChange={(event) => setInput({ ...input, area_id: event.target.value })}
              >
                {catalog.areas
                  .filter((item) => item.is_active !== false || item.id === equipment?.area_id)
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("Тип")}
              <input
                value={input.equipment_type}
                onChange={(event) => setInput({ ...input, equipment_type: event.target.value })}
                required
              />
            </label>
            <label>
              {t("Критичность")}
              <select
                value={input.criticality}
                onChange={(event) => setInput({ ...input, criticality: event.target.value })}
              >
                {[1, 2, 3, 4, 5].map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {error && <p className="error">{message(error)}</p>}
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="primary" disabled={busy}>
            {busy ? t("Сохраняем…") : t("Сохранить")}
          </button>
        </div>
        {(area || equipment) && (
          <section className="catalog-archive" aria-label={t("Статус записи")}>
            <strong>
              {(area ?? equipment)!.is_active !== false ? t("Архивирование") : t("Восстановление")}
            </strong>
            <p>
              {(area ?? equipment)!.is_active !== false
                ? t("Архив не участвует в выдаче новых нарядов. История останется доступной.")
                : t("Восстановленная запись снова доступна при выдаче нарядов.")}
            </p>
            {(area ?? equipment)!.is_active !== false && !archiveConfirm ? (
              <button className="danger-button" type="button" onClick={() => setArchiveConfirm(true)}>
                {t("Архивировать запись")}
              </button>
            ) : (
              <div className="archive-confirm">
                <button
                  className={(area ?? equipment)!.is_active !== false ? "danger-button" : "secondary"}
                  type="button"
                  onClick={() => void setActive()}
                  disabled={busy}
                >
                  {busy
                    ? t("Обновляем…")
                    : (area ?? equipment)!.is_active !== false
                      ? t("Подтвердить архивирование")
                      : t("Восстановить запись")}
                </button>
              </div>
            )}
          </section>
        )}
      </form>
    </Dialog>
  );
}

function SimpleCatalogEditor({
  catalog,
  api,
  editor,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  api: Api;
  editor: { kind: Exclude<CatalogEditorKind, "area" | "equipment">; id?: string };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const brigade =
    editor.kind === "brigade" ? catalog.brigades.find((item) => item.id === editor.id) : undefined;
  const material =
    editor.kind === "material" ? catalog.materials.find((item) => item.id === editor.id) : undefined;
  const fault =
    editor.kind === "fault-code" ? catalog.fault_codes.find((item) => item.id === editor.id) : undefined;
  const norm =
    editor.kind === "time-norm" ? catalog.time_norms.find((item) => item.id === editor.id) : undefined;
  const record = brigade ?? material ?? fault ?? norm;
  const labels: Record<typeof editor.kind, string> = {
    brigade: t("бригада"),
    material: t("материал"),
    "fault-code": t("шифр неисправности"),
    "time-norm": t("норматив времени"),
  };
  const [input, setInput] = useState({
    code: brigade?.code ?? material?.code ?? fault?.code ?? "",
    name: brigade?.name ?? material?.name ?? fault?.name ?? "",
    specialty: fault?.specialty ?? "",
    unit: material?.unit ?? "",
    fault_code_id: norm?.fault_code_id ?? catalog.fault_codes[0]?.id ?? "",
    equipment_type: norm?.equipment_type ?? "",
    minutes: String(norm?.minutes ?? ""),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const write = async () => {
    const codeName = { code: input.code.trim(), name: input.name.trim() };
    if (editor.kind === "brigade") {
      if (brigade) await api.updateBrigade(brigade.id, codeName);
      else await api.createBrigade(codeName);
    }
    if (editor.kind === "material") {
      const value = { ...codeName, unit: input.unit.trim() };
      if (material) await api.updateMaterial(material.id, value);
      else await api.createMaterial(value);
    }
    if (editor.kind === "fault-code") {
      const value = { ...codeName, specialty: input.specialty.trim() };
      if (fault) await api.updateFaultCode(fault.id, value);
      else await api.createFaultCode(value);
    }
    if (editor.kind === "time-norm") {
      const value = {
        fault_code_id: input.fault_code_id,
        equipment_type: input.equipment_type.trim(),
        minutes: Number(input.minutes),
      };
      if (norm) await api.updateTimeNorm(norm.id, value);
      else await api.createTimeNorm(value);
    }
  };
  const errorMessage = (caught: unknown, verb: "save" | "delete") => {
    if (!(caught instanceof ApiError))
      return verb === "save" ? t("Не удалось сохранить изменения.") : t("Не удалось удалить запись.");
    if (caught.detail === "reference_in_use")
      return t(
        "Запись используется в связанных данных и не может быть удалена. Сохраните историю или сначала измените связанные записи.",
      );
    if (caught.detail === "material_has_history" || caught.detail === "material_unit_has_history")
      return t(
        "Материал уже использован в нарядах. Чтобы сохранить историю, его код, название и единицу менять нельзя. Добавьте новую позицию.",
      );
    if (caught.detail === "fault_code_has_history")
      return t(
        "Шифр уже использован в нарядах. Чтобы сохранить историю, добавьте новый шифр вместо изменения существующего.",
      );
    if (caught.detail === "duplicate_or_invalid_reference" || caught.status === 409)
      return t("Такой код уже существует или выбранная ссылка больше недействительна.");
    if (caught.status === 404) return t("Запись уже удалена. Обновите список справочника.");
    return verb === "save" ? t("Не удалось сохранить изменения.") : t("Не удалось удалить запись.");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await write();
      await onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "save"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!record) return;
    setBusy(true);
    setError("");
    try {
      if (editor.kind === "brigade") await api.deleteBrigade(record.id);
      if (editor.kind === "material") await api.deleteMaterial(record.id);
      if (editor.kind === "fault-code") await api.deleteFaultCode(record.id);
      if (editor.kind === "time-norm") await api.deleteTimeNorm(record.id);
      await onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "delete"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`${editor.id ? t("Изменить") : t("Добавить")} · ${labels[editor.kind]}`} onClose={onClose}>
      <form className="catalog-editor" onSubmit={(event) => void submit(event)}>
        {editor.kind !== "time-norm" ? (
          <>
            <label>
              {t("Код")}
              <input
                value={input.code}
                onChange={(event) => setInput({ ...input, code: event.target.value })}
                required
                minLength={2}
                maxLength={32}
              />
            </label>
            <label>
              {t("Название")}
              <input
                value={input.name}
                onChange={(event) => setInput({ ...input, name: event.target.value })}
                required
                maxLength={160}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              {t("Шифр неисправности")}
              <select
                value={input.fault_code_id}
                onChange={(event) => setInput({ ...input, fault_code_id: event.target.value })}
                required
              >
                <option value="">{t("Выберите шифр")}</option>
                {catalog.fault_codes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Тип оборудования")}
              <input
                value={input.equipment_type}
                onChange={(event) => setInput({ ...input, equipment_type: event.target.value })}
                required
                maxLength={64}
              />
            </label>
            <label>
              {t("Норма, минут")}
              <input
                type="number"
                min="1"
                max="100000"
                value={input.minutes}
                onChange={(event) => setInput({ ...input, minutes: event.target.value })}
                required
              />
            </label>
          </>
        )}
        {editor.kind === "fault-code" && (
          <label>
            {t("Специализация")}
            <input
              value={input.specialty}
              onChange={(event) => setInput({ ...input, specialty: event.target.value })}
              required
              maxLength={64}
            />
          </label>
        )}
        {editor.kind === "material" && (
          <label>
            {t("Единица измерения")}
            <input
              value={input.unit}
              onChange={(event) => setInput({ ...input, unit: event.target.value })}
              required
              maxLength={24}
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {message(error)}
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t("Отмена")}
          </button>
          <button className="primary" disabled={busy}>
            {busy ? t("Сохраняем…") : t("Сохранить")}
          </button>
        </div>
        {record && (
          <section className="catalog-archive catalog-delete" aria-label={t("Удаление записи")}>
            <strong>{t("Удаление записи")}</strong>
            <p>
              {t(
                "Удаление доступно только пока запись не используется в нарядах, нормативах или составе бригады.",
              )}
            </p>
            {!deleteConfirm ? (
              <button className="danger-button" type="button" onClick={() => setDeleteConfirm(true)}>
                {t("Удалить запись")}
              </button>
            ) : (
              <div className="archive-confirm">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={busy}
                >
                  {t("Не удалять")}
                </button>
                <button className="danger-button" type="button" onClick={() => void remove()} disabled={busy}>
                  {busy ? t("Удаляем…") : t("Подтвердить удаление")}
                </button>
              </div>
            )}
          </section>
        )}
      </form>
    </Dialog>
  );
}
