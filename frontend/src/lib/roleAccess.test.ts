import { describe, expect, it } from "vitest";
import { navigation, permittedView, canReviewRepair, canViewEmployees, canViewWorkload } from "./roleAccess";
import type { Role } from "../types";

describe("role visibility boundary", () => {
  it.each([
    ["executor", ["orders", "analytics"], false, false, false],
    ["master", ["orders", "workload", "reference", "analytics"], true, true, true],
    ["manager", ["orders", "workload", "analytics"], true, false, true],
    ["admin", ["employees", "reference"], false, true, false],
  ] as const)("%s receives only its work surfaces", (role, views, review, employees, workload) => {
    expect(navigation[role].map(([view]) => view)).toEqual(views);
    expect(canReviewRepair(role)).toBe(review);
    expect(canViewEmployees(role)).toBe(employees);
    expect(canViewWorkload(role)).toBe(workload);
  });
  it.each(["executor", "master", "manager", "admin"] as Role[])(
    "guards stale view state after a session/role change to %s",
    (role) => {
      for (const requested of ["orders", "workload", "reference", "analytics", "employees"] as const) {
        const resolved = permittedView(role, requested);
        expect(navigation[role].some(([view]) => view === resolved)).toBe(true);
      }
    },
  );
});
