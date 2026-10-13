import { Skeleton } from "../components/Skeleton";
import { t, getLocale, message } from "../lib/i18n";
import { useEffect, useState } from "react";
import type { Api } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { OrderReference } from "../components/OrderReference";
import type { NotificationItem, NotificationPage } from "../types";
import { cleanNotificationText, groupNotifications, type NotificationGroup } from "../lib/notifications";
import "./notifications.css";

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(value));

function decodePublicKey(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(padded);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

function supportsPush() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

function initialPushState(supported: boolean, permission: NotificationPermission | "unsupported") {
  if (!supported)
    return t(
      "Этот браузер не поддерживает фоновые уведомления или страница открыта не по защищённому адресу.",
    );
  if (permission === "denied") return t("Уведомления заблокированы в настройках браузера для этого сайта.");
  if (permission === "granted") return t("Разрешение браузера выдано. Проверяем подписку этого устройства…");
  return t("Получайте уведомления, когда приложение свёрнуто.");
}

export function NotificationButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="notification-button"
      onClick={onOpen}
      aria-label={t("Уведомления: непрочитанных {0}", [count])}
      title={t("Уведомления")}
    >
      <Icon name="bell" />
      {count > 0 && <b aria-hidden="true">{count > 99 ? "99+" : count}</b>}
    </button>
  );
}

type NotificationsDialogProps = {
  api: Api;
  onClose: () => void;
  onOrder: (orderId: string) => void;
  onFaultReport: (reportId: string) => void;
  onPushBound?: (subscriptionId: string) => void;
  revision: number;
};

