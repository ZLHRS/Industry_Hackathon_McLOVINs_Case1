import { Icon, type IconName } from "../components/Icon";
import { getLocale, t } from "../lib/i18n";
import type { AnalyticsRating, AnalyticsRatingComponent } from "../types";
import "./my-rating.css";

const metrics: { key: string; title: string; icon: IconName; description: string }[] = [
  {
    key: "quality",
    title: "Качество работ",
    icon: "shield",
    description: "Итоговые оценки принятых работ. Оценка мастера имеет приоритет.",
  },
  {
    key: "timeliness",
    title: "Сдача в срок",
    icon: "clock",
    description: "Учитывается время сдачи работы, а не ожидание приёмки мастером.",
  },
  {
    key: "rework",
    title: "Без доработок и повторов",
    icon: "refresh",
    description: "Учитываются ремонты с полным окном наблюдения в 7 дней.",
  },
  {
    key: "volume",
    title: "Объём выполненных работ",
    icon: "orders",
    description: "Шкала до 20 нормочасов за выбранный период. Это не загрузка смены.",
  },
  {
    key: "refusal",
    title: "Обоснованность отказов",
    icon: "check",
    description: "Только рассмотренные отказы. Нерассмотренные не снижают оценку.",
  },
];

const number = (value: number) =>
  new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);

function evidence(key: string, item: AnalyticsRatingComponent) {
  const { numerator: n, denominator: d } = item;
  if (n == null || d == null || d <= 0) return null;
  switch (key) {
    case "quality":
      return t("Средняя оценка: {0} из 5 · оценено работ: {1}", [number(n / (d / 5)), number(d / 5)]);
    case "timeliness":
      return t("В срок сдано: {0} из {1}", [number(n), number(d)]);
    case "rework":
      return t("Без доработок и повторов: {0} из {1}", [number(d - n), number(d)]);
    case "volume":
      return t("Выполнено: {0} нормочасов из {1} по шкале", [number(n / 60), number(d / 60)]);
    case "refusal":
      return t("Обоснованных отказов: {0} из {1} рассмотренных", [number(d - n), number(d)]);
    default:
      return null;
  }
}

export function MyRating({ row, limitations }: { row: AnalyticsRating; limitations: string[] }) {
  const available = Object.values(row.components).filter((item) => item.value != null).length;
  return (
    <div className="personal-rating">
      <div className="personal-rating-overview">
        <div className="personal-rating-score">
          <span>{t("Итог за период")}</span>
          <div>
            <strong>{row.score == null ? "—" : number(row.score)}</strong>
            <span>/ 100</span>
          </div>
          <small>{row.score == null ? t("Недостаточно данных") : t("Взвешенная оценка показателей")}</small>
        </div>
        <div className="personal-rating-context">
          <strong className="personal-rating-person">{row.subject_name}</strong>
          <dl>
            <div>
              <dt>{t("Нарядов в оценке")}</dt>
              <dd>{row.sample_size}</dd>
            </div>
            <div>
              <dt>{t("Показателей с данными")}</dt>
              <dd>
                {available} / {Object.keys(row.components).length}
              </dd>
            </div>
          </dl>
          {row.sample_size < 5 ? (
            <p className="personal-rating-caution">
              <Icon name="alert" />
              {t("Предварительный результат: в оценке меньше 5 нарядов.")}
            </p>
          ) : (
            <p>{t("Нет данных — нет штрафа: учитываются только доступные показатели.")}</p>
          )}
        </div>
      </div>
      <RatingMetrics row={row} />
      <RatingMethod row={row} limitations={limitations} />
    </div>
  );
}

export function RatingMetrics({ row }: { row: AnalyticsRating }) {
  return (
    <div className="personal-rating-metrics">
      {metrics.map(({ key, title, icon, description }) => {
        const item = row.components[key];
        const value = item?.value == null ? null : Math.max(0, Math.min(100, item.value * 100));
        return (
          <article className={`personal-rating-metric${value == null ? " is-unavailable" : ""}`} key={key}>
            <div className="personal-rating-metric-heading">
              <span className="personal-rating-icon">
                <Icon name={icon} />
              </span>
              <h3>{t(title)}</h3>
              <strong>{value == null ? t("Нет данных") : `${number(value)}%`}</strong>
            </div>
            <div className="personal-rating-track" aria-hidden="true">
              <span style={{ width: `${value ?? 0}%` }} />
            </div>
            <p className="personal-rating-evidence">
              {value == null ? t("Не влияет на итоговую оценку") : evidence(key, item)}
            </p>
            <p className="personal-rating-description">{t(description)}</p>
          </article>
        );
      })}
    </div>
  );
}

export function RatingMethod({ row, limitations = [] }: { row: AnalyticsRating; limitations?: string[] }) {
  return (
    <details className="personal-rating-method">
      <summary>{t("Как рассчитывается оценка")}</summary>
      <p>{t("Чем выше показатель, тем больше его вклад в итог. Отсутствующие данные не считаются нулём.")}</p>
      <dl>
        {metrics.map(
          ({ key, title }) =>
            row.components[key]?.detail && (
              <div key={key}>
                <dt>{t(title)}</dt>
                <dd>{row.components[key].detail}</dd>
              </div>
            ),
        )}
      </dl>
      {limitations.length > 0 && (
        <ul>
          {limitations.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
