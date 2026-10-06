import type { Role } from "../types";

export type View = "orders" | "workload" | "reference" | "analytics" | "employees";
export const navigation: Record<Role, Array<[View, string]>> = {
  executor: [
    ["orders", "Моя работа"],
    ["analytics", "Мои результаты"],
  ],
  master: [
    ["orders", "Наряды"],
    ["workload", "Загрузка"],
    ["reference", "Справочники"],
    ["analytics", "Отчёт"],
  ],
  manager: [
    ["orders", "Наряды"],
    ["workload", "Загрузка"],
    ["analytics", "Отчёт"],
  ],
  admin: [
    ["employees", "Сотрудники"],
    ["reference", "Справочники"],
  ],
};
export const canReviewRepair = (role: Role) => role === "master" || role === "manager";
export const canViewWorkload = (role: Role) => role === "master" || role === "manager";
export const canViewEmployees = (role: Role) => role === "master" || role === "admin";
export function permittedView(role: Role, requested: View): View {
  return navigation[role].some(([view]) => view === requested) ? requested : navigation[role][0][0];
}
export const roleLabels: Record<Role | "system", string> = {
  master: "Мастер",
  executor: "Исполнитель",
  manager: "Руководитель",
  admin: "Администратор",
  system: "Система",
};
