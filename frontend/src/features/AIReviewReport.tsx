import type { AiJob, Review, ReviewCheckStatus, ReviewReport } from "../types";

const local = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Almaty",
  }).format(new Date(value));

const verdictLabels: Record<string, string> = {
  accepted: "Принято",
  accepted_with_remarks: "Принято с замечаниями",
  rework_required: "Нужна доработка",
};
const sourceLabels: Record<NonNullable<ReviewReport["source"]>, string> = {
  openai: "Модель OpenAI",
  rules: "Проверка правилами",
  unavailable: "Автоматическая проверка недоступна",
};
const checkStatus: Record<ReviewCheckStatus, string> = {
  pass: "Пройдено",
  warning: "Внимание",
  fail: "Не пройдено",
  unknown: "Нет данных",
};
const jobLabels: Record<string, string> = {
  pending: "Проверка поставлена в очередь",
  running: "Проверка выполняется",
  retry: "Проверка будет повторена",
  completed: "Проверка завершена",
  stale: "Результат проверки устарел",
};

function minutes(value: number | null | undefined) {
  if (typeof value !== "number") return "—";
  const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return hours ? `${hours} ч ${number.format(remainder)} мин` : `${number.format(remainder)} мин`;
}

function ReviewSummary({ review }: { review: Review }) {
  const source = review.report?.source;
  return (
    <div className="review-summary">
      <strong>{verdictLabels[review.verdict ?? ""] || "Вердикт не сформирован"}</strong>
      <span>{source ? sourceLabels[source] : "Архивная запись без структурированного отчёта"}</span>
      <small>{local(review.created_at)}</small>
    </div>
  );
}

function JobState({ job }: { job: AiJob }) {
  const retryAt = job.next_attempt_at ? ` Следующая попытка: ${local(job.next_attempt_at)}.` : "";
  const error = job.last_error_code ? ` Код: ${job.last_error_code}.` : "";
  return (
    <p className="ai-job" role="status">
      {jobLabels[job.status] || "Статус автоматической проверки обновляется."} Попыток: {job.attempts}.
      {retryAt}
      {error}
    </p>
  );
}

export function AIReviewReport({
  review,
  aiJob,
  attempt,
}: {
  review?: Review;
  aiJob?: AiJob | null;
  attempt?: number;
}) {
  if (!review) {
    return (
      <section className="ai-review-report" aria-label="Автоматическая проверка">
        <div className="ai-review-heading">
          <div>
            <p className="eyebrow">Автоматическая проверка</p>
            <h3>{attempt ? `Попытка ремонта ${attempt}` : "Архивная проверка"}</h3>
          </div>
          <span className="review-badge pending">Ожидание</span>
        </div>
        {aiJob ? (
          <JobState job={aiJob} />
        ) : (
          <p className="muted">Отчёт для этой попытки ещё не сформирован.</p>
        )}
      </section>
    );
  }

  const report = review.report ?? {};
  const checks = report.checks ?? [];
  const timing = report.timing;
  const needsAttention = review.needs_master_review || review.verdict === "rework_required";
  return (
    <section className="ai-review-report" aria-label="Автоматическая проверка">
      <div className="ai-review-heading">
        <div>
          <p className="eyebrow">
            Автоматическая проверка ·{" "}
            {attempt ? `попытка ${attempt}` : `версия наряда ${review.order_version}`}
          </p>
          <h3>{verdictLabels[review.verdict ?? ""] || "Вердикт не сформирован"}</h3>
        </div>
        <span className={`review-badge ${needsAttention ? "warning" : "pass"}`}>
          {review.needs_master_review ? "Нужно решение мастера" : "Готово к решению мастера"}
        </span>
      </div>
      <p className="review-explanation">{review.explanation || "Пояснение отсутствует."}</p>
      <div className="review-meta">
        <span>{report.source ? sourceLabels[report.source] : "Архивная запись: источник не указан"}</span>
        {report.source && review.model_name && <span>Модель: {review.model_name}</span>}
        {typeof review.score === "number" && <span>Оценка проверки: {review.score}/5</span>}
        {typeof report.confidence === "number" && (
          <span>Уверенность модели (не калиброванная оценка): {Math.round(report.confidence * 100)}%</span>
        )}
        {typeof review.master_score === "number" && <span>Оценка мастера: {review.master_score}/5</span>}
      </div>
      {checks.length > 0 ? (
        <ul className="review-checks">
          {checks.map((check) => (
            <li key={check.code} className={`review-check ${check.status}`}>
              <strong>{check.title}</strong>
              <span>{checkStatus[check.status]}</span>
              <small>{check.detail}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Структурированные результаты по этой попытке отсутствуют.</p>
      )}
      {timing && (
        <dl className="review-timing">
          <div>
            <dt>Активная работа</dt>
            <dd>{minutes(timing.active_minutes)}</dd>
          </div>
          <div>
            <dt>Паузы</dt>
            <dd>{minutes(timing.paused_minutes)}</dd>
          </div>
          <div>
            <dt>Прошедшее время</dt>
            <dd>{minutes(timing.elapsed_minutes)}</dd>
          </div>
          <div>
            <dt>Норма</dt>
            <dd>{minutes(timing.norm_minutes)}</dd>
          </div>
        </dl>
      )}
      {report.limitations && report.limitations.length > 0 && (
        <aside className="review-limitations">
          <strong>Ограничения проверки</strong>
          <ul>
            {report.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}

export function ReviewHistory({ reviews }: { reviews: Review[] }) {
  const older = reviews.filter((review) => !review.is_current);
  if (!older.length) return null;
  return (
    <details className="review-history">
      <summary>Предыдущие проверки ({older.length})</summary>
      {older.map((review) => (
        <details className="review-history-entry" key={review.id}>
          <summary>
            Проверка по версии наряда {review.order_version} · {local(review.created_at)}
          </summary>
          <ReviewSummary review={review} />
          <AIReviewReport review={review} />
        </details>
      ))}
    </details>
  );
}
