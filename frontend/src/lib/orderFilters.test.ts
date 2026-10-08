import { describe, expect, it } from "vitest";
import {
  activeOrderStatuses,
  archivedOrderStatuses,
  orderFilterKey,
  orderFiltersUrl,
  readOrderFilters,
} from "./orderFilters";
const master = { id: "10000000-0000-0000-0000-000000000001", role: "master" as const };
const other = "10000000-0000-0000-0000-000000000002";
describe("order filter navigation and offline identity", () => {
  it("defaults to self for masters and keeps refusal active, not archived", () => {
    const filters = readOrderFilters("/orders", master);
    expect(filters.master_id).toBe(master.id);
    expect(filters.status).toEqual(activeOrderStatuses);
    expect(filters.status).toContain("rejected");
    expect(archivedOrderStatuses).toEqual(["closed", "cancelled"]);
  });
  it("round trips all filters including explicit all masters and pagination", () => {
    const filters = {
      ...readOrderFilters("/orders", master),
      master_id: "all",
      executor_id: other,
      area_id: other,
      equipment_id: other,
      priority: "high",
      sort: "deadline" as const,
      query: "Насос & №2",
      attention: true,
      overdue: true,
      offset: 50,
    };
    expect(readOrderFilters(orderFiltersUrl(filters), master)).toEqual(filters);
    const archived = { ...filters, status: archivedOrderStatuses };
    expect(readOrderFilters(orderFiltersUrl(archived), master)).toEqual(archived);
  });
  it("maps old archive links to history and old all links to current work", () => {
    expect(readOrderFilters("/orders?status=archive", master).status).toEqual(archivedOrderStatuses);
    expect(readOrderFilters("/orders?status=history", master).status).toEqual(archivedOrderStatuses);
    expect(readOrderFilters("/orders?status=all", master).status).toEqual(activeOrderStatuses);
  });
  it("worker deep links suppress the default master but bare orders restores it", () => {
    expect(readOrderFilters(`/orders?executor_id=${other}&status=all`, master).master_id).toBe("all");
    expect(readOrderFilters("/orders", master).master_id).toBe(master.id);
    expect(readOrderFilters(`/orders?master_id=${other}`, { ...master, role: "manager" }).master_id).toBe(
      other,
    );
  });
  it("keeps the executor's permitted master filter but ignores a copied executor", () => {
    const filters = readOrderFilters(`/orders?master_id=${other}&executor_id=${other}`, {
      ...master,
      role: "executor",
    });
    expect(filters.master_id).toBe(other);
    expect(filters.executor_id).toBe("");
  });
  it("defaults to priority sorting and round trips a requested server sort", () => {
    expect(readOrderFilters("/orders", master).sort).toBe("priority");
    const filters = { ...readOrderFilters("/orders?sort=deadline", master), offset: 24 };
    expect(orderFiltersUrl(filters)).toContain("sort=deadline");
    expect(readOrderFilters(orderFiltersUrl(filters), master)).toEqual(filters);
    expect(readOrderFilters("/orders?sort=untrusted", master).sort).toBe("priority");
  });
  it("ignores malformed filters and directory query parameters", () => {
    expect(readOrderFilters("/orders?master_id=invalid&offset=-1&priority=bad", master)).toEqual(
      readOrderFilters("/orders", master),
    );
    expect(readOrderFilters("/reference/equipment?q=other&status=archive", master)).toEqual(
      readOrderFilters("/orders", master),
    );
  });
  it("never identifies different master, worker, page or archive results as the same snapshot", () => {
    const filters = readOrderFilters("/orders", master);
    const key = orderFilterKey(filters, master);
    for (const changed of [
      { master_id: "all" },
      { executor_id: other },
      { offset: 50 },
      { status: archivedOrderStatuses },
      { query: "насос" },
      { priority: "high" },
      { sort: "deadline" as const },
    ])
      expect(orderFilterKey({ ...filters, ...changed }, master)).not.toBe(key);
    expect(orderFilterKey({ ...filters, status: [...filters.status].reverse() }, master)).toBe(key);
  });
});
