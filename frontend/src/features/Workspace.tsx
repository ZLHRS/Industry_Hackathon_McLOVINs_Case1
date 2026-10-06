import { roleLabels } from "../lib/roleAccess";
import "./workspace-ux.css";
import { FormEvent, useMemo, useState } from "react";
import { Dialog } from "../components/Dialog";
import { local, ruPriority, ruStatus } from "./OrderDetail";
import type { Catalog, CreateOrder, Order, OrderPage, Role, Workload } from "../types";
const activeStatuses = [
  "issued",
  "accepted",
  "queued",
  "in_progress",
  "paused",
  "completed",
  "ai_review",
  "rework",
];
const archiveStatuses = ["closed", "cancelled", "rejected"];

export function OrdersView({
  role,
  page,
  catalog,
  workload,
  filters,
  onFilters,
  onOpen,
  onCreate,
  onHistory,
  loading,
}: {
  role: Role;
  page: OrderPage | null;
  catalog: Catalog | null;
  workload: Workload[];
  filters: {
    status: string[];
    priority: string;
    overdue: boolean;
    area_id: string;
    equipment_id: string;
    executor_id: string;
    offset: number;
  };
  onFilters: (next: {
    status: string[];
    priority: string;
    overdue: boolean;
    area_id: string;
    equipment_id: string;
    executor_id: string;
    offset: number;
  }) => void;
  onOpen: (id: string) => void;
  onCreate: (input: CreateOrder) => Promise<void>;
  onHistory: (equipmentId: string) => Promise<void>;
  loading: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const allTab = !filters.status.length;
  const additionalFilterCount = [
    Boolean(filters.priority),
    Boolean(filters.area_id),
    Boolean(filters.equipment_id),
    Boolean(filters.executor_id),
    filters.overdue,
  ].filter(Boolean).length;
  const hasAdditionalFilters = additionalFilterCount > 0;
  const resetFilters = () =>
    onFilters({
      ...filters,
      priority: "",
      area_id: "",
      equipment_id: "",
      executor_id: "",
      overdue: false,
      offset: 0,
    });
  const emptyState = page?.items.length === 0;
  const unfilteredEmpty = allTab && !hasAdditionalFilters;

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

      {page && (
        <div className="status-tabs" aria-label="Список нарядов">
          <button
            className={activeTab ? "active" : ""}
            aria-pressed={activeTab}
            onClick={() => onFilters({ ...filters, status: activeStatuses, offset: 0 })}
          >
            Активные
          </button>
          <button
            className={archiveTab ? "active" : ""}
            aria-pressed={archiveTab}
            onClick={() => onFilters({ ...filters, status: archiveStatuses, offset: 0 })}
          >
            Архив
          </button>
          <button
            className={allTab ? "active" : ""}
            aria-pressed={allTab}
            onClick={() => onFilters({ ...filters, status: [], offset: 0 })}
          >
            Все наряды
          </button>
        </div>
      )}

      <div className="orders-filter-actions">
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
              {catalog.areas.map((item) => (
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
                .filter((item) => !filters.area_id || item.area_id === filters.area_id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.inventory_number} · {item.name}
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
          В списке: <strong>{page.total}</strong>
        </p>
      )}
      {loading && <p className="muted">Обновляем наряды…</p>}
      {emptyState ? (
        <div className="empty orders-empty">
          <h2>{unfilteredEmpty ? "Нарядов пока нет" : "По выбранным условиям нарядов нет"}</h2>
          <p>
            {unfilteredEmpty
              ? role === "master"
                ? "Создайте первый наряд, когда появится работа на участке."
                : "Новые наряды появятся здесь после выдачи мастером."
              : hasAdditionalFilters
                ? "Сбросьте дополнительные фильтры или выберите другой список нарядов."
                : "Переключите список на активные, архивные или все наряды."}
          </p>
          {hasAdditionalFilters && (
            <button className="secondary" type="button" onClick={resetFilters}>
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : role !== "executor" ? (
        <Kanban orders={page?.items ?? []} catalog={catalog} onOpen={onOpen} onHistory={onHistory} />
      ) : (
        <div className="order-list">
          {page?.items.map((order) => (
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
    ["На проверке", ["completed", "ai_review", "rework"]],
    ["Завершено", ["closed", "cancelled", "rejected"]],
  ];
  return (
    <div className="kanban" aria-label="Доска нарядов">
      {columns.map(([title, statuses]) => {
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
function defaultDeadline() {
  const value = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(Date.now() + 2 * 60 * 60 * 1000));
  return value.replace(" ", "T");
}
function CreateOrderDialog({
  catalog,
  workers,
  onClose,
  onCreate,
}: {
  catalog: Catalog;
  workers: Workload[];
  onClose: () => void;
  onCreate: (input: CreateOrder) => Promise<void>;
}) {
  const [input, setInput] = useState({
    work_type: "unplanned",
    description: "",
    area_id: catalog.areas[0]?.id ?? "",
    equipment_id: "",
    executor_id: "",
    priority: "normal",
    deadline: defaultDeadline(),
    comment: "",
  });
  const [error, setError] = useState("");
  const equipment = useMemo(
    () => catalog.equipment.filter((item) => item.area_id === input.area_id),
    [catalog, input.area_id],
  );
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
        deadline: `${input.deadline}:00+05:00`,
        comment: input.comment || undefined,
      });
    } catch {
      setError("Наряд не создан. Проверьте обязательные поля и доступ участка.");
    }
  }
  return (
    <Dialog title="Выдать наряд" onClose={onClose}>
      <form className="dialog-form" onSubmit={(e) => void submit(e)}>
        <label>
          Участок
          <select
            required
            value={input.area_id}
            onChange={(e) => setInput({ ...input, area_id: e.target.value, equipment_id: "" })}
          >
            {catalog.areas.map((item) => (
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
            onChange={(e) => setInput({ ...input, equipment_id: e.target.value })}
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
          Исполнитель
          <select
            required
            value={input.executor_id}
            onChange={(e) => setInput({ ...input, executor_id: e.target.value })}
          >
            <option value="">Выберите исполнителя</option>
            {workers
              .filter((person) => person.is_on_shift)
              .map((person) => (
                <option key={person.employee_id} value={person.employee_id}>
                  {person.display_name} · {person.availability}
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
            onChange={(e) => setInput({ ...input, description: e.target.value })}
          />
        </label>
        <div className="two-col">
          <label>
            Тип
            <select
              value={input.work_type}
              onChange={(e) => setInput({ ...input, work_type: e.target.value })}
            >
              <option value="unplanned">Внеплановый</option>
              <option value="planned">Плановый</option>
            </select>
          </label>
          <label>
            Приоритет
            <select value={input.priority} onChange={(e) => setInput({ ...input, priority: e.target.value })}>
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
            onChange={(e) => setInput({ ...input, deadline: e.target.value })}
          />
        </label>
        <label>
          Комментарий
          <input value={input.comment} onChange={(e) => setInput({ ...input, comment: e.target.value })} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary">Выдать наряд</button>
      </form>
    </Dialog>
  );
}
export function WorkloadView({ workers }: { workers: Workload[] }) {
  return (
    <section className="workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">СМЕНА</p>
          <h1>Загрузка исполнителей</h1>
        </div>
      </div>
      <div className="workload">
        {workers.map((person) => (
          <article key={person.employee_id} className="worker">
            <span className={`availability ${person.availability}`}></span>
            <div>
              <strong>{person.display_name}</strong>
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
              <small>{person.current_order_number || `В очереди: ${person.queue_length}`}</small>
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
}: {
  role: Role;
  catalog: Catalog | null;
  employees: { display_name: string; role: string; is_on_shift: boolean }[];
}) {
  if (!catalog)
    return (
      <section className="workspace">
        <p>Загрузка справочников…</p>
      </section>
    );
  return (
    <section className="workspace">
      <div className="page-head">
        <div>
          <p className="eyebrow">{role === "admin" ? "СПРАВОЧНИКИ" : "ТОЛЬКО ЧТЕНИЕ"}</p>
          <h1>{role === "admin" ? "Справочные данные" : "Контекст участка"}</h1>
        </div>
      </div>
      {role === "admin" && (
        <p className="notice">
          Справочники доступны для просмотра. Учётные записи настраиваются в разделе «Сотрудники».
        </p>
      )}
      <div className="reference-grid">
        <section>
          <h2>Участки</h2>
          {catalog.areas.map((item) => (
            <p key={item.id}>
              {item.code} · {item.name}
            </p>
          ))}
        </section>
        <section>
          <h2>Оборудование</h2>
          {catalog.equipment.map((item) => (
            <p key={item.id}>
              {item.inventory_number} · {item.name}
            </p>
          ))}
        </section>
        {role !== "admin" && (
          <section>
            <h2>Сотрудники</h2>
            {employees.length ? (
              employees.map((item, index) => (
                <p key={`${item.display_name}-${index}`}>
                  {item.display_name} · {roleLabels[item.role as Role] ?? "Сотрудник"} ·{" "}
                  {item.is_on_shift ? "в смене" : "не в смене"}
                </p>
              ))
            ) : (
              <p>Нет доступа к списку сотрудников.</p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
