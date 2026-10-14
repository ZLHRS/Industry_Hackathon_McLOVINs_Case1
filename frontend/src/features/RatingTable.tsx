import { useId } from "react";
import { Icon } from "../components/Icon";
import { getLocale, t } from "../lib/i18n";
import type { AnalyticsRating } from "../types";
import { RatingMethod, RatingMetrics } from "./MyRating";
import "./ratings.css";

const format = (value: number) =>
  new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);
const highlights = [
  ["quality", "Качество"],
  ["timeliness", "Сдача в срок"],
  ["rework", "Без доработок и повторов"],
] as const;

export function RatingTable({
  title,
  rows,
  ranked,
}: {
  title: string;
  rows: AnalyticsRating[];
  ranked: boolean;
}) {
  const titleId = useId();
  return (
    <section className="ratings-board" aria-labelledby={titleId}>
      <header className="ratings-board-head">
        <h3 id={titleId}>{title}</h3>
        <span>{t("Шкала 0–100")}</span>
      </header>
      {!rows.length ? (
        <p className="ratings-board-empty">{t("Для периода недостаточно подтверждённых данных.")}</p>
      ) : (
        <ol className="ratings-board-list">
          {rows.map((row, index) => {
            const score = row.score == null ? null : Math.max(0, Math.min(100, row.score));
            const available = Object.values(row.components).filter((item) => item.value != null).length;
            return (
              <li className="ratings-entry" key={row.subject_id}>
                <div className="ratings-entry-head">
                  <span
                    className={`ratings-place${ranked && score != null && index < 3 ? ` ratings-place--${index + 1}` : ""}`}
                    aria-label={score == null ? t("Недостаточно данных") : t("Место {0}", [index + 1])}
                  >
                    {ranked && score != null ? index + 1 : "—"}
                  </span>
                  <div className="ratings-person">
                    <strong>{row.subject_name}</strong>
                    <span>
                      {t("Нарядов в оценке")}: <b>{row.sample_size}</b>
                    </span>
                  </div>
                  <div
                    className="ratings-total"
                    aria-label={
                      score == null ? t("Недостаточно данных") : t("Оценка: {0} из 100", [format(score)])
                    }
                  >
                    <strong>{score == null ? "—" : format(score)}</strong>
                    <small>/ 100</small>
                  </div>
                </div>
                <div className="ratings-progress" aria-hidden="true">
                  <span style={{ width: `${score ?? 0}%` }} />
                </div>
                <dl className="ratings-quick-metrics">
                  {highlights.map(([key, label]) => {
                    const value = row.components[key]?.value;
                    return (
                      <div key={key}>
                        <dt>{t(label)}</dt>
                        <dd>
                          {value == null
                            ? t("Нет данных")
                            : `${format(Math.max(0, Math.min(100, value * 100)))}%`}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                <div className="ratings-data-notes">
                  {row.sample_size < 5 && (
                    <span className="ratings-small-sample">
                      <Icon name="alert" />
                      {t("Малая выборка")}
                    </span>
                  )}
                  {row.unavailable_components.length > 0 && (
                    <span>
                      {t("Показателей с данными")}: {available} / {Object.keys(row.components).length}
                    </span>
                  )}
                  {score == null && <span>{t("Рейтинг пока не рассчитан")}</span>}
                </div>
                <details className="ratings-breakdown">
                  <summary>
                    <span>{t("Состав оценки")}</span>
                    <Icon name="chevronRight" />
                  </summary>
                  <RatingMetrics row={row} />
                  <RatingMethod row={row} />
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
