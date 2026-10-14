import { Skeleton } from "../components/Skeleton";
import { t, message } from "../lib/i18n";
import { useEffect, useState } from "react";
import type { Api } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { NotificationGroupCard } from "./NotificationGroupCard";
import type { NotificationGroupPage } from "../types";
import "./notifications.css";

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
  const [result, setResult] = useState<{
    page: NotificationGroupPage;
    offset: number;
    unreadOnly: boolean;
  }>();
  const [pushSupported] = useState(() => supportsPush());
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">(() =>
    supportsPush() ? Notification.permission : "unsupported",
  );
  const [pushState, setPushState] = useState(() => initialPushState(pushSupported, pushPermission));
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const page = result?.offset === offset && result.unreadOnly === unreadOnly ? result.page : undefined;
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void api
      .notificationGroups(offset, unreadOnly)
      .then((next) => {
        if (!active) return;
        if (offset > 0 && next.items.length === 0) {
          setOffset(Math.max(0, offset - 10));
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
        {!page && !error && <Skeleton variant="notifications" count={3} />}
        {!error && page?.items.length === 0 && (
          <p className="muted notification-empty">{t("Уведомлений нет.")}</p>
        )}
        {page && page.items.length > 0 && (
          <p className="notification-page-note">
            <span>{t("Групп на странице: {0} из {1}.", [page.items.length, page.total])}</span>
            <span>{t("Нажмите на карточку, чтобы посмотреть связанные события.")}</span>
          </p>
        )}
        <div className="notification-groups" key={`${offset}:${unreadOnly}`}>
          {page?.items.map((summary) => (
            <NotificationGroupCard
              key={summary.key}
              api={api}
              summary={summary}
              unreadOnly={unreadOnly}
              revision={revision}
              onReceipt={() => setReload((value) => value + 1)}
              onOrder={onOrder}
              onFaultReport={onFaultReport}
            />
          ))}
        </div>
        {(offset > 0 || (page && page.total > 10)) && (
          <nav className="notification-pagination" aria-label={t("Навигация по уведомлениям")}>
            <button
              type="button"
              className="secondary"
              aria-label={t("Предыдущие уведомления")}
              disabled={!page || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 10))}
            >
              <Icon name="chevronLeft" />
              {t("Назад")}
            </button>
            <span className="notification-page-position" role="status">
              {page
                ? t("Страница {0} из {1}", [Math.floor(offset / 10) + 1, Math.ceil(page.total / 10)])
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
