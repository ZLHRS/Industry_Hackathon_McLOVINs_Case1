import { useEffect, useState } from "react";
import type { Api } from "../api";
import type { NotificationItem, NotificationPage, NotificationGroupSummary } from "../types";
import { Skeleton } from "../components/Skeleton";
import { Icon } from "../components/Icon";
import { OrderReference } from "../components/OrderReference";
import { cleanNotificationText, groupNotifications, type NotificationGroup } from "../lib/notifications";
import { t, getLocale, message } from "../lib/i18n";
const formatDate = (value: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(value));

export function NotificationGroupCard({
  api,
  summary,
  unreadOnly,
  revision,
  onReceipt,
  onOrder,
  onFaultReport,
}: {
  api: Api;
  summary: NotificationGroupSummary;
  unreadOnly: boolean;
  revision: number;
  onReceipt: () => void;
  onOrder: (id: string) => void;
  onFaultReport: (id: string) => void;
}) {
  const group = groupNotifications([summary.latest])[0];
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    page: NotificationPage;
    offset: number;
    revision: number;
    reload: number;
  }>();
  const page = result?.offset === offset ? result.page : undefined;
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const refreshing = open && (!page || result?.revision !== revision || result.reload !== reload);
  const [pending, setPending] = useState<string[]>([]);
  const { order_id, fault_report_id } = summary;
  const setPage = (update: (current: NotificationPage | undefined) => NotificationPage | undefined) => {
    setResult((current) => {
      if (current?.offset !== offset) return current;
      const next = update(current.page);
      return next ? { ...current, page: next } : undefined;
    });
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api
      .notifications(offset, unreadOnly, { order_id, fault_report_id })
      .then((next) => {
        if (!active) return;
        setError("");
        if (offset > 0 && next.items.length === 0) {
          setOffset(Math.max(0, offset - 50));
          return;
        }
        setResult({ page: next, offset, revision, reload });
      })
      .catch(() => {
        if (active) setError(t("Не удалось получить уведомления."));
      });
    return () => {
      active = false;
    };
  }, [api, open, offset, unreadOnly, order_id, fault_report_id, revision, reload]);
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
      onReceipt();
    } catch {
      setError(acknowledge ? t("Не удалось подтвердить получение.") : t("Не удалось отметить уведомление."));
    } finally {
      setPending((current) => current.filter((id) => id !== item.id));
    }
  }

  const groupTitle = (group: NotificationGroup) => {
    if (group.type === "order") return t("Наряд");
    if (group.type === "fault") return t("Сообщение о неисправности");
    return t("Системные уведомления");
  };
  const groupKind = (group: NotificationGroup) =>
    group.type === "order"
      ? group.equipmentLabel || t("События по наряду")
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
    <details
      className={`notification-group group-${group.type} ${summary.pending_count ? "has-urgent" : ""}`}
      onToggle={(event) => {
        setError("");
        setOpen(event.currentTarget.open);
      }}
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
          <small>{t("Событий: {0} · непрочитано: {1}", [summary.total, summary.unread_count])}</small>
          {summary.pending_count > 0 && (
            <span className="notification-urgent-label">{t("Требуется подтверждение")}</span>
          )}
        </span>
        <span className="notification-group-toggle" aria-hidden="true">
          {summary.unread_count > 0 && <b>{summary.unread_count}</b>}
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
      {open && !page && !error && <Skeleton variant="notification-events" count={2} />}
      {error && (
        <div className="notification-error notification-history-tools" role="alert">
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
      {page && <p className="notification-history-note">{t("События показаны от новых к старым.")}</p>}
      {refreshing && page && (
        <p className="notification-history-note" role="status">
          {t("Обновляем…")}
        </p>
      )}
      <div className="notification-event-list" aria-busy={refreshing}>
        {page?.items.map((item) => (
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
                  disabled={refreshing || pending.includes(item.id)}
                  onClick={() => void changeReceipt(item, false)}
                >
                  <Icon name="check" />
                </button>
              )}
              {item.urgent && item.action_required && !item.acknowledged_at && (
                <button
                  type="button"
                  className="primary"
                  disabled={refreshing || pending.includes(item.id)}
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
      {(offset > 0 || (page && page.total > 50)) && (
        <nav className="notification-pagination notification-history-tools" aria-label={t("История событий")}>
          <button
            type="button"
            className="secondary"
            disabled={refreshing || !page || offset === 0}
            onClick={() => {
              setError("");
              setOffset(Math.max(0, offset - 50));
            }}
          >
            {t("Новее")}
          </button>
          <span className="notification-page-position">
            {page
              ? t("События {0}–{1} из {2}", [offset + 1, offset + page.items.length, page.total])
              : t("Загрузка…")}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={refreshing || !page || offset + page.items.length >= page.total}
            onClick={() => {
              setError("");
              if (page) setOffset(offset + page.items.length);
            }}
          >
            {t("Ранее")}
          </button>
        </nav>
      )}
    </details>
  );
}
