import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { t } from "../lib/i18n";
import { readableLimitation } from "../lib/presentationText";
import { summarySections } from "../lib/summaryPresentation";
import type { AnalyticsSummary } from "../types";
import "./analytics-summary.css";

export function AnalyticsSummaryPanel({
  summary,
  period,
  busy,
  disabled,
  error,
  onGenerate,
}: {
  summary: AnalyticsSummary | null;
  period: string;
  busy: boolean;
  disabled: boolean;
  error: string;
  onGenerate: () => void;
}) {
  const sections = summary ? summarySections(summary.text, period) : null;
  return (
    <section className="analytics-section ai-summary-panel" aria-label={t("ИИ-сводка мастера")}>
      <header className="ai-summary-head">
        <div className="ai-summary-heading">
          <span className="ai-summary-symbol" aria-hidden="true">
            <Icon name="analytics" />
          </span>
          <div>
            <p className="eyebrow">{t("ОБЗОР СМЕНЫ")}</p>
            <h2>{t("ИИ-сводка мастера")}</h2>
            <p className="ai-summary-period">{period}</p>
          </div>
        </div>
        <button className="secondary with-icon" onClick={onGenerate} disabled={busy || disabled}>
          <Icon name="refresh" />
          {busy ? t("Формируем…") : summary ? t("Обновить сводку") : t("Сформировать ИИ-сводку")}
        </button>
      </header>
      {error && (
        <p className="error ai-summary-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="ai-summary-progress" role="status">
          {t("Собираем выводы по показателям отчёта…")}
        </p>
      )}
      {busy && !summary && <Skeleton variant="summary" />}
      {!busy && !summary && !error && (
        <p className="ai-summary-intro">{t("Основные выводы и рекомендации за выбранный период.")}</p>
      )}
      {summary && sections && (
        <article className="ai-summary-result" aria-label={t("Результат сводки")}>
          <div className="ai-summary-source">
            <span className={`ai-summary-badge ${summary.source === "openai" ? "" : "is-rules"}`}>
              {summary.source === "openai" ? t("ИИ-анализ") : t("Обзор по данным")}
            </span>
            <span>
              {summary.source === "openai"
                ? t("На основе показателей отчёта")
                : t("Обзор показателей без ИИ-интерпретации.")}
            </span>
          </div>
          <div className={`ai-summary-columns ${sections.actions.length ? "has-actions" : ""}`}>
            <section className="ai-summary-facts">
              <h3>{t("Главное за период")}</h3>
              {sections.facts.length ? (
                <ul>
                  {sections.facts.map((fact, index) => (
                    <li key={index}>{fact}</li>
                  ))}
                </ul>
              ) : (
                <p>{summary.text}</p>
              )}
            </section>
            {sections.actions.length > 0 && (
              <section className="ai-summary-actions">
                <h3>{t("Рекомендуемые действия")}</h3>
                <ol>
                  {sections.actions.map((action, index) => (
                    <li key={index}>
                      <span>{action}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
          {summary.limitations.length > 0 && (
            <details className="ai-summary-limitations">
              <summary>{t("О данных и ограничениях сводки")}</summary>
              <ul>
                {summary.limitations.map((limitation, index) => (
                  <li key={index}>{readableLimitation(limitation)}</li>
                ))}
              </ul>
            </details>
          )}
        </article>
      )}
    </section>
  );
}