export function NotificationsDialog({
  api,
  onClose,
  onOrder,
  onFaultReport,
  onPushBound,
  revision,
}: NotificationsDialogProps) {
  const [result, setResult] = useState<{ page: NotificationPage; offset: number; unreadOnly: boolean }>();
  const [pushSupported] = useState(() => supportsPush());
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">(() =>
    supportsPush() ? Notification.permission : "unsupported",
  );
  const [pushState, setPushState] = useState(() => initialPushState(pushSupported, pushPermission));
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const page = result?.offset === offset && result.unreadOnly === unreadOnly ? result.page : undefined;
  const setPage = (
    update: NotificationPage | ((current: NotificationPage | undefined) => NotificationPage | undefined),
  ) => {
    setResult((current) => {
      if (current && (current.offset !== offset || current.unreadOnly !== unreadOnly)) return current;
      const next = typeof update === "function" ? update(current?.page) : update;
      return next ? { page: next, offset, unreadOnly } : undefined;
    });
  };
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void api
      .notifications(offset, unreadOnly)
      .then((next) => {
        if (!active) return;
        if (offset > 0 && next.items.length === 0) {
          setOffset(Math.max(0, offset - 50));
          return;
        }
        setError("");
        setResult({ page: next, offset, unreadOnly });
      })
      .catch(() => {
        if (active) setError(t("Не удалось получить уведомления."));
      });
    return () => {
      active = false;
    };
  }, [api, revision, offset, unreadOnly, reload]);
  useEffect(() => {
    if (pushSupported && pushPermission === "granted") {
      void navigator.serviceWorker.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => {
          if (subscription) setPushState(t("Уведомления на этом устройстве включены."));
          else setPushState(t("Разрешение браузера выдано, но устройство ещё не подписано на уведомления."));
        })
        .catch(() => setPushState(t("Не удалось проверить подписку устройства.")));
    }
  }, [pushPermission, pushSupported]);
  async function changeReceipt(item: NotificationItem, acknowledge: boolean) {
    setPending((current) => [...current, item.id]);
    try {
      const next = acknowledge
        ? await api.acknowledgeNotification(item.id)
        : await api.markNotificationRead(item.id);
      setPage((current) => {
        if (!current) return current;
        const previous = current.items.find((entry) => entry.id === next.id);
        if (!previous) return current;
        return {
          ...current,
          unread_count: Math.max(0, current.unread_count - (!previous.read_at && next.read_at ? 1 : 0)),
          items: current.items.map((entry) => (entry.id === next.id ? next : entry)),
        };
      });
      setError("");
      // Refill the server page after an item leaves the unread filter.
      setReload((current) => current + 1);
    } catch {
      setError(acknowledge ? t("Не удалось подтвердить получение.") : t("Не удалось отметить уведомление."));
    } finally {
      setPending((current) => current.filter((id) => id !== item.id));
    }
  }

  async function enablePush() {
    if (!pushSupported) {
      return;
    }
    if (Notification.permission === "denied") {
      setPushState(t("Уведомления заблокированы в настройках браузера для этого сайта."));
      return;
    }
    try {
      const config = await api.pushConfig();
      if (!config.enabled || !config.public_key) {
        setPushState(t("Фоновые уведомления пока недоступны. Обратитесь к администратору."));
        return;
      }
      const permission =
        Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setPushPermission(permission);
      if (permission !== "granted") {
        setPushState(t("Разрешение на уведомления не выдано."));
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodePublicKey(config.public_key),
        }));
      const registered = await api.subscribePush(subscription.toJSON());
      onPushBound?.(registered.id);
      setPushState(t("Уведомления на этом устройстве включены."));
    } catch {
      setPushState(t("Не удалось включить уведомления. Повторите позже."));
    }
  }

  const groups = page ? groupNotifications(page.items) : [];
  const groupTitle = (group: NotificationGroup) => {
    if (group.type === "order") return t("Наряд");
    if (group.type === "fault") return t("Сообщение о неисправности");
    return t("Системные уведомления");
  };
  const groupKind = (group: NotificationGroup) =>
    group.type === "order"
      ? group.equipmentLabel && group.orderReference
        ? t("Наряд {0}", [group.orderReference])
        : t("События по наряду")
      : group.type === "fault"
        ? t("Сообщения об оборудовании")
        : t("Служебные сообщения");
  const groupIcon = (group: NotificationGroup) =>
    group.type === "order" ? "orders" : group.type === "fault" ? "alert" : "bell";
  const eventTitle = (item: NotificationItem) =>
    cleanNotificationText(item.title) || t("Служебное уведомление");
  const eventBody = (item: NotificationItem) =>
    cleanNotificationText(item.body) || t("Откройте приложение, чтобы посмотреть детали.");

  return (
    <Dialog title={t("Уведомления")} onClose={onClose} size="wide">
      <section className="notification-drawer">
        <header className="notification-drawer-tools">
          <div className="push-control">
            <div className="push-control-copy">
              <strong>{t("Уведомления на устройстве")}</strong>
              <small>{message(pushState)}</small>
            </div>
            {pushPermission !== "denied" && pushSupported && (
              <button type="button" className="secondary" onClick={() => void enablePush()}>
                <Icon name="bell" />
                {pushPermission === "granted" ? t("Подключить устройство") : t("Включить уведомления")}
              </button>
            )}
          </div>
          <label className="check notification-unread-filter">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => {
                setError("");
                setUnreadOnly(event.target.checked);
                setOffset(0);
              }}
            />
            <span>{t("Только непрочитанные")}</span>
          </label>
        </header>
        {error && (
          <div role="alert" className="notification-error">
            <p className="error">{message(error)}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setError("");
                setReload((value) => value + 1);
              }}
            >
              {t("Повторить")}
            </button>
          </div>
        )}
        {!page && !error && <Skeleton variant="list" count={3} />}
        {!error && page?.items.length === 0 && (
          <p className="muted notification-empty">{t("Уведомлений нет.")}</p>
        )}
        {page && page.items.length > 0 && (
          <p className="notification-page-note">
            <span>{t("На этой странице: {0} из {1} уведомлений.", [page.items.length, page.total])}</span>
            <span>{t("Нажмите на карточку, чтобы посмотреть связанные события.")}</span>
          </p>
        )}
        <div className="notification-groups" key={`${offset}:${unreadOnly}`}>
          {groups.map((group) => (
            <details
              className={`notification-group group-${group.type} ${group.urgentCount ? "has-urgent" : ""}`}
              key={group.id}
            >
              <summary className="notification-group-head">
                <span className="notification-group-symbol" aria-hidden="true">
                  <Icon name={groupIcon(group)} />
                </span>
                <span className="notification-group-title">
                  <span className="notification-group-kind">{groupKind(group)}</span>
                  {group.type === "order" && group.orderReference ? (
                    <OrderReference
                      description={group.orderDescription ?? group.equipmentLabel}
                      number={group.orderReference}
                    />
                  ) : (
                    <strong>{groupTitle(group)}</strong>
                  )}
                  <span className="notification-group-preview">{eventTitle(group.items[0])}</span>
                  <small>
                    {t("Событий: {0} · непрочитано: {1}", [group.items.length, group.unreadCount])}
                  </small>
                  {group.items.some(
                    (item) => item.urgent && item.action_required && !item.acknowledged_at,
                  ) && <span className="notification-urgent-label">{t("Требуется подтверждение")}</span>}
                </span>
                <span className="notification-group-toggle" aria-hidden="true">
                  {group.unreadCount > 0 && <b>{group.unreadCount}</b>}
                  <Icon name="chevronRight" />
                </span>
              </summary>
              {(group.orderId || group.faultReportId) && (
                <div className="notification-group-navigation">
                  {group.orderId && (
                    <button
                      type="button"
                      className="secondary notification-group-open"
                      onClick={() => onOrder(group.orderId!)}
                    >
                      <Icon name="open" />
                      {t("Открыть наряд")}
                    </button>
                  )}
                  {group.faultReportId && (
                    <button
                      type="button"
                      className="secondary notification-group-open"
                      onClick={() => onFaultReport(group.faultReportId!)}
                    >
                      <Icon name="open" />
                      {t("Открыть сообщение")}
                    </button>
                  )}
                </div>
              )}
              <div className="notification-event-list">
                {group.items.map((item) => (
                  <article
                    className={`notification-item ${item.urgent ? "urgent" : ""} ${item.read_at ? "read" : ""}`}
                    key={item.id}
                  >
                    <div className="notification-event-copy">
                      <div className="notification-event-meta">
                        {item.urgent && <span className="notification-urgent-label">{t("Срочно")}</span>}
                        {!item.read_at && <span className="notification-unread-label">{t("Новое")}</span>}
                        <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                      </div>
                      <strong>{eventTitle(item)}</strong>
                      <p>{eventBody(item)}</p>
                    </div>
                    <div className="notification-actions">
                      {!item.read_at && (
                        <button
                          type="button"
                          className="icon-action"
                          aria-label={t("Прочитано")}
                          title={t("Прочитано")}
                          disabled={pending.includes(item.id)}
                          onClick={() => void changeReceipt(item, false)}
                        >
                          <Icon name="check" />
                        </button>
                      )}
                      {item.urgent && item.action_required && !item.acknowledged_at && (
                        <button
                          type="button"
                          className="primary"
                          disabled={pending.includes(item.id)}
                          onClick={() => void changeReceipt(item, true)}
                        >
                          <Icon name="check" />
                          {t("Подтвердить получение")}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </details>
          ))}
        </div>
        {(offset > 0 || (page && page.total > 50)) && (
          <nav className="notification-pagination" aria-label={t("Навигация по уведомлениям")}>
            <button
              type="button"
              className="secondary"
              aria-label={t("Предыдущие уведомления")}
              disabled={!page || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              <Icon name="chevronLeft" />
              {t("Назад")}
            </button>
            <span className="notification-page-position" role="status">
              {page
                ? t("Страница {0} из {1}", [Math.floor(offset / 50) + 1, Math.ceil(page.total / 50)])
                : t("Загрузка…")}
            </span>
            <button
              type="button"
              className="secondary"
              aria-label={t("Следующие уведомления")}
              disabled={!page || offset + page.items.length >= page.total}
              onClick={() => page && setOffset(offset + page.items.length)}
            >
              {t("Вперёд")}
              <Icon name="chevronRight" />
            </button>
          </nav>
        )}
      </section>
    </Dialog>
  );
}
