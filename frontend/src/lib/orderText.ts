import type { Catalog, Order, Workload } from "../types";

/** Human title of a work order: its task text without the synthetic demo prefix. */
export function orderTitle(order: Pick<Order, "description" | "is_synthetic">) {
  return order.is_synthetic
    ? order.description.replace(/^ДЕМО: синтетические данные\.\s*ДЕМО:\s*/i, "")
    : order.description;
}

/** Attach the running order's title and machine so screens never show a bare order number. */
export function withCurrentOrderTitles(
  workload: Workload[],
  running: Order[] | null,
  catalog: Catalog | null,
): Workload[] {
  if (!running?.length) return workload;
  const byId = new Map(running.map((order) => [order.id, order]));
  return workload.map((person) => {
    const order = person.current_order_id ? byId.get(person.current_order_id) : undefined;
    if (!order) return person;
    const machine = catalog?.equipment.find((item) => item.id === order.equipment_id);
    return {
      ...person,
      current_order_title: orderTitle(order),
      current_order_equipment: machine ? `${machine.inventory_number} · ${machine.name}` : null,
    };
  });
}
