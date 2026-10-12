import { afterEach, expect, it, vi } from "vitest";
import { closeOrderPage, directoryUrl, readRoute, replaceRouteIfCurrent } from "./navigation";

afterEach(() => vi.unstubAllGlobals());

it("returns an order opened from a filtered directory to that history entry", () => {
  const back = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    history: {
      state: { technaryad: true, parent: "/reference/equipment?q=CR-001&state=all" },
      back,
      replaceState,
    },
  });
  closeOrderPage();
  expect(back).toHaveBeenCalledOnce();
  expect(replaceState).not.toHaveBeenCalled();
});

it("a direct order link closes to the list without sending the user to an external previous page", () => {
  const back = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    history: { state: null, back, replaceState },
    location: { pathname: "/orders/00112233-4455-6677-8899-aabbccddeeff", search: "" },
    dispatchEvent: vi.fn(),
  });
  closeOrderPage();
  expect(back).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledWith(null, "", "/orders");
});

it("does not let a stale route normalizer replace a newer navigation", () => {
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    history: { state: null, replaceState },
    location: { pathname: "/reference/fault-codes", search: "" },
    dispatchEvent: vi.fn(),
  });
  expect(replaceRouteIfCurrent("/reference", "/reference")).toBe(false);
  expect(replaceState).not.toHaveBeenCalled();
});

it("replaces a route only while the effect snapshot is still current", () => {
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    history: { state: null, replaceState },
    location: { pathname: "/unknown", search: "" },
    dispatchEvent: vi.fn(),
  });
  expect(replaceRouteIfCurrent("/unknown", "/orders")).toBe(true);
  expect(replaceState).toHaveBeenCalledWith(null, "", "/orders");
});

it("preserves Cyrillic search, special characters and archive filters in directory links", () => {
  const filters = { query: "Насос & №2", state: "archived" as const, area: "area-1" };
  const parsed = readRoute(directoryUrl("equipment", filters));
  expect(parsed.section).toBe("equipment");
  expect(parsed.directoryFilters).toEqual(filters);
  expect(readRoute("/orders/not-an-id").orderId).toBeNull();
});

it("recognizes an equipment QR link without treating it as an order", () => {
  const id = "00112233-4455-6677-8899-aabbccddeeff";
  const route = readRoute("/equipment/" + id);
  expect(route.equipmentId).toBe(id);
  expect(route.orderId).toBeNull();
});
