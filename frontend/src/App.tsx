import { t, getLocale, useLanguage, message } from "./lib/i18n";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { navigation, permittedView, canViewWorkload, type View } from "./lib/roleAccess";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError, clearMutationKeys } from "./api";
import { Login } from "./features/Login";
import { OrderDetailDialog, type ActionOutcome } from "./features/OrderDetail";
import { NotificationButton, NotificationsDialog } from "./features/Notifications";
import { DeviceSetup } from "./features/DeviceSetup";
import { RealtimeConnection } from "./lib/realtime";
import { OrdersView, ReferenceView, WorkloadView } from "./features/Workspace";
import { EmployeesView } from "./features/Employees";
import { AnalyticsView } from "./features/Analytics";
import {
  clearActor,
  enqueue,
  getSnapshot,
  listPending,
  removePending,
  saveSnapshot,
  syncPending,
  retryPending,
} from "./lib/offline";
import type {
  ActionRequest,
  Catalog,
  Employee,
  EventItem,
  MasterOption,
  OrderPage,
  User,
  Workload,
} from "./types";
import "./styles.css";
import { useAppLocation, readRoute, navigate, directoryUrl, closeOrderPage } from "./lib/navigation";

import { readOrderFilters, orderFiltersUrl, orderFilterKey, type OrderFilters } from "./lib/orderFilters";

