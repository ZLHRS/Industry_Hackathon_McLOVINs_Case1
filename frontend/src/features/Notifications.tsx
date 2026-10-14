import { Skeleton } from "../components/Skeleton";
import { t, message } from "../lib/i18n";
import { useEffect, useState } from "react";
import type { Api } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { NotificationGroupCard } from "./NotificationGroupCard";
import type { NotificationGroupPage } from "../types";
import type { PushStatus, usePushStatus } from "../lib/usePushStatus";
import "./notifications.css";

export function NotificationButton({
  count,
  onOpen,
  pushStatus,
}: {
  count: number;
  onOpen: () => void;
  pushStatus?: PushStatus;
}) {
  return (
    <button
      type="button"
      className={`notification-button${pushStatus === "enabled" ? " notification-button--connected" : ""}`}
      onClick={onOpen}
      aria-label={
        t("Уведомления: непрочитанных {0}", [count]) +
        (pushStatus === "enabled" ? ". " + t("Уведомления на этом устройстве включены.") : "")
      }
      title={pushStatus === "enabled" ? t("Уведомления на этом устройстве включены.") : t("Уведомления")}
    >
      <Icon name="bell" />
      {pushStatus === "enabled" && (
        <span
          className="notification-connection-dot"
          aria-label={t("Уведомления на этом устройстве включены.")}
        />
      )}
      {count > 0 && <b aria-hidden="true">{count > 99 ? "99+" : count}</b>}
    </button>
  );
}

type NotificationsDialogProps = {
  api: Api;
  onClose: () => void;
  onOrder: (orderId: string) => void;
  onFaultReport: (reportId: string) => void;
  push: ReturnType<typeof usePushStatus>;
  revision: number;
};

export function NotificationsDialog({
  api,
  onClose,
  onOrder,
  onFaultReport,
  push,
  revision,
}: NotificationsDialogProps) {
  const [result, setResult] = useState<{
    page: NotificationGroupPage;
    offset: number;
    unreadOnly: boolean;
  }>();
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

  return (
    <Dialog title={t("Уведомления")} onClose={onClose} size="wide">
      <section className="notification-drawer">
        <header className="notification-drawer-tools">
          <div className={`push-control push-control--${push.status}`} aria-busy={push.status === "checking"}>
            <span className="push-control-icon" aria-hidden="true">
              <Icon name={push.status === "enabled" ? "check" : "bell"} />
            </span>
            <div className="push-control-copy">
              <strong>{t("Уведомления на устройстве")}</strong>
              <span className="push-status-badge" role="status">
                {t(pushLabels[push.status])}
              </span>
              <small>{t(pushDescriptions[push.status])}</small>
            </div>
            {["off", "error"].includes(push.status) && (
              <button type="button" className="secondary" onClick={() => void push.enable()}>
                <Icon name="bell" />
                {push.status === "error" ? t("Повторить") : t("Включить уведомления")}
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

const pushLabels: Record<PushStatus, string> = {
  checking: "Проверяем подключение",
  enabled: "Включены",
  off: "Не подключены",
  blocked: "Заблокированы браузером",
  unavailable: "Недоступны",
  error: "Не удалось подключить",
};
const pushDescriptions: Record<PushStatus, string> = {
  checking: "Проверяем разрешение и связь этого устройства с сервером.",
  enabled:
    "Это устройство подключено. Уведомления будут приходить и при свёрнутом приложении, пока действует вход.",
  off: "Получайте уведомления, когда приложение свёрнуто.",
  blocked: "Уведомления заблокированы в настройках браузера для этого сайта.",
  unavailable: "Фоновые уведомления недоступны. Проверьте поддержку браузера и настройку сервера.",
  error: "Не удалось подтвердить подключение. Проверьте интернет и повторите попытку.",
};
