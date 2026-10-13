import type { NotificationItem } from "../types";

export type NotificationGroupType = "order" | "fault" | "system";

export type NotificationGroup = {
  id: string;
  type: NotificationGroupType;
  orderId: string | null;
  faultReportId: string | null;
  orderReference: string | null;
  orderDescription: string | null;
  items: NotificationItem[];
  unreadCount: number;
  urgentCount: number;
};

/** Remove accidental edge whitespace from server copy without changing its meaning. */
export function cleanNotificationText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function candidateReference(value: unknown) {
  const text = typeof value === "string" ? cleanNotificationText(value) : "";
  return text && /\d/u.test(text) ? text : null;
}

function orderReference(item: NotificationItem) {
  const payloadReference =
    candidateReference(item.payload.order_number) ?? candidateReference(item.payload.number);
  if (payloadReference) return payloadReference;

  const text = `${cleanNotificationText(item.title)} ${cleanNotificationText(item.body)}`;
  const named = text.match(/(?:наряд|заявка)\s*№?\s*((?=[\p{L}\d_-]*\d)[\p{L}\d][\p{L}\d_-]*)/iu)?.[1];
  if (named) return named;
  return text.match(/\b[\p{L}]{1,6}[-–]\d[\p{L}\d_-]*\b/iu)?.[0] ?? null;
}

function orderDescription(item: NotificationItem) {
  const value = item.payload.order_description;
  return typeof value === "string" && cleanNotificationText(value) ? cleanNotificationText(value) : null;
}

/**
 * Group only the notifications received in this loaded server page.
 * The API paginates individual events, therefore this deliberately does not
 * imply that a group is the full lifetime history of a work order.
 */
export function groupNotifications(items: readonly NotificationItem[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const item of items) {
    const type: NotificationGroupType = item.order_id ? "order" : item.fault_report_id ? "fault" : "system";
    const key =
      type === "order"
        ? `order:${item.order_id}`
        : type === "fault"
          ? `fault:${item.fault_report_id}`
          : "system";
    const reference = type === "order" ? orderReference(item) : null;
    const description = type === "order" ? orderDescription(item) : null;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      existing.unreadCount += item.read_at ? 0 : 1;
      existing.urgentCount += item.urgent ? 1 : 0;
      existing.orderReference ||= reference;
      existing.orderDescription ||= description;
      continue;
    }
    groups.set(key, {
      id: key,
      type,
      orderId: item.order_id,
      faultReportId: item.fault_report_id,
      orderReference: reference,
      orderDescription: description,
      items: [item],
      unreadCount: item.read_at ? 0 : 1,
      urgentCount: item.urgent ? 1 : 0,
    });
  }
  return [...groups.values()];
}
