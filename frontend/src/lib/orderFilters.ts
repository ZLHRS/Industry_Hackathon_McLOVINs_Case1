import type { User } from "../types";
export const activeOrderStatuses = [
  "issued",
  "accepted",
  "queued",
  "in_progress",
  "paused",
  "completed",
  "ai_review",
  "rework",
  "rejected",
];
export const archivedOrderStatuses = ["closed", "cancelled"];
export type OrderFilters = {
  status: string[];
  priority: string;
  overdue: boolean;
  area_id: string;
  equipment_id: string;
  executor_id: string;
  master_id: string;
  query: string;
  attention: boolean;
  offset: number;
};
type Actor = Pick<User, "id" | "role">;
const uuid = (value: string | null) =>
  value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";
export function readOrderFilters(location: string, actor: Actor | null): OrderFilters {
  const url = new URL(location, "https://technaryad.invalid");
  const params = /^\/orders(?:\/|$)/.test(url.pathname) ? url.searchParams : new URLSearchParams();
  const master = params.get("master_id");
  const executor = actor?.role === "executor" ? "" : uuid(params.get("executor_id"));
  const offset = Number(params.get("offset") ?? 0);
  const scope = params.get("status");
  return {
    status:
      scope === "history" || scope === "archive" ? [...archivedOrderStatuses] : [...activeOrderStatuses],
    priority: ["planned", "normal", "high", "emergency"].includes(params.get("priority") ?? "")
      ? params.get("priority")!
      : "",
    overdue: params.get("overdue") === "true",
    area_id: uuid(params.get("area_id")),
    equipment_id: uuid(params.get("equipment_id")),
    executor_id: executor,
    master_id:
      actor?.role === "master"
        ? master === "all" || (!master && executor)
          ? "all"
          : uuid(master) || actor.id
        : actor?.role === "manager"
          ? uuid(master) || "all"
          : "",
    query: (params.get("q") ?? "").slice(0, 200),
    attention: params.get("attention") === "true",
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
  };
}
export function orderFiltersUrl(filters: OrderFilters): string {
  const params = new URLSearchParams();
  if (filters.status.join(",") === archivedOrderStatuses.join(",")) params.set("status", "history");
  for (const name of ["master_id", "executor_id", "area_id", "equipment_id", "priority"] as const)
    if (filters[name]) params.set(name, filters[name]);
  if (filters.query) params.set("q", filters.query);
  if (filters.overdue) params.set("overdue", "true");
  if (filters.attention) params.set("attention", "true");
  if (filters.offset) params.set("offset", String(filters.offset));
  return "/orders" + (params.size ? "?" + params : "");
}
export function orderFilterKey(filters: OrderFilters, actor: Actor): string {
  return JSON.stringify({
    ...filters,
    status: [...filters.status].sort(),
    executor_id: actor.role === "executor" ? actor.id : filters.executor_id,
    master_id:
      ["master", "manager"].includes(actor.role) && filters.master_id !== "all" ? filters.master_id : "",
  });
}
