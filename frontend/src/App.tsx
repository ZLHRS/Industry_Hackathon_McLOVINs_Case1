import { Skeleton } from "./components/Skeleton";
import { t, getLocale, useLanguage, message } from "./lib/i18n";
import { AppPreferences } from "./components/AppPreferences";
import { ProfileMenu } from "./components/ProfileMenu";
import { ShiftChip } from "./components/ShiftChip";
import { Icon, type IconName } from "./components/Icon";
import { OrderReference } from "./components/OrderReference";
import { useDeviceInstallation } from "./lib/useDeviceInstallation";
import { navigation, permittedView, canViewWorkload, type View } from "./lib/roleAccess";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError, clearMutationKeys } from "./api";
import { Login } from "./features/Login";
import { OrderDetailDialog, type ActionOutcome } from "./features/OrderDetail";
import { NotificationButton, NotificationsDialog } from "./features/Notifications";
import { RealtimeConnection } from "./lib/realtime";
import { CreateOrderDialog, OrdersView, ReferenceView } from "./features/Workspace";
import { WorkloadView } from "./features/Workers";
import { withCurrentOrderTitles } from "./lib/orderText";
import { EquipmentCard } from "./features/EquipmentCard";
import { EmployeesView } from "./features/Employees";
import { AnalyticsView } from "./features/Analytics";
import { MasterAssistant } from "./features/MasterAssistant";
import { FaultReportsDialog } from "./features/FaultReports";
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
  BeforePhotos,
  CreateOrder,
  Catalog,
  Employee,
  Equipment,
  EventItem,
  MasterOption,
  OrderPage,
  PreventiveDraft,
  FaultReportView,
  User,
  Workload,
} from "./types";
import "./styles.css";
import "./shell.css";
import "./layout-polish.css";
import "./theme.css";
import "./features/workers.css";
import "./features/insights.css";
import "./features/order-polish.css";
import "./features/admin-polish.css";
import "./print.css";
import {
  useAppLocation,
  readRoute,
  navigate,
  directoryUrl,
  closeOrderPage,
  replaceRouteIfCurrent,
} from "./lib/navigation";

