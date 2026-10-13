import { describe, expect, it } from "vitest";
import { orderTitle, withCurrentOrderTitles } from "./orderText";
import type { Catalog, Order, Workload } from "../types";

const person = (overrides: Partial<Workload>): Workload => ({
  employee_id: "e1",
  area_ids: [],
  display_name: "Тимур Назаров",
  specialty: "электрик",
  grade: 4,
  brigade_id: null,
  is_on_shift: true,
  availability: "busy",
  current_order_id: "o1",
  current_order_number: "НР-2026-0596",
  current_started_at: null,
  current_order_description: null,
  queue_length: 0,
  paused_count: 0,
  ...overrides,
});

describe("work order titles", () => {
  it("drops only the synthetic demo prefix", () => {
    expect(
      orderTitle({ is_synthetic: true, description: "ДЕМО: синтетические данные. ДЕМО: Замена ремня" }),
    ).toBe("Замена ремня");
    expect(orderTitle({ is_synthetic: false, description: "ДЕМО: синтетические данные. ДЕМО: x" })).toBe(
      "ДЕМО: синтетические данные. ДЕМО: x",
    );
  });

  it("shows what a busy person works on instead of a bare order number", () => {
    const catalog = {
      equipment: [{ id: "m1", inventory_number: "CR-001", name: "Конвейер 1" }],
    } as unknown as Catalog;
    const running = [
      { id: "o1", description: "Повреждение кабеля", is_synthetic: false, equipment_id: "m1" },
    ] as Order[];
    const [busy, free] = withCurrentOrderTitles(
      [person({}), person({ employee_id: "e2", availability: "free", current_order_id: null })],
      running,
      catalog,
    );
    expect(busy).toMatchObject({
      current_order_title: "Повреждение кабеля",
      current_order_equipment: "CR-001 · Конвейер 1",
    });
    expect(free.current_order_title).toBeUndefined();
    const unchanged = [person({})];
    expect(withCurrentOrderTitles(unchanged, null, catalog)).toBe(unchanged);
  });
});
