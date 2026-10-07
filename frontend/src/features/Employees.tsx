import { FormEvent, useEffect, useMemo, useState } from "react";
import { Api, ApiError } from "../api";
import { Dialog } from "../components/Dialog";
import { roleLabels } from "../lib/roleAccess";
import type { AdminEmployee, Catalog, CreateEmployee, Employee, EmployeeAccessUpdate, Role } from "../types";
import "./employees.css";

const roles: Role[] = ["executor", "master", "manager", "admin"];
const blankCreate = (): CreateEmployee => ({
  login: "",
  display_name: "",
  role: "executor",
  specialty: "",
  grade: 1,
  brigade_id: null,
  area_ids: [],
  secret: "",
});
const failure = (error: unknown, action: string) => {
  if (!(error instanceof ApiError)) return "Не удалось " + action + ". Проверьте соединение и повторите.";
  if (error.status === 409 && error.detail === "self_access_change_forbidden")
    return "Нельзя изменить собственную роль или статус. Это ограничение защищает доступ администратора.";
  if (error.status === 409 && error.detail === "duplicate_or_invalid_reference")
    return "Логин уже используется или выбранная бригада либо участок изменились. Обновите список и повторите.";
  if (error.status === 409 && error.detail === "worker_has_active_order")
    return "Нельзя изменить доступ: у сотрудника есть незавершённый наряд. Завершите или отмените его сначала.";
  if (error.status === 409) return "Данные сотрудника изменились. Обновите список и повторите действие.";
  if (error.status === 422) return "Проверьте поля: логин, пароль и доступы должны соответствовать правилам.";
  return "Не удалось " + action + ". Повторите попытку.";
};
const specialties = (catalog: Catalog) =>
  Array.from(new Set(catalog.fault_codes.map((code) => code.specialty).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "ru"),
  );

