import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { getLocale, t } from "../lib/i18n";

const zone = "Asia/Qostanay";

function shiftNow(now: Date) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: zone }).format(now),
  );
  return hour >= 8 && hour < 20 ? "day" : "night";
}

/** Current shift by plant time. Purely informational: it never changes report periods or data. */
export function ShiftChip({ live }: { live: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const shift = shiftNow(now);
  const time = new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(now);
  return (
    <div
      className="shift-chip"
      title={`${t("Время Костаная")} · ${shift === "day" ? "08:00–20:00" : "20:00–08:00"}`}
    >
      <span className={`shift-chip-icon ${shift === "night" ? "is-night" : ""}`} aria-hidden="true">
        <Icon name={shift === "night" ? "clock" : "activity"} />
      </span>
      <strong>{shift === "day" ? t("Дневная смена") : t("Ночная смена")}</strong>
      <span aria-label={t("Текущее время")}>{time}</span>
      {live && <span className="live-indicator" title={t("Данные обновляются в реальном времени")} />}
    </div>
  );
}
