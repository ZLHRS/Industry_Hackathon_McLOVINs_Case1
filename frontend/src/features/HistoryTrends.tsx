import { Icon } from "../components/Icon";
import { getLocale, t } from "../lib/i18n";
import type { BreakdownTime, FailureForecast } from "../types";

const number = (value: number) =>
  new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);
/** "в 3,3 раза" / "в 5 раз": Russian agreement for a rounded multiplier. */
function times(value: number) {
  const rounded = Math.round(value * 10) / 10;
  const whole = Number.isInteger(rounded) ? rounded % 100 : null;
  const few = whole === null || (whole % 10 >= 2 && whole % 10 <= 4 && (whole < 12 || whole > 14));
  return few ? t("в {0} раза", [number(rounded)]) : t("в {0} раз", [number(rounded)]);
}

/** Server-computed forecast and shift split (case §6.5) from the same report snapshot. */
export function HistoryTrends({
  forecast,
  timing,
  equipmentName,
}: {
  forecast?: FailureForecast | null;
  timing?: BreakdownTime | null;
  equipmentName: (id: string, fallback: string) => string;
}) {
  if (!forecast && !timing) return null;
  return (
    <section
      className="analytics-section analytics-split history-trends"
      aria-label={t("Прогноз и время поломок")}
    >
      {forecast && (
        <div className="history-column">
          <div className="section-heading">
            <div className="section-heading-title">
              <span className="section-heading-icon" aria-hidden="true">
                <Icon name="trendingUp" />
              </span>
              <h2>{t("Прогноз отказов")}</h2>
            </div>
            <small>{t("Рост внеплановых нарядов за 30 дней к обычному уровню прошлых 60 дней.")}</small>
          </div>
          {forecast.baseline_days < 60 ? (
            <p className="muted trend-empty">
              {t("Мало истории для прогноза: нужно не меньше 90 дней нарядов.")}
            </p>
          ) : forecast.items.length ? (
            <>
              <ol className="forecast-list">
                {forecast.items.map((risk) => (
                  <li key={risk.equipment_id} className={`is-${risk.level}`}>
                    <div className="forecast-line">
                      <strong>{equipmentName(risk.equipment_id, risk.equipment_name)}</strong>
                      <span className={`forecast-level is-${risk.level}`}>
                        {risk.level === "high" ? t("Высокий риск") : t("Повышенный риск")}
                      </span>
                    </div>
                    <small>
                      {risk.growth === null
                        ? t("{0} внеплановых за 30 дней, раньше не было", [risk.recent_count])
                        : t("{0} внеплановых за 30 дней, обычно {1}: рост {2}", [
                            risk.recent_count,
                            number(risk.usual_count),
                            times(risk.growth),
                          ])}
                    </small>
                    {risk.fault_code && (
                      <small className="forecast-fault">
                        {t("{0} из них — шифр {1}", [risk.fault_count, risk.fault_code])}
                        {risk.fault_name ? ` (${risk.fault_name})` : ""}
                      </small>
                    )}
                  </li>
                ))}
              </ol>
              <p className="trend-advice">
                <Icon name="wrench" />
                {t("Вероятен отказ указанного оборудования. Проверьте его узлы и включите в план ППР.")}
              </p>
            </>
          ) : (
            <p className="muted trend-empty">{t("Роста поломок не видно: признаков близкого отказа нет.")}</p>
          )}
        </div>
      )}
      {timing && (
        <div className="history-column">
          <div className="section-heading">
            <div className="section-heading-title">
              <span className="section-heading-icon" aria-hidden="true">
                <Icon name="clock" />
              </span>
              <h2>{t("Поломки по сменам и времени суток")}</h2>
            </div>
            <small>{t("Внеплановые наряды за 90 дней по времени поломки, время Костаная.")}</small>
          </div>
          <TimeOfDay timing={timing} />
        </div>
      )}
    </section>
  );
}

function TimeOfDay({ timing }: { timing: BreakdownTime }) {
  if (!timing.total) return <p className="muted trend-empty">{t("Внеплановых нарядов за период нет.")}</p>;
  const share = (value: number) => Math.round((value / timing.total) * 100);
  const maxBucket = Math.max(1, ...timing.buckets);
  const rows: Array<{ key: string; label: string; value: number }> = [
    { key: "day", label: t("Дневная смена"), value: timing.day_shift },
    { key: "night", label: t("Ночная смена"), value: timing.night_shift },
  ];
  const buckets = ["00–06", "06–12", "12–18", "18–24"];
  const night = timing.dominant_shift === "night";
  return (
    <>
      <div className="shift-rows">
        {rows.map((row) => (
          <div className={`shift-row is-${row.key}`} key={row.key}>
            <span>{row.label}</span>
            <div className="leader-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(3, share(row.value))}%` }} />
            </div>
            <b>
              {row.value} <small>{share(row.value)}%</small>
            </b>
          </div>
        ))}
      </div>
      <div className="time-buckets" aria-label={t("По времени суток")}>
        {timing.buckets.map((value, index) => (
          <div key={buckets[index]} className="time-bucket">
            <div className="time-bucket-bar" aria-hidden="true">
              <span style={{ height: `${Math.max(4, Math.round((value / maxBucket) * 100))}%` }} />
            </div>
            <b>{value}</b>
            <small>{buckets[index]}</small>
          </div>
        ))}
      </div>
      <p className={timing.dominant_shift ? "trend-advice" : "muted trend-empty"}>
        {timing.total < 20 ? (
          t("Недостаточно данных для вывода по сменам: нужно не меньше 20 поломок.")
        ) : timing.dominant_shift ? (
          <>
            <Icon name="alert" />
            {timing.ratio === null
              ? night
                ? t(
                    "Все поломки пришлись на ночную смену. Проверьте ночные обходы, освещение и передачу смены.",
                  )
                : t(
                    "Все поломки пришлись на дневную смену. Сравните нагрузку и режим работы оборудования в разные смены.",
                  )
              : night
                ? t(
                    "Ночью поломок {0} больше, чем днём. Проверьте ночные обходы, освещение и передачу смены.",
                    [times(timing.ratio)],
                  )
                : t(
                    "Днём поломок {0} больше, чем ночью. Сравните нагрузку и режим работы оборудования в разные смены.",
                    [times(timing.ratio)],
                  )}
          </>
        ) : (
          t("Явной связи со сменой нет: поломки распределены равномерно.")
        )}
      </p>
    </>
  );
}
