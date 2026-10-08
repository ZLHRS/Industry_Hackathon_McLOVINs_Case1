import {
  activeOrderStatuses as activeStatuses,
  archivedOrderStatuses as archiveStatuses,
} from "../lib/orderFilters";
import { roleLabels } from "../lib/roleAccess";
import type { DirectoryFilters, DirectorySection } from "../lib/navigation";
import "./workspace-ux.css";
import "./reference-ux.css";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Api, ApiError } from "../api";
import { local, ruPriority, ruStatus } from "./OrderDetail";
import type {
  Catalog,
  CreateOrder,
  MasterOption,
  Order,
  OrderPage,
  OrderSuggestionExecutor,
  OrderSuggestions,
  Role,
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
  onHistory,
  onSuggest,
  loading,
}: {
  role: Role;
  page: OrderPage | null;
  catalog: Catalog | null;
  workload: Workload[];
  masters: MasterOption[];
  currentUserId: string;
  filters: {
    status: string[];
    priority: string;
    overdue: boolean;
    area_id: string;
    equipment_id: string;
    executor_id: string;
    master_id: string;
    query: string;
    attention: boolean;
    offset: number;
  };
  onFilters: (next: {
    status: string[];
    priority: string;
    overdue: boolean;
    area_id: string;
    equipment_id: string;
    executor_id: string;
    master_id: string;
    query: string;
    attention: boolean;
    offset: number;
  }) => void;
  onOpen: (id: string) => void;
  onCreate: (input: CreateOrder) => Promise<void>;
  onHistory: (equipmentId: string) => Promise<void>;
  onSuggest: (input: {
    area_id: string;
    equipment_id: string;
    description: string;
    fault_code_id?: string | null;
  }) => Promise<OrderSuggestions>;
  loading: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(filters.query);
  const committedQuery = useRef(filters.query);
  const view = {
    executor: {
      eyebrow: "МОЯ СМЕНА",
      title: "Мои наряды",
      guidance: "Откройте наряд, чтобы принять его, начать работу или завершить выполнение.",
    },
    master: {
      eyebrow: "УПРАВЛЕНИЕ СМЕНОЙ",
      title: "Наряды участка",
      guidance: "Выдавайте наряды и контролируйте ход работ по участку.",
    },
    manager: {
      eyebrow: "КОНТРОЛЬ РАБОТ",
      title: "Наряды участка",
      guidance: "Просматривайте ход работ и переключайте список по текущей задаче.",
    },
    admin: {
      eyebrow: "ПРОСМОТР РАБОТ",
      title: "Наряды",
      guidance: "Просматривайте текущий список нарядов.",
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
  const emptyState = visibleOrders.length === 0;
  const unfilteredEmpty = !hasAdditionalFilters && !filters.query && !filters.attention;

  return (
    <section className="workspace orders-workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">{view.eyebrow}</p>
          <h1>{view.title}</h1>
          <p className="muted orders-guidance">{view.guidance}</p>
        </div>
        {role === "master" && (
          <button className="primary" onClick={() => setCreating(true)}>
            Выдать наряд
          </button>
        )}
      </div>

      {page && (role !== "executor" || urgentCount > 0) && (
        <section className={`operations-strip role-${role}`} aria-label="Сводка очереди">
          <button
            type="button"
            className={filters.attention ? "operations-signal is-active" : "operations-signal"}
            onClick={() => onFilters({ ...filters, attention: !filters.attention, offset: 0 })}
            aria-pressed={filters.attention}
          >
            <span className="operations-kicker">ТРЕБУЮТ ВНИМАНИЯ</span>
            <strong>{urgentCount}</strong>
            <small>{filters.attention ? "Показаны срочные" : "Сроки и высокий приоритет"}</small>
          </button>
          <div className="operations-stat">
            <span>Выполняются</span>
            <strong>{activeCount}</strong>
          </div>
          <div className="operations-stat">
            <span>В выборке</span>
            <strong>{page.total}</strong>
          </div>
        </section>
      )}

      {page && (
        <div className="status-tabs" aria-label="Список нарядов">
          <button
            className={activeTab ? "active" : ""}
            aria-pressed={activeTab}
            onClick={() =>
              onFilters({ ...filters, query: searchInput.trim(), status: activeStatuses, offset: 0 })
            }
          >
            В работе
          </button>
          <button
            className={archiveTab ? "active" : ""}
            aria-pressed={archiveTab}
            onClick={() =>
              onFilters({ ...filters, query: searchInput.trim(), status: archiveStatuses, offset: 0 })
            }
          >
            История
          </button>
        </div>
      )}

      <div className="orders-filter-actions">
        <label className="order-search">
          <span className="sr-only">Поиск наряда</span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Номер, задача или оборудование"
            aria-label="Поиск наряда"
          />
        </label>
        <button
          className="filter-toggle"
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="order-filters"
          aria-label={additionalFilterCount ? "Фильтры: выбрано " + additionalFilterCount : "Фильтры"}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Фильтры{additionalFilterCount ? " (" + additionalFilterCount + ")" : ""}
        </button>
        {hasAdditionalFilters && (
          <button className="text-button reset-order-filters" type="button" onClick={resetFilters}>
            Сбросить фильтры
          </button>
        )}
      </div>

      <div id="order-filters" className={"filters " + (filtersOpen ? "is-open" : "")}>
        <label>
          Приоритет
          <select
            aria-label="Приоритет"
            value={filters.priority}
            onChange={(e) => onFilters({ ...filters, priority: e.target.value, offset: 0 })}
          >
            <option value="">Все</option>
            {Object.entries(ruPriority).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {catalog && (
          <label>
            Участок
            <select
              aria-label="Участок"
              value={filters.area_id}
              onChange={(e) =>
                onFilters({ ...filters, area_id: e.target.value, equipment_id: "", offset: 0 })
              }
            >
              <option value="">Все участки</option>
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
            Оборудование
            <select
              aria-label="Оборудование"
              value={filters.equipment_id}
              onChange={(e) => onFilters({ ...filters, equipment_id: e.target.value, offset: 0 })}
            >
              <option value="">Всё оборудование</option>
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
        {(role === "master" || role === "manager") && (
          <label>
            Мастер
            <select
              aria-label="Мастер"
              value={filters.master_id === "all" ? "" : filters.master_id}
              onChange={(e) =>
                onFilters({
                  ...filters,
                  master_id: e.target.value || (role === "master" ? "all" : ""),
                  offset: 0,
                })
              }
            >
              <option value="">Все доступные мастера</option>
              {role === "master" && <option value={currentUserId}>Мои наряды</option>}
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
            Исполнитель
            <select
              aria-label="Исполнитель"
              value={filters.executor_id}
              onChange={(e) => onFilters({ ...filters, executor_id: e.target.value, offset: 0 })}
            >
              <option value="">Все исполнители</option>
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
          Только просроченные
        </label>
      </div>

      {page && (
        <p className="orders-summary" aria-live="polite">
          {filters.query || filters.attention ? "Найдено" : "В списке"}:{" "}
          <strong>{visibleOrders.length}</strong>
          {visibleOrders.length !== page.total && ` из ${page.total}`}
        </p>
      )}
      {loading && <p className="muted">Обновляем наряды…</p>}
      {emptyState ? (
        <div className="empty orders-empty">
          <h2>
            {unfilteredEmpty
              ? archiveTab
                ? "История пока пуста"
                : "Нет текущих нарядов"
              : "По выбранным условиям нарядов нет"}
          </h2>
          <p>
            {unfilteredEmpty
              ? archiveTab
                ? "Здесь появятся закрытые и отменённые наряды."
                : role === "master"
                  ? "Создайте первый наряд, когда появится работа на участке."
                  : "Новые наряды появятся здесь после выдачи мастером."
              : hasAdditionalFilters
                ? "Сбросьте дополнительные фильтры или выберите другой список нарядов."
                : "Переключитесь между текущими нарядами и историей."}
          </p>
          {hasAdditionalFilters && (
            <button className="secondary" type="button" onClick={resetFilters}>
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : role !== "executor" ? (
        <Kanban orders={visibleOrders} catalog={catalog} onOpen={onOpen} onHistory={onHistory} />
      ) : (
        <div className="order-list worker-queue">
          {visibleOrders.map((order) => (
            <OrderRow key={order.id} order={order} catalog={catalog} onOpen={onOpen} />
          ))}
        </div>
      )}

      {page && page.total > page.limit && (
        <div className="pagination">
          <button
            className="secondary"
            disabled={page.offset === 0}
            onClick={() => onFilters({ ...filters, offset: Math.max(0, page.offset - page.limit) })}
          >
            Назад
          </button>
          <span>
            {page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} из {page.total}
          </span>
          <button
            className="secondary"
            disabled={page.offset + page.limit >= page.total}
            onClick={() => onFilters({ ...filters, offset: page.offset + page.limit })}
          >
            Далее
          </button>
        </div>
      )}
      {creating && catalog && (
        <CreateOrderDialog
          catalog={catalog}
          workers={workload}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            await onCreate(input);
            setCreating(false);
          }}
          onSuggest={onSuggest}
        />
      )}
    </section>
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
  const columns: Array<[string, string[]]> = [
    ["К выдаче", ["issued", "accepted", "queued"]],
    ["В работе", ["in_progress", "paused"]],
    ["На проверке", ["completed", "ai_review"]],
    ["Доработка и отказы", ["rework", "rejected"]],
    ["Закрытые", ["closed"]],
    ["Отменённые", ["cancelled"]],
  ] satisfies Array<[string, string[]]>;
  const visibleColumns = columns.filter(([, statuses]) =>
    orders.some((order) => statuses.includes(order.status)),
  );
  return (
    <div className="kanban" aria-label="Доска нарядов">
      {visibleColumns.map(([title, statuses]) => {
        const items = orders.filter((order) => statuses.includes(order.status));
        return (
          <section key={title} className="kanban-column">
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
              <p className="muted">Нет нарядов</p>
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
  const description = order.is_synthetic
    ? order.description.replace(/^ДЕМО: синтетические данные\.\s*ДЕМО:\s*/i, "")
    : order.description;
  return (
    <article className={`order-row priority-${order.priority}`}>
      <button
        className="order-hit"
        onClick={() => onOpen(order.id)}
        aria-label={`Открыть наряд ${order.number}`}
      >
        <span className="order-number">{order.number}</span>
        <span className="order-main">
          <strong>{description}</strong>
          <small>{machine ? `${machine.inventory_number} · ${machine.name}` : "Оборудование"}</small>
        </span>
        <span className={`status status-${order.status}`}>{ruStatus[order.status]}</span>
        <span className={order.overdue ? "deadline danger-text" : "deadline"}>{local(order.deadline)}</span>
      </button>
      {machine && onHistory && (
        <button
          className="history-button"
          onClick={() => void onHistory(machine.id)}
          aria-label={`История ${machine.name}`}
        >
          История
        </button>
      )}
    </article>
  );
}
function CreateOrderDialog({
  catalog,
  workers,
  onClose,
  onCreate,
  onSuggest,
}: {
  catalog: Catalog;
  workers: Workload[];
  onClose: () => void;
  onCreate: (input: CreateOrder) => Promise<void>;
  onSuggest: (input: {
    area_id: string;
    equipment_id: string;
    description: string;
    fault_code_id?: string | null;
  }) => Promise<OrderSuggestions>;
}) {
  const initialArea = catalog.areas.find((item) => item.is_active !== false)?.id ?? "";
  const [input, setInput] = useState({
    work_type: "unplanned",
    description: "",
    area_id: initialArea,
    equipment_id: "",
    fault_code_id: "",
    executor_id: "",
    priority: "normal",
    deadline: "",
    comment: "",
  });
  const [error, setError] = useState("");
  const [suggestionError, setSuggestionError] = useState("");
  const [suggestions, setSuggestions] = useState<OrderSuggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const requestId = useRef(0);
  const equipment = useMemo(
    () => catalog.equipment.filter((item) => item.is_active !== false && item.area_id === input.area_id),
    [catalog, input.area_id],
  );
  const suggestionKey = [
    input.area_id,
    input.equipment_id,
    input.description.trim(),
    input.fault_code_id,
  ].join("|");
  const [receivedKey, setReceivedKey] = useState("");
  const selectedEquipment = catalog.equipment.find((item) => item.id === input.equipment_id);
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
      setSuggesting(false);
      setSuggestionError("");
    }
    setInput(next);
  };
  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [],
  );

  async function requestSuggestions() {
    if (!input.area_id || !input.equipment_id || !input.description.trim()) {
      setSuggestionError("Выберите участок и оборудование, затем опишите работу.");
      return;
    }
    const id = ++requestId.current;
    const key = suggestionKey;
    setSuggesting(true);
    setSuggestionError("");
    try {
      const result = await onSuggest({
        area_id: input.area_id,
        equipment_id: input.equipment_id,
        description: input.description.trim(),
        fault_code_id: input.fault_code_id || null,
      });
      if (id !== requestId.current || key !== suggestionKey) return;
      setSuggestions(result);
      setReceivedKey(key);
    } catch {
      if (id === requestId.current) {
        setSuggestions(null);
        setSuggestionError("Подбор недоступен. Заполните поля вручную или повторите попытку.");
      }
    } finally {
      if (id === requestId.current) setSuggesting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!input.deadline) {
      setError("Укажите срок выполнения.");
      return;
    }
    try {
      await onCreate({
        ...input,
        work_type: input.work_type as CreateOrder["work_type"],
        priority: input.priority as CreateOrder["priority"],
        deadline: input.deadline + ":00+05:00",
        fault_code_id: input.fault_code_id || undefined,
        comment: input.comment || undefined,
      });
    } catch {
      setError("Наряд не создан. Проверьте обязательные поля и доступ участка.");
    }
  }
  return (
    <Dialog title="Выдать наряд" onClose={onClose}>
      <form className="dialog-form guided-order-form" onSubmit={(event) => void submit(event)}>
        <div className="form-progress" aria-label="Шаги выдачи наряда">
          <span>
            <b>1</b> Где работа
          </span>
          <span>
            <b>2</b> Что сделать
          </span>
          <span>
            <b>3</b> Кому
          </span>
        </div>
        <p className="form-hint">
          Система показывает варианты, но не выбирает исполнителя, шифр или срок вместо мастера.
        </p>
        <label>
          Участок
          <select
            required
            value={input.area_id}
            onChange={(event) =>
              (() => {
                setSelectedSuggestedExecutor(null);
                updateInput(
                  { ...input, area_id: event.target.value, equipment_id: "", executor_id: "" },
                  true,
                );
              })()
            }
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
          Оборудование
          <select
            required
            value={input.equipment_id}
            onChange={(event) => updateInput({ ...input, equipment_id: event.target.value }, true)}
          >
            <option value="">Выберите оборудование</option>
            {equipment.map((item) => (
              <option key={item.id} value={item.id}>
                {item.inventory_number} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Описание
          <textarea
            required
            minLength={1}
            value={input.description}
            onChange={(event) => updateInput({ ...input, description: event.target.value }, true)}
          />
        </label>
        <label>
          Шифр неисправности
          <select
            value={input.fault_code_id}
            onChange={(event) => updateInput({ ...input, fault_code_id: event.target.value }, true)}
          >
            <option value="">Не выбран</option>
            {catalog.fault_codes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        {selectedNorm !== undefined ? (
          <p className="suggestion-norm">
            Ориентир трудоёмкости: {selectedNorm} мин. Это не срок выполнения.
          </p>
        ) : (
          input.fault_code_id && (
            <p className="muted suggestion-note">Для выбранного шифра и типа оборудования нормы пока нет.</p>
          )
        )}
        <section className="order-suggestions" aria-label="Подбор вариантов">
          {input.fault_code_id && (
            <p className="suggestion-selected-fault">
              Подбор исполнителя по выбранному шифру. Чтобы найти другой шифр, очистите это поле.
            </p>
          )}
          <div className="order-suggestions-head">
            <div>
              <h3>Подбор вариантов</h3>
              <p>Учитывает участок, оборудование, описание и текущую нагрузку.</p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => void requestSuggestions()}
              disabled={suggesting}
            >
              {suggesting ? "Подбираем…" : "Подобрать по описанию"}
            </button>
          </div>
          {suggestionError && (
            <p className="error" role="alert">
              {suggestionError}
            </p>
          )}
          {suggestions && receivedKey !== suggestionKey && (
            <p className="muted">Данные изменились. Подберите варианты снова.</p>
          )}
          {suggestions && receivedKey === suggestionKey && (
            <div className="suggestion-results">
              {!input.fault_code_id && suggestions.faults.length > 0 && (
                <section>
                  <h4>Шифры неисправности</h4>
                  {suggestions.faults.map((fault) => (
                    <article className="suggestion-card" key={fault.fault_code_id}>
                      <div>
                        <strong>
                          {fault.code} · {fault.name}
                        </strong>
                        {fault.reasons.length > 0 && <small>{fault.reasons.join(" · ")}</small>}
                        {fault.norm_minutes !== null && (
                          <small>Ориентир трудоёмкости: {fault.norm_minutes} мин</small>
                        )}
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => updateInput({ ...input, fault_code_id: fault.fault_code_id }, true)}
                      >
                        Выбрать шифр
                      </button>
                    </article>
                  ))}
                </section>
              )}
              {suggestions.executors.length > 0 && (
                <section>
                  <h4>Исполнители</h4>
                  {suggestions.executors.map((person) => (
                    <article className="suggestion-card" key={person.employee_id}>
                      <div>
                        <strong>
                          {person.display_name} · {person.specialty} · {person.grade} разряд
                        </strong>
                        {person.reasons.length > 0 && <small>{person.reasons.join(" · ")}</small>}
                        <small>
                          {person.availability === "free"
                            ? "Свободен"
                            : person.availability === "queued"
                              ? "В очереди"
                              : "Занят"}
                          {person.queue_length > 0 && <> · очередь: {person.queue_length}</>}
                          {person.paused_count > 0 && <> · пауз: {person.paused_count}</>}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setSelectedSuggestedExecutor(person);
                          updateInput({ ...input, executor_id: person.employee_id });
                        }}
                      >
                        Выбрать исполнителя
                      </button>
                    </article>
                  ))}
                </section>
              )}
              {suggestions.notes.map((note, index) => (
                <p className="muted suggestion-note" key={index}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </section>
        <label>
          Исполнитель
          <select
            required
            value={input.executor_id}
            onChange={(event) => {
              setSelectedSuggestedExecutor(null);
              updateInput({ ...input, executor_id: event.target.value });
            }}
          >
            <option value="">Выберите исполнителя</option>
            {selectedSuggestedExecutor && !manualExecutorExists && (
              <option value={selectedSuggestedExecutor.employee_id}>
                {selectedSuggestedExecutor.display_name} · {selectedSuggestedExecutor.specialty} ·{" "}
                {selectedSuggestedExecutor.grade} разряд
              </option>
            )}
            {workers
              .filter((person) => person.area_ids?.includes(input.area_id))
              .map((person) => (
                <option key={person.employee_id} value={person.employee_id} disabled={!person.is_on_shift}>
                  {person.display_name} · {person.specialty} · {person.grade} разряд ·{" "}
                  {person.availability === "free"
                    ? "Свободен"
                    : person.availability === "queued"
                      ? "В очереди"
                      : person.availability === "busy"
                        ? "В работе"
                        : "Не на смене"}
                </option>
              ))}
          </select>
        </label>
        <div className="two-col">
          <label>
            Тип
            <select
              value={input.work_type}
              onChange={(event) => updateInput({ ...input, work_type: event.target.value })}
            >
              <option value="unplanned">Внеплановый</option>
              <option value="planned">Плановый</option>
            </select>
          </label>
          <label>
            Приоритет
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
        <label>
          Срок (Asia/Almaty)
          <input
            type="datetime-local"
            required
            value={input.deadline}
            onChange={(event) => updateInput({ ...input, deadline: event.target.value })}
          />
        </label>
        <div className="deadline-presets" aria-label="Быстрый выбор срока">
          <span>Быстрый срок после проверки мастером:</span>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              updateInput({ ...input, deadline: almatyInputDate(new Date(Date.now() + 60 * 60_000)) })
            }
          >
            Через 1 час
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              updateInput({ ...input, deadline: almatyInputDate(new Date(Date.now() + 2 * 60 * 60_000)) })
            }
          >
            Через 2 часа
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => updateInput({ ...input, deadline: endOfCurrentShift() })}
          >
            До конца смены
          </button>
        </div>
        <label>
          Комментарий для исполнителя
          <input
            value={input.comment}
            onChange={(event) => updateInput({ ...input, comment: event.target.value })}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary">Выдать наряд</button>
      </form>
    </Dialog>
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
  const onShift = workers.filter((person) => person.is_on_shift);
  const busy = onShift.filter((person) => person.availability === "busy").length;
  return (
    <section className="workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">СМЕНА</p>
          <h1>Загрузка исполнителей</h1>
        </div>
      </div>
      <div className="workload-summary" aria-label="Сводка загрузки">
        <span>
          <b>{onShift.length}</b> в смене
        </span>
        <span>
          <b>{busy}</b> заняты
        </span>
        <span>
          <b>{onShift.reduce((sum, person) => sum + person.queue_length, 0)}</b> в очереди
        </span>
      </div>
      <div className="workload">
        {workers.map((person) => (
          <article key={person.employee_id} className="worker">
            <span className={`availability ${person.availability}`}></span>
            <div>
              <button
                type="button"
                className="workload-person-link"
                onClick={() => onEmployeeOrders(person.employee_id)}
              >
                {person.display_name}
              </button>
              <small>
                {person.specialty} · {person.grade} разряд
              </small>
            </div>
            <div>
              <b>
                {person.availability === "busy"
                  ? "Занят"
                  : person.availability === "free"
                    ? "Свободен"
                    : person.availability === "queued"
                      ? "Очередь"
                      : "Не в смене"}
              </b>
              {person.current_order_id && person.current_order_number ? (
                <button
                  className="workload-order-link"
                  type="button"
                  onClick={() => onOpen(person.current_order_id!)}
                >
                  {person.current_order_number}
                </button>
              ) : (
                <small>В очереди: {person.queue_length}</small>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
export function ReferenceView({
  role,
  catalog,
  employees,
  api,
  onCatalogChange,
  onEmployees,
  onEmployeeOrders,
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
  section: DirectorySection | null;
  onSectionChange: (section: DirectorySection | null) => void;
  directoryFilters: DirectoryFilters;
  onDirectoryFiltersChange: (filters: DirectoryFilters) => void;
}) {
  const [editor, setEditor] = useState<{ kind: CatalogEditorKind; id?: string } | null>(null);
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
        <p>Загрузка справочников…</p>
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
      title: "Участки",
      count: catalog.areas.length,
      summary: `${activeAreas} активных · зоны обслуживания и выдачи работ`,
    },
    {
      id: "equipment",
      title: "Оборудование",
      count: catalog.equipment.length,
      summary: `${activeEquipment} активных · инвентарные номера и критичность`,
    },
    ...(role === "admin" || role === "master"
      ? [
          {
            id: "brigades" as const,
            title: "Бригады",
            count: catalog.brigades.length,
            summary: "Состав ремонтных групп и назначение сотрудников",
          },
        ]
      : []),
    {
      id: "materials",
      title: "Материалы",
      count: catalog.materials.length,
      summary: "Расходники и единицы измерения для отчётов",
    },
    {
      id: "fault-codes",
      title: "Шифры неисправностей",
      count: catalog.fault_codes.length,
      summary: "Коды и специализации для сдачи работ",
    },
    ...(role === "admin" || role === "master"
      ? [
          {
            id: "time-norms" as const,
            title: "Нормативы времени",
            count: catalog.time_norms.length,
            summary: "Ориентир по шифру неисправности и типу оборудования",
          },
        ]
      : []),
    {
      id: "employees",
      title: "Сотрудники",
      count: role === "admin" ? undefined : employees.length,
      summary: role === "admin" ? "Учётные записи и доступы" : "Состав смены и доступность исполнителей",
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
        <strong>По этим условиям ничего не найдено.</strong>
        <p>Измените поиск или сбросьте фильтры.</p>
        <button type="button" className="secondary" onClick={resetFilters}>
          Сбросить фильтры
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
          {value === "active" ? "Активные" : value === "archived" ? "Архив" : "Все"}
        </button>
      ))}
    </div>
  );
  const search = (placeholder: string) => (
    <label className="reference-search">
      <span className="sr-only">Поиск по справочнику</span>
      <input
        aria-label="Поиск по справочнику"
        value={directorySearch}
        onChange={(event) => updateDirectoryFilters({ query: event.target.value })}
        placeholder={placeholder}
        type="search"
      />
    </label>
  );
  const stateLabel = (isActive: boolean) => (isActive ? "Активна" : "В архиве");
  const resultCount = (count: number) => <p className="reference-results">Найдено: {count}</p>;
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
      item.is_on_shift ? "в смене" : "не в смене",
    ),
  );

  if (!section)
    return (
      <section className="workspace reference-workspace">
        <div className="page-head">
          <div>
            <p className="eyebrow">{canManageCatalog ? "СПРАВОЧНИКИ" : "КОНТЕКСТ УЧАСТКА"}</p>
            <h1>{canManageCatalog ? "Справочные данные" : "Справочники"}</h1>
            <p className="muted reference-lead">
              Выберите раздел, чтобы посмотреть сведения и выполнить доступные действия.
            </p>
          </div>
        </div>
        <div className="reference-overview" aria-label="Разделы справочника">
          {sectionCards.map((item) => (
            <button
              key={item.id}
              type="button"
              className="reference-card"
              aria-label={`Открыть раздел: ${item.title}`}
              onClick={() => openSection(item.id)}
              ref={(node) => {
                cardRefs.current[item.id] = node;
              }}
            >
              {item.count !== undefined && <span className="reference-card-count">{item.count}</span>}
              <strong>{item.title}</strong>
              <small>{item.summary}</small>
              <span className="reference-card-action">Открыть раздел →</span>
            </button>
          ))}
        </div>
      </section>
    );

  const sectionTitle = sectionCards.find((item) => item.id === section)?.title ?? "Справочники";
  const editorMatchesSection =
    editor &&
    ((editor.kind === "area" && section === "areas") ||
      (editor.kind === "equipment" && section === "equipment") ||
      (editor.kind === "brigade" && section === "brigades") ||
      (editor.kind === "material" && section === "materials") ||
      (editor.kind === "fault-code" && section === "fault-codes") ||
      (editor.kind === "time-norm" && section === "time-norms"));
  const addAction: Partial<Record<DirectorySection, { kind: CatalogEditorKind; label: string }>> = {
    areas: { kind: "area", label: "Добавить участок" },
    equipment: { kind: "equipment", label: "Добавить оборудование" },
    brigades: { kind: "brigade", label: "Добавить бригаду" },
    materials: { kind: "material", label: "Добавить материал" },
    "fault-codes": { kind: "fault-code", label: "Добавить шифр" },
    "time-norms": { kind: "time-norm", label: "Добавить норматив" },
  };
  return (
    <section className="workspace reference-workspace">
      <div className="page-head">
        <div>
          <nav className="reference-breadcrumb" aria-label="Навигация справочника">
            <button type="button" className="text-button reference-back" onClick={goToOverview}>
              Все разделы
            </button>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{sectionTitle}</span>
          </nav>
          <p className="eyebrow">{canManageCatalog ? "СПРАВОЧНИКИ" : "ТОЛЬКО ЧТЕНИЕ"}</p>
          <h1 ref={sectionHeading} tabIndex={-1}>
            {sectionTitle}
          </h1>
        </div>
        {canManageCatalog && section && addAction[section] && (
          <button className="primary" onClick={() => setEditor({ kind: addAction[section]!.kind })}>
            {addAction[section]!.label}
          </button>
        )}
      </div>
      {canManageCatalog && (section === "areas" || section === "equipment") && (
        <p className="notice">
          Управляйте участками и оборудованием. Архив не используется при выдаче новых нарядов, но сохраняется
          в истории.
        </p>
      )}
      {section === "areas" && (
        <section className="reference-directory" aria-label="Список участков">
          <div className="directory-controls">
            {search("Код, инвентарный номер или название")}
            {stateTabs("Статус участков")}
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
                      Изменить
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
        <section className="reference-directory" aria-label="Список оборудования">
          <div className="directory-controls equipment-controls">
            {search("Код, инвентарный номер или название")}
            <label className="reference-area-filter">
              <span>Участок</span>
              <select
                aria-label="Участок оборудования"
                value={equipmentAreaId}
                onChange={(event) => updateDirectoryFilters({ area: event.target.value })}
              >
                <option value="">Все участки</option>
                {catalog.areas.map((area) => (
                  <option value={area.id} key={area.id}>
                    {area.code} · {area.name}
                  </option>
                ))}
              </select>
            </label>
            {stateTabs("Статус оборудования")}
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
                      {area ? `${area.code} · ${area.name}` : "Участок не найден"} · {item.equipment_type} ·
                      критичность {item.criticality}/5
                    </small>
                  </div>
                  <div className="reference-row-meta">
                    <span
                      className={item.is_active !== false ? "reference-state" : "reference-state archived"}
                    >
                      {stateLabel(item.is_active !== false)}
                    </span>
                    {canManageCatalog && (
                      <button
                        className="text-button"
                        onClick={() => setEditor({ kind: "equipment", id: item.id })}
                      >
                        Изменить
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
        <section className="reference-directory" aria-label="Список материалов">
          <div className="directory-controls">{search("Код или название материала")}</div>
          {resultCount(materials.length)}
          <div className="reference-list">
            {materials.map((item) => (
              <article className="reference-row" key={item.id}>
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </div>
                <div className="reference-row-meta">
                  <span className="reference-unit">Ед. изм.: {item.unit}</span>
                  {canManageCatalog && (
                    <button
                      className="text-button"
                      onClick={() => setEditor({ kind: "material", id: item.id })}
                    >
                      Изменить
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
        <section className="reference-directory" aria-label="Список шифров неисправностей">
          <div className="directory-controls">{search("Шифр или название неисправности")}</div>
          {resultCount(faultCodes.length)}
          <div className="reference-list">
            {faultCodes.map((item) => (
              <article className="reference-row" key={item.id}>
                <div>
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </div>
                <div className="reference-row-meta">
                  <span className="reference-unit">Специализация: {item.specialty || "Не указана"}</span>
                  {canManageCatalog && (
                    <button
                      className="text-button"
                      onClick={() => setEditor({ kind: "fault-code", id: item.id })}
                    >
                      Изменить
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
        <section className="reference-directory" aria-label="Список бригад">
          <div className="directory-controls">{search("Код или название бригады")}</div>
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
                      Изменить
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
        <section className="reference-directory" aria-label="Список нормативов времени">
          <div className="directory-controls">{search("Шифр, тип оборудования или минуты")}</div>
          {resultCount(timeNorms.length)}
          <div className="reference-list">
            {timeNorms.map((item) => {
              const fault = catalog.fault_codes.find((code) => code.id === item.fault_code_id);
              return (
                <article className="reference-row" key={item.id}>
                  <div>
                    <strong>{fault ? `${fault.code} · ${fault.name}` : "Шифр не найден"}</strong>
                    <span>{item.equipment_type}</span>
                  </div>
                  <div className="reference-row-meta">
                    <span className="reference-unit">Норма: {item.minutes} мин</span>
                    {canManageCatalog && (
                      <button
                        className="text-button"
                        onClick={() => setEditor({ kind: "time-norm", id: item.id })}
                      >
                        Изменить
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
        <section className="reference-directory" aria-label="Список сотрудников">
          <div className="directory-controls">{search("Имя, роль или смена")}</div>
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
                  <span>{roleLabels[item.role as Role] ?? "Сотрудник"}</span>
                </div>
                <div className="reference-row-meta">
                  <span className={item.is_on_shift ? "reference-state" : "reference-state archived"}>
                    {item.is_on_shift ? "В смене" : "Не в смене"}
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
          ? "Оборудование с историей нарядов нельзя перенести на другой участок."
          : caught instanceof ApiError && caught.status === 409
            ? "Такой код уже есть или ссылка недействительна."
            : "Не удалось сохранить изменения.",
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
          ? `${area ? "Участок" : "Оборудование"} нельзя архивировать: есть незавершённые наряды. Завершите или отмените их, затем повторите.`
          : "Не удалось изменить статус записи.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${editor.id ? "Изменить" : "Добавить"} · ${editor.kind === "area" ? "участок" : "оборудование"}`}
      onClose={onClose}
    >
      <form className="catalog-editor" onSubmit={(event) => void submit(event)}>
        {editor.kind === "area" ? (
          <>
            <label>
              Код
              <input
                value={input.code}
                onChange={(event) => setInput({ ...input, code: event.target.value })}
                required
              />
            </label>
            <label>
              Название
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
              Инвентарный номер
              <input
                value={input.inventory_number}
                onChange={(event) => setInput({ ...input, inventory_number: event.target.value })}
                required
              />
            </label>
            <label>
              Название
              <input
                value={input.name}
                onChange={(event) => setInput({ ...input, name: event.target.value })}
                required
              />
            </label>
            <label>
              Участок
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
              Тип
              <input
                value={input.equipment_type}
                onChange={(event) => setInput({ ...input, equipment_type: event.target.value })}
                required
              />
            </label>
            <label>
              Критичность
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
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
        {(area || equipment) && (
          <section className="catalog-archive" aria-label="Статус записи">
            <strong>{(area ?? equipment)!.is_active !== false ? "Архивирование" : "Восстановление"}</strong>
            <p>
              {(area ?? equipment)!.is_active !== false
                ? "Архив не участвует в выдаче новых нарядов. История останется доступной."
                : "Восстановленная запись снова доступна при выдаче нарядов."}
            </p>
            {(area ?? equipment)!.is_active !== false && !archiveConfirm ? (
              <button className="danger-button" type="button" onClick={() => setArchiveConfirm(true)}>
                Архивировать запись
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
                    ? "Обновляем…"
                    : (area ?? equipment)!.is_active !== false
                      ? "Подтвердить архивирование"
                      : "Восстановить запись"}
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
    brigade: "бригада",
    material: "материал",
    "fault-code": "шифр неисправности",
    "time-norm": "норматив времени",
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
      return verb === "save" ? "Не удалось сохранить изменения." : "Не удалось удалить запись.";
    if (caught.detail === "reference_in_use")
      return "Запись используется в связанных данных и не может быть удалена. Сохраните историю или сначала измените связанные записи.";
    if (caught.detail === "material_has_history" || caught.detail === "material_unit_has_history")
      return "Материал уже использован в нарядах. Чтобы сохранить историю, его код, название и единицу менять нельзя. Добавьте новую позицию.";
    if (caught.detail === "fault_code_has_history")
      return "Шифр уже использован в нарядах. Чтобы сохранить историю, добавьте новый шифр вместо изменения существующего.";
    if (caught.detail === "duplicate_or_invalid_reference" || caught.status === 409)
      return "Такой код уже существует или выбранная ссылка больше недействительна.";
    if (caught.status === 404) return "Запись уже удалена. Обновите список справочника.";
    return verb === "save" ? "Не удалось сохранить изменения." : "Не удалось удалить запись.";
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
    <Dialog title={`${editor.id ? "Изменить" : "Добавить"} · ${labels[editor.kind]}`} onClose={onClose}>
      <form className="catalog-editor" onSubmit={(event) => void submit(event)}>
        {editor.kind !== "time-norm" ? (
          <>
            <label>
              Код
              <input
                value={input.code}
                onChange={(event) => setInput({ ...input, code: event.target.value })}
                required
                minLength={2}
                maxLength={32}
              />
            </label>
            <label>
              Название
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
              Шифр неисправности
              <select
                value={input.fault_code_id}
                onChange={(event) => setInput({ ...input, fault_code_id: event.target.value })}
                required
              >
                <option value="">Выберите шифр</option>
                {catalog.fault_codes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Тип оборудования
              <input
                value={input.equipment_type}
                onChange={(event) => setInput({ ...input, equipment_type: event.target.value })}
                required
                maxLength={64}
              />
            </label>
            <label>
              Норма, минут
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
            Специализация
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
            Единица измерения
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
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
        {record && (
          <section className="catalog-archive catalog-delete" aria-label="Удаление записи">
            <strong>Удаление записи</strong>
            <p>
              Удаление доступно только пока запись не используется в нарядах, нормативах или составе бригады.
            </p>
            {!deleteConfirm ? (
              <button className="danger-button" type="button" onClick={() => setDeleteConfirm(true)}>
                Удалить запись
              </button>
            ) : (
              <div className="archive-confirm">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={busy}
                >
                  Не удалять
                </button>
                <button className="danger-button" type="button" onClick={() => void remove()} disabled={busy}>
                  {busy ? "Удаляем…" : "Подтвердить удаление"}
                </button>
              </div>
            )}
          </section>
        )}
      </form>
    </Dialog>
  );
}
