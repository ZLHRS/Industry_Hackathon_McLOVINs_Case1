import { Icon } from "../components/Icon";
import { t } from "../lib/i18n";
import type { Status } from "../types";

type Step = { key: string; label: string };

const position: Record<Status, number> = {
  issued: 0,
  accepted: 1,
  queued: 1,
  rejected: 1,
  in_progress: 2,
  paused: 2,
  rework: 2,
  completed: 3,
  ai_review: 4,
  closed: 5,
  cancelled: -1,
};

/** Read-only life-cycle overview. The journal below stays the source of truth. */
export function OrderProgress({ status }: { status: Status }) {
  const steps: Step[] = [
    { key: "issued", label: t("Выдан") },
    {
      key: "accepted",
      label: status === "queued" ? t("В очереди") : status === "rejected" ? t("Отказ") : t("Принят"),
    },
    {
      key: "work",
      label: status === "paused" ? t("Пауза") : status === "rework" ? t("Доработка") : t("В работе"),
    },
    { key: "completed", label: t("Сдан") },
    { key: "review", label: t("Проверка") },
    { key: "closed", label: t("Закрыт") },
  ];
  const current = position[status];
  const tone =
    status === "rejected" || status === "rework"
      ? "is-alert"
      : status === "paused" || status === "queued"
        ? "is-waiting"
        : status === "closed"
          ? "is-done"
          : "";
  if (status === "cancelled")
    return (
      <div className="order-progress is-cancelled" aria-label={t("Этапы наряда")}>
        <Icon name="close" />
        <span>{t("Наряд отменён — этапы выполнения остановлены.")}</span>
      </div>
    );
  return (
    <ol className={`order-progress ${tone}`} aria-label={t("Этапы наряда")}>
      {steps.map((step, index) => {
        const state =
          index < current || status === "closed" ? "done" : index === current ? "current" : "next";
        return (
          <li
            key={step.key}
            className={`order-progress-step is-${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="order-progress-dot" aria-hidden="true">
              {state === "done" ? <Icon name="check" /> : index + 1}
            </span>
            <span className="order-progress-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
