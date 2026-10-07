import { readableLimitation } from "../lib/presentationText";
import type { AiJob, ExecutorFeedback, Review, ReviewCheckStatus, ReviewReport } from "../types";

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
  openai: "Проверка ИИ",
  rules: "Базовая проверка",
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

function timingComparison(feedback: ExecutorFeedback) {
  const difference = feedback.timing.difference_minutes;
  const percent = feedback.timing.percent_of_norm;
  if (difference === null || difference === undefined || percent === null || percent === undefined)
    return "Сравнение с нормой пока недоступно.";
  const roundedPercent = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(percent);
  if (difference === 0) return `Точно по норме · ${roundedPercent}% нормы.`;
  const delta = minutes(Math.abs(difference));
  return difference > 0
    ? `Дольше нормы на ${delta} · ${roundedPercent}% нормы.`
    : `Быстрее нормы на ${delta} · ${roundedPercent}% нормы.`;
}

function ReviewSummary({ review }: { review: Review }) {
  const source = review.report?.source;
  return (
    <div className="review-summary">
      <strong>{verdictLabels[review.verdict ?? ""] || "Предварительный вывод не сформирован"}</strong>
      <span>{source ? sourceLabels[source] : "Архивная проверка"}</span>
      <small>{local(review.created_at)}</small>
    </div>
  );
}

function JobState({ job }: { job: AiJob }) {
  const retryAt = job.next_attempt_at ? ` Следующая попытка: ${local(job.next_attempt_at)}.` : "";
  return (
    <p className="ai-job" role="status">
      {jobLabels[job.status] || "Статус автоматической проверки обновляется."}.{retryAt}
    </p>
  );
}