import {
  archivedOrderStatuses,
  readOrderFilters,
  orderFiltersUrl,
  orderFilterKey,
  type OrderFilters,
} from "./lib/orderFilters";

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
const navIcons: Record<View, IconName> = {
  orders: "orders",
  workload: "workload",
  reference: "reference",
  analytics: "analytics",
  insights: "sparkles",
  employees: "employees",
};
const navCollapsedKey = "technaryad.nav.collapsed";
function storedNavCollapsed() {
  try {
    return localStorage.getItem(navCollapsedKey) === "1";
  } catch {
    return false;
  }
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
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
  const language = useLanguage();
  const installation = useDeviceInstallation();
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
  const [equipmentForOrder, setEquipmentForOrder] = useState<Equipment | null>(null);
  const [preventiveDraft, setPreventiveDraft] = useState<PreventiveDraft | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [faultReportDialog, setFaultReportDialog] = useState<{
    mode: "executor" | "master" | "detail";
    reportId?: string;
    equipmentId?: string;
  } | null>(null);
  const [faultReportDraft, setFaultReportDraft] = useState<FaultReportView | null>(null);
  const [faultReportRevision, setFaultReportRevision] = useState(0);
  const [faultReportCount, setFaultReportCount] = useState(0);
  const appLocation = useAppLocation();
  const route = readRoute(appLocation);
  const view = route.view;
  const mainRef = useRef<HTMLElement>(null);
  const shownView = useRef(view);
  // A menu choice opens the new screen from its top and moves keyboard/screen-reader focus to it.
  // Back/forward and in-screen navigation keep their own scroll and focus handling.
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    if (!document.activeElement?.closest(".side-nav, .bottom-nav")) return;
    window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);
  const selected = route.orderId;
  useEffect(() => {
    if (equipmentForOrder && route.equipmentId !== equipmentForOrder.id) setEquipmentForOrder(null);
  }, [equipmentForOrder, route.equipmentId]);
  const [navCollapsed, setNavCollapsed] = useState(storedNavCollapsed);
  const toggleNavigation = () =>
    setNavCollapsed((collapsed) => {
      try {
        localStorage.setItem(navCollapsedKey, collapsed ? "0" : "1");
      } catch {
        /* Layout preference is optional. */
      }
      return !collapsed;
    });
  const setView = (next: View) => navigate("/" + next);
  const setSelected = (id: string | null) => (id ? navigate("/orders/" + id) : closeOrderPage());
  useEffect(() => {
    if (!user) return;
    const current = readRoute(appLocation);
    // Equipment QR cards are a protected detail route for every role.
    if (current.equipmentId) return;
    if (user.role === "admin" && current.view === "reference" && current.section === "employees") {
      replaceRouteIfCurrent(appLocation, "/employees");
      return;
    }
    const allowed = permittedView(user.role, current.view);
    if (allowed !== current.view) {
      replaceRouteIfCurrent(appLocation, "/" + allowed);
      return;
    }
    const path = current.section
      ? "/reference/" + current.section
      : current.orderId
        ? "/orders/" + current.orderId
        : "/" + allowed;
    const query = appLocation.includes("?") ? appLocation.slice(appLocation.indexOf("?")) : "";
    replaceRouteIfCurrent(appLocation, path + query);
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
    async (actorId?: string, preserveEquipmentRoute = true) => {
      authGeneration.current += 1;
      const actor = actorId ?? actorIdRef.current ?? user?.id ?? storedUser()?.id;
      const equipmentRoute = readRoute(appLocation).equipmentId ? appLocation : null;
      sessionStorage.removeItem(tokenKey);
      sessionStorage.removeItem(expiryKey);
      sessionStorage.removeItem(userKey);
      clearMutationKeys();
      setToken(null);
      actorIdRef.current = null;
      setUser(null);
      setData(null);
      setEquipmentForOrder(null);
      setPreventiveDraft(null);
      setAssistantOpen(false);
      setFaultReportDialog(null);
      setFaultReportDraft(null);
      setPending([]);
      setSavedAt(null);
      navigate(preserveEquipmentRoute && equipmentRoute ? equipmentRoute : "/", true);
      if (actor) await clearActor(actor).catch(() => undefined);
    },
    [appLocation, user?.id],
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
      const historyPage = currentFilters.status.join(",") === archivedOrderStatuses.join(",");
      const limit = historyPage ? 24 : 50;
      const guard = authGeneration.current;
      const request = ++refreshGeneration.current;
      setLoading(true);
      setError("");
      try {
        const [catalog, orders, rawWorkload, employees, masters, running] = await Promise.all([
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
                  ["master", "manager", "executor"].includes(actor.role) && currentFilters.master_id !== "all"
                    ? currentFilters.master_id || undefined
                    : undefined,
                q: currentFilters.query || undefined,
                attention: currentFilters.attention || undefined,
                sort: currentFilters.sort,
                offset: currentFilters.offset,
                limit,
              }),
          canViewWorkload(actor.role) ? api.workload() : Promise.resolve([]),
          actor.role === "master" ? api.employees() : Promise.resolve([]),
          ["master", "manager", "executor"].includes(actor.role) ? api.masters() : Promise.resolve([]),
          // Titles for "currently working on": optional, never blocks the dashboard.
          canViewWorkload(actor.role)
            ? api
                .orders({ status: ["in_progress"], limit: 200 })
                .then((page) => page.items)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        const workload = withCurrentOrderTitles(rawWorkload, running, catalog);
        if (guard !== authGeneration.current || request !== refreshGeneration.current) return;
        if (orders.items.length === 0 && currentFilters.offset > 0 && currentFilters.offset >= orders.total) {
          const lastOffset =
            orders.total > 0 ? Math.floor((orders.total - 1) / orders.limit) * orders.limit : 0;
          navigate(orderFiltersUrl({ ...currentFilters, offset: lastOffset }), true);
          return;
        }
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
    if (user?.role !== "master") {
      setFaultReportCount(0);
      return;
    }
    let active = true;
    void api
      .faultReports("open", 0, 1)
      .then((page) => {
        if (active) setFaultReportCount(page.total);
      })
      .catch(() => {
        if (active) setFaultReportCount(0);
      });
    return () => {
      active = false;
    };
  }, [api, faultReportRevision, liveRevision, user?.role]);
  useEffect(() => {
    if (!user || user.role === "admin") return;
    const id = new URLSearchParams(location.search).get("notification");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    let active = true;
    void api
      .notification(id)
      .then((item) => {
        if (!active) return;
        if (item.fault_report_id) {
          setFaultReportDialog({ mode: "detail", reportId: item.fault_report_id });
          navigate("/orders", true);
        } else navigate(item.order_id ? "/orders/" + item.order_id : "/orders", true);
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
  const openOwnOrders = () => {
    if (!user || user.role === "admin") return;
    navigate(orderFiltersUrl(readOrderFilters("/orders", user)), true);
  };
  const loadedOrderRoute = useRef("");
  useEffect(() => {
    if (!user || route.view !== "orders" || route.orderId || route.equipmentId) {
      loadedOrderRoute.current = "";
      return;
    }
    const key = user.id + ":" + appLocation;
    if (loadedOrderRoute.current === key) return;
    loadedOrderRoute.current = key;
    void refreshRef.current(user);
  }, [appLocation, route.equipmentId, route.orderId, route.view, user]);
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
  const openEquipmentOrders = (equipmentId: string) => {
    if (!user || !["executor", "manager"].includes(user.role)) return;
    navigate(
      orderFiltersUrl({
        ...readOrderFilters("/orders", user),
        area_id: "",
        equipment_id: equipmentId,
        executor_id: "",
        master_id: "all",
        priority: "",
        overdue: false,
        query: "",
        attention: false,
        offset: 0,
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
  /** Issue an order, then attach the fault photos picked in the form (case §5.1, demo step 2). */
  async function createOrder(input: CreateOrder, photos?: BeforePhotos) {
    const created = await api.create(input);
    let photoFailed = false;
    if (photos?.files.length) {
      let version = created.version;
      try {
        for (const file of photos.files)
          version = (await api.photo(created.order_id, "before", version, file, photos.aiShareAllowed))
            .version;
      } catch {
        // The order already exists: never report it as "not created" because a photo failed.
        photoFailed = true;
      }
    }
    await refresh();
    if (photoFailed) setError(t("Наряд выдан, но фото не загружено. Добавьте фото в карточке наряда."));
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
    // Leave this device immediately. The captured API instance retains this session's token,
    // so delayed best-effort revocation cannot affect a later sign-in.
    void (async () => {
      try {
        if (subscriptionId) await api.removePushSubscription(subscriptionId);
      } catch {
        // Session revocation below also prevents delivery if device removal fails.
      }
      try {
        await api.logout();
      } catch {
        // Local credentials are already cleared; server revocation can fail while offline.
      }
    })();
    await invalidate(actor.id, false);
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
        <span className="splash-mark" aria-hidden="true">
          {t("Т")}
          <span>•</span>
        </span>
        <p role="status">{t("Проверяем сессию…")}</p>
        {error && <p className="error">{error}</p>}
      </main>
    );
  const currentNav = navigation[user.role];
  const visibleView = permittedView(user.role, view);
  const activeOrders = data?.orderFilterKey === orderFilterKey(filters, user) ? data.orders : null;
  const equipmentFromRoute = route.equipmentId
    ? (data?.catalog.equipment.find((item) => item.id === route.equipmentId) ?? null)
    : null;
  const equipmentArea = equipmentFromRoute
    ? (data?.catalog.areas.find((item) => item.id === equipmentFromRoute.area_id) ?? null)
    : null;
  const assistantScopeKey = data?.catalog
    ? [
        user.id,
        language,
        ...data.catalog.areas.map((area) => `${area.id}:${area.is_active}`),
        ...data.catalog.equipment.map(
          (equipment) => `${equipment.id}:${equipment.area_id}:${equipment.is_active}`,
        ),
      ].join("|")
    : user.id;
  const roleLabel =
    user.role === "master"
      ? t("Мастер")
      : user.role === "executor"
        ? t("Исполнитель")
        : user.role === "manager"
          ? t("Руководитель")
          : t("Администратор");
  const navExpanded = !navCollapsed;
  const toggleLabel = navCollapsed ? t("Развернуть меню") : t("Свернуть меню");
  return (
    <div className={navCollapsed ? "app-shell nav-collapsed" : "app-shell"}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {t("Перейти к содержимому")}
      </a>
      <aside className="side-nav" id="side-nav">
        <div className="side-nav-head">
          <button
            type="button"
            className="nav-toggle"
            onClick={toggleNavigation}
            aria-controls="side-nav"
            aria-expanded={navExpanded}
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            <Icon name="menu" />
          </button>
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
        </div>
        <nav aria-label={t("Основная навигация")}>
          {currentNav.map(([key, label]) => (
            <button
              key={key}
              className={visibleView === key ? "active" : ""}
              aria-current={visibleView === key ? "page" : undefined}
              data-tooltip={label}
              onClick={() => setView(key)}
            >
              <Icon name={navIcons[key]} className="nav-icon" />
              <span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="user-card">
          <span className="user-avatar" aria-hidden="true" title={user.display_name}>
            {initials(user.display_name)}
          </span>
          <div className="user-meta">
            {user.role === "admin" ? (
              <strong>{user.display_name}</strong>
            ) : (
              <button className="user-current-orders" type="button" onClick={openOwnOrders}>
                {user.display_name}
              </button>
            )}
            <small>{roleLabel}</small>
          </div>
          <button
            type="button"
            className="user-logout"
            onClick={() => void signOut()}
            aria-label={t("Выйти")}
            data-tooltip={t("Выйти")}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="app-main" id="main-content" ref={mainRef} tabIndex={-1}>
        <header
          className={user.role === "admin" ? "topbar" : "topbar live-bar"}
          data-live-state={user.role === "admin" ? undefined : liveState}
        >
          <div className="topbar-brand">
            <span className="brand-mark">
              {t("Т")}
              <span>•</span>
            </span>
            <strong>
              {t("Тех")}
              <span>{t("Наряд")}</span>
            </strong>
          </div>
          <ShiftChip live={user.role !== "admin" && liveState === "live"} />
          <div className="topbar-actions">
            {user.role !== "admin" && liveState !== "live" && (
              <span className={`connection-state ${liveState}`} role="status">
                {liveState === "offline" ? (
                  <Icon name="wifiOff" />
                ) : (
                  <span className={`live-dot ${liveState}`}></span>
                )}
                <span className="connection-label">
                  {liveState === "reconnecting"
                    ? t("Переподключение…")
                    : liveState === "connecting"
                      ? t("Подключение…")
                      : t("Нет соединения")}
                </span>
              </span>
            )}
            <AppPreferences installation={installation} />
            {user.role !== "admin" && (
              <NotificationButton count={unreadCount} onOpen={() => setInboxOpen(true)} />
            )}
            <ProfileMenu
              name={user.display_name}
              initials={initials(user.display_name)}
              role={roleLabel}
              onOwnOrders={user.role === "admin" ? undefined : openOwnOrders}
              onSignOut={() => void signOut()}
            />
          </div>
        </header>
        {history.state?.technaryad && history.state?.parent && (
          <nav className="page-navigation" aria-label={t("Навигация страницы")}>
            <button type="button" className="text-button" onClick={() => history.back()}>
              <Icon name="arrowLeft" />
              {t("Назад")}
            </button>
          </nav>
        )}
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
                <Icon name="close" />
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
                    <OrderReference
                      description={
                        data?.orders.items.find((order) => order.id === entry.orderId)?.description
                      }
                      number={data?.orders.items.find((order) => order.id === entry.orderId)?.number}
                    />
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
        {route.equipmentId &&
          (data?.catalog ? (
            <EquipmentCard
              equipment={equipmentFromRoute}
              area={equipmentArea}
              role={user.role}
              closeLabel={user.role === "admin" ? "К оборудованию" : "К нарядам"}
              onClose={() => navigate(user.role === "admin" ? "/reference/equipment" : "/orders")}
              onCreateOrder={() => {
                if (equipmentFromRoute) setEquipmentForOrder(equipmentFromRoute);
              }}
              onShowOrders={() => {
                if (equipmentFromRoute) openEquipmentOrders(equipmentFromRoute.id);
              }}
              onFaultReport={() => {
                if (equipmentFromRoute && user.role === "executor")
                  setFaultReportDialog({ mode: "executor", equipmentId: equipmentFromRoute.id });
              }}
            />
          ) : (
            <section className="workspace">{!error && <Skeleton variant="detail" />}</section>
          ))}
        {visibleView === "orders" && !route.equipmentId && (
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
            onCreate={(input, photos) => createOrder(input, photos)}
            onAssistant={() => setAssistantOpen(true)}
            faultReportCount={faultReportCount}
            onFaultReports={() =>
              setFaultReportDialog({ mode: user.role === "master" ? "master" : "executor" })
            }
            onSuggest={(input) => api.suggestions(input)}
            onBrigadeOptions={(input) => api.brigadeOptions(input)}
            onSimilar={(input) => api.similarRepairs(input)}
            onViewEvidence={(id) => api.order(id)}
            onWorkers={canViewWorkload(user.role) ? () => setView("workload") : undefined}
            onHistory={async (equipmentId) =>
              changeFilters({
                ...filters,
                status: archivedOrderStatuses,
                equipment_id: equipmentId,
                offset: 0,
              })
            }
            loading={loading || (!activeOrders && !error)}
          />
        )}{" "}
        {visibleView === "workload" &&
          !route.equipmentId &&
          (!data ? (
            !error && (
              <section className="workspace">
                <div className="page-head">
                  <div>
                    <p className="eyebrow">{t("СМЕНА")}</p>
                    <h1>{t("Исполнители")}</h1>
                  </div>
                </div>
                <Skeleton variant="people" count={9} label={t("Загружаем исполнителей…")} />
              </section>
            )
          ) : (
            <WorkloadView
              workers={data?.workload ?? []}
              onOpen={setSelected}
              onEmployeeOrders={openEmployeeOrders}
            />
          ))}{" "}
        {(visibleView === "analytics" || visibleView === "insights") && !route.equipmentId && (
          <AnalyticsView
            key={visibleView}
            api={api}
            role={user.role}
            mode={visibleView === "insights" ? "insights" : "report"}
            revision={liveRevision}
            onPreventiveDraft={setPreventiveDraft}
          />
        )}{" "}
        {visibleView === "employees" &&
          user.role === "admin" &&
          !route.equipmentId &&
          (data?.catalog ? (
            <EmployeesView
              api={api}
              catalog={data.catalog}
              currentUserId={user.id}
              onSelfPasswordChanged={() => void invalidate(user.id)}
            />
          ) : (
            !error && (
              <section className="workspace">
                <div className="page-head">
                  <div>
                    <p className="eyebrow">{t("АДМИНИСТРИРОВАНИЕ")}</p>
                    <h1>{t("Сотрудники и доступ")}</h1>
                  </div>
                </div>
                <Skeleton variant="list" label={t("Загружаем сотрудников…")} />
              </section>
            )
          ))}
        {visibleView === "reference" &&
          !route.equipmentId &&
          (!data ? (
            !error && (
              <section className="workspace">
                <div className="page-head">
                  <div>
                    <p className="eyebrow">{t("СПРАВОЧНИКИ")}</p>
                    <h1>{t("Справочники")}</h1>
                  </div>
                </div>
                <Skeleton label={t("Загрузка справочников…")} />
              </section>
            )
          ) : (
            <ReferenceView
              role={user.role}
              catalog={data?.catalog ?? null}
              employees={data?.employees ?? []}
              api={api}
              onCatalogChange={refresh}
              onEmployees={() => setView("employees")}
              onEmployeeOrders={openEmployeeOrders}
              onEquipmentQr={(equipmentId) => navigate("/equipment/" + equipmentId)}
              section={route.section}
              onSectionChange={(section) => navigate(directoryUrl(section))}
              directoryFilters={route.directoryFilters}
              onDirectoryFiltersChange={(filters) => navigate(directoryUrl(route.section, filters), true)}
            />
          ))}
      </main>
      <nav
        className="bottom-nav"
        aria-label={t("Мобильная навигация")}
        style={{ gridTemplateColumns: "repeat(" + currentNav.length + ", 1fr)" }}
      >
        {currentNav.map(([key, label]) => (
          <button
            key={key}
            className={visibleView === key ? "active" : ""}
            aria-current={visibleView === key ? "page" : undefined}
            onClick={() => setView(key)}
          >
            <Icon name={navIcons[key]} />
            <span>{label}</span>
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
          onFaultReport={(id) => {
            setInboxOpen(false);
            setFaultReportDialog({ mode: "detail", reportId: id });
          }}
          onPushBound={(id) => {
            pushSubscriptionId.current = id;
          }}
          revision={liveRevision}
        />
      )}
      {user.role === "master" && data?.catalog && (
        <MasterAssistant
          key={assistantScopeKey}
          api={api}
          catalog={data.catalog}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          onOpenOrder={(id) => {
            setAssistantOpen(false);
            setSelected(id);
          }}
        />
      )}
      {equipmentForOrder &&
        route.equipmentId === equipmentForOrder.id &&
        data?.catalog &&
        user.role === "master" && (
          <CreateOrderDialog
            catalog={data.catalog}
            workers={data.workload}
            initialAreaId={equipmentForOrder.area_id}
            initialEquipmentId={equipmentForOrder.id}
            onClose={() => setEquipmentForOrder(null)}
            onCreate={async (input, photos) => {
              await createOrder(input, photos);
              setEquipmentForOrder(null);
            }}
            onSuggest={(input) => api.suggestions(input)}
            onBrigadeOptions={(input) => api.brigadeOptions(input)}
            onSimilar={(input) => api.similarRepairs(input)}
            onViewEvidence={(id) => api.order(id)}
          />
        )}
      {preventiveDraft && data?.catalog && user.role === "master" && (
        <CreateOrderDialog
          key={`${preventiveDraft.source.family}:${preventiveDraft.equipment_id}:${preventiveDraft.source.order_ids.join(",")}`}
          catalog={data.catalog}
          workers={data.workload}
          preventiveDraft={preventiveDraft}
          onClose={() => setPreventiveDraft(null)}
          onCreate={async (input, photos) => {
            await createOrder(input, photos);
            setPreventiveDraft(null);
            setNotice(t("Наряд выдан"));
          }}
          onSuggest={(input) => api.suggestions(input)}
          onBrigadeOptions={(input) => api.brigadeOptions(input)}
          onSimilar={(input) => api.similarRepairs(input)}
          onViewEvidence={(id) => api.order(id)}
        />
      )}
      {faultReportDraft && data?.catalog && user.role === "master" && (
        <CreateOrderDialog
          key={faultReportDraft.id}
          catalog={data.catalog}
          workers={data.workload}
          faultReportDraft={faultReportDraft}
          onClose={() => setFaultReportDraft(null)}
          onCreate={async (input, photos) => {
            await createOrder(input, photos);
            setFaultReportDraft(null);
            setNotice(t("Наряд выдан"));
            setFaultReportRevision((value) => value + 1);
          }}
          onSuggest={(input) => api.suggestions(input)}
          onBrigadeOptions={(input) => api.brigadeOptions(input)}
          onSimilar={(input) => api.similarRepairs(input)}
          onViewEvidence={(id) => api.order(id)}
        />
      )}
      {faultReportDialog && data?.catalog && (user.role === "executor" || user.role === "master") && (
        <FaultReportsDialog
          key={`${faultReportDialog.mode}:${faultReportDialog.reportId ?? faultReportDialog.equipmentId ?? "list"}`}
          api={api}
          role={user.role}
          catalog={data.catalog}
          mode={faultReportDialog.mode}
          reportId={faultReportDialog.reportId}
          initialEquipmentId={faultReportDialog.equipmentId}
          revision={liveRevision + faultReportRevision}
          onClose={() => setFaultReportDialog(null)}
          onPrepare={(report) => {
            setFaultReportDialog(null);
            setFaultReportDraft(report);
          }}
          onChanged={() => setFaultReportRevision((value) => value + 1)}
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
          onBrigadeOptions={(input) => api.brigadeOptions(input)}
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
