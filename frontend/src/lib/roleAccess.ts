import { t } from "./i18n";
import type { Role } from "../types";

export type View = "orders" | "workload" | "reference" | "analytics" | "employees";
export const navigation: Record<Role, Array<[View, string]>> = {
  get executor(): Array<[View, string]> {
    return [
      ["orders", t("Моя работа")],
      ["analytics", t("Мои результаты")],
    ];
  },
  get master(): Array<[View, string]> {
    return [
      ["orders", t("Наряды")],
      ["workload", t("Загрузка")],
      ["reference", t("Справочники")],
      ["analytics", t("Отчёт")],
    ];
  },
  get manager(): Array<[View, string]> {
    return [
      ["orders", t("Наряды")],
      ["workload", t("Загрузка")],
      ["analytics", t("Отчёт")],
    ];
  },
  get admin(): Array<[View, string]> {
    return [
      ["employees", t("Сотрудники")],
      ["reference", t("Справочники")],
    ];
  },
};
export const canReviewRepair = (role: Role) => role === "master" || role === "manager";
/** A worker may read the safe result of their own repair, but may never decide it. */
export const canViewRepairOutcome = (role: Role) => canReviewRepair(role) || role === "executor";
export const canViewWorkload = (role: Role) => role === "master" || role === "manager";
export const canViewEmployees = (role: Role) => role === "master" || role === "admin";
export function permittedView(role: Role, requested: View): View {
  return navigation[role].some(([view]) => view === requested) ? requested : navigation[role][0][0];
}
export const roleLabels: Record<Role | "system", string> = {
  get master() {
    return t("Мастер");
  },
  get executor() {
    return t("Исполнитель");
  },
  get manager() {
    return t("Руководитель");
  },
  get admin() {
    return t("Администратор");
  },
  get system() {
    return t("Система");
  },
};
