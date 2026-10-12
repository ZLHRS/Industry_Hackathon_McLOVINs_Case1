import { t } from "../lib/i18n";
import "./skeleton.css";

type SkeletonProps = {
  variant?: "cards" | "list" | "detail" | "report";
  label?: string;
  count?: number;
};

/** Decorative placeholders never expose invented values or actions to assistive technology. */
export function Skeleton({ variant = "cards", label = t("Загрузка…"), count = 6 }: SkeletonProps) {
  return (
    <div className={`loading-skeleton loading-skeleton--${variant}`} role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="loading-skeleton-grid" aria-hidden="true">
        {Array.from({ length: variant === "detail" ? 1 : count }, (_, index) => (
          <div className="loading-skeleton-card" key={index}>
            <div className="loading-skeleton-top">
              <span className="loading-skeleton-block loading-skeleton-kicker" />
              <span className="loading-skeleton-block loading-skeleton-badge" />
            </div>
            <span className="loading-skeleton-block loading-skeleton-title" />
            <span className="loading-skeleton-block loading-skeleton-line" />
            <span className="loading-skeleton-block loading-skeleton-short" />
            <div className="loading-skeleton-footer">
              <span className="loading-skeleton-block loading-skeleton-meta" />
              <span className="loading-skeleton-block loading-skeleton-meta" />
            </div>
          </div>
        ))}
      </div>
      {variant === "report" && (
        <div className="loading-skeleton-chart loading-skeleton-block" aria-hidden="true" />
      )}
    </div>
  );
}
