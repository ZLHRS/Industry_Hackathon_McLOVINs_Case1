import { describe, expect, it } from "vitest";
import { cleanNotificationText, groupNotifications } from "../lib/notifications";
import type { NotificationItem } from "../types";

function notification(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: "notice-1",
    order_id: null,
    fault_report_id: null,
    kind: "workflow",
    title: "Служебное уведомление",
    body: "Откройте приложение.",
    urgent: false,
    action_required: false,
    created_at: "2026-10-12T10:00:00Z",
    read_at: null,
    acknowledged_at: null,
    payload: {},
    ...overrides,
  };
}

describe("notification inbox grouping", () => {
  it("groups only loaded work-order events by their stable order ID and retains each unread event", () => {
    const groups = groupNotifications([
      notification({
        id: "first",
        order_id: "order-a",
        title: "Назначен наряд НР-2026-0042",
        urgent: true,
      }),
      notification({
        id: "second",
        order_id: "order-a",
        title: "До срока наряда НР-2026-0042 — 20 мин",
        read_at: "2026-10-12T10:01:00Z",
      }),
      notification({
        id: "third",
        order_id: "order-b",
        title: "Наряд НР-2026-0042: требуется доработка",
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      id: "order:order-a",
      type: "order",
      orderId: "order-a",
      orderReference: "НР-2026-0042",
      unreadCount: 1,
      urgentCount: 1,
    });
    expect(groups[0].items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(groups[1]).toMatchObject({ id: "order:order-b", unreadCount: 1 });
  });

  it("keeps fault-report and system notifications separate without dropping unread records", () => {
    const groups = groupNotifications([
      notification({ id: "fault-open", fault_report_id: "fault-a", kind: "fault_report_created" }),
      notification({ id: "system-one", kind: "service" }),
      notification({ id: "fault-closed", fault_report_id: "fault-a", read_at: "2026-10-12T10:01:00Z" }),
      notification({ id: "system-two", kind: "service", urgent: true }),
    ]);

    expect(groups.map((group) => [group.id, group.type, group.items.length, group.unreadCount])).toEqual([
      ["fault:fault-a", "fault", 2, 1],
      ["system", "system", 2, 2],
    ]);
    expect(groups[1].urgentCount).toBe(1);
  });

  it("trims accidental edge whitespace before display without changing internal words", () => {
    expect(cleanNotificationText(" \n  Проверить насос   на линии 2 \t")).toBe(
      "Проверить насос   на линии 2",
    );
    expect(cleanNotificationText(undefined)).toBe("");
  });

  it("does not mistake a plain lifecycle title for an order number and can find a later reference", () => {
    const [group] = groupNotifications([
      notification({ id: "first", order_id: "order-a", title: "Наряд отменён" }),
      notification({ id: "second", order_id: "order-a", title: "Наряд НР-2026-0043: закрыт" }),
    ]);

    expect(group.orderReference).toBe("НР-2026-0043");
  });
});
