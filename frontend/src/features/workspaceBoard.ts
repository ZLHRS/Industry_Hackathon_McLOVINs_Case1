import type { Order, Status, Workload } from "../types";

const terminalStatuses = new Set<Status>(["closed", "cancelled"]);

/**
 * Trust the API's overdue flag: it already applies the operational status rules.
 * Terminal orders stay in their status/history columns even if legacy data carries
 * an overdue flag.
 */
export function belongsToOverdueBoardColumn(order: Order): boolean {
  return order.overdue && !terminalStatuses.has(order.status);
}

export function boardColumnOrders(orders: Order[], statuses: Status[]): Order[] {
  return orders.filter((order) => statuses.includes(order.status) && !belongsToOverdueBoardColumn(order));
}

export function currentBusyOrderNumber(
  person: Pick<Workload, "availability" | "current_order_number">,
): string | null {
  return person.availability === "busy" ? person.current_order_number : null;
}
