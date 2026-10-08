import { useSyncExternalStore } from "react";
import type { View } from "./roleAccess";

export type DirectorySection =
  "areas" | "equipment" | "brigades" | "materials" | "fault-codes" | "time-norms" | "employees";
export type DirectoryFilters = { query: string; state: "active" | "archived" | "all"; area: string };
const sections: DirectorySection[] = [
  "areas",
  "equipment",
  "brigades",
  "materials",
  "fault-codes",
  "time-norms",
  "employees",
];
const views: View[] = ["orders", "workload", "reference", "analytics", "employees"];
const eventName = "technaryad:navigation";
const snapshot = () => window.location.pathname + window.location.search;
const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(eventName, listener);
  };
};
export function useAppLocation() {
  return useSyncExternalStore(subscribe, snapshot);
}
export function navigate(path: string, replace = false) {
  if (!path.startsWith("/") || path.startsWith("//")) return;
  if (snapshot() === path) return;
  const state = { technaryad: true, parent: snapshot() };
  if (replace) window.history.replaceState(window.history.state, "", path);
  else window.history.pushState(state, "", path);
  window.dispatchEvent(new Event(eventName));
}
export function readRoute(value: string) {
  const url = new URL(value, "https://technaryad.invalid");
  const parts = url.pathname.split("/").filter(Boolean);
  const view = views.includes(parts[0] as View) ? (parts[0] as View) : "orders";
  const section =
    view === "reference" && sections.includes(parts[1] as DirectorySection)
      ? (parts[1] as DirectorySection)
      : null;
  const isUuid = (value: string | undefined) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
  const orderId = parts[0] === "orders" && isUuid(parts[1]) ? parts[1] : null;
  const equipmentId = parts[0] === "equipment" && isUuid(parts[1]) ? parts[1] : null;
  const state = url.searchParams.get("state");
  const directoryFilters: DirectoryFilters = {
    query: url.searchParams.get("q") ?? "",
    state: state === "archived" || state === "all" ? state : "active",
    area: url.searchParams.get("area") ?? "",
  };
  return { view, section, orderId, equipmentId, directoryFilters };
}
export function directoryUrl(section: DirectorySection | null, filters?: DirectoryFilters) {
  const params = new URLSearchParams();
  if (filters?.query) params.set("q", filters.query);
  if (filters?.state && filters.state !== "active") params.set("state", filters.state);
  if (filters?.area) params.set("area", filters.area);
  return "/reference" + (section ? "/" + section : "") + (params.size ? "?" + params : "");
}
export function closeOrderPage() {
  const parent = window.history.state?.technaryad && window.history.state?.parent;
  if (
    typeof parent === "string" &&
    /^\/(orders|workload|analytics|reference|employees)(\/|\?|$)/.test(parent) &&
    !readRoute(parent).orderId
  )
    window.history.back();
  else navigate("/orders", true);
}
