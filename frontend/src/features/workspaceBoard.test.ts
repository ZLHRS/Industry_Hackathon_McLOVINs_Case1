import { describe, expect, it } from "vitest";
import { boardColumnOrders, belongsToOverdueBoardColumn, currentBusyOrderNumber } from "./workspaceBoard";
import type { Order } from "../types";

function order(overrides: Partial<Order>): Order {
  return {
    id: "order-id",
    number: "НР-1",
    work_type: "unplanned",
    description: "Проверка",
    area_id: "area-id",
    equipment_id: "equipment-id",
    executor_id: "worker-id",
    master_id: "master-id",
    priority: "normal",
    status: "issued",
    issued_at: "2026-10-08T08:00:00+05:00",
    deadline: "2026-10-08T09:00:00+05:00",
    started_at: null,
    completed_at: null,
    closed_at: null,
    comment: null,
    version: 1,
    attempt: 1,
    last_submission_version: null,
    is_synthetic: false,
    overdue: false,
    ...overrides,
  };
}

describe("work order board partition", () => {
  it("puts API-marked active overdue work only in the overdue column", () => {
    const overdue = order({ id: "overdue", status: "in_progress", overdue: true });
    const regular = order({ id: "regular", status: "in_progress" });

    expect(belongsToOverdueBoardColumn(overdue)).toBe(true);
    expect(boardColumnOrders([overdue, regular], ["in_progress", "paused"])).toEqual([regular]);
  });

  it("keeps terminal records in their status columns even when legacy data flags them overdue", () => {
    const closed = order({ id: "closed", status: "closed", overdue: true });
    const cancelled = order({ id: "cancelled", status: "cancelled", overdue: true });

    expect(belongsToOverdueBoardColumn(closed)).toBe(false);
    expect(belongsToOverdueBoardColumn(cancelled)).toBe(false);
    expect(boardColumnOrders([closed], ["closed"])).toEqual([closed]);
    expect(boardColumnOrders([cancelled], ["cancelled"])).toEqual([cancelled]);
  });
});

describe("busy worker current order", () => {
  it("exposes only the supplied current order number for a busy worker", () => {
    expect(currentBusyOrderNumber({ availability: "busy", current_order_number: "НР-2026-0421" })).toBe(
      "НР-2026-0421",
    );
    expect(
      currentBusyOrderNumber({ availability: "queued", current_order_number: "НР-2026-0421" }),
    ).toBeNull();
    expect(currentBusyOrderNumber({ availability: "busy", current_order_number: null })).toBeNull();
  });
});
