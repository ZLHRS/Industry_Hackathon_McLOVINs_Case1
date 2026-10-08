import { t, getLocale, message } from "../lib/i18n";
import { useEffect, useState } from "react";
import type { Api } from "../api";
import { Dialog } from "../components/Dialog";
import type { NotificationItem, NotificationPage } from "../types";

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
    >
      {t("Уведомления")}
      {count > 0 && <b>{count}</b>}
    </button>
  );
}

type NotificationsDialogProps = {
  api: Api;
  onClose: () => void;
  onOrder: (orderId: string) => void;
  onPushBound?: (subscriptionId: string) => void;
  revision: number;
};

export function NotificationsDialog({
  api,
  onClose,
  onOrder,
  onPushBound,
  revision,
}: NotificationsDialogProps) {
  const [page, setPage] = useState<NotificationPage>();
  const [pushSupported] = useState(() => supportsPush());
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">(() =>
    supportsPush() ? Notification.permission : "unsupported",
  );
  const [pushState, setPushState] = useState(() => initialPushState(pushSupported, pushPermission));
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
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
        setPage(next);
      })
      .catch(() => {
        if (active) setError(t("Не удалось получить уведомления."));
      });
    return () => {
      active = false;
    };
  }, [api, revision, offset, unreadOnly]);
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
  const update = (item: NotificationItem) =>
    setPage((current) => {
      if (!current) return current;
      const previous = current.items.find((entry) => entry.id === item.id);
      return {
        ...current,
        unread_count: Math.max(0, current.unread_count - (previous?.read_at ? 0 : 1)),
        items: current.items.map((entry) => (entry.id === item.id ? item : entry)),
      };
    });

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

  return (
    <Dialog title={t("Уведомления")} onClose={onClose}>
      <section className="notification-drawer">
        <div className="push-control">
          <strong>{t("Уведомления на устройстве")}</strong>
          <small>{message(pushState)}</small>
          {pushPermission !== "denied" && pushSupported && (
            <button type="button" className="secondary" onClick={() => void enablePush()}>
              {pushPermission === "granted" ? t("Подключить устройство") : t("Включить уведомления")}
            </button>
          )}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => {
              setUnreadOnly(event.target.checked);
              setOffset(0);
            }}
          />{" "}
          {t("Только непрочитанные")}
        </label>
        {error && <p className="error">{message(error)}</p>}
        {!page && !error && <p className="muted">{t("Загрузка…")}</p>}
        {page?.items.length === 0 && <p className="muted">{t("Уведомлений нет.")}</p>}
        {page?.items.map((item) => (
          <article
            className={`notification-item ${item.urgent ? "urgent" : ""} ${item.read_at ? "read" : ""}`}
            key={item.id}
          >
            <div>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <small>{formatDate(item.created_at)}</small>
            </div>
            <div className="notification-actions">
              {item.order_id && (
                <button type="button" className="secondary" onClick={() => onOrder(item.order_id!)}>
                  {t("Открыть наряд")}
                </button>
              )}
              {!item.read_at && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    void api
                      .markNotificationRead(item.id)
                      .then(update)
                      .catch(() => setError(t("Не удалось отметить уведомление.")))
                  }
                >
                  {t("Прочитано")}
                </button>
              )}
              {item.urgent && item.action_required && !item.acknowledged_at && (
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    void api
                      .acknowledgeNotification(item.id)
                      .then(update)
                      .catch(() => setError(t("Не удалось подтвердить получение.")))
                  }
                >
                  {t("Подтвердить получение")}
                </button>
              )}
            </div>
          </article>
        ))}
        {offset > 0 && (
          <button type="button" className="secondary" onClick={() => setOffset(Math.max(0, offset - 50))}>
            {t("Предыдущие уведомления")}
          </button>
        )}
        {page && page.total > offset + page.items.length && (
          <button type="button" className="secondary" onClick={() => setOffset(offset + page.items.length)}>
            {t("Следующие уведомления")}
          </button>
        )}
      </section>
    </Dialog>
  );
}