type Dashboard = {
  orderFilterKey?: string;
  catalog: Catalog;
  orders: OrderPage;
  workload: Workload[];
  employees: Employee[];
  masters: MasterOption[];
};
const tokenKey = "naryadai.session.token";
const expiryKey = "naryadai.session.expires";
const userKey = "naryadai.session.user";
const actionLabels: Record<string, string> = {
  get accept() {
    return t("Принятие");
  },
  get queue() {
    return t("Постановка в очередь");
  },
  get reject() {
    return t("Отказ");
  },
  get start() {
    return t("Начало работы");
  },
  get pause() {
    return t("Пауза");
  },
  get resume() {
    return t("Возобновление");
  },
  get complete() {
    return t("Сдача работы");
  },
};
const navIcons: Record<View, string> = {
  orders: "▦",
  workload: "◒",
  reference: "⌘",
  analytics: "↗",
  employees: "◎",
};
function storedUser(): User | null {
  try {
    const raw = sessionStorage.getItem(userKey);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}
function storedToken() {
  const token = sessionStorage.getItem(tokenKey);
  const expiry = sessionStorage.getItem(expiryKey);
  return token && expiry && Date.parse(expiry) > Date.now() ? token : null;
}

export default function App() {
  useLanguage();
  const initialToken = storedToken();
  const expiredActor = useRef<string | null>(initialToken ? null : (storedUser()?.id ?? null));
  const [token, setToken] = useState<string | null>(initialToken);
  const actorIdRef = useRef<string | null>(initialToken ? (storedUser()?.id ?? null) : null);
  const invalidateRef = useRef<(() => Promise<void>) | null>(null);
  const api = useMemo(
    () =>
      new Api(
        () => token,
        (invalidToken) => {
          if (sessionStorage.getItem(tokenKey) === invalidToken) return invalidateRef.current?.();
        },
      ),
    [token],
  );
  const [user, setUser] = useState<User | null>(() => (initialToken ? storedUser() : null));
  const [data, setData] = useState<Dashboard | null>(null);
  const appLocation = useAppLocation();
  const route = readRoute(appLocation);
  const view = route.view;
  const selected = route.orderId;
  const setView = (next: View) => navigate("/" + next);
  const setSelected = (id: string | null) => (id ? navigate("/orders/" + id) : closeOrderPage());
  useEffect(() => {
    if (!user) return;
    const current = readRoute(appLocation);
    if (user.role === "admin" && current.view === "reference" && current.section === "employees") {
      navigate("/employees", true);
      return;
    }
    const allowed = permittedView(user.role, current.view);
    if (allowed !== current.view) {
      navigate("/" + allowed, true);
      return;
    }
    const path = current.section
      ? "/reference/" + current.section
      : current.orderId
        ? "/orders/" + current.orderId
        : "/" + allowed;
    const query = appLocation.includes("?") ? appLocation.slice(appLocation.indexOf("?")) : "";
    navigate(path + query, true);
  }, [appLocation, user]);
  const [loading, setLoading] = useState(Boolean(token));
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Awaited<ReturnType<typeof listPending>>>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<"offline" | "connecting" | "live" | "reconnecting">("offline");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [liveRevision, setLiveRevision] = useState(0);
  const pushSubscriptionId = useRef<string | null>(null);
  const filters = useMemo(() => readOrderFilters(appLocation, user), [appLocation, user]);
  const authGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const loadOrderDetail = useCallback(
    async (id: string) => {
      const detail = await api.order(id);
      const events: EventItem[] = [];
      let after = 0;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await api.events(id, after);
        events.push(...page.items);
        if (page.next_after === null) return { detail, events };
        after = page.next_after;
      }
      throw new ApiError(413, "history_limit_exceeded");
    },
    [api],
  );
  const sender = useCallback(
    (entry: { orderId: string; request: ActionRequest; id: string }) =>
      api.action(entry.orderId, entry.request, entry.id),
    [api],
  );
  const invalidate = useCallback(
    async (actorId?: string) => {
      authGeneration.current += 1;
      const actor = actorId ?? actorIdRef.current ?? user?.id ?? storedUser()?.id;
      sessionStorage.removeItem(tokenKey);
      sessionStorage.removeItem(expiryKey);
      sessionStorage.removeItem(userKey);
      clearMutationKeys();
      setToken(null);
      actorIdRef.current = null;
      setUser(null);
      setData(null);
      setPending([]);
      setSavedAt(null);
      navigate("/", true);
      if (actor) await clearActor(actor).catch(() => undefined);
    },
    [user?.id],
  );
  useEffect(() => {
    if (!token && expiredActor.current) {
      const actor = expiredActor.current;
      expiredActor.current = null;
      sessionStorage.removeItem(tokenKey);
      sessionStorage.removeItem(expiryKey);
      sessionStorage.removeItem(userKey);
      clearMutationKeys();
      void clearActor(actor);
    }
  }, [token]);
  invalidateRef.current = () => invalidate();
  useEffect(() => {
    if (!token) return;
    const delay = Date.parse(sessionStorage.getItem(expiryKey) ?? "") - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) {
      void invalidate();
      return;
    }
    const timeout = window.setTimeout(() => void invalidate(), delay);
    return () => window.clearTimeout(timeout);
  }, [token, invalidate]);
  const sync = useCallback(
    async (actorId: string) => {
      const report = await syncPending(actorId, sender);
      if (report.unauthorized) {
        await invalidate(actorId);
        return report;
      }
      setPending(await listPending(actorId));
      if (report.sent) {
        setNotice(t("Подтверждено сервером: {0}.", [report.sent]));
      }
      if (report.blocked) setError(t("Некоторые отложенные действия требуют ручного решения."));
      return report;
    },
    [invalidate, sender],
  );
  const refresh = useCallback(
    async (knownUser?: User, requestedFilters?: OrderFilters) => {
      const actor = knownUser ?? user;
      if (!actor) return;
      const currentFilters = requestedFilters ?? readOrderFilters(appLocation, actor);
      const currentFilterKey = orderFilterKey(currentFilters, actor);
      const guard = authGeneration.current;
      const request = ++refreshGeneration.current;
      setLoading(true);
      setError("");
      try {
        const [catalog, orders, workload, employees, masters] = await Promise.all([
          api.catalog(),
          actor.role === "admin"
            ? Promise.resolve({
                items: [],
                total: 0,
                counts: {} as OrderPage["counts"],
                offset: 0,
                limit: 50,
              })
            : api.orders({
                status: currentFilters.status,
                priority: currentFilters.priority || undefined,
                overdue: currentFilters.overdue || undefined,
                area_id: currentFilters.area_id || undefined,
                equipment_id: currentFilters.equipment_id || undefined,
                executor_id: actor.role === "executor" ? actor.id : currentFilters.executor_id || undefined,
                master_id:
                  ["master", "manager"].includes(actor.role) && currentFilters.master_id !== "all"
                    ? currentFilters.master_id || undefined
                    : undefined,
                q: currentFilters.query || undefined,
                attention: currentFilters.attention || undefined,
                offset: currentFilters.offset,
                limit: 50,
              }),
          canViewWorkload(actor.role) ? api.workload() : Promise.resolve([]),
          actor.role === "master" ? api.employees() : Promise.resolve([]),
          ["master", "manager"].includes(actor.role) ? api.masters() : Promise.resolve([]),
        ]);
        if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
        const dashboard = { catalog, orders, workload, employees, masters, orderFilterKey: currentFilterKey };
        setData(dashboard);
        setSavedAt(null);
        setNotice((current) =>
          current.startsWith(t("Показан сохранённый снимок")) ||
          current.startsWith(t("Для выбранных фильтров"))
            ? ""
            : current,
        );
        if (actor.role !== "admin")
          await saveSnapshot(actor.id, "dashboard", dashboard).catch(() => undefined);
        if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
        setPending(await listPending(actor.id));
      } catch (caught) {
        if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
        const failure = caught as ApiError;
        if (failure.status === 401) {
          await invalidate(actor.id);
          return;
        }
        const cached =
          actor.role === "admin" || (failure.status > 0 && failure.status < 500)
            ? null
            : await getSnapshot<Dashboard>(actor.id, "dashboard").catch(() => null);
        if (cached) {
          if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
          setData(
            cached.data.orderFilterKey !== currentFilterKey
              ? {
                  ...cached.data,
                  orderFilterKey: currentFilterKey,
                  orders: { items: [], total: 0, counts: {} as OrderPage["counts"], offset: 0, limit: 50 },
                }
              : cached.data,
          );
          setPending(await listPending(actor.id));
          setSavedAt(cached.savedAt);
          setNotice(
            cached.data.orderFilterKey === currentFilterKey
              ? t("Показан сохранённый снимок. Новые данные появятся после восстановления связи.")
              : t(
                  "Для выбранных фильтров нет сохранённых нарядов. Подключитесь к сети, чтобы загрузить список.",
                ),
          );
        } else {
          setData(null);
          setError(t("Не удалось получить данные. Проверьте соединение и выбранные фильтры."));
        }
      } finally {
        if (guard === authGeneration.current && request === refreshGeneration.current) setLoading(false);
      }
    },
    [api, appLocation, invalidate, user],
  );
  const refreshRef = useRef(refresh);
  const syncRef = useRef(sync);
  useEffect(() => {
    refreshRef.current = refresh;
    syncRef.current = sync;
  }, [refresh, sync]);
  useEffect(() => {
    if (!token) return;
    let live = true;
    const run = async () => {
      try {
        const next = await api.me();
        if (!live) return;
        actorIdRef.current = next.id;
        sessionStorage.setItem(userKey, JSON.stringify(next));
        setUser(next);
        await refreshRef.current(next);
        if (!live || sessionStorage.getItem(tokenKey) !== token) return;
        const report = await syncRef.current(next.id);
        if (live && report.sent && sessionStorage.getItem(tokenKey) === token) {
          await refreshRef.current(next);
        }
      } catch (caught) {
        if (live && (caught as ApiError).status === 401) await invalidate();
        else if (live) {
          const remembered = storedUser();
          if (remembered) {
            actorIdRef.current = remembered.id;
            setUser(remembered);
            await refreshRef.current(remembered);
          } else setError(t("Сервер недоступен. Войдите снова после восстановления связи."));
        }
      }
    };
    void run();
    return () => {
      live = false;
    };
  }, [api, invalidate, token]);
  useEffect(() => {
    if (!user) return;
    const retry = () => {
      void sync(user.id).then(() => refresh());
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [refresh, sync, user]);
  useEffect(() => {
    if (!user || user.role === "admin" || !("serviceWorker" in navigator)) return;
    let active = true;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => subscription && api.subscribePush(subscription.toJSON()))
      .then((result) => {
        if (active && result) pushSubscriptionId.current = result.id;
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, user]);
  useEffect(() => {
    if (!user || user.role === "admin") return;
    let active = true;
    const updateCount = () =>
      void api
        .notifications(0, true)
        .then((page) => {
          if (active) setUnreadCount(page.unread_count);
        })
        .catch(() => undefined);
    updateCount();
    let latestRevision = 0;
    const connection = new RealtimeConnection({
      token: token!,
      onState: setLiveState,
      onUnauthorized: () => void invalidate(user.id),
      onRefresh: (revision) => {
        if (revision < latestRevision) return;
        latestRevision = revision;
        setLiveRevision(revision);
        void refreshRef.current(user);
        updateCount();
      },
    });
    connection.start();
    return () => {
      active = false;
      connection.stop();
    };
  }, [api, invalidate, token, user]);
  useEffect(() => {
    if (!user || user.role === "admin") return;
    const id = new URLSearchParams(location.search).get("notification");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    let active = true;
    void api
      .notification(id)
      .then((item) => {
        if (!active) return;
        navigate(item.order_id ? "/orders/" + item.order_id : "/orders", true);
        setInboxOpen(false);
        navigate(location.pathname, true);
        void api.markNotificationRead(id).catch(() => undefined);
      })
      .catch(() => {
        if (!active) return;
        setInboxOpen(true);
        setNotice(t("Уведомление больше недоступно. Открыт ваш журнал."));
        navigate(location.pathname, true);
      });
    return () => {
      active = false;
    };
  }, [api, user]);
  const changeFilters = (next: OrderFilters) => navigate(orderFiltersUrl(next), true);
  const loadedOrderRoute = useRef("");
  useEffect(() => {
    if (!user || route.view !== "orders" || route.orderId) {
      loadedOrderRoute.current = "";
      return;
    }
    const key = user.id + ":" + appLocation;
    if (loadedOrderRoute.current === key) return;
    loadedOrderRoute.current = key;
    void refreshRef.current(user);
  }, [appLocation, route.orderId, route.view, user]);
  const openEmployeeOrders = (employeeId: string) => {
    if (!user || !["master", "manager"].includes(user.role)) return;
    navigate(
      orderFiltersUrl({
        ...readOrderFilters("/orders", user),
        executor_id: employeeId,
        master_id: "all",
      }),
    );
  };
  async function login(login: string, secret: string) {
    const response = await api.login(login, secret);
    authGeneration.current += 1;
    sessionStorage.setItem(tokenKey, response.access_token);
    sessionStorage.setItem(expiryKey, response.expires_at);
    setToken(response.access_token);
  }
  async function directAction(id: string, request: ActionRequest, canQueue = false): Promise<ActionOutcome> {
    if (!user) throw new ApiError(401, "unauthorized");
    if (user.role === "executor" && canQueue) {
      const entry = await enqueue({ actorId: user.id, orderId: id, request });
      setPending(await listPending(user.id));
      const report = await sync(user.id);
      if (report.unauthorized) throw new ApiError(401, "unauthorized");
      const remaining = (await listPending(user.id)).find((item) => item.id === entry.id);
      if (report.offline || report.remaining) setNotice(t("Действие ожидает подтверждения сервером."));
      await refresh();
      return remaining
        ? {
            state: remaining.state === "blocked" ? "blocked" : "pending",
            message:
              remaining.error ??
              t(
                "Действие сохранено на устройстве. Отправим его при восстановлении связи; статус ещё не изменён.",
              ),
          }
        : { state: "confirmed" };
    }
    await api.action(id, request);
    await refresh();
    return { state: "confirmed" };
  }
  async function signOut() {
    const actor = user;
    if (!actor) return;
    const subscriptionId = pushSubscriptionId.current;
    pushSubscriptionId.current = null;
    try {
      if (subscriptionId) await api.removePushSubscription(subscriptionId);
    } catch {
      // Session revocation below also prevents delivery if device removal fails.
    }
    // Browser subscription may be reused after login; delivery always requires a live session.
    try {
      await api.logout();
    } finally {
      await invalidate(actor.id);
    }
  }
  async function retry(id: string) {
    if (!user) return;
    const report = await retryPending(user.id, id, sender);
    if (report.unauthorized) await invalidate(user.id);
    setPending(await listPending(user.id));
    if (report.sent) await refresh();
  }
  if (!token) return <Login onLogin={login} />;
  if (!user)
    return (
      <main className="splash">
        <span className="spinner"></span>
        <p>{t("Проверяем сессию…")}</p>
        {error && <p className="error">{error}</p>}
      </main>
    );
  const currentNav = navigation[user.role];
  const visibleView = permittedView(user.role, view);
  const activeOrders = data?.orderFilterKey === orderFilterKey(filters, user) ? data.orders : null;
  return (
    <div className="app-shell">
      <aside className="side-nav">
        <div className="brand">
          <div className="brand-mark">
            {t("Т")}
            <span>•</span>
          </div>
          <strong>
            {t("Тех")}
            <span>{t("Наряд")}</span>
          </strong>
        </div>
        <p className="nav-caption">{t("РАБОЧИЙ КОНТУР")}</p>
        <nav aria-label={t("Основная навигация")}>
          {currentNav.map(([key, label]) => (
            <button key={key} className={visibleView === key ? "active" : ""} onClick={() => setView(key)}>
              <span className="nav-icon" aria-hidden="true">
                {navIcons[key]}
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="user-card">
          <LanguageSwitcher />
          <strong>{user.display_name}</strong>
          <small>
            {user.role === "master"
              ? t("Мастер")
              : user.role === "executor"
                ? t("Исполнитель")
                : user.role === "manager"
                  ? t("Руководитель")
                  : t("Администратор")}
          </small>
          <button onClick={() => void signOut()}>{t("Выйти")}</button>
        </div>
      </aside>
      <header className="mobile-header">
        <div className="mobile-brand">
          <span>
            {t("Т")}
            <span>•</span>
          </span>
          <strong>{t("ТехНаряд")}</strong>
        </div>
        <div>
          <small>
            {user.display_name} · {user.role === "executor" ? t("смена") : t("контур")}
          </small>
          <button aria-label={t("Выйти из учётной записи")} onClick={() => void signOut()}>
            {t("Выйти")}
          </button>
        </div>
      </header>{" "}
      <main className="app-main">
        <div className="mobile-language">
          <LanguageSwitcher />
        </div>
        {history.state?.technaryad && history.state?.parent && (
          <nav className="page-navigation" aria-label={t("Навигация страницы")}>
            <button type="button" className="text-button" onClick={() => history.back()}>
              {t("← Назад")}
            </button>
          </nav>
        )}
        {user.role !== "admin" && (
          <div className="live-bar" data-live-state={liveState}>
            {liveState !== "live" && (
              <span className="connection-state" role="status">
                <span className={`live-dot ${liveState}`}></span>
                {liveState === "reconnecting"
                  ? t("Переподключение…")
                  : liveState === "connecting"
                    ? t("Подключение…")
                    : t("Нет соединения")}
              </span>
            )}
            <NotificationButton count={unreadCount} onOpen={() => setInboxOpen(true)} />
          </div>
        )}
        {user.role !== "admin" && <DeviceSetup />}
        {(notice || savedAt || error) && (
          <div className={error ? "banner error-banner" : "banner"} role={error ? "alert" : "status"}>
            {message(error || notice)}
            {savedAt &&
              t(" · сохранено {0}", [
                new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(
                  new Date(savedAt),
                ),
              ])}
            {(notice || error) && (
              <button
                aria-label={t("Закрыть сообщение")}
                onClick={() => {
                  setNotice("");
                  setError("");
                }}
              >
                ×
              </button>
            )}
          </div>
        )}
        {pending.length > 0 && (
          <section className="pending-panel">
            <div>
              <strong>
                {t("Ожидают отправки:")} {pending.length}
              </strong>
              <p>{t("Действия сохранены на устройстве и ожидают отправки.")}</p>
            </div>
            <div>
              {pending.map((entry) => (
                <div key={entry.id} className="pending-item">
                  <span>
                    {actionLabels[entry.request.action] || t("Действие")} ·{" "}
                    {data?.orders.items.find((order) => order.id === entry.orderId)?.number || t("наряд")}
                  </span>
                  <small>{message(entry.error || "") || t("Ожидает подтверждения")}</small>
                  <button
                    className="secondary"
                    onClick={() => void retry(entry.id)}
                    disabled={entry.state === "blocked"}
                  >
                    {t("Повторить")}
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      void (async () => {
                        await removePending(user.id, entry.id);
                        setPending(await listPending(user.id));
                      })()
                    }
                  >
                    {t("Удалить")}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        {visibleView === "orders" && (
          <OrdersView
            role={user.role}
            page={activeOrders}
            catalog={data?.catalog ?? null}
            workload={data?.workload ?? []}
            masters={data?.masters ?? []}
            currentUserId={user.id}
            filters={filters}
            onFilters={changeFilters}
            onOpen={setSelected}
            onCreate={async (input) => {
              await api.create(input);
              await refresh();
            }}
            onSuggest={(input) => api.suggestions(input)}
            onHistory={async (equipmentId) => {
              const page = await api.equipmentHistory(equipmentId);
              setData((current) => (current ? { ...current, orders: page } : current));
              setView("orders");
            }}
            loading={loading}
          />
        )}{" "}
        {visibleView === "workload" && (
          <WorkloadView
            workers={data?.workload ?? []}
            onOpen={setSelected}
            onEmployeeOrders={openEmployeeOrders}
          />
        )}{" "}
        {visibleView === "analytics" && <AnalyticsView api={api} role={user.role} revision={liveRevision} />}{" "}
        {visibleView === "employees" &&
          user.role === "admin" &&
          (data?.catalog ? (
            <EmployeesView
              api={api}
              catalog={data.catalog}
              currentUserId={user.id}
              onSelfPasswordChanged={() => void invalidate(user.id)}
            />
          ) : (
            <p>{t("Загрузка данных сотрудников…")}</p>
          ))}
        {visibleView === "reference" && (
          <ReferenceView
            role={user.role}
            catalog={data?.catalog ?? null}
            employees={data?.employees ?? []}
            api={api}
            onCatalogChange={refresh}
            onEmployees={() => setView("employees")}
            onEmployeeOrders={openEmployeeOrders}
            section={route.section}
            onSectionChange={(section) => navigate(directoryUrl(section))}
            directoryFilters={route.directoryFilters}
            onDirectoryFiltersChange={(filters) => navigate(directoryUrl(route.section, filters), true)}
          />
        )}
      </main>
      <nav
        className="bottom-nav"
        aria-label={t("Мобильная навигация")}
        style={{ gridTemplateColumns: "repeat(" + currentNav.length + ", 1fr)" }}
      >
        {currentNav.map(([key, label]) => (
          <button key={key} className={visibleView === key ? "active" : ""} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </nav>
      {inboxOpen && user.role !== "admin" && (
        <NotificationsDialog
          api={api}
          onClose={() => setInboxOpen(false)}
          onOrder={(id) => {
            setInboxOpen(false);
            setSelected(id);
          }}
          onPushBound={(id) => {
            pushSubscriptionId.current = id;
          }}
          revision={liveRevision}
        />
      )}
      {selected && data && user.role !== "admin" && (
        <OrderDetailDialog
          key={selected}
          id={selected}
          role={user.role}
          currentUserId={user.id}
          catalog={data.catalog}
          workers={data.workload}
          load={loadOrderDetail}
          revision={liveRevision}
          onAction={directAction}
          photoUrl={(path) => api.photoBlob(path)}
          onReport={(id) => api.orderReport(id)}
          onDowntime={(id, input) => api.downtime(id, input)}
          onAssessRefusal={(id, eventId, input) => api.assessRefusal(id, eventId, input)}
          onPhoto={async (id, kind, version, file, aiShareAllowed, capturedAt) => {
            await api.photo(id, kind, version, file, aiShareAllowed, undefined, capturedAt);
            await refresh();
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