export function EmployeesView({
  api,
  catalog,
  currentUserId,
  onSelfPasswordChanged,
}: {
  api: Api;
  catalog: Catalog;
  currentUserId: string;
  onSelfPasswordChanged?: () => void;
}) {
  const [items, setItems] = useState<Employee[] | null>(null);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<AdminEmployee | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<AdminEmployee | null>(null);
  const [statusTarget, setStatusTarget] = useState<AdminEmployee | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setItems(await api.employees());
      setError("");
    } catch (caught) {
      setError(failure(caught, "получить список сотрудников"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
    // Employee data and access changes are intentionally memory-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ru-RU");
    return (items ?? []).filter((employee) => {
      const matchesSearch =
        !needle ||
        [employee.display_name, employee.login, employee.specialty].some((value) =>
          value.toLocaleLowerCase("ru-RU").includes(needle),
        );
      return (
        matchesSearch &&
        (!role || employee.role === role) &&
        (status === "all" || (status === "active" ? employee.is_active : !employee.is_active))
      );
    });
  }, [items, role, search, status]);

  const openAccess = async (employee: Employee) => {
    setError("");
    try {
      setSelected(await api.employee(employee.id));
    } catch (caught) {
      setError(failure(caught, "открыть параметры доступа"));
    }
  };

  return (
    <section className="workspace employees" aria-busy={loading}>
      <div className="page-head employees-head">
        <div>
          <p className="eyebrow">АДМИНИСТРИРОВАНИЕ</p>
          <h1>Сотрудники и доступ</h1>
          <p className="muted">
            Добавьте сотрудника или откройте его запись, чтобы настроить права и пароль.
          </p>
        </div>
        <button className="primary" type="button" onClick={() => setCreateOpen(true)}>
          Добавить сотрудника
        </button>
      </div>
      <section className="employee-filters" aria-label="Фильтры сотрудников">
        <label className="employee-search">
          Поиск
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Имя, логин или специальность"
          />
        </label>
        <button
          type="button"
          className="secondary employee-filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls="employee-filter-options"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          Фильтры{role || status !== "all" ? ` · ${Number(Boolean(role)) + Number(status !== "all")}` : ""}
        </button>
        <div
          id="employee-filter-options"
          className={`employee-filter-options ${filtersOpen ? "is-open" : ""}`}
        >
          <label>
            Роль
            <select
              aria-label="Роль"
              value={role}
              onChange={(event) => setRole(event.target.value as Role | "")}
            >
              <option value="">Все роли</option>
              {roles.map((value) => (
                <option value={value} key={value}>
                  {roleLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Статус
            <select
              aria-label="Статус"
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="all">Все статусы</option>
              <option value="active">Доступ активен</option>
              <option value="inactive">Доступ отключён</option>
            </select>
          </label>
        </div>
        <button className="secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Обновляем…" : "Обновить"}
        </button>
      </section>
      {notice && (
        <p className="employee-feedback" role="status">
          {notice}
          <button
            type="button"
            className="text-button"
            aria-label="Закрыть подтверждение"
            onClick={() => setNotice("")}
          >
            ×
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loading && items && (
        <p className="employees-count">
          <span>
            Найдено: <strong>{visible.length}</strong> из {items.length}
          </span>
          {(search || role || status !== "all") && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setSearch("");
                setRole("");
                setStatus("all");
              }}
            >
              Сбросить поиск и фильтры
            </button>
          )}
        </p>
      )}
      {loading && !items ? (
        <div className="empty">
          <span className="spinner" />
          <p>Загружаем сотрудников…</p>
        </div>
      ) : visible.length ? (
        <div className="employee-list" aria-label="Список сотрудников">
          {visible.map((employee) => (
            <article
              className={"employee-row " + (!employee.is_active ? "is-inactive" : "")}
              key={employee.id}
            >
              <div className="employee-name">
                <strong>{employee.display_name}</strong>
                <span>{employee.login}</span>
              </div>
              <div className="employee-meta">
                <span>{roleLabels[employee.role]}</span>
                <span>{employee.specialty || "Специальность не указана"}</span>
                <span>{employee.grade ? employee.grade + " разряд" : "Разряд не указан"}</span>
              </div>
              <div className="employee-state">
                <span className={"access-status " + (employee.is_active ? "active" : "inactive")}>
                  {employee.is_active ? "Доступ активен" : "Доступ отключён"}
                </span>
                {employee.id === currentUserId && <small>Это ваша учётная запись</small>}
              </div>
              <button className="secondary" type="button" onClick={() => void openAccess(employee)}>
                Настроить
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <h2>Сотрудники не найдены</h2>
          <p>Измените строку поиска или фильтры.</p>
        </div>
      )}
      {createOpen && (
        <CreateDialog
          api={api}
          catalog={catalog}
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            setNotice("Сотрудник создан. Передайте ему логин и пароль для входа.");
            setSearch("");
            setRole("");
            setStatus("all");
            await refresh();
          }}
        />
      )}
      {selected && (
        <AccessDialog
          api={api}
          catalog={catalog}
          employee={selected}
          currentUserId={currentUserId}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null);
            setNotice("Права доступа сохранены. Сотруднику нужно войти заново.");
            await refresh();
          }}
          onPassword={() => {
            setPasswordTarget(selected);
            setSelected(null);
          }}
          onStatus={() => {
            setStatusTarget(selected);
            setSelected(null);
          }}
        />
      )}
      {passwordTarget && (
        <PasswordDialog
          api={api}
          employee={passwordTarget}
          onClose={() => setPasswordTarget(null)}
          onSaved={async () => {
            const own = passwordTarget.id === currentUserId;
            setPasswordTarget(null);
            setNotice("Пароль изменён. Старый пароль больше не действует.");
            if (own) {
              onSelfPasswordChanged?.();
              return;
            }
            await refresh();
          }}
        />
      )}
      {statusTarget && (
        <StatusDialog
          api={api}
          employee={statusTarget}
          onClose={() => setStatusTarget(null)}
          onSaved={async () => {
            setStatusTarget(null);
            setNotice(
              statusTarget.is_active
                ? "Доступ отключён. История работы сохранена."
                : "Доступ восстановлен. Сотрудник может войти в систему.",
            );
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function AreaFields({
  catalog,
  value,
  onChange,
}: {
  catalog: Catalog;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="employee-areas">
      <legend>Участки допуска</legend>
      <p className="muted">Сотрудник видит и обрабатывает данные только этих участков.</p>
      <div>
        {catalog.areas.map((area) => (
          <label key={area.id}>
            <input
              type="checkbox"
              checked={value.includes(area.id)}
              onChange={(event) =>
                onChange(event.target.checked ? [...value, area.id] : value.filter((id) => id !== area.id))
              }
            />
            <span>
              {area.code} · {area.name}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CreateDialog({
  api,
  catalog,
  onClose,
  onSaved,
}: {
  api: Api;
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [input, setInput] = useState<CreateEmployee>(blankCreate);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (input.role !== "admin" && input.area_ids.length === 0) {
      setError("Выберите хотя бы один участок, иначе сотрудник не увидит доступные ему данные.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.createEmployee(input);
      setInput((current) => ({ ...current, secret: "" }));
      await onSaved();
    } catch (caught) {
      setError(failure(caught, "создать сотрудника"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Новый сотрудник" onClose={busy ? () => undefined : onClose}>
      <form className="dialog-form employee-form" onSubmit={(event) => void submit(event)}>
        <p className="muted">
          Сначала укажите сотрудника и его работу, затем выберите участки и задайте пароль.
        </p>
        <p className="muted" id="employee-login-hint">
          Логин: от 3 до 64 символов — строчные латинские буквы, цифры, точка, дефис или подчёркивание.
          Пароль: от 8 символов.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="employee-form-grid">
          <label>
            Логин
            <input
              value={input.login}
              onChange={(event) => setInput({ ...input, login: event.target.value })}
              autoComplete="off"
              aria-label="Логин"
              aria-describedby="employee-login-hint"
              pattern={"[a-z0-9][a-z0-9._\\-]{2,63}"}
              maxLength={64}
              required
            />
          </label>
          <label>
            ФИО сотрудника
            <input
              value={input.display_name}
              onChange={(event) => setInput({ ...input, display_name: event.target.value })}
              maxLength={160}
              required
            />
          </label>
          <label>
            Роль
            <select
              aria-label="Роль"
              value={input.role}
              onChange={(event) => setInput({ ...input, role: event.target.value as Role })}
            >
              {roles.map((value) => (
                <option key={value} value={value}>
                  {roleLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Специальность
            <select
              aria-label="Специальность"
              value={input.specialty}
              onChange={(event) => setInput({ ...input, specialty: event.target.value })}
              required
            >
              <option value="">Выберите специальность</option>
              {specialties(catalog).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Разряд
            <input
              type="number"
              min="1"
              max="6"
              value={input.grade}
              onChange={(event) => setInput({ ...input, grade: Number(event.target.value) })}
              required
            />
          </label>
          <label>
            Бригада
            <select
              aria-label="Бригада"
              value={input.brigade_id ?? ""}
              onChange={(event) => setInput({ ...input, brigade_id: event.target.value || null })}
            >
              <option value="">Не назначена</option>
              {catalog.brigades.map((brigade) => (
                <option key={brigade.id} value={brigade.id}>
                  {brigade.code} · {brigade.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {input.role === "admin" ? (
          <p className="notice">
            Администратор работает со всеми справочниками; участки не ограничивают его доступ.
          </p>
        ) : (
          <AreaFields
            catalog={catalog}
            value={input.area_ids}
            onChange={(area_ids) => setInput({ ...input, area_ids })}
          />
        )}
        <label>
          Пароль
          <input
            type="password"
            value={input.secret}
            onChange={(event) => setInput({ ...input, secret: event.target.value })}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <div className="action-row">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Создаём…" : "Создать сотрудника"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AccessDialog({
  api,
  catalog,
  employee,
  currentUserId,
  onClose,
  onSaved,
  onPassword,
  onStatus,
}: {
  api: Api;
  catalog: Catalog;
  employee: AdminEmployee;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onPassword: () => void;
  onStatus: () => void;
}) {
  const self = employee.id === currentUserId;
  const [role, setRole] = useState<Role>(employee.role);
  const [areaIds, setAreaIds] = useState(employee.area_ids);
  const changed =
    role !== employee.role || [...areaIds].sort().join(",") !== [...employee.area_ids].sort().join(",");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const summary = employee.area_ids.length
    ? employee.area_ids
        .map((id) => catalog.areas.find((area) => area.id === id)?.code ?? "Неизвестный участок")
        .join(", ")
    : "Участки не назначены";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (role !== "admin" && areaIds.length === 0) {
      setError("Выберите хотя бы один участок, иначе сотрудник не увидит доступные ему данные.");
      return;
    }
    const input: EmployeeAccessUpdate = { role: self ? undefined : role, area_ids: areaIds };
    setBusy(true);
    setError("");
    try {
      await api.updateEmployeeAccess(employee.id, input);
      await onSaved();
    } catch (caught) {
      setError(failure(caught, "сохранить доступ"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Доступ сотрудника" onClose={busy ? () => undefined : onClose}>
      <form className="dialog-form employee-form" onSubmit={(event) => void submit(event)}>
        <div className="employee-dialog-summary">
          <strong>{employee.display_name}</strong>
          <span>
            {employee.login} · {summary}
          </span>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {self && (
          <p className="notice">
            Для собственной учётной записи нельзя менять роль и статус. Это защищает доступ администратора.
          </p>
        )}
        <p className="notice">Изменение роли или участков завершит активные сеансы сотрудника.</p>
        <label>
          Роль
          <select
            aria-label="Роль"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={self}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {roleLabels[value]}
              </option>
            ))}
          </select>
        </label>
        {role === "admin" ? (
          <p className="notice">
            Администратор работает со всеми справочниками; участки не ограничивают его доступ.
          </p>
        ) : (
          <AreaFields catalog={catalog} value={areaIds} onChange={setAreaIds} />
        )}
        <section className="employee-password-action" aria-label="Пароль сотрудника">
          <div>
            <strong>Пароль сотрудника</strong>
            <p>Задайте новый пароль, если сотрудник потерял доступ.</p>
          </div>
          <button className="secondary" type="button" onClick={onPassword} disabled={busy}>
            Сбросить пароль
          </button>
        </section>
        <div className="employee-danger-zone">
          <div>
            <strong>{employee.is_active ? "Доступ включён" : "Доступ отключён"}</strong>
            <p>При изменении статуса все активные сеансы сотрудника будут завершены.</p>
          </div>
          <button
            className={employee.is_active ? "danger-button" : "secondary"}
            type="button"
            onClick={onStatus}
            disabled={self || busy}
          >
            {employee.is_active ? "Отключить доступ" : "Включить доступ"}
          </button>
        </div>
        <div className="action-row">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="primary" disabled={busy || !changed}>
            {busy ? "Сохраняем…" : "Сохранить доступ"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordDialog({
  api,
  employee,
  onClose,
  onSaved,
}: {
  api: Api;
  employee: AdminEmployee;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (secret !== confirmation) {
      setError("Пароли не совпадают. Проверьте оба поля.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.updateEmployeeAccess(employee.id, { secret });
      setSecret("");
      await onSaved();
    } catch (caught) {
      setError(failure(caught, "сбросить пароль"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Сброс пароля" onClose={busy ? () => undefined : onClose}>
      <form className="dialog-form employee-form" onSubmit={(event) => void submit(event)}>
        <p>
          Новый пароль для <strong>{employee.display_name}</strong>. После сохранения все активные сеансы
          будут завершены.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <label className="password-field">
          Новый пароль
          <input
            type={showSecret ? "text" : "password"}
            aria-label="Новый пароль"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowSecret((value) => !value)}
            aria-label={showSecret ? "Скрыть пароль" : "Показать пароль"}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
              {showSecret ? (
                <>
                  <path d="m3 3 18 18" />
                  <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c5.2 0 8.8 4.2 9.7 6.8a1 1 0 0 1 0 .5 11.7 11.7 0 0 1-3.3 4.5M6.2 6.2A11.7 11.7 0 0 0 2.3 11.8a1 1 0 0 0 0 .5C3.2 14.8 6.8 19 12 19c1 0 2-.2 2.9-.6" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </>
              ) : (
                <>
                  <path d="M2.3 12C3.2 9.3 6.8 5 12 5s8.8 4.3 9.7 7c-.9 2.7-4.5 7-9.7 7S3.2 14.7 2.3 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
          </button>
        </label>
        <label>
          Повторите пароль
          <input
            type={showSecret ? "text" : "password"}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <div className="action-row">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить пароль"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function StatusDialog({
  api,
  employee,
  onClose,
  onSaved,
}: {
  api: Api;
  employee: AdminEmployee;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const next = !employee.is_active;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateEmployeeAccess(employee.id, { is_active: next });
      await onSaved();
    } catch (caught) {
      setError(failure(caught, next ? "включить доступ" : "отключить доступ"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={next ? "Включить доступ" : "Отключить доступ"} onClose={busy ? () => undefined : onClose}>
      <div className="dialog-form employee-form">
        <p>
          {next ? "Включить" : "Отключить"} учётную запись <strong>{employee.display_name}</strong>?
        </p>
        <p className={next ? "notice" : "error"}>
          {next
            ? "Сотрудник сможет снова войти в систему."
            : "Все активные сеансы сотрудника будут немедленно завершены."}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className={next ? "primary" : "danger-button"}
            type="button"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "Сохраняем…" : next ? "Включить доступ" : "Подтвердить отключение"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
