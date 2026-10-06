import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError, clearMutationKeys } from "./api";
import { Login } from "./features/Login";
import { OrderDetailDialog } from "./features/OrderDetail";
import { NotificationButton, NotificationsDialog } from "./features/Notifications";
import { RealtimeConnection } from "./lib/realtime";
import { OrdersView, ReferenceView, WorkloadView } from "./features/Workspace";
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
import type { ActionRequest, Catalog, Employee, EventItem, OrderPage, Role, User, Workload } from "./types";
import "./styles.css";

type View = "orders" | "workload" | "reference" | "analytics";
type Dashboard = { catalog: Catalog; orders: OrderPage; workload: Workload[]; employees: Employee[] };
const tokenKey = "naryadai.session.token";
const expiryKey = "naryadai.session.expires";
const userKey = "naryadai.session.user";
const actionLabels: Record<string, string> = {
  accept: "Принятие",
  queue: "Постановка в очередь",
  reject: "Отказ",
  start: "Начало работы",
  pause: "Пауза",
  resume: "Возобновление",
  complete: "Сдача работы",
};
const nav: Record<Role, Array<[View, string]>> = {
  master: [
    ["orders", "Наряды"],
    ["workload", "Загрузка"],
    ["reference", "Контекст"],
    ["analytics", "Отчёт"],
  ],
  executor: [
    ["orders", "Моя работа"],
    ["workload", "Смена"],
    ["reference", "Контекст"],
    ["analytics", "Отчёт"],
  ],
  manager: [
    ["orders", "Наряды"],
    ["workload", "Загрузка"],
    ["reference", "Контекст"],
    ["analytics", "Отчёт"],
  ],
  admin: [["reference", "Справочники"]],
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
  const [view, setView] = useState<View>("orders");
  const [selected, setSelected] = useState<string | null>(null);
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
  const [filters, setFilters] = useState({
    status: [
      "issued",
      "accepted",
      "queued",
      "in_progress",
      "paused",
      "completed",
      "ai_review",
      "rework",
    ] as string[],
    priority: "",
    overdue: false,
    area_id: "",
    equipment_id: "",
    executor_id: "",
    offset: 0,
  });
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
      setSelected(null);
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
        setNotice(`Подтверждено сервером: ${report.sent}.`);
      }
      if (report.blocked) setError("Некоторые отложенные действия требуют ручного решения.");
      return report;
    },
    [invalidate, sender],
  );
  const refresh = useCallback(
    async (knownUser?: User, currentFilters = filters) => {
      const actor = knownUser ?? user;
      if (!actor) return;
      const guard = authGeneration.current;
      const request = ++refreshGeneration.current;
      setLoading(true);
      setError("");
      try {
        const [catalog, orders, workload, employees] = await Promise.all([
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
                offset: currentFilters.offset,
                limit: 50,
              }),
          actor.role === "admin" ? Promise.resolve([]) : api.workload(),
          ["master", "manager", "admin"].includes(actor.role) ? api.employees() : Promise.resolve([]),
        ]);
        if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
        const dashboard = { catalog, orders, workload, employees };
        setData(dashboard);
        setSavedAt(null);
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
        const cached = await getSnapshot<Dashboard>(actor.id, "dashboard").catch(() => null);
        if (cached) {
          if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
          setData(cached.data);
          setPending(await listPending(actor.id));
          setSavedAt(cached.savedAt);
          setNotice("Показан сохранённый снимок. Новые данные появятся после восстановления связи.");
        } else setError("Не удалось получить данные. Проверьте соединение и повторите.");
      } finally {
        if (guard === authGeneration.current && request === refreshGeneration.current) setLoading(false);
      }
    },
    [api, filters, invalidate, user],
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
        setView((current) => (next.role === "admin" ? "reference" : current));
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
          } else setError("Сервер недоступен. Войдите снова после восстановления связи.");
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
        setSelected(item.order_id);
        setInboxOpen(false);
        history.replaceState(null, "", location.pathname);
        void api.markNotificationRead(id).catch(() => undefined);
      })
      .catch(() => {
        if (!active) return;
        setInboxOpen(true);
        setNotice("Уведомление больше недоступно. Открыт ваш журнал.");
        history.replaceState(null, "", location.pathname);
      });
    return () => {
      active = false;
    };
  }, [api, user]);
  const changeFilters = (next: typeof filters) => {
    const normalized = { ...next, offset: next.offset ?? 0 };
    setFilters(normalized);
    if (user) void refresh(user, normalized);
  };
  async function login(login: string, secret: string) {
    const response = await api.login(login, secret);
    authGeneration.current += 1;
    sessionStorage.setItem(tokenKey, response.access_token);
    sessionStorage.setItem(expiryKey, response.expires_at);
    setView("orders");
    setToken(response.access_token);
  }
  async function directAction(id: string, request: ActionRequest, canQueue = false) {
    if (!user) return;
    if (user.role === "executor" && canQueue) {
      await enqueue({ actorId: user.id, orderId: id, request });
      setPending(await listPending(user.id));
      const report = await sync(user.id);
      if (report.offline || report.remaining) setNotice("Действие ожидает подтверждения сервером.");
      await refresh();
      return;
    }
    await api.action(id, request);
    await refresh();
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
        <p>Проверяем сессию…</p>
        {error && <p className="error">{error}</p>}
      </main>
    );
  const currentNav = nav[user.role];
  const activeOrders = data?.orders ?? null;
  return (
    <div className="app-shell">
      <aside className="side-nav">
        <div className="brand">
          <div className="brand-mark">
            N<span>•</span>
          </div>
          <strong>
            НАРЯД<span>AI</span>
          </strong>
        </div>
        <nav aria-label="Основная навигация">
          {currentNav.map(([key, label]) => (
            <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="user-card">
          <strong>{user.display_name}</strong>
          <small>
            {user.role === "master"
              ? "Мастер"
              : user.role === "executor"
                ? "Исполнитель"
                : user.role === "manager"
                  ? "Руководитель"
                  : "Администратор"}
          </small>
          <button onClick={() => void signOut()}>Выйти</button>
        </div>
      </aside>
      <header className="mobile-header">
        <div className="mobile-brand">
          <span>
            N<span>•</span>
          </span>
          <strong>НАРЯДAI</strong>
        </div>
        <div>
          <small>{user.display_name}</small>
          <button aria-label="Выйти из учётной записи" onClick={() => void signOut()}>
            Выйти
          </button>
        </div>
      </header>{" "}
      <main className="app-main">
        <div className="live-bar">
          <span className={`live-dot ${liveState}`}></span>
          {liveState === "live"
            ? "Обновления включены"
            : liveState === "reconnecting"
              ? "Переподключение…"
              : liveState === "connecting"
                ? "Подключение…"
                : "Нет соединения"}
          {user.role !== "admin" && (
            <NotificationButton count={unreadCount} onOpen={() => setInboxOpen(true)} />
          )}
        </div>
        {(notice || savedAt || error) && (
          <div className={error ? "banner error-banner" : "banner"} role={error ? "alert" : "status"}>
            {error || notice}
            {savedAt &&
              ` · сохранено ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(savedAt))}`}
            {(notice || error) && (
              <button
                aria-label="Закрыть сообщение"
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
              <strong>Ожидают отправки: {pending.length}</strong>
              <p>Действия сохранены на устройстве и ожидают отправки.</p>
            </div>
            <div>
              {pending.map((entry) => (
                <div key={entry.id} className="pending-item">
                  <span>
                    {actionLabels[entry.request.action] || "Действие"} ·{" "}
                    {data?.orders.items.find((order) => order.id === entry.orderId)?.number || "наряд"}
                  </span>
                  <small>{entry.error || "Ожидает подтверждения"}</small>
                  <button
                    className="secondary"
                    onClick={() => void retry(entry.id)}
                    disabled={entry.state === "blocked"}
                  >
                    Повторить
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
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        {view === "orders" && (
          <OrdersView
            role={user.role}
            page={activeOrders}
            catalog={data?.catalog ?? null}
            workload={data?.workload ?? []}
            filters={filters}
            onFilters={changeFilters}
            onOpen={setSelected}
            onCreate={async (input) => {
              await api.create(input);
              await refresh();
            }}
            onHistory={async (equipmentId) => {
              const page = await api.equipmentHistory(equipmentId);
              setData((current) => (current ? { ...current, orders: page } : current));
              setView("orders");
            }}
            loading={loading}
          />
        )}{" "}
        {view === "workload" && <WorkloadView workers={data?.workload ?? []} />}{" "}
        {view === "analytics" && <AnalyticsView api={api} role={user.role} revision={liveRevision} />}{" "}
        {view === "reference" && (
          <ReferenceView role={user.role} catalog={data?.catalog ?? null} employees={data?.employees ?? []} />
        )}
      </main>
      <nav
        className="bottom-nav"
        aria-label="Мобильная навигация"
        style={{ gridTemplateColumns: "repeat(" + currentNav.length + ", 1fr)" }}
      >
        {currentNav.map(([key, label]) => (
          <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
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
      {selected && data && (
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
          onPhoto={async (id, kind, version, file) => {
            await api.photo(id, kind, version, file);
            await refresh();
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