export function AIReviewReport({
  review,
  aiJob,
  attempt,
  audience = "reviewer",
  decisionResolved = false,
}: {
  review?: Review;
  aiJob?: AiJob | null;
  attempt?: number;
  audience?: "executor" | "reviewer";
  decisionResolved?: false | "closed" | "cancelled";
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
          <p className="muted">
            {audience === "executor"
              ? "Итог по вашей сдаче ещё не сформирован. Когда проверка завершится, здесь появятся результат и время относительно нормы."
              : "Отчёт для этой попытки ещё не сформирован."}
          </p>
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
          <p className="eyebrow">Автоматическая проверка{attempt ? ` · попытка ремонта ${attempt}` : ""}</p>
          <h3>{verdictLabels[review.verdict ?? ""] || "Предварительный вывод не сформирован"}</h3>
        </div>
        <span className={`review-badge ${!decisionResolved && needsAttention ? "warning" : "pass"}`}>
          {decisionResolved
            ? decisionResolved === "cancelled"
              ? "Наряд отменён"
              : "Решение мастера принято"
            : review.needs_master_review
              ? "Ожидает решения мастера"
              : "Рекомендация готова"}
        </span>
      </div>
      {decisionResolved && (
        <p className="muted">
          {decisionResolved === "cancelled" ? "Наряд отменён." : "Наряд закрыт."} Ниже сохранён
          предварительный вывод проверки на момент сдачи.
        </p>
      )}
      {audience === "executor" && (
        <p className="muted review-outcome-intro">
          Это предварительный результат по вашей сдаче. Решение о закрытии или доработке принимает мастер.
        </p>
      )}
      <p className="review-explanation">{review.explanation || "Пояснение отсутствует."}</p>
      <div className="review-meta">
        <span>{report.source ? sourceLabels[report.source] : "Архивная проверка"}</span>
        {typeof review.score === "number" && <span>Предварительная оценка ИИ: {review.score}/5</span>}
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
        <p className="muted">Подробности проверки не сохранены.</p>
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
              <li key={item}>{readableLimitation(item)}</li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}

export function ReviewHistory({
  reviews,
  audience = "reviewer",
}: {
  reviews: Review[];
  audience?: "executor" | "reviewer";
}) {
  const older = reviews.filter((review) => !review.is_current);
  if (!older.length) return null;
  return (
    <details className="review-history">
      <summary>Предыдущие проверки ({older.length})</summary>
      {older.map((review) => (
        <details className="review-history-entry" key={review.id}>
          <summary>Проверка от {local(review.created_at)}</summary>
          <ReviewSummary review={review} />
          <AIReviewReport review={review} audience={audience} />
        </details>
      ))}
    </details>
  );
}

function ExecutorFeedbackEntry({
  feedback,
  status,
  attempt,
}: {
  feedback: ExecutorFeedback;
  status?: string;
  attempt?: number;
}) {
  const strongPoints = feedback.recommendations.filter((item) => item.status === "pass");
  const improve = feedback.recommendations.filter((item) => item.status !== "pass");
  const historical =
    !feedback.is_current ||
    (typeof feedback.attempt === "number" && typeof attempt === "number" && feedback.attempt < attempt);
  const decided = status === "closed" || status === "cancelled" || status === "rework";
  const badge = historical
    ? "Предыдущая сдача"
    : status === "closed"
      ? "Работа принята мастером"
      : status === "cancelled"
        ? "Наряд отменён"
        : status === "rework"
          ? "Возвращено на доработку"
          : "Ожидает решения мастера";
  return (
    <section className="ai-review-report executor-review" aria-label="Результат вашей сдачи">
      <div className="ai-review-heading">
        <div>
          <p className="eyebrow">РЕЗУЛЬТАТ ВАШЕЙ СДАЧИ · ПОПЫТКА {feedback.attempt ?? "—"}</p>
          <h3>{verdictLabels[feedback.verdict ?? ""] || "Итог проверки"}</h3>
        </div>
        <span className={`review-badge ${decided || historical ? "pass" : "warning"}`}>{badge}</span>
      </div>
      <div className="review-meta executor-review-score">
        <span>
          Итоговая оценка:{" "}
          {typeof feedback.effective_score === "number" ? `${feedback.effective_score}/5` : "—"}
        </span>
        {typeof feedback.score === "number" && <span>Предварительная оценка ИИ: {feedback.score}/5</span>}
        {typeof feedback.master_score === "number" && <span>Оценка мастера: {feedback.master_score}/5</span>}
      </div>
      <dl className="review-timing">
        <div>
          <dt>Активная работа</dt>
          <dd>{minutes(feedback.timing.active_minutes)}</dd>
        </div>
        <div>
          <dt>Паузы</dt>
          <dd>{minutes(feedback.timing.paused_minutes)}</dd>
        </div>
        <div>
          <dt>Норма</dt>
          <dd>{minutes(feedback.timing.norm_minutes)}</dd>
        </div>
        <div>
          <dt>Относительно нормы</dt>
          <dd>{timingComparison(feedback)}</dd>
        </div>
      </dl>
      <div className="executor-review-notes">
        <section>
          <h4>Что получилось</h4>
          {strongPoints.length ? (
            <ul className="review-checks">
              {strongPoints.map((item) => (
                <li key={`${feedback.submission_version}-${item.title}`} className="review-check pass">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Проверка не выделила отдельных сильных сторон.</p>
          )}
        </section>
        <section>
          <h4>Что улучшить</h4>
          {improve.length ? (
            <ul className="review-checks">
              {improve.map((item) => (
                <li
                  key={`${feedback.submission_version}-${item.title}`}
                  className={`review-check ${item.status}`}
                >
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Замечаний по этой сдаче нет.</p>
          )}
        </section>
      </div>
      <p className="muted">
        Обновлено: {local(feedback.reviewed_at)}. Закрытие или возврат в доработку решает мастер.
      </p>
    </section>
  );
}

export function ExecutorFeedbackReport({
  feedback,
  status,
  attempt,
}: {
  feedback: ExecutorFeedback[];
  status: string;
  attempt: number;
}) {
  const current = feedback.find((item) => item.is_current) ?? feedback.at(-1);
  if (!current) return null;
  const previous = feedback.filter((item) => item !== current);
  return (
    <>
      {!feedback.some((item) => item.is_current) && (status === "completed" || status === "ai_review") && (
        <p className="notice" role="status">
          Новая сдача проверяется. Ниже показан результат предыдущей попытки.
        </p>
      )}
      <ExecutorFeedbackEntry feedback={current} status={status} attempt={attempt} />
      {previous.length > 0 && (
        <details className="review-history">
          <summary>Предыдущие результаты ({previous.length})</summary>
          {previous.map((item) => (
            <details className="review-history-entry" key={`${item.submission_version}-${item.attempt}`}>
              <summary>
                Попытка {item.attempt ?? "—"} · {local(item.reviewed_at)}
              </summary>
              <ExecutorFeedbackEntry feedback={{ ...item, is_current: false }} />
            </details>
          ))}
        </details>
      )}
    </>
  );
}
